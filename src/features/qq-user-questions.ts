/**
 * qq-user-questions.ts — QQ 远程提问: 把 AI 的 ask_user_question 变成 QQ 按钮卡片
 *
 * 机制(与 QQ 远程审批同款): 宿主 ctx 上 `user-questions/request` 是 Agent 作用域的
 * waterfall 事件(dsh-user-questions/lib: UserQuestionService.ask → waterfall 派发)。
 * Web UI 答案器在宿主引导期注册(dsh-client-ui-user-questions), 会在浏览器连着且
 * agent 有 GUI 会话时先 claim —— 所以本监听必须 { prepend: true } 抢在它前面。
 *
 * 形状(@deepseek-ai/dsh-user-questions/types):
 *   request = { questions: [{ id, question, detail?, header?, options?:[{label,...}], multiSelect? }], agent?, signal? }
 *   answer   = { answers: [{ id, selected: string[], custom? }] }
 *
 * 2026-09-11 增强(主人需求, 本轮新增):
 *   ① 按钮 label 带字母前缀(A. / B. / …), 卡片正文列出**全部**选项字母表;
 *   ② **文字选项兜底**: 待答期间直接回文字也算回答 ——
 *        回 `A` / `2`            → 选第 1 / 第 2 个选项(字母与序号都认);
 *        回 `A,C` / `1 3` / `选 1 3` → 多选;
 *        回选项原文(与某个 label 完全一致) → 选它;
 *        回**其它任意文字**       → 作为自由回答(custom)透传给 AI(answers[].custom);
 *   ③ 多问题(questions > 1): 依次发卡, 回答时可用 `#2 B` 指定第 2 问;
 *   ④ 选项超过按钮上限(QQ 卡片最多 5 行 → 5 个可点按钮)时, 卡片正文照样列全, 靠文字兜底补齐;
 *   ⑤ 按钮卡片发送失败时不再放弃提问 —— 退化成纯文字选项清单, pending 保留(文字兜底能收答案)。
 *
 * 2026-09-24 增强(主人需求: 卡片要能"指定 openid 或昵称匹配"):
 *   卡片可点人既认 `<@32位openid>`、也认 **`<@群友昵称>`** —— 昵称会用本地群成员台账
 *   (`{dataRoot}/表情包/group-members.jsonl`, 在群里发过言/申请过入群的人)解析成 openid;
 *   没写 `<@...>` 标注、但 question/header 文本里唯一命中某位成员昵称时同样按点名处理。
 *   解析不到就沿用老逻辑(最近被 @ 的人 → 消息发送者壳 → 会话发起者)。
 */
import type { ReplyTarget } from '@tencent-connect/qqbot-nodejs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { join } from 'node:path';
import type { QQBotSender } from '../transport/outbound-buffer.js';
import type { SessionManager } from '../session/index.js';
import type { Logger } from '../types.js';
import { readGroupMembers } from './chat-ledger.js';

const BTN_PREFIX = 'q:';
/** 抢答按钮前缀（claim）：点击后把回答权转移给点击者，全员可点 */
const CLAIM_PREFIX = 'qc:';
/** 选项字母表(文字兜底按它映射) */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** QQ 卡片按钮上限: 最多 5 行, 每行 1 个选项 → 最多 5 个可点按钮 */
const CARD_MAX_OPTIONS = 5;
/** 单个问题的选项上限(超出交回宿主, 不接管) */
const MAX_OPTIONS = 26;
/** 单次提问最多接管几个问题(超出交回宿主) */
const MAX_QUESTIONS = 5;

interface PendingItem {
  qid: string;
  question: string;
  header: string;
  detail: string;
  opts: Array<{ label: string }>;
  /** 发起者 openid(群=member_openid, c2c=user_openid); 回调/文字兜底都校验, 防止别人代答 */
  ownerId: string;
  /**
   * 抢答许可(2026-09-30 主人定): 卡片上多一个「🙋 我来回答」按钮，
   * **所有人都能点**，点一次即把回答权**转移**给点的人（`ownerId` 被改写），
   * 之后原 owner 与其他人再点都会被拒。
   * 用途：机器人把问题问错人 / 被问的人不在 / 想让"谁先看到谁答"的场景。
   */
  claimable?: boolean;
  /** 是否已被抢走（抢到后置 true，第二个人再点会被明确拒绝） */
  claimed?: boolean;
  /** 抢答成功者 openid（仅用于回执文案「已被 XXX 抢到」） */
  claimedBy?: string;
  /** 是否多选(宿主给的 multiSelect) */
  multiSelect: boolean;
  /** 会话键 `scope:peerId`: 文字兜底据此判断"这条消息是不是在回答本问题" */
  peerKey: string;
  /** 同批问题共享的组(多问题时按组收集全部答案后统一 resolve) */
  group: PendingGroup;
  /** 本问题在该批中的序号(1 起; 文字兜底用 `#2 B` 指定) */
  index: number;
  /** 该批问题总数 */
  total: number;
  deadlineAt: number;
}

