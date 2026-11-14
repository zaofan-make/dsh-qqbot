/**
 * value-score.ts — 群聊价值评分(本地小模型 KNN, 2026-09-13 主人定)
 *
 * 目的(零 token): 判断"这条群消息值不值得唤醒 AI 开口"。
 * 方法(实测 90~100%): 样例近邻加权投票(KNN) —— 而非"描述句 zero-shot"(实测仅 65%, 分数全挤在 0.5 附近)。
 * 三种模式(config.localModel.valueGate):
 *   off   = 不评分(省 CPU)
 *   log   = 只记录分数(默认, 观察期: 不改变任何行为)
 *   block = 低分不唤醒 AI(消息仍 append 进上下文, 不丢)
 */
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { closeFile, ensureDir } from '../shared/async-append.js';
import { dirname, join } from 'node:path';
import type { Logger } from '../types.js';
import { createLocalEmbedder } from './local-embed.js';
import { loadValueSamples, valueSamplesPath, type ValueSample } from './value-sample.js';

/** 近邻数(实测 k=5 及加权版在独立测试集上 10/10) */
const K = 5;
/** 相似度加权指数: 把近邻的相似度差距拉开(实测区分度更好) */
const WEIGHT_POW = 8;

/**
 * 打分文本的 mention 归一化（2026-09-15 主人实测后加）。
 *
 * 症状：样例带 `@bot …` 前缀、入站文本带 `<@openid> …` →
 *   两者的**最大共同特征**变成"这条 @ 了她"，语义被前缀淹没：
 *   实测「<@xx> 不知道」拿到 **1.00**（近邻全是 `@bot …`：这个bug你修一下 / 继续找 / 大不大），
 *   而它其实只是群里一句"不知道"。
 *
 * 做法：**样例与查询都过这个函数** → 相似度只反映正文；
 *   "是否被点名"改由独立特征承担（gate 的 `!mentioned` 放行、加权里的 AGG_MENTION_BOOST、
 *   以及"@了别人"时的 OTHER_MENTION_PENALTY）。
 */
