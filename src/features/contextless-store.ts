/**
 * contextless-store.ts — 「无上下文模式」的**按会话**开关存储（2026-09-27 主人定）。
 *
 * 需求（主人原话）：
 *   「无上下文模式，开启后自动删除历史对话，在 dock 页面但会话里开启」
 *   —— 在 dock 面板里对**某个会话**开启；开启后该会话**每轮都丢掉历史对话**
 *      （只保留系统规则 + 「@ 之前 N 条群消息」），用来大幅省 token。
 *
 * 与其他配置的区别：
 *   - 全局配置（`config.contextlessMode`）是"所有会话都这样"；
 *   - 本文件是"**只有这个会话**这样"（会话级覆盖，优先级高于全局）。
 *
 * 存储：`{dataRoot}/.qqbot/contextless.json`，结构 `{ "<sessionKey>": { enabled, window } }`。
 *   ⚠️ 只放"开关 + 条数"，不放任何消息内容 —— 群消息内容由既有的 mediaHistoryBuffer 管。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { diagWrite } from '../shared/diag.js';
import { join, dirname } from 'node:path';

/** 单个会话的无上下文设置 */
export interface ContextlessSetting {
  /** 是否对该会话开启"每轮丢历史" */
  enabled: boolean;
  /** 保留「@ 之前」多少条群消息（0 = 一条都不带，只留系统规则） */
  window: number;
  /**
   * 「智能判断」子模式（2026-10-01 主人设计）—— **与 window 互斥**。
   *   true  = 不按固定条数：交给 AI **每轮自己判断话题**，结束就调 `context_compact` /
   *           `context_drop` 自主压缩或丢弃历史，只需留下自己写的要点（存独立文件，压缩碰不到）；
   *   false/缺省 = 老行为：每轮只带「@ 之前 window 条」。
   * ⚠️ 互斥在**读取侧**保证：smart=true 时 window 不生效（见 keepWindowOf()），UI 也做成二选一。
   */
  smart?: boolean;
  /**
   * **分段压缩**（2026-11-06 主人定）：只压「上回合结束 → 本回合开始」这一段，
   * 更早的历史一个字都不动（前缀不变 ⇒ 缓存照样命中）。
   * 与 smart 互斥；与 window 也互斥（window 是"每轮只带 N 条"，分段压缩是"只压新的那段"）。
   */
  segment?: boolean;
  /** 分段压缩保留条数：这段里最后 N 条普通消息留下，更旧的压成一个占位节点 */
  segmentKeep?: number;
  /**
   * 分段压缩·**价值分保命门槛**（0 = 关闭）：入站时本地小模型给每条消息打过分（0~1），
   * 分数 ≥ 这个值的消息**即使排在 N 条之外也保留**。主人举例：填 0.78，那 0.99 和 0.79 两个都留。
   */
  segmentScoreMin?: number;
  /** 备忘条数上限（面板可设；超出自动丢最旧） */
  memoMax?: number;
}

const DEFAULT_SETTING: ContextlessSetting = { enabled: false, window: 5, smart: false };

let storePath = '';
let loaded = false;
const table = new Map<string, ContextlessSetting>();

function ensureDir(p: string): void {
  try { mkdirSync(dirname(p), { recursive: true }); } catch { /* ignore */ }
}

/**
 * 兜底：若没人调过 initContextlessStore（例如"桥"那份模块实例与插件侧不是同一个），
 * 就按 DSH_HOME / 家目录推一个路径，**至少要能落盘**（2026-09-27 群聊AI排查发现：
 * storePath 为空时 persist() 直接 return，前端照样收到 ok，造成"开关永远存不上"）。
 */
function ensurePath(): void {
  if (storePath) return;
  try {
    // ⚠️ 这只是"最后兜底"：正常路径应由 bootstrap(插件侧) 或桥的 loadContextlessStore() 显式 init。
    //    兜底路径放在 {DSH_HOME} 下，若真的用到它，说明调用方没 init（两份模块实例的老问题）。
    const home = (process.env.DSH_HOME && process.env.DSH_HOME.trim())
      || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
    storePath = join(home, 'qqbot-contextless.json');
  } catch { /* ignore */ }
}

/** 绑定 dataRoot（apply 时调一次；之后所有读写都落在这里） */
export function initContextlessStore(dataRoot: string): void {
  const next = join(dataRoot, '.qqbot', 'contextless.json');
  // ⚠️ 2026-09-27 修：多实例共享一个模块级 storePath 时，后 init 的会覆盖前面的
  //   （实测：A 实例读到了 B 实例的目录）。这里改为**记住多个根**，
  //   读的时候把各根合并（同一 key 取先出现的），写的时候写回"该 key 原来所在的根"。
  if (storePath && storePath !== next && !roots.includes(next)) {
    roots.push(next);
  } else if (!storePath) {
    roots.push(next);
  }
  storePath = next;
  loaded = false;
  table.clear();
  for (const p of roots) loadFrom(p);
}