/** 一批提问(一次 ask_user_question 的全部问题) —— 全部答完/超时后统一 resolve 宿主(阻塞档)或投递回会话(后台档) */
interface PendingGroup {
  /** 该批问题的 qid 顺序(resolve 时按此顺序出答案) */
  qids: string[];
  /** qid → 已收答案 */
  answers: Map<string, { selected: string[]; custom?: string }>;
  resolve: (ans: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 该批占用的 pending key(收尾清理用) */
  keys: string[];
  signal?: AbortSignal;
  onAbort?: () => void;
  /** 该批的问题项(后台档组装回执文案要 question/header) */
  items?: PendingItem[];
  /**
   * 发起该批提问的会话记录(结构化类型, 后台档事后投递用)。
   * agent.inject = 回合内安全插入; agent.followup = 唤醒新回合。
   */
  record?: {
    agent?: unknown;
    turnActive?: boolean;
    lastInboundAt?: number;
    /** 发起提问时的回复目标(带 msgId) —— 抢答补发卡片必须用它走被动回复通道 */
    replyTarget?: { scope: string; targetId: string; msgId?: string };
  };
  /** true = 后台档(async): 不 resolve 宿主, 答案改了投递回会话 */
  isAsync?: boolean;
}

/** Web 浮层看到的待办提问(去敏) */
export interface WebPendingQuestion {
  /** 唯一键 = qid:token(web 结算回传用) */
  key: string;
  question: string;
  header: string;
  detail: string;
  options: Array<{ label: string }>;
  deadlineAt: number;
}

/** 选项按钮 keyboard(每行1个=竖排, 字宽不截断; QQ 最多5行 → 最多5个按钮)
 *  label 带字母前缀(A. xxx) —— 与文字兜底/卡片正文的字母表对齐。
 *  permission: 群聊限定"发起对话者本人"可点(specify_user_ids=ownerId), 防群里其他人替你选 */
function optionsKeyboard(item: PendingItem, token: string, ownerId?: string): { content: { rows: unknown[] } } {
  const shown = item.opts.slice(0, CARD_MAX_OPTIONS);
  // ★ c2c(私聊)修复: QQ **私聊不下发 permission.type=0(指定用户)按钮** —— 客户端直接拦,
  //   点击连 INTERACTION_CREATE 都不产生(2026-10-16 实测: 私聊里选项按钮点不动, 同一张卡上
  //   硬编码 type=2 的抢答按钮却能点)。私聊本来只有对方一个人, 一律放成全员可点,
  //   点击人校验由 handleInteraction 的 item.ownerId 兜底(见 "这个问题不是问你的哦~")。
  const isC2C = String(item.peerKey ?? '').startsWith('c2c:');
  const permission: Record<string, unknown> = (ownerId && !isC2C)
    ? { type: 0, specify_user_ids: [ownerId] }
    : { type: 2 };
  const rows = shown.map((opt, idx) => {
    const label = `${LETTERS[idx] ?? String(idx + 1)}. ${String(opt.label ?? '')}`.slice(0, 24);
    return {
      buttons: [{
        id: `${BTN_PREFIX}${item.qid}:${token}:${idx}`,
        render_data: { label, visited_label: label, style: 1 },
        action: {
          type: 1,
          permission,
          data: `${BTN_PREFIX}${item.qid}:${token}:${idx}`,
          unsupport_tips: '按钮不可用时, 发 /答 A (或 /答 你的回答)',
        },
      }],
    };
  });
  // ── 抢答按钮（2026-09-30 主人定）──────────────────────────────
  //   放在最上面：**全员可点**（permission type 2）。谁先点谁把回答权抢走
  //   （回调里改写 item.ownerId 并重发卡片），之后其他人再点只收到「已被 XXX 抢到」。
  //   用途：机器人问错人 / 被问的人不在 / 想"谁先看到谁答"。
  if (item.claimable && !item.claimed) {
    const claimLabel = '🙋 我来回答';
    rows.unshift({
      buttons: [{
        id: `${CLAIM_PREFIX}${item.qid}:${token}`,
        render_data: { label: claimLabel, visited_label: claimLabel, style: 1 },
        action: {
          type: 1,
          permission: { type: 2 },
          data: `${CLAIM_PREFIX}${item.qid}:${token}`,
          unsupport_tips: '按钮不可用时, 直接发 /答 A (或 /答 你的回答)',
        },
      }],
    });
  }
  return { content: { rows } };
}

/** 选项字母表(卡片正文用): `A. xxx` 一行一个, 列全 */
function optionsLines(opts: Array<{ label: string }>, from = 0): string[] {
  return opts.map((o, i) => `${LETTERS[i] ?? String(i + 1)}. ${String(o?.label ?? '')}`).slice(from);
}

/** 卡片/文字提示的正文 */
function promptOf(item: PendingItem, timeoutMs: number, forCard: boolean): string {
  const header = item.header ? `**${item.header}**\n\n` : '';
  const detail = item.detail ? `\n\n${item.detail}` : '';
  const seq = item.total > 1 ? `（第 ${item.index}/${item.total} 问）` : '';
  const ask = `${header}❓ **${item.question}**${seq}${detail}`;
  const list = optionsLines(item.opts).map((l) => `  ${l}`).join('\n');
  const point = forCard && item.opts.length <= CARD_MAX_OPTIONS
    ? `⏱ ${Math.ceil(timeoutMs / 1000)} 秒内点下方按钮回答：`
    : `⏱ ${Math.ceil(timeoutMs / 1000)} 秒内回答：`;
  const tips = [
    `按钮点不动或想自己打字时, 用斜杠回答: \`/答 ${LETTERS[0] ?? 'A'}\`` + (item.multiSelect ? '（多选 `/答 A,C`）' : ''),
    item.total > 1 ? `多个提问并存用 \`/答 #${item.index} 你的选择\`` : '',
    item.opts.length > CARD_MAX_OPTIONS ? `选项超过 ${CARD_MAX_OPTIONS} 个, 第 ${CARD_MAX_OPTIONS + 1} 个起请用 \`/答 字母\` 选择` : '',
    '想自由回答: `/答 你的话`（原样转给 AI）',
  ].filter(Boolean).join('；');
  return `${ask}\n\n${list}\n\n${point}\n（${tips}）`;
}

/** 昵称 → openid 的解析器(群聊用; 数据源=本地群成员台账) */
export interface QuestionOwnerResolver {
  /** 昵称 → openid(命中才返回; 同名取最近发言者, 包含匹配要求唯一) */
  byName(name: string): string | null;
  /** 整段文本里唯一命中的成员昵称 → openid(没有任何 <@...> 标注时兜底用) */
  byText(text: string): string | null;
}

/** 取出文本里所有 `<@内容>` 标注(内容可能是 openid, 也可能是昵称) */
function atTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text || '').matchAll(/<@([^<>\n]{1,64})>/g)) {
    const v = String(m[1] ?? '').trim();
    if (v) out.push(v);
  }
  return out;
}