export function stripMentionForScore(raw: string): string {
  return String(raw ?? '')
    .replace(/<@[!&]?\d+>/g, ' ')                 // QQ 原生 <@!1234567890>
    .replace(/<@[0-9A-Za-z_-]{6,}>/g, ' ')        // openid 形式 <@49C7A1D43E0018DF6F5E9DAB9C823E28>
    .replace(/@bot\b/gi, ' ')                     // 预设/样例里手写的 @bot
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 这条消息 **@ 了别人**（不是她）→ 判定分扣一点。
 *
 * ⚠️ 2026-09-15 主人**修正过一次语义**："不是没人@她的时候降低评分, 是有人@别人的时候降低评分"。
 *   人家第一版做成了"没被 @ 就扣分"——那是错的：**没被 @ 恰恰是她该主动接话的常态**（群里没人点她，她才会自己挑话插），
 *   扣分等于把她变成"等点名才说话"。
 *   真正的信号是"这句话 @ 的是谁"：@ 了别人 = 这轮对话的方向是那个人，她基本不该插嘴。
 *   （@ 的是她自己时走另一条路：`!mentioned` 的拦截豁免 → 必回。）
 *
 * 为什么用**减法**而不是乘法：门槛附近的高分要更保守（0.90 想越 0.89 的线得真够格），
 *   而本来就很低的分再乘系数没有意义（都是拦）。0.06 ≈ 让"@别人"这条多要 6 分。
 * 只影响判定分（effScore），**不改**模型原始分（日志里 score/scoreAdj 分开记，能复盘）。
 */
export const OTHER_MENTION_PENALTY = 0.06;


export interface ScoreNeighbor {
  m: string;
  y: 0 | 1;
  s: number;
}

export interface ScoreResult {
  /** 0~1: 近邻加权投票中"值得回应"的占比 */
  score: number;
  /** score >= minScore */
  worth: boolean;
  /** 最近邻居的最高相似度(0~1): 越低说明"地图上没有同类样本", 判断越不可靠 */
  confidence: number;
  /** 低置信(confidence < 0.5): 新话题/没见过的类型 —— block 模式下**不应据此拦截**(宁可多花 token 也别漏) */
  lowConfidence: boolean;
  /** top3 近邻(排查/解释用) */
  top: ScoreNeighbor[];
}

export interface ValueScorer {
  /** 打分; 不可用/失败 → undefined(调用方按"未知"处理, 不拦截) */
  score(text: string): Promise<ScoreResult | undefined>;
  /** 样例向量是否已就绪 */
  ready(): boolean;
  /** 后台预热(加载模型 + 预计算样例向量), 不阻塞 */
  warmup(): void;
}

const scorers = new Map<string, ValueScorer>();

/** 取值分器(同参数单例复用: 模型与样例向量只算一次) */
export function createValueScorer(opts: {
  dataRoot: string;
  modelDir?: string;
  minScore?: number;
  logger?: Logger;
}): ValueScorer {
  const cacheKey = `${opts.dataRoot}|${opts.modelDir ?? ''}|${opts.minScore ?? ''}`;
  const cached = scorers.get(cacheKey);
  if (cached) return cached;

  const minScore = typeof opts.minScore === 'number' ? opts.minScore : 0.5;
  const embedder = createLocalEmbedder({ modelDir: opts.modelDir, logger: opts.logger });
  let samples: ValueSample[] = [];
  /** 样例文本的 mention 归一化版本（与 sampleTexts[i] 对应; 供近邻展示用干净文本） */
  let sampleTexts: string[] = [];
  let vecs: number[][] = [];
  let initing: Promise<boolean> | undefined;
  let inited = false;
  /** 已加载样例文件的 mtime(0=文件不存在, 用内置默认) —— 变化时自动重载: 改样例无需重启/无需改代码 */
  let loadedMtime = -1;

  function samplesMtime(): number {
    try { return statSync(valueSamplesPath(opts.dataRoot)).mtimeMs; } catch { return 0; }
  }

  async function init(): Promise<boolean> {
    const mt = samplesMtime();
    if (inited && mt === loadedMtime) return true;   // 样例未变 → 用缓存
    if (initing) return initing;
    initing = (async (): Promise<boolean> => {
      try {
        samples = loadValueSamples(opts.dataRoot);
        if (samples.length === 0) return false;
        // mention 归一化: 剥掉 `@bot`/`<@openid>` 再嵌入 —— 否则"这条 @ 了她"会淹掉语义(见 stripMentionForScore)
        sampleTexts = samples.map((s) => stripMentionForScore(s.m) || s.m);
        const v = await embedder.embedPassages(sampleTexts);
        if (!v || v.length !== samples.length) return false;
        vecs = v;
        inited = true;
        loadedMtime = mt;
        opts.logger?.info(`[im-qqbot] 价值评分就绪: ${samples.length} 条样例`);
        return true;
      } catch (e) {
        opts.logger?.warn(`[im-qqbot] 价值评分初始化失败: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      } finally {
        initing = undefined;
      }
    })();
    return initing;
  }

  function dot(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
    return s;
  }

  const scorer: ValueScorer = {
    ready: () => inited,
    warmup: () => { void init(); },
    async score(text: string): Promise<ScoreResult | undefined> {
      // 查询侧也剥 mention —— 与样例侧(init 里的 sampleTexts)保持一致
      const t = stripMentionForScore(String(text || '')) || String(text || '').trim();
      if (!t) return undefined;
      if (!(await init())) return undefined;
      const qv = await embedder.embedQuery(t);
      if (!qv) return undefined;
      const scored: ScoreNeighbor[] = samples
        .map((s, i) => ({ m: sampleTexts[i] ?? s.m, y: s.y, s: dot(qv, vecs[i] ?? []) }))
        .sort((a, b) => b.s - a.s);
      const top = scored.slice(0, K);
      let w1 = 0;
      let w0 = 0;
      for (const n of top) {
        const w = Math.max(0, n.s) ** WEIGHT_POW;
        if (n.y === 1) w1 += w;
        else w0 += w;
      }
      const total = w1 + w0;
      const score = total > 0 ? w1 / total : 0;
      // 置信度 = 最近邻居的相似度(低于 0.5 视为"地图上没这类样本", 判断不可靠)
      const confidence = top[0]?.s ?? 0;
      return { score, worth: score >= minScore, confidence, lowConfidence: confidence < 0.5, top: top.slice(0, 3) };
    },
  };
  scorers.set(cacheKey, scorer);
  return scorer;
}

/**
 * 评分日志的滚动上限（2026-09-14 加）。
 *
 * 起因：主人清点 `.qqbot/` 目录时发现 `value-scores.jsonl` 是**唯一没有上限**的数据文件 ——
 *   它每条群消息都 append 一行，thinking-log / four-source / group-audit 都有滚动，就它没有。
 *   跑久了会无界增长（当天已 810 行 / 361 KB）。
 *
 * 策略与 group-audit 一致：**超过体积阈值才检查**（不是每次都 stat，省 IO），
 *   超了就保留最新 N 行 —— 面板「最近评分」只读尾部，排查也只看最近的，砍旧的零损失。
 */
const SCORE_LOG_MAX_BYTES = 2 * 1024 * 1024;
const SCORE_LOG_KEEP_LINES = 2000;
const SCORE_LOG_CHECK_EVERY = 100;
let scoreLogSinceCheck = 0;

/** 追加一条评分记录(观察期用): {dataRoot}/.qqbot/value-scores.jsonl —— 一行一条, 可直接翻 */
export function appendScoreLog(dataRoot: string, rec: Record<string, unknown>): void {
  try {
    const p = join(dataRoot, '.qqbot', 'value-scores.jsonl');
    ensureDir(dirname(p));
    // ⚠️ 这里**必须同步写**：评分日志会被同进程的统计/回归测试**立刻读回**，
    //    改异步后 classify-accuracy 回归直接失败（实测）。目录创建那一步仍用缓存优化。
    appendFileSync(p, JSON.stringify({ ts: Date.now(), ...rec }) + String.fromCharCode(10), 'utf8');
    // 滚动：每 N 次才 stat 一次；超阈值就保留最新 KEEP 行（原子替换，避免半截文件）
    if (++scoreLogSinceCheck >= SCORE_LOG_CHECK_EVERY) {
      scoreLogSinceCheck = 0;
      try {
        if (statSync(p).size > SCORE_LOG_MAX_BYTES) {
          closeFile(p); // ★ 重写前必须先关流，否则旧 fd 会写进被 rename 掉的旧文件
          const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '');
          if (lines.length > SCORE_LOG_KEEP_LINES) {
            const tmp = `${p}.tmp`;
            writeFileSync(tmp, `${lines.slice(-SCORE_LOG_KEEP_LINES).join('\n')}\n`, 'utf8');
            renameSync(tmp, p);
          }
        }
      } catch { /* 滚动失败不影响记录 */ }
    }
  } catch { /* 记录失败不影响主流程 */ }
}