/** 已知的数据根文件路径（多实例场景下不止一个） */
const roots: string[] = [];
/** 每个 key 归属哪个文件（写回时用它，避免把 A 实例的开关写到 B 实例目录） */
const keyOwner = new Map<string, string>();

/** 从某个文件读入表（已存在的不覆盖，先到的优先） */
function loadFrom(p: string): void {
  try {
    if (!p || !existsSync(p)) return;
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return;
    for (const [key, v] of Object.entries(raw)) {
      if (table.has(key)) continue;
      const o = v as { enabled?: unknown; window?: unknown; smart?: unknown; memoMax?: unknown; segment?: unknown; segmentKeep?: unknown; segmentScoreMin?: unknown };
      table.set(key, {
        enabled: o?.enabled === true,
        smart: o?.smart === true,
        segment: o?.segment === true,
        segmentKeep: Number(o?.segmentKeep) > 0 ? Math.max(1, Math.trunc(Number(o.segmentKeep))) : undefined,
        segmentScoreMin: Number(o?.segmentScoreMin) > 0 ? Math.min(1, Number(o.segmentScoreMin)) : undefined,
        memoMax: Number(o?.memoMax) > 0 ? Number(o.memoMax) : undefined,
        window: Number.isFinite(Number(o?.window)) ? Math.max(0, Math.trunc(Number(o.window))) : DEFAULT_SETTING.window,
      });
      keyOwner.set(key, p);   // 记住这个 key 是从哪个文件读来的
    }
  } catch { /* 损坏的文件当空表 */ }
}

/** 所有已知文件路径（诊断用） */
export function describeStorePaths(): string {
  try { ensurePath(); return [storePath, ...roots].filter(Boolean).join(' | '); } catch { return '(err)'; }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  ensurePath();
  const targets = [storePath, ...roots].filter(Boolean);
  for (const p of targets) loadFrom(p);
}

function persist(): void {
  try {
    ensurePath();
    if (!storePath) return;
    // 按"key 归属的文件"分组写回：避免多实例互相覆盖（A 实例的开关写进了 B 实例的目录）
    const byFile = new Map<string, Record<string, ContextlessSetting>>();
    for (const [k, v] of table) {
      const owner = keyOwner.get(k) || storePath;
      const bucket = byFile.get(owner) ?? {};
      bucket[k] = v;
      byFile.set(owner, bucket);
    }
    if (byFile.size === 0) byFile.set(storePath, {});
    for (const [file, obj] of byFile) {
      try {
        ensureDir(file);
        writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
      } catch { /* 单个文件失败不影响其它 */ }
    }
  } catch { /* 写失败不影响运行 */ }
}

/**
 * 落盘追踪（2026-09-27 加，专治"静默失败"）：
 * 这个功能前后踩了 9 个坑，其中 8 个都不报错 —— 全靠反复试探。
 * 现在把「被调用 / 跳过原因 / 结果 / 异常」统统追加到 {dataRoot}/.qqbot/contextless-trace.log，
 * 一出问题先看这个文件，别再猜。
 */
export function traceContextless(line: string): void {
  // ★ 2026-10-06 还债：收口到统一诊断底座（默认关 / 2MB 上限 / 自动轮转 / 只写一个位置）。
  //   以前这里**没有任何上限**（实测一路涨到 25 MB），同一条内容还往三个地方各写一份，
  //   并且每行都往终端 console.error 刷屏。要排查时开配置项 `diagLog`
  //   （或 `set DSH_QQBOT_DIAG=1` 重启）即可。
  diagWrite('contextless-trace', line);
}


/** 诊断：当前绑定的文件路径（trace 用） */
export function describeStorePath(): string {
  try { ensurePath(); return storePath || '(empty)'; } catch { return '(err)'; }
}

/** 读某会话的设置（未设置 → 默认关） */
export function getContextless(sessionKey: string): ContextlessSetting {
  ensurePath();
  load();
  return table.get(sessionKey) ?? { ...DEFAULT_SETTING };
}