/** 32 位字母数字 = openid(QQ 的 member_openid/user_openid 形状) */
function looksLikeOpenid(s: string): boolean {
  return /^[0-9A-Za-z]{32}$/.test(s);
}

/**
 * 解析"这张提问卡片该谁回答"(按钮 permission.type=0 + specify_user_ids 显式指定人):
 *  ① 本次提问的 question/header 文本里的 `<@openid>` **或 `<@昵称>`** —— 显式指定(优先级最高)
 *  ①b 文本里没写任何 `<@...>` 标注、但**唯一**命中某位群成员的昵称 → 也算点名
 *  ② 最近真人 user/message 文本里的 `<@openid>`/`<@昵称>`: 取最后一个(提问目标句末; 前面常是 @bot 自己)
 *  ③ 消息发送者壳 [昵称 (openid)]
 *  ④ 兜底: 会话发起者 record.senderId
 * 注: 群投票/谁都能点可走 permission.type:2(owner 为空时 optionsKeyboard 已处理)。
 * 2026-09-24 增强(主人需求): 支持**昵称匹配** —— 不必手打 32 位 openid, 写 `<@某群友昵称>` 即可。
 */
function resolveCardOwner(
  record: { senderId: string; agent?: { session?: { events?: readonly unknown[] } } },
  inlineText?: string,
  resolver?: QuestionOwnerResolver,
): string {
  /** 标注内容 → openid: 是 openid 直接用; 是昵称则走台账匹配 */
  const fromToken = (tok: string): string | null => {
    if (looksLikeOpenid(tok)) return tok;
    return resolver?.byName(tok) ?? null;
  };
  // ① 提问文本里的点名 = 显式指定(id 或昵称写在 header/question 都算)
  if (inlineText) {
    const toks = atTokens(inlineText);
    for (let i = toks.length - 1; i >= 0; i--) {
      const hit = fromToken(toks[i]!);
      if (hit) return hit;
    }
    // ①b 没写 <@...> 标注时: 文本里唯一出现的成员昵称也算点名
    if (toks.length === 0) {
      const hit = resolver?.byText(inlineText) ?? null;
      if (hit) return hit;
    }
  }
  try {
    const evs = record.agent?.session?.events;
    if (Array.isArray(evs) && evs.length > 0) {
      const from = Math.max(0, evs.length - 60);
      for (let i = evs.length - 1; i >= from; i--) {
        const ev = evs[i] as { type?: string; data?: Record<string, unknown> } | undefined;
        if (!ev || ev.type !== 'user/message') continue;
        const data = ev.data && typeof ev.data === 'object' ? ev.data : (ev as unknown as Record<string, unknown>);
        const src = data.source as { kind?: string } | undefined;
        if (src && src.kind === 'plugin') continue;
        const content = Array.isArray(data.content) ? (data.content as Array<{ text?: string }>) : [];
        const text = content.map((b) => (b?.text ?? '')).join('\n');
        if (!text) continue;
        // ② 最近真人消息点名(取最后一个 @): openid 或昵称都认
        const toks = atTokens(text);
        for (let k = toks.length - 1; k >= 0; k--) {
          const hit = fromToken(toks[k]!);
          if (hit) return hit;
        }
        // ③ 消息发送者壳
        const shell = text.match(/\[\[^\]\n]*?\s*\(([A-Za-z0-9]{32})\)\]/);
        if (shell) return shell[1]!;
        return record.senderId;
      }
    }
  } catch { /* 解析失败回落 */ }
  return record.senderId;
}

/** 文字兜底的解析结果: 命中选项(可能多选) 或 自由文本 */
export type ParsedQuestionAnswer =
  | { kind: 'option'; indices: number[]; labels: string[] }
  | { kind: 'custom'; text: string };

/**
 * 把一条**文字回复**解析成对某问题的答案(2026-09-11 主人定的文字兜底):
 *   - 先去口语前缀(`选`/`选择`/`选：` 等);
 *   - 用 `,`/`，`/空格/`、`/`;` 切 token;
 *   - token 命中规则: ①单个字母 A-Z → 第 N 个选项 ②纯数字 1-26 → 第 N 个选项
 *     ③与该问题某个选项 label 完全相同(去空白/忽略大小写) → 那个选项;
 *   - 所有 token 都命中 → option(非多选时只取第一个);
 *   - 否则(含"自定义:xxx"这类) → custom, 原文透传给 AI。
 * @returns null = 这条不该当成答案(空文本)
 */
export function parseQuestionAnswer(raw: string, item: Pick<PendingItem, 'opts' | 'multiSelect'>): ParsedQuestionAnswer | null {
  const text = String(raw ?? '').trim();
  if (text === '') return null;

  const body = text.replace(/^(选|选择|选择：|选：|答|答案[:：]?)\s*/u, '').trim();
  const tokens = body.split(/[,，、;；\s]+/u).filter((t) => t !== '');
  if (tokens.length === 0) return null;

  const idxOf = (tok: string): number | null => {
    const up = tok.toUpperCase();
    // ① 单个字母: A=0, B=1 ...
    if (/^[A-Z]$/u.test(up)) {
      const i = LETTERS.indexOf(up);
      return i >= 0 && i < item.opts.length ? i : null;
    }
    // ② 纯数字: 1=0, 2=1 ...
    if (/^\d{1,2}$/u.test(tok)) {
      const n = Number(tok);
      return n >= 1 && n <= item.opts.length ? n - 1 : null;
    }
    // ③ 与选项文字完全相同
    const norm = (s: string): string => s.replace(/\s+/gu, '').toLowerCase();
    const i = item.opts.findIndex((o) => norm(String(o?.label ?? '')) === norm(tok));
    return i >= 0 ? i : null;
  };

  const indices: number[] = [];
  for (const tok of tokens) {
    const i = idxOf(tok);
    if (i === null) return { kind: 'custom', text }; // 有任何一个 token 不命中 → 整条当自由文本
    if (!indices.includes(i)) indices.push(i);
  }
  if (indices.length === 0) return { kind: 'custom', text };
  const picked = item.multiSelect ? indices : [indices[0]!];
  return { kind: 'option', indices: picked, labels: picked.map((i) => String(item.opts[i]?.label ?? '')) };
}

export class QqUserQuestionsController {
  private readonly pending = new Map<string, PendingItem>();

  constructor(
    private readonly manager: SessionManager,
    private readonly sender: QQBotSender,
    private readonly logger: Logger,
    private readonly timeoutMsProvider: () => number,
    /**
     * 提问工作方式(现读, live 热更): 'async'=后台提问(默认, 不卡回合) / 'blocking'=旧行为(工具阻塞等答案)。
     * 见 config.questionsMode 与 docs §11.29。
     */
    private readonly modeProvider: () => 'async' | 'blocking' = () => 'async',
  ) {}

  /**
   * 群成员昵称 → openid 解析器(2026-09-24 主人需求: 提问卡片支持"昵称匹配"指定收件人)。
   * 数据源 = 本地群成员台账 `{dataRoot}/表情包/group-members.jsonl`(在群里发过言/申请过入群的人);
   * 群聊之外、或台账里查不到 → 返回 undefined, 调用方按老逻辑回落(会话发起者)。
   * ⚠️ 从没发过言的人查不到(官方群成员列表接口未开放) —— 那种情况请照旧写 <@32位openid>。
   */
  private ownerResolverFor(record: { replyTarget?: { scope?: string; targetId?: string } }): QuestionOwnerResolver | undefined {
    try {
      const scope = record?.replyTarget?.scope;
      const gid = scope === 'group' ? String(record?.replyTarget?.targetId ?? '') : '';
      if (!gid) return undefined;
      const members = readGroupMembers(join(this.manager.dataRoot, '表情包'), gid);
      if (!Array.isArray(members) || members.length === 0) return undefined;
      const byName = (name: string): string | null => {
        const key = String(name ?? '').trim().replace(/^[＠@]+/u, '').trim();
        if (!key) return null;
        // 精确同名: 台账按最近发言倒序 → 第一个就是最近说话的那位
        const exact = members.filter((m) => m.name === key);
        const f = exact[0];
        if (f && f.mid) return f.mid;
        // 包含匹配: 必须唯一命中, 否则宁可不指定(避免绑错人)
        const part = members.filter((m) => typeof m.name === 'string' && m.name.length > 0 && m.name.includes(key));
        const p = part[0];
        if (part.length === 1 && p && p.mid) return p.mid;
        return null;
      };
      const byText = (text: string): string | null => {
        const hits = new Set<string>();
        for (const m of members) {
          const nm = String(m.name ?? '').trim();
          if (nm.length < 2 || !m.mid) continue;
          if (String(text ?? '').includes(nm)) hits.add(m.mid);
        }
        const arr = [...hits];
        return arr.length === 1 ? arr[0]! : null;
      };
      return { byName, byText };
    } catch { return undefined; }
  }