/** 写某会话的设置（dock 面板调用；只对有值的字段覆盖） */
export function setContextless(sessionKey: string, patch: Partial<ContextlessSetting>): ContextlessSetting {
  ensurePath();
  load();
  const cur = table.get(sessionKey) ?? { ...DEFAULT_SETTING };
  const next: ContextlessSetting = {
    enabled: patch.enabled === undefined ? cur.enabled : patch.enabled === true,
    window: patch.window === undefined
      ? cur.window
      : Math.max(0, Math.trunc(Number(patch.window)) || 0),
    // 2026-10-01: 「智能判断」子模式（与 window **互斥**）——
    //   这里只**存值、不互斥清零**，这样主人在 UI 上来回切换时 window 的旧值不会丢；
    //   真正的互斥由读取侧（contextlessSmartOf / keepWindowOf）与面板单选一起保证。
    smart: patch.smart === undefined ? (cur.smart === true) : patch.smart === true,
    segment: patch.segment === undefined ? (cur.segment === true) : patch.segment === true,
    segmentKeep: patch.segmentKeep === undefined
      ? cur.segmentKeep
      : (Number.isFinite(Number(patch.segmentKeep)) ? Math.max(1, Math.trunc(Number(patch.segmentKeep))) : undefined),
    segmentScoreMin: patch.segmentScoreMin === undefined
      ? cur.segmentScoreMin
      : (Number(patch.segmentScoreMin) > 0 ? Math.min(1, Number(patch.segmentScoreMin)) : undefined),
  };
  table.set(sessionKey, next);
  if (!keyOwner.has(sessionKey)) { try { ensurePath(); if (storePath) keyOwner.set(sessionKey, storePath); } catch { /* ignore */ } }
  persist();
  return next;
}

/** 全表（给 dock 面板列出来） */
export function listContextless(): Record<string, ContextlessSetting> {
  load();
  const out: Record<string, ContextlessSetting> = {};
  for (const [k, v] of table) out[k] = v;
  return out;
}

/** 删某会话的设置 */
export function clearContextless(sessionKey: string): boolean {
  load();
  const ok = table.delete(sessionKey);
  if (ok) persist();
  return ok;
}

/** 会话是否处于"无上下文模式"（全局开 **或** 该会话单独开） */
export function isContextlessActive(sessionKey: string, globalEnabled?: boolean): boolean {
  if (globalEnabled === true) return true;
  return getContextless(sessionKey).enabled;
}

/**
 * 该会话是否用「智能判断」子模式（2026-10-01 主人设计）。
 *
 * ⚠️ **与 window 互斥**：返回 true 时，`contextlessWindowOf` 的条数**不生效** ——
 *   由 AI 每轮自己判断话题，自主调用 context_compact / context_drop。
 *   会话级优先；没设过时用全局默认（config.contextlessSmart）。
 */
/** 该会话的备忘条数上限（未设置则 undefined，由默认值兜底） */
export function contextlessMemoMaxOf(sessionKey: string): number | undefined {
  try {
    const v = getContextless(sessionKey).memoMax;
    return Number(v) > 0 ? Number(v) : undefined;
  } catch {
    return undefined;
  }
}

export function contextlessSmartOf(sessionKey: string, globalDefault?: boolean): boolean {
  try {
    const s = getContextless(sessionKey);
    if (s.smart !== undefined) return s.smart === true;
    return globalDefault === true;
  } catch {
    return globalDefault === true;
  }
}

/** 该会话应携带的「@ 之前」群消息条数（会话级优先，其次全局默认 5） */
export function contextlessWindowOf(sessionKey: string, fallback = 5): number {
  const s = getContextless(sessionKey);
  if (s.enabled) return s.window;
  return Math.max(0, Math.trunc(fallback) || 0);
}

/**
 * 该会话是否开启**分段压缩**（2026-11-06）。与 smart / window 互斥 ——
 * 它不改变"每轮带多少条历史"，只把「上回合结束 → 本回合开始」这段里的旧消息压成一行占位，
 * 更早的（缓存前缀）一个字都不动。
 */
export function contextlessSegmentOf(sessionKey: string): boolean {
  try {
    return getContextless(sessionKey).segment === true;
  } catch {
    return false;
  }
}

/** 分段压缩保留的条数（默认 3） */
export function contextlessSegmentKeepOf(sessionKey: string, fallback = 3): number {
  try {
    const v = getContextless(sessionKey).segmentKeep;
    return Number(v) > 0 ? Math.max(1, Math.trunc(Number(v))) : Math.max(1, Math.trunc(fallback) || 3);
  } catch {
    return Math.max(1, Math.trunc(fallback) || 3);
  }
}

/**
 * 分段压缩的**价值分保命门槛**（2026-11-06 主人定）：0/未设 = 关闭。
 * 分数 ≥ 门槛的消息即使排在"最近 N 条"之外也保留。
 */
export function contextlessSegmentScoreMinOf(sessionKey: string): number | undefined {
  try {
    const v = getContextless(sessionKey).segmentScoreMin;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(1, n) : undefined;
  } catch {
    return undefined;
  }
}