  /**
   * 宿主 user-questions/request 处理器。只 claim"会话可定位 + 每个问题都带选项"的场景;
   * 其余(无会话/无选项/选项过多/问题过多) → next() 交回宿主(Web UI 或原样)。
   * 多问题时依次发卡, 回答用 `#2 B` 指定; 全部答完或超时后一起回给宿主。
   */
  async request(
    req: { questions?: Array<Record<string, unknown>>; agent?: unknown; signal?: AbortSignal },
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const record = this.manager.findByAgent(req.agent as never);
    if (!record) return next();
    const questions = Array.isArray(req.questions) ? req.questions : [];
    if (questions.length === 0 || questions.length > MAX_QUESTIONS) return next();

    const parsed = questions.map((q) => {
      const raw = q as {
        id?: string; question?: string; detail?: string; header?: string;
        options?: Array<{ label: string; description?: string }>; multiSelect?: boolean;
      };
      return {
        qid: String(raw?.id ?? ''),
        question: String(raw?.question ?? ''),
        header: String(raw?.header ?? ''),
        detail: String(raw?.detail ?? ''),
        multiSelect: raw?.multiSelect === true,
        opts: (Array.isArray(raw?.options) ? raw.options : []).map((o) => ({ label: String(o?.label ?? '') })),
      };
    });
    // 只有"每个问题都有选项且不超过上限"才接管 —— 否则答案形状与宿主期望不符, 交回 Web UI 更稳
    if (parsed.some((q) => q.qid === '' || q.opts.length === 0 || q.opts.length > MAX_OPTIONS)) return next();

    const timeoutMs = Math.max(5000, this.timeoutMsProvider() || 120000);
    const token = Math.random().toString(36).slice(2, 8);
    const peerKey = `${record.replyTarget.scope}:${record.replyTarget.targetId}`;
    // 卡片可点人: 从最近真人消息解析——被点名的最后一人(@)优先, 其次消息发送者壳, 回落会话发起者
    // (修复: 主人让 bot 问群友时, 卡片应绑被问者而不是 bot/主人, 否则被问者点卡片=无权限)
    const owner = resolveCardOwner(record, parsed.map((q) => `${q.header} ${q.question}`).join(' '), this.ownerResolverFor(record));
    this.logger.info(`QQ question owner resolved: ${owner ? owner.slice(0, 8) + '…' : '(全员可点)'}`);

    // ★ 2026-10-07 主人定: 默认走"后台提问"(async) —— 卡片发出即把占位答案交回宿主, 她的回合不被卡住;
    //   真正的答案回来后由 deliverAnswers 当"回执消息"投递回会话(她忙插话 / 空闲唤醒)。'blocking'=旧行为。
    const isAsync = this.modeProvider() === 'async';
    // 先注册 pending(防按钮回调/文字回复先于 Promise 建立到达)
    let resolver: (v: unknown) => void = () => undefined;
    const answer = new Promise<unknown>((resolve) => { resolver = resolve; });
    const group: PendingGroup = {
      qids: parsed.map((q) => q.qid),
      answers: new Map(),
      resolve: resolver,
      timer: setTimeout(() => this.finishGroup(group), timeoutMs),
      keys: [],
      signal: req.signal,
      isAsync,
      record: record as unknown as PendingGroup['record'],
    };
    if (req.signal) {
      group.onAbort = () => this.finishGroup(group);
      try { req.signal.addEventListener('abort', group.onAbort, { once: true }); } catch { /* ignore */ }
    }

    const items: PendingItem[] = parsed.map((q, i) => {
      const key = `${q.qid}:${token}`;
      const item: PendingItem = {
        qid: q.qid, question: q.question, header: q.header, detail: q.detail,
        opts: q.opts, ownerId: owner, multiSelect: q.multiSelect,
        peerKey, group, index: i + 1, total: parsed.length,
        // ── 抢答按钮（2026-09-30 主人定）──────────────────────────
        //   卡片上多一个「🙋 我来回答」：**全员可点、只能抢一次**，
        //   抢到即把回答权转移给他（ownerId 改写 + 补发绑他的卡片）。
        //   默认开启：解决"机器人问错人 / 被问的人不在 / 谁先看到谁答"。
        //   ⚠️ 单问题时才加（多问题时抢答语义混乱：一张卡 5 个按钮上限，
        //      抢答按钮要占一行，问题多了会挤掉选项）。
        claimable: parsed.length === 1,
        deadlineAt: Date.now() + timeoutMs,
      };
      group.keys.push(key);
      this.pending.set(key, item);
      return item;
    });
    group.items = items; // 后台档组装回执文案要用(question/header)

    // 依次发卡(多问题 = 多张卡, 各自带序号与字母表)
    for (const item of items) {
      try {
        await this.sender.sendMarkdownWithKeyboard(record.replyTarget, promptOf(item, timeoutMs, true), optionsKeyboard(item, token, owner));
        this.logger.info(`QQ question sent: qid=${item.qid} opts=${item.opts.length} (${item.index}/${item.total})`);
      } catch (err) {
        this.logger.warn(`QQ question card failed: ${err instanceof Error ? err.message : String(err)}`);
        // 卡片不可用 → 发纯文字选项清单; **保留 pending**(文字兜底能收答案, 不再像以前那样直接放弃)
        try {
          await this.sender.sendMarkdown(record.replyTarget, promptOf(item, timeoutMs, false));
        } catch (err2) {
          // 连文字都发不出去(限频/网络) ≠ 提问结束: 保留 pending 供 Web 浮层兜底
          this.logger.error(`QQ question fallback text failed: ${err2 instanceof Error ? err2.message : String(err2)} (qid=${item.qid}, web 浮层可兜底)`);
        }
      }
    }
    if (isAsync) {
      // 后台提问: 立刻把"占位答案"交回宿主 —— 宿主 ask_user_question 工具随即返回,
      //   她的回合不被挂住, 可以继续和群友聊天/干活。
      // ⚠️ 占位文案必须写明"答案稍后自动送达 + 别重复发问", 否则她可能以为没人理而反复发卡。
      this.logger.info(`QQ question sent(后台 async): qids=${items.map((i) => i.qid).join(',')} 等待 ${Math.round(timeoutMs / 1000)}s`);
      return {
        answers: parsed.map((q) => ({
          id: q.qid,
          selected: [] as string[],
          custom: '（已发出提问卡片，正在等对方作答；答案稍后会自动送回来，你可以先继续手上的事，不要重复发问）',
        })),
      };
    }
    return answer;
  }

  /**
   * 入站文字兜底(2026-09-11 主人需求): 待答提问期间, 发起者发来的文字也算回答 ——
   *   命中选项(字母/序号/选项原文, 支持多选) → 选中结算;
   *   其它文字 → 作为自由回答(custom)透传给 AI。
   * 非本会话/非发起者/斜杠命令 → 不消费(交回正常入站链)。
   * @returns true = 消息已被提问逻辑消费(调用方不要再派发给 agent)
   */
  async handleInbound(
    msg: { kind?: string; senderId?: string; content?: string; groupOpenid?: string },
    replyTarget: ReplyTarget,
  ): Promise<boolean> {
    const scope: 'c2c' | 'group' = msg.kind === 'group' ? 'group' : 'c2c';
    const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId ?? '') : (msg.senderId ?? '');
    const peerKey = `${scope}:${peerId}`;
    const text = String(msg.content ?? '').trim();
    if (text === '' || text.startsWith('/')) return false;

    const items = [...this.pending.values()].filter((p) => p.peerKey === peerKey);
    if (items.length === 0) return false;

    // 只认"卡片指定的那个人"的回答(与按钮回调同一判据); 别人说话照常进 agent
    const sender = String(msg.senderId ?? '');
    const owner = items[0]!.ownerId;
    if (owner && sender && sender !== owner) return false;

    // 目标是哪一问: `#2 xxx` 指定第 2 问; 否则取序号最小的未答问题
    let target: PendingItem | undefined;
    let body = text;
    const seq = /^#\s*(\d{1,2})\s*([\s\S]*)$/u.exec(text);
    if (seq) {
      const want = Number(seq[1]);
      body = String(seq[2] ?? '').trim();
      target = items.find((p) => p.index === want);
      if (!target) return false;
      if (body === '') return false;
    } else {
      target = items.slice().sort((a, b) => a.index - b.index)[0];
    }
    if (!target) return false;

    const parsedAnswer = parseQuestionAnswer(body, target);
    if (!parsedAnswer) return false;

    if (parsedAnswer.kind === 'option') {
      await this.receipt(replyTarget, `已选择：${parsedAnswer.labels.join(' / ')}`);
      this.settleAnswer(target, { selected: parsedAnswer.labels });
    } else {
      await this.receipt(replyTarget, `已回复：${parsedAnswer.text}`);
      this.settleAnswer(target, { selected: [], custom: parsedAnswer.text });
    }
    return true;
  }

  /**
   * 斜杠命令兜底入口(`/答` / `/ans`, 2026-09-11 主人定): 与 handleInbound 同一套解析与结算,
   * 但**不依赖消息在链上的位置** —— 命令层在 @门控之后、延迟聚合之上就执行完并 ctx.stop。
   * 为什么必须有它: 裸文字作答在群里被 mentionGate 拦下, 私聊/群消息又被 debounce 聚合层
   * 直接吞进 agent(那一层自己调 transport.handleInbound, 绕过 message 处理器), 实测无效;
   * 而以 `/` 开头的消息被 debounce 直放行(见 gateway/debounce.ts), 命令层随即处理。
   * @returns ok=false 时 msg 是给用户看的提示(命令层原样回执)
   */
  answerByText(args: { scope: 'c2c' | 'group'; peerId: string; senderId?: string; text: string }): { ok: boolean; msg: string } {
    const peerKey = `${args.scope}:${args.peerId}`;
    const raw = String(args.text ?? '').trim();
    if (raw === '') return { ok: false, msg: '没看到回答内容' };

    const items = [...this.pending.values()].filter((p) => p.peerKey === peerKey);
    if (items.length === 0) return { ok: false, msg: '当前没有待回答的提问(可能已超时或被撤回)。' };

    // 只认卡片指定的那个人(与按钮回调、文字兜底同一判据)
    const sender = String(args.senderId ?? '');
    const owner = items[0]!.ownerId;
    if (owner && sender && sender !== owner) return { ok: false, msg: '这个问题不是问你的哦~' };

    // `#2 xxx` 指定第 2 问; 否则取序号最小的未答项
    let target: PendingItem | undefined;
    let body = raw;
    const seq = /^#\s*(\d{1,2})\s*([\s\S]*)$/u.exec(raw);
    if (seq) {
      const want = Number(seq[1]);
      body = String(seq[2] ?? '').trim();
      target = items.find((p) => p.index === want);
      if (!target) return { ok: false, msg: `没有第 ${want} 个待答提问(当前共 ${items.length} 个)。` };
      if (body === '') return { ok: false, msg: '请在 #N 后面写上你的选择' };
    } else {
      target = items.slice().sort((a, b) => a.index - b.index)[0];
    }
    if (!target) return { ok: false, msg: '当前没有待回答的提问。' };

    const parsedAnswer = parseQuestionAnswer(body, target);
    if (!parsedAnswer) return { ok: false, msg: '没看到回答内容' };
    const head = target.total > 1 ? `第 ${target.index}/${target.total} 问：` : '';
    if (parsedAnswer.kind === 'option') {
      this.settleAnswer(target, { selected: parsedAnswer.labels });
      return { ok: true, msg: `${head}已选择：${parsedAnswer.labels.join(' / ')}` };
    }
    this.settleAnswer(target, { selected: [], custom: parsedAnswer.text });
    return { ok: true, msg: `${head}已回复：${parsedAnswer.text}` };
  }

  /** interaction 回调: data = q:<qid>:<token>:<idx> → 按选项 label 组 answer; 仅发起者本人可答 */
  async handleInteraction(event: unknown, replyTarget: ReplyTarget): Promise<boolean> {
    const e = event as {
      data?: { type?: number; resolved?: { button_data?: string } };
      group_member_openid?: string;
      user_openid?: string;
    };
    if (e?.data?.type !== 11) return false;
    const data = e.data.resolved?.button_data;
    if (!data || (!data.startsWith(BTN_PREFIX) && !data.startsWith(CLAIM_PREFIX))) return false;

    /** 点击者 openid（群聊看 group_member_openid，私聊看 user_openid） */
    const presser = e.group_member_openid ?? e.user_openid ?? '';

    // ── 抢答分支（2026-09-30 主人定）：全员可点、先到先得，点击即转移回答权 ──
    //   带 `claimable` 的问题会多一个「🙋 我来回答」按钮（permission type=2 全员可点）。
    //   第一个人点 → 改写 item.ownerId 为他（此后选项回调与文字兜底都按新 owner 判），
    //   第二个人再点 → 只收到「已被 XXX 抢到」，不会误答。
    if (data.startsWith(CLAIM_PREFIX)) {
      const cm = /^qc:([^:]+):([^:]+)$/.exec(data);
      if (!cm) return false;
      const item = this.pending.get(`${cm[1]!}:${cm[2]!}`);
      if (!item) {
        try { this.sender.sendMarkdown(replyTarget, '这个问题已经结束啦~').catch(() => undefined); } catch { /* ignore */ }
        return true;
      }
      if (!presser) return true;
      // 白名单（groupAdmin.owners，通常是主人）拥有【无限抢答权】：
      //   不受"只能抢一次"限制，任何时候都能把回答权拿回来（含从别的普通人手里拿回）。
      //   普通人则严格"先到先得、抢到即锁"。
      //   —— 2026-09-30 主人定。
      let isAdmin = false;
      try { isAdmin = this.manager.adminOwners().includes(presser); } catch { isAdmin = false; }
      // 已被别人抢走 → 普通人明确拒绝；白名单直接夺回
      if (item.claimed && item.ownerId && item.ownerId !== presser && !isAdmin) {
        try {
          this.sender.sendMarkdown(replyTarget, `手慢了～已经被 <@${item.ownerId}> 抢到啦`).catch(() => undefined);
        } catch { /* ignore */ }
        return true;
      }
      // 自己已经是 owner（重复点）→ 友好提示
      if (item.ownerId === presser) {
        try {
          this.sender.sendMarkdown(replyTarget, '你已经抢到啦，直接点下面的选项，或发 /答 A').catch(() => undefined);
        } catch { /* ignore */ }
        return true;
      }
      const tookOver = item.claimed && item.ownerId && item.ownerId !== presser;   // 白名单夺回
      // ★ 权限转移：改写 ownerId + 标记已抢；原 owner 与其他人此后都会被拒
      item.ownerId = presser;
      item.claimed = true;
      item.claimedBy = presser;
      this.logger.info(`QQ question claimed: qid=${item.qid} by=${presser.slice(0, 8)}…${isAdmin ? ' (admin)' : ''}${tookOver ? ' 夺回' : ''}`);
      try {
        await this.sender.sendMarkdown(
          replyTarget,
          tookOver
            ? `👑 <@${presser}>（主人）接管了回答权，请点下面的选项，或直接发 /答 A`
            : `✅ <@${presser}> 抢到了回答权，请点下面的选项，或直接发 /答 A（也可自由回答）`,
        );
      } catch { /* ignore */ }
      // 选项按钮的 permission 是"发送时烘焙"的、已发的卡片改不了 →
      // 必须补发一张绑新 owner 的卡片，抢到的人才能点选项。
      // ★ 2026-10-16 修复(私聊兜底结构性失效): 这里原来用交互事件推出的 replyTarget
      //   (只有 scope/targetId, **没有 msgId**) → 等于走"主动消息"通道, c2c 下受主动消息
      //   限制/被拒; 而 sendMarkdownWithKeyboard 失败是直接抛、没有 sendMarkdown 那套降级链,
      //   外层又是空 catch → 表现就是"点抢答只回一句抢到了, 永远不发新卡"。
      //   改用发起提问时记录的 record.replyTarget(带 msgId, 被动回复通道)。
      const reCardTarget = item.group.record?.replyTarget ?? replyTarget;
      try {
        const left = Math.max(5000, item.deadlineAt - Date.now());
        await this.sender.sendMarkdownWithKeyboard(
          reCardTarget,
          promptOf(item, left, true),
          optionsKeyboard(item, cm[2]!, item.ownerId),
        );
      } catch (err) {
        // 不再静默: 补发失败必须留痕(私聊主动消息受限时这里会响)
        this.logger.warn(`QQ question re-card failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }

    const m = /^q:([^:]+):([^:]+):(\d+)$/.exec(data);
    if (!m) return false;
    const qid = m[1]!;
    const token = m[2]!;
    const idx = Number(m[3]);
    const key = `${qid}:${token}`;
    const item = this.pending.get(key);
    if (!item) return false;

    // 防别人代答: 必须等于【当前 owner】—— owner 可能已被"抢答"改写，
    // 所以这里必须重新读 item.ownerId，不能用发送卡片时的快照。
    if (item.ownerId && presser && presser !== item.ownerId) {
      try { this.sender.sendMarkdown(replyTarget, '这个问题不是问你的哦~').catch(() => undefined); } catch { /* ignore */ }
      return true;
    }

    const label = item.opts[idx]?.label ?? '';
    if (!label) return false;
    try { this.sender.sendMarkdown(replyTarget, `已选择：${label}`).catch(() => undefined); } catch { /* ignore */ }
    this.settleAnswer(item, { selected: [label] });
    return true;
  }

  /** 回执(QQ 直发, 失败不影响结算) */
  private async receipt(replyTarget: ReplyTarget, text: string): Promise<void> {
    try { await this.sender.sendMarkdown(replyTarget, text); } catch { /* ignore */ }
  }

  /** 结算单个问题: 写进组, 该批全部答完 → 一次交回宿主 */
  private settleAnswer(item: PendingItem, ans: { selected: string[]; custom?: string }): void {
    for (const [k, v] of this.pending) {
      if (v === item) {
        this.pending.delete(k);
        break;
      }
    }
    const group = item.group;
    group.answers.set(item.qid, ans);
    if (group.answers.size >= group.qids.length) this.finishGroup(group);
  }

  /**
   * 该批提问收尾: 清定时器/监听 + 清理未答项的 pending + 按 qid 顺序组装宿主 answer。
   * 超时/取消时未答的问题给空答案(selected: []) —— 与宿主原语义一致。
   */
  private finishGroup(group: PendingGroup): void {
    clearTimeout(group.timer);
    if (group.signal && group.onAbort) {
      try { group.signal.removeEventListener('abort', group.onAbort); } catch { /* ignore */ }
    }
    for (const [k, v] of [...this.pending]) {
      if (v.group === group) this.pending.delete(k);
    }
    if (group.isAsync) {
      // 后台档: 宿主早就拿着占位答案往下走了 → 这里不再 resolve, 改成把真答案投递回会话
      this.deliverAnswers(group);
      return;
    }
    const answers = group.qids.map((qid) => {
      const a = group.answers.get(qid);
      if (!a) return { id: qid, selected: [] };
      return a.custom === undefined
        ? { id: qid, selected: a.selected }
        : { id: qid, selected: a.selected, custom: a.custom };
    });
    group.resolve({ answers });
  }

  /**
   * 后台提问的答案投递(2026-10-07 主人定: "ai 可以等 qq 返回结果，期间还可以继续和群友对话"):
   *   把答案组装成一条 "[提问卡片·回执]" 消息送回她的会话 ——
   *     · 她还在回合里(忙) → `agent.inject`(不唤醒, 排到下个轮次边界, 与 debounce 插话同款通道);
   *     · 她已经空闲/回合结束 → `agent.followup` **唤醒**她接着处理(主人原话: "忙时插话、空闲唤醒")。
   *   投递后刷新 `lastInboundAt` 并置 `turnActive`(与真人消息同语义, "适配主动"据此判断最近有人在说话)。
   * 投递失败只记日志, 不影响 QQ 侧回执与结算(答案不会丢在磁盘上, 但也不会重投 —— 保留 pending 语义)。
   */
  private deliverAnswers(group: PendingGroup): void {
    const rec = group.record;
    if (!rec) return;
    const qOf = (qid: string, i: number): string => {
      const it = (group.items ?? []).find((x) => x.qid === qid);
      return String(it?.header || it?.question || `问题${i + 1}`);
    };
    const lines = group.qids.map((qid, i) => {
      const a = group.answers.get(qid);
      const shown = !a
        ? '超时未答'
        : (a.custom !== undefined && a.custom !== ''
          ? a.custom
          : (a.selected.length > 0 ? a.selected.join(' / ') : '未选'));
      return `「${qOf(qid, i)}」→ ${shown}`;
    });
    const text = `[提问卡片·回执] 你之前发出的提问有结果了(后台送达)：\n${lines.join('\n')}`;
    const agent = rec.agent as { inject?: (m: unknown) => void; followup?: (m: unknown) => void } | undefined;
    if (!agent) {
      this.logger.warn('[qq-questions] 答案投递失败: 该会话 agent 已不可用');
      return;
    }
    let msg: unknown;
    try {
      msg = createUserMessage({ content: [{ type: 'text' as const, text }], source: { kind: 'user' as const } });
    } catch (err) {
      this.logger.warn(`[qq-questions] 回执消息构造失败: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      if (rec.turnActive === true && typeof agent.inject === 'function') {
        agent.inject(msg);
        this.logger.info('[qq-questions] 答案已投递(她正忙 → 插进当前回合)');
        return;
      }
      if (typeof agent.followup === 'function') {
        // 唤醒路径: 与真人入站同款(置 turnActive + 刷 lastInboundAt), outbound 的 turn/end 会复位
        rec.lastInboundAt = Date.now();
        rec.turnActive = true;
        agent.followup(msg);
        this.logger.info('[qq-questions] 答案已投递(她空闲 → 唤醒处理)');
        return;
      }
      if (typeof agent.inject === 'function') {
        agent.inject(msg);
        this.logger.info('[qq-questions] 答案已投递(inject 兜底, 不唤醒)');
        return;
      }
      this.logger.warn('[qq-questions] 答案投递失败: agent 既无 inject 也无 followup');
    } catch (err) {
      this.logger.warn(`[qq-questions] 答案投递异常: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Web 浮层拉取待办问题列表 */
  listPendingForWeb(): WebPendingQuestion[] {
    const out: WebPendingQuestion[] = [];
    for (const [key, p] of this.pending) {
      out.push({
        key,
        question: p.question,
        header: p.header,
        detail: p.detail,
        options: p.opts,
        deadlineAt: p.deadlineAt,
      });
    }
    return out.sort((a, b) => a.deadlineAt - b.deadlineAt);
  }

  /** Web 浮层点选项: key + 选项下标 → 与 QQ 按钮同源结算(先到先得) */
  decideByWeb(key: string, optIdx: number): { ok: boolean; msg: string } {
    const item = this.pending.get(key);
    if (!item) return { ok: false, msg: '该问题不存在或已过期' };
    const label = item.opts[optIdx]?.label;
    if (!label) return { ok: false, msg: '无效选项' };
    this.settleAnswer(item, { selected: [label] });
    return { ok: true, msg: `已选择：${label}` };
  }

  dispose(): void {
    for (const group of new Set([...this.pending.values()].map((p) => p.group))) {
      if (group.isAsync) {
        // 后台档: 占位答案早已交回宿主 → 卸载/热重载时只需清 pending, 不再往会话里投递(agent 可能已在销毁)
        clearTimeout(group.timer);
        for (const [k, v] of [...this.pending]) {
          if (v.group === group) this.pending.delete(k);
        }
        continue;
      }
      this.finishGroup(group);
    }
  }
}

// ── 按实例(ns)注册的提问控制器注册表 —— Web 提问浮层(settings-host 同源路由)经此读写 ──
const questionControllers = new Map<string, QqUserQuestionsController>();

export function registerQuestionController(ns: string, c: QqUserQuestionsController | undefined): void {
  if (c) questionControllers.set(ns, c);
  else questionControllers.delete(ns);
}

/** 汇总所有实例的待办提问 */
export function listAllPendingQuestionsWeb(): Array<WebPendingQuestion & { ns: string }> {
  const out: Array<WebPendingQuestion & { ns: string }> = [];
  for (const [ns, c] of questionControllers) {
    for (const p of c.listPendingForWeb()) out.push({ ns, ...p });
  }
  return out.sort((a, b) => a.deadlineAt - b.deadlineAt);
}

/** 跨实例结算提问 */
export function decideQuestionByWebAny(key: string, optIdx: number): { ok: boolean; ns?: string; msg: string } {
  for (const [ns, c] of questionControllers) {
    const r = c.decideByWeb(key, optIdx);
    if (r.ok) return { ok: true, ns, msg: r.msg };
  }
  return { ok: false, msg: '该问题不存在或已过期' };
}

/**
 * 斜杠命令(`/答` / `/ans`)的结算入口: 按实例 ns 找到提问控制器 → 把文字当答案结算(2026-09-11 主人定)。
 * 命令层在 @门控之后、延迟聚合之上执行, 是**唯一可靠**的用户文字作答通道
 * (裸文字在群里被 mentionGate 拦、私聊被 debounce 聚合层直接吞进 agent, 实测无效)。
 */
export function answerPendingQuestionByText(args: {
  ns?: string;
  scope: 'c2c' | 'group';
  peerId: string;
  senderId?: string;
  text: string;
}): { ok: boolean; msg: string } {
  const ns = String(args.ns ?? '').trim();
  const c = ns !== ''
    ? questionControllers.get(ns)
    : (questionControllers.size === 1 ? [...questionControllers.values()][0] : undefined);
  if (!c) return { ok: false, msg: `提问控制器未注册(ns=${ns || '(未指定)'})` };
  return c.answerByText({ scope: args.scope, peerId: args.peerId, senderId: args.senderId, text: args.text });
}
