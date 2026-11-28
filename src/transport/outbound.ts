/**
 * 出站处理器 — dsh session/event → QQ 消息发送
 *
 * 采用路由器模式：OutboundRouter 持有会话级状态（文本缓冲、工具调用记录），
 * 事件解析归一化在 events.ts，路由按事件类型分发到私有方法。
 */
import type { SessionManager, SessionRecord } from '../session/index.js';
import type { ImQQBotConfig } from '../config.js';
import type { Logger, ReplyTarget } from '../types.js';
import { resolve as resolvePath } from 'node:path';
import { OutboundBuffer, sendRichOutbound, type QQBotSender } from './outbound-buffer.js';
import { containsMedia, normalizeMediaMarkers, parseOutbound, collectRecallIndices, resolveSource } from './rich-media.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveMsgIndex } from './msg-index.js';
import { dataRootOf } from '../gateway/data-root.js';
import { noteThinking } from '../features/thinking-log.js';
import { noteTurnSignals, extractInnerText, applyTurnAttitude } from '../features/four-source.js';
import { getLastSender } from '../features/attitude.js';
import { formatToolResult, type ToolsRegistryLike, type ToolResultData } from './tool-presenter.js';

/**
 * `reply_gate` 的参数里是不是"判定静默"？
 *
 * 2026-09-14 主人报的现象：她调 `reply_gate{reply:false}` 决定吃瓜，
 *   紧接着又想"顺手把群友的喜好记一笔"（`people_memo`），
 *   但那批工具已经被闸门的 `agent.cancel` 连带中止了 → 聊天里刷出一串
 *   `❌ 工具 people_memo 执行失败 / Error: tool call aborted`。
 *
 * 那些 abort **不是故障，是有意行为**（关闸就是要停），不该当报错展示。
 * 所以这里只看参数、不解析结果 —— 闸门一关就把整个回合的工具展示全部静音。
 */
/**
 * 判定「这次 `reply_gate` 是不是真的把回合静默了」。
 *
 * @param scope 会话类型。**私聊必须传 'c2c'** —— 闸门在私聊恒放行（工具侧返回
 *   `stopped:false` 且**不会** `agent.cancel`），即"静默"根本没发生。
 *   这里要是照样返回 true，调用方会把 sessionKey 记进 `gateSilenced`，
 *   后续所有工具结果 / 回合结束通知全被静音，而模型其实正在开口
 *   （CodeRabbit 2026-11-28 · Major）。
 */
export function isGateSilence(rawArgs: string, scope?: string): boolean {
  try {
    const a = JSON.parse(String(rawArgs ?? '')) as { reply?: unknown; reason?: unknown };
    if (a?.reply !== false) return false;
    // 私聊：闸门恒开 ⇒ 没有"静默"这回事，别设出站静默标记
    if (scope === 'c2c') return false;
    // reason 与 reply 自相矛盾：模型想回却传了 false —— 不当静默，避免误吞后续 aborted 并让回合有机会继续。
    // ⚠️ 否定/已答语境（"不需要回复""已经有群友回答了"）不算矛盾，判定在 isContradictoryReplyFalse 里。
    if (isContradictoryReplyFalse(a?.reason)) return false;
    return true;
  } catch {
    return false;
  }
}
import { isContradictoryReplyFalse } from '../shared/reply-gate-reason.js';
import {
  parseEvent,
  extractTurnError,
  type ChunkEvent,
  type MessageEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type TurnEndEvent,
  type DeliverablesPresentedEvent,
  type RawSessionEvent,
  type StreamDelta,
} from './events.js';
import { DeliverablesDeliverer } from './deliverables.js';
import { feedReasoning, endReasoningTurn } from '../features/reasoning-bus.js';
import { rewriteLocalMarkdownImages, localMarkdownImagesToMediaMarkers, stripMarkdownImagesForPlainText, normalizeMarkdownImages } from '../features/md-media-rewrite.js';
import { botAvatarMarkdown } from '../features/bot-avatar.js';
import { stripOutboundArtifacts } from './strip-artifacts.js';
import { replaceFacePlaceholders } from './face-placeholder.js';
import { resolveTurnErrorMessage, resolveToolErrorMessage } from './turn-error.js';
import type { OutboundCtx } from '../features/ext-outbound.js';

/**
 * 「正文被平台判违规」已经告知过 AI 的回合标记（2026-11-07 主人要的功能）。
 * 键＝SessionRecord 对象，值＝该回合的 turnStartAt；同一回合只提醒一次，免得连发刷屏。
 */
const violationNotified = new WeakMap<object, number>();
/**
 * 正文被 QQ 判「内容违规」时，把这件事**立刻注入上下文**告诉 AI。
 *
 * 背景（主人实测 2026-11-07）：违规只进日志，AI 毫不知情，于是它会以为"已经说出去了"，
 * 继续基于那句话往下聊 —— 观感非常怪。
 * 注入用 `agent.inject`（不唤醒、下个 step 就能看到）；没有 inject 才退回 followup。
 */
export function buildViolationNotice(): string {
  // ★ 2026-11-07 主人定：提示语要给出**两条路**，别只逼它改内容（会死磕、越改越偏）：
  //   ① 换个说法（改内容）；② 换个发送方式（压缩 / 加密成压缩包 / 转成文件发）。
  //   也**不复述被拒内容** —— 写长文被拒时，把上千字再贴一遍纯属浪费 token。
  return '[系统通知] 刚才那段正文被 QQ 判「内容违规」，没发出去。别原样重试，两条路选一条：'
    + '① 换个说法（改内容）；② 换个发送方式（压缩 / 加密成压缩包 / 转成 txt 文件发）。';
}

export type { QQBotSender } from './outbound-buffer.js';
export type { ToolsRegistryLike } from './tool-presenter.js';

/** 出站处理器签名（注册到 ctx.on('session/event')） */
export type OutboundHandler = (session: SessionLike, event: RawSessionEvent) => void;

/** dsh Session 简化类型 */
export interface SessionLike {
  header: { id: string };
}

/** 工具调用记录（tool/call 建立，tool/result 消费） */
interface ToolCallRecord {
  name: string;
  args: string;
}

interface TurnBlockState {
  msgId: string;
  count: number;
  last: string;
}

/** 不展示给用户的轮次错误码（底层传输/网络错误，对用户无意义，且常被重试兜住） */
const SILENT_TURN_ERROR_CODES = new Set(['STREAM_CLOSED']);

/** 适配主动: 同一入站消息(msg_id)最多被动回复条数(QQ 回复同一消息上限 ~4-5 条), 超出自动转主动 */
const ADAPTIVE_MAX_PASSIVE = 5;
/** 适配主动: 「最近收到消息」判据(距上次入站活动 N ms 内才算; 过期旧 msg_id 不再被动引用, 防引用失效丢消息) */
const ADAPTIVE_RECENT_MS = 5 * 60_000;

/**
 * ★ 2026-11-24（社区补丁 Bemly/dsh-plug 指出，已吸收）：出站扩展的 caps 原来只有 `{ source, ...outboundExtCaps(_record, this.manager as never) }`，
 *   `ctx.appendWake` 从来没实现 —— 扩展 `annihilate()` 掉正文后**没有任何办法告知模型**，
 *   消息静默蒸发、turn/end 还报 completed（anti-similar-style 这类查重扩展因此形同虚设）。
 *
 *   这里用 `record.agent.followup` 实现 appendWake（与 caps.appendWake 同一条路：
 *   走正常回合，dsh 会先补人设，天然安全）。拿不到 agent 就返回 false，绝不抛。
 */
function outboundExtCaps(
  record: unknown,
  manager?: { groupAdmin?: unknown; mediaApi?: unknown },
): { appendWake: (text: string) => Promise<boolean>; appendSilent: (text: string) => Promise<boolean>; apiCall: (m: string, p: string, b?: unknown) => Promise<unknown> } {
  const agent = (record as { agent?: { followup?: (m: unknown) => void; inject?: (m: unknown) => void } } | undefined)?.agent;
  const ga = (manager?.groupAdmin ?? manager?.mediaApi) as
    | { apiCall?: (m: string, p: string, b?: unknown) => Promise<unknown> }
    | undefined;
  return {
    appendWake: async (text: string): Promise<boolean> => {
      const t = String(text ?? '').trim();
      if (!t) return false;
      if (!agent || typeof agent.followup !== 'function') return false;
      try {
        // createUserMessage 自带稳定 id（签名禁止外部传 id），不会让 dsh-session 校验 corrupt
        agent.followup(createUserMessage({ content: [{ type: 'text', text: t }], source: { kind: 'user' } }));
        return true;
      } catch {
        return false;
      }
    },
    // ★ 2026-11-24：静默注入（只落上下文、不唤醒）—— 与 caps.appendSilent 同义
    appendSilent: async (text: string): Promise<boolean> => {
      const s = String(text ?? '').trim();
      if (!s) return false;
      if (!agent || typeof agent.inject !== 'function') return false;
      try {
        agent.inject(createUserMessage({ content: [{ type: 'text', text: s }], source: { kind: 'user' } }));
        return true;
      } catch {
        return false;
      }
    },
    // ★ 2026-11-24：官方 API 调用（带 token 缓存由 apiCall 内部负责）
    // ★ CodeRabbit：这里必须叫 apiCall —— makeOutboundCtx 读的是 opts.apiCall（(method, path, body) 契约），
    //   叫 api 的话 ctx.api 永远是 undefined。
    apiCall: async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const p = String(path ?? '').trim();
      if (!p || !ga || typeof ga.apiCall !== 'function') return { ok: false, err: { code: 'NO_API', human: '拿不到 apiCall' } };
      try {
        return await ga.apiCall(String(method || 'GET'), p, body);
      } catch (err) {
        return { ok: false, err: { code: 'THROWN', human: err instanceof Error ? err.message : String(err) } };
      }
    },
  };
}

/**
 * 出站路由器：持有会话级状态，按事件类型分发到处理器
 */
class OutboundRouter {
  private readonly buffers = new Map<string, OutboundBuffer>();
  private readonly pendingSends = new Map<string, Set<Promise<void>>>();

  /** agentId(sessionId) → 当前正在流的 attemptId（LLM 重试会换 attempt） */
  private readonly streamAttempt = new Map<string, string>();
  /** 本回合是否产出过正文增量（turn/end 判断"有没有正文"用） */
  private readonly streamSawText = new Set<string>();

  /**
   * 消费 `agent/assistant-stream` 的瞬态帧（2026-10-20 对齐上游 c8b9158）。
   * · attempt-start：新 attempt → 丢掉上一 attempt 已流出的内容（重试不该出第二条）
   * · text-delta：增量交给该会话的出站缓冲，走 StreamingWriter
   */
  routeStreamFrame(agentId: string, delta: StreamDelta): void {
    if (delta.kind === 'reasoning-delta') {
      // ★ 2026-11-21（issue #78）：**带上本回合的投递目标**。
      //   原来只传 agentId ⇒ 扩展发消息时没有 target，只能回落到"最近活跃会话" ⇒ 并发会话必然串台。
      //   agentId 就是 DSH sessionId（见 streamAttempt 注释），可反查 QQ 会话记录。
      let reasonTarget: { scope: string; peerId: string } | undefined;
      try {
        const rec = this.manager.findBySessionId(agentId);
        if (rec?.scope && rec?.peerId) {
          reasonTarget = { scope: String(rec.scope), peerId: String(rec.peerId) };
        }
      } catch { /* 查不到就不带 target：由扩展自己决定要不要发 */ }
      feedReasoning(agentId, delta.text, reasonTarget);
      return;
    }
    const buffer = this.buffers.get(agentId);
    if (!buffer) return; // 不是 QQ 会话 / 本回合还没建缓冲
    const cur = this.streamAttempt.get(agentId);
    if (delta.kind === 'attempt-start') {
      if (cur === delta.attemptId) return;
      this.streamAttempt.set(agentId, delta.attemptId);
      const maybeAbort = (buffer as unknown as { abort?: () => void }).abort;
      if (typeof maybeAbort === 'function') maybeAbort.call(buffer);
      return;
    }
    if (cur !== undefined && cur !== delta.attemptId) return; // 旧 attempt 的尾帧丢弃
    this.streamSawText.add(agentId);
    if (delta.text) buffer.append(delta.text);
  }

  private readonly toolCalls = new Map<string, ToolCallRecord>();
  /** 适配主动状态: sessionKey → 当前入站 msg_id 及已被动回复条数 */
  private readonly adaptiveState = new Map<string, { msgId?: string; passiveCount: number }>();
  /** passive 收尾(2026-09-10 主人定 A 方案): **同一个 msg_id 下**已发出的正文块计数 + 最后一块文本。
   *  ⚠️ 必须按 msgId 分组: QQ 的被动回复 5 条上限是**按 msg_id 计**的, 群友中途发言会让
   *  record.replyTarget 换成新 msgId、配额随之重置 —— 那时后面的块本来就送得到, 不该再补发。 */
  private readonly turnBlocks = new Map<string, TurnBlockState>();
  /** 详细主动(detail, 2026-09-11 主人加): sessionKey → 聚合中的工具调用提示 */
  private readonly toolNotices = new Map<string, { record: SessionRecord; lines: string[]; timer: ReturnType<typeof setTimeout> }>();
  /** 详细主动: 工具调用提示的聚合窗口(ms) —— 一个回合连着调 10 个工具也只推一条, 防刷屏 */
  private static readonly TOOL_NOTICE_WINDOW_MS = 1200;
  /** 详细主动: 单条工具提示最多列几个工具(其余折叠成"等 N 个") */
  private static readonly TOOL_NOTICE_MAX = 8;
  /**
   * 本回合工具调用参数里的**中文内心话**（sessionKey → 文本数组）。
   *
   * 2026-09-14 主人口径："**工具里的判断也是思考里的判断，没有给群友看到的都算是内心活动**"。
   * 用途：并入四源标量的"内心倾向"判定（有些实例没有 reasoning 块，但它 `reply_gate` 的
   * reason 里写着真实判断，白丢可惜）。assistant/message 用完即清，turn/end 兜底清。
   */
  private readonly innerToolText = new Map<string, string[]>();
  /**
   * 本回合已被回复闸门静默的会话（sessionKey）。
   *   闸门一关 → `agent.cancel` 会连带中止本回合剩余的工具调用，
   *   那些 "aborted" 是**有意行为**，一律不展示（否则聊天里刷一串假报错）。
   */
  private readonly gateSilenced = new Set<string>();
  /**
   * 回合级累积 —— 好感度**按回合结算**（2026-09-14 修）。
   *
   * 为什么不能在 `assistant/message` 里逐条算：
   *   · 一个回合常有两三步（step1 思考+调工具 → step2 思考+出正文），
   *     按步算会把同一份内心**重复加减**（实测 45 分钟里一个人就攒到 83 次"事件"）；
   *   · 中间步`replyText`是空的 → `replyChars = 0` 落进"又烦又冷(重罚)"分支，
   *     明明还没说话就先扣一笔。
   * 所以这里只**攒**（思考 / 工具中文 / 正文 / 这一轮在跟谁说话），
   * 到 `turn/end` 一次性交给 `applyTurnAttitude` 结算。
   */
  private readonly turnAcc = new Map<string, {
    scope: string;
    targetId: string;
    think: string[];
    tool: string[];
    reply: string[];
    senderId?: string;
    senderName?: string;
    userEmo?: string;
  }>();

  /** 交付物投递器（readonly，构造时建一次） */
  private readonly deliverables: DeliverablesDeliverer;
  /**
   * 本回合已由 present 直发的文件（sessionKey → 规范化路径集合）。
   * 用途：模型常"既 present 又在正文写 [MEDIA:file|同一路径]"，若不拦会发两遍（2026-10-27）。
   * turn/end 清空（deliverables/presented 先于 turn/end 到达，时序天然安全）。
   */
  private readonly deliveredFiles = new Map<string, Set<string>>();

  public constructor(
    private readonly manager: SessionManager,
    private readonly bot: QQBotSender,
    private readonly config: ImQQBotConfig,
    private readonly logger: Logger,
    private readonly toolsRegistry: ToolsRegistryLike | undefined,
  ) {
    // present 声明的交付物投递器（2026-10-27）：宿主在 turn/end 前发 deliverables/presented
    this.deliverables = new DeliverablesDeliverer(bot, config, logger, (r) => this.resolveTarget(r));
  }

  /** 出站目标(每次实际发送前逐条调用, [RECALL] 除外):
   *  passive → 一律带 msg_id 回复(其余行为不变; 唯一例外: 回合主回复正文块>5 时
   *   第 6 块起转主动, 见 chunkTargetFn——2026-09-10 主人定);
   *  adaptive(默认)/active → 智能: 最近 5 分钟内收到过消息
   *  (lastActivity 新鲜)且同一条入站消息(msg_id)回复未超过 ADAPTIVE_MAX_PASSIVE 条 → 带 msg_id
   *  被动回复(有引用感); 超出/无近期入站(定时推送等) → 自动去 msg_id 转主动(防 QQ 吞/引用失效)。
   *  新入站消息(msg_id 变化)自动重置被动配额。 */
  private resolveTarget(record: SessionRecord): ReplyTarget {
    const rt = record.replyTarget;
    const mode = this.config.outboundMode || 'adaptive';
    if (mode === 'passive') return rt;
    if (!rt.msgId) return { scope: rt.scope, targetId: rt.targetId };
    // 仅真实入站(QQ 收到消息)后 5 分钟内算「最近收到消息」; 定时注入不刷新 lastInboundAt → 直接主动
    const recent = Date.now() - (record.lastInboundAt || 0) <= ADAPTIVE_RECENT_MS;
    if (!recent) return { scope: rt.scope, targetId: rt.targetId };
    const key = record.sessionKey;
    let st = this.adaptiveState.get(key);
    if (!st || st.msgId !== rt.msgId) {
      // 新入站消息(msg_id 变化)→ 重置被动配额
      st = { msgId: rt.msgId, passiveCount: 0 };
      this.adaptiveState.set(key, st);
    }
    if (st.passiveCount < ADAPTIVE_MAX_PASSIVE) {
      st.passiveCount += 1;
      return rt;
    }
    // 已连续被动 5 条 → 本条起转主动(去掉 msg_id, 不再被 QQ 回复上限吞)
    return { scope: rt.scope, targetId: rt.targetId };
  }

  /** 主动目标(去 msg_id 独立发送): 回合主回复正文块>5 时的收尾块用 */
  private activeTarget(record: SessionRecord): ReplyTarget {
    const rt = record.replyTarget;
    return { scope: rt.scope, targetId: rt.targetId };
  }

  /**
   * 引用短号查表(2026-09-13 主人定): 正文里 [rf:短号] → 完整 msg_id。
   * 台账按 peer 存({dataRoot}/.qqbot/msg-index/{peer}/refs.json, 见 transport/msg-index.ts)。
   */
  private refLookupFor(record: SessionRecord): (index: string) => string | undefined {
    const rt = record.replyTarget;
    const root = dataRootOf(this.config);
    return (index) => resolveMsgIndex(root, rt.scope, rt.targetId, index);
  }

  /**
   * 回合主回复的「块级目标」: passive 模式正文块>5 时仅最后一块(总结)转主动发送,
   * 中途不改模式(前 total-1 块全被动带引用) —— 2026-09-10 主人最终语义:
   * 回合结束判断最后一个正文块>5 → 获取其内容单独主动发到 QQ。
   * 返回 undefined = 不启用(adaptive 走自身 resolveTarget 计数, 无需此处干预)。
   */
  private chunkTargetFn(record: SessionRecord): ((i: number, total: number) => ReplyTarget) | undefined {
    if ((this.config.outboundMode || 'adaptive') !== 'passive') return undefined;
    return (i, total) => (total > 5 && i === total - 1) ? this.activeTarget(record) : this.resolveTarget(record);
  }

  /** 记账(**生成侧**, 2026-09-10 修正): 每产生一块正文就登记, **与发送成败解耦**。
   *  ⚠️ 原实现挂在「发送成功之后」(sendRichOutbound 的 onBlockSent), 一旦 QQ 吞消息
   *  (在这里表现为 sendMarkdown 抛错), await 就炸 → 记账中断(实测 count 停在第 4 条, 补发永不触发)。
   *  按 msgId 分组: 同一 msgId 才算同一批被动回复配额, msgId 变化(群友中途发言)即重新计数。 */
  /**
   * 出站正文统一处理（2026-11-19）：**先彩蛋，再清洗**。
   *
   * 顺序不能反：
   *   1. 先 `replaceFacePlaceholders` —— 不洗表情时，把 `【表情: 狂笑】` 换成**真的 QQ 表情**（彩蛋）；
   *   2. 再 `stripOutboundArtifacts` —— 换完之后 `【表情:XX】` 已经不存在了，
   *      它那个 strip 分支自然不匹配 ⇒ **不需要加新配置、也不会互相打架**。
   *
   * 三处出站（send / noteGenerated / OutboundBuffer）都走它，避免口径分叉。
   */
  private processOutboundText(text: string): string {
    const withFaces = this.config.stripFacePlaceholder === true
      ? text                                                      // 明确要洗 → 不转表情，交给 strip 删
      : replaceFacePlaceholders(text, dataRootOf(this.config));    // 默认 → 彩蛋：换成真表情
    return stripOutboundArtifacts(withFaces, this.config);
  }

  private noteGenerated(sessionKey: string, msgId: string, text: string): void {
    // ★ 2026-11-19 issue #72：**记账时就清洗**，因为 `st.last` 并不只用于统计 ——
    //   `maybeResendLastBlock()` 会拿它**再发一次**（passive 模式下第 6 块之后补发最后一块），
    //   还会交给出站扩展（`runOutboundTurnEnd(st.last, …)`）。
    //   只在 `send()` 的正文路径清洗的话，这两条都会绕过 ⇒ 时间头照样漏出去。
    //   在这里清洗一次，所有读 `st.last` 的地方拿到的都是干净的。
    const cleaned = this.processOutboundText(text);
    // ★ 2026-11-19 审查：**洗成空串的块不参与记账**。
    //   否则一轮里夹一个"纯时间头"块，count 照样 +1 ⇒ passive 收尾误判"超过 5 块"重复补发；
    //   如果空块在末尾，还会覆盖 last ⇒ 此前真正的正文就再也补发不了了。
    if (!cleaned.trim()) return;
    const cur = this.turnBlocks.get(sessionKey);
    if (!cur || cur.msgId !== msgId) {
      this.turnBlocks.set(sessionKey, { msgId, count: 1, last: cleaned });
      return;
    }
    cur.count += 1;
    cur.last = cleaned;
  }

  /**
   * passive 回合收尾(2026-09-10 主人定 **A 方案**):
   *   **同一个 msg_id 下**发出的正文块 > 5 时, 把**最后一块的文本复制一份**, 用主动目标(去掉
   *   msg_id)单独再发一次 —— QQ 对同一条入站消息的被动回复上限约 5 条, 前 5 块之后的可能被吞,
   *   而最后一块通常是结论/总结, 值得保住。
   *   ⚠️ 计数按 msgId 分组: 群友中途发言 → msgId 变 → 5 条配额重置 → 后面的块送得到 → **不补发**
   *   (2026-09-10 主人指出原按"回合总块数"判定会白白重复推一条)。
   *   注: adaptive 模式本身「第 6 条起自动转主动」= 主人说的 B 方案, 已内建, 故此处只处理 passive。
   */
  private maybeResendLastBlock(sessionKey: string, record: SessionRecord, st: TurnBlockState | undefined): void {
    if (!st) return;

    // ══ ★★ 2026-10-16 主人定：**回合结束钩子**（出站扩展的配图挂这里）★★ ══
    //   为什么是这里：`turn/end` + `buffer.flush()` 之后 = **回合真正结束**；
    //   而 `st.last` 由 `noteGenerated` 逐块更新 ⇒ **是这一回合权威的最后一块正文**。
    //   ⚠️ 之前挂在 `sendRichOutbound` 入口是**错的**：一段回复可能有"正文→工具调用→正文"
    //      多段，每段都走一次入口 ⇒ 第一段就被当成本回合正文拿去判定了（主人实测抓到）。
    //   丢后台跑（不 await）：正文早就发完了，配图慢一点无所谓，而且绝不能反过来卡住任何发送。
    void (async () => {
      try {
        const { runOutboundTurnEnd } = await import('../features/ext-outbound.js');
        await runOutboundTurnEnd(st.last, {
          target: this.resolveTarget(record),
          sender: this.bot,
          logger: this.logger,
          turnId: sessionKey,
          source: 'assistant/message',
          // ★ 2026-11-24（子代理审查 C1）：turnEnd 也要能 appendWake/appendSilent/api ——
          //   否则扩展在 turnEnd 里写 ctx.appendWake 会 TypeError，连熔断 5 次整个扩展被停用。
          ...outboundExtCaps(record, this.manager as never),
        });
      } catch (err) {
        this.logger.warn(
          `im-qqbot: 回合结束钩子失败(不影响任何发送): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();

    if ((this.config.outboundMode || 'adaptive') !== 'passive') return;
    if (st.count <= 5 || !st.last.trim()) return;
    void this.bot.sendMarkdown(this.activeTarget(record), st.last).then(
      () => this.logger.info(`im-qqbot: [passive 收尾] 回合正文 ${st.count} 块 > 5, 已把最后一块单独补发(主动)`),
      (err: unknown) => this.logger.warn(`im-qqbot: [passive 收尾] 最后一块补发失败: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  /** 事件分发入口 */
  public route(session: SessionLike, raw: RawSessionEvent): void {
    const event = parseEvent(raw);
    if (event === undefined) return;

    const record = this.manager.findBySessionId(session.header.id);
    if (record === undefined) return;

    // ── 内部状态留档(观察期, 2026-09-13) ──
    // 与发送行为**完全无关**: 只写本地数据文件, 不进群、不进面板、不参与任何判定(设计稿 §9/§11 红线)。
    // 位置刻意放在下面 silent/nothink 的早退**之前** —— "照常思考"本就包括潜水模式。
    if (event.type === 'assistant/message') {
      const root = dataRootOf(this.config);
      const replyText = event.content
        .filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
        .map((b) => b.text as string)
        .join('\n');
      // 本回合**工具调用参数里的中文**（未给群友看 → 按主人口径也算内心活动）
      const toolText = (this.innerToolText.get(record.sessionKey) ?? []).join('\n');
      this.innerToolText.delete(record.sessionKey);
      // 好感度：这一轮在跟**谁**说话（入站时记下，见 inbound 的 noteLastSender）
      // 键与入站侧保持一致：`<scope>:<targetId>`（群 openid / 私聊 openid）
      const sender = getLastSender(`${record.replyTarget.scope}:${record.replyTarget.targetId}`);
      if (event.reasoning !== undefined) {
        // 2026-10-21: 块级思考全文（每步一条 = 步结束）也喂给 reasoning 总线；宿主不推 delta 时这是唯一可靠来源
        try { feedReasoning(String(record.sessionKey || record.replyTarget.targetId), event.reasoning, {
          scope: String(record.replyTarget.scope),
          peerId: String(record.replyTarget.targetId),
        }); } catch { /* ignore */ }
        // ① 思考**原文**留档(隐私: 只落本地; 与标量分开存, 便于单独删)
        noteThinking(root, {
          scope: record.replyTarget.scope,
          peerId: record.replyTarget.targetId,
          turn: event.turn,
          step: event.step,
          tokens: event.reasoningTokens,
          text: event.reasoning,
        });
      }
      // ② 四源标量(内心倾向 + 正文情绪 + 长度; **只存标量不存原文**) —— 要跑本地小模型, 异步
      //    ⚠️ 这里只**记录观察数据**（按 step 一行）；好感度不在这里结算，见下面的 turnAcc。
      void noteTurnSignals(
        root,
        {
          scope: record.replyTarget.scope,
          peerId: record.replyTarget.targetId,
          turn: event.turn,
          step: event.step,
          thinkChars: event.reasoning?.length,
          thinkTokens: event.reasoningTokens,
          toolChars: toolText.length,
          replyChars: replyText.length,
          attitudeKey: sender ? `person:${sender.id}` : undefined,
          attitudeName: sender?.name,
          userEmo: sender?.emo,
        },
        {
          think: event.reasoning,
          tool: toolText,
          reply: replyText,
          modelDir: this.config.localModel?.modelDir,
          logger: this.logger,
        },
      );
      // ③ 回合级累积（好感度按回合结算用）—— 只在**本回合第一次**取一次"在跟谁说话"，
      //    后面即使群里又有人说话把 lastSender 覆盖了，这一轮的对象也不再变。
      {
        let acc = this.turnAcc.get(record.sessionKey);
        if (acc === undefined) {
          const who = getLastSender(`${record.replyTarget.scope}:${record.replyTarget.targetId}`);
          acc = {
            scope: record.replyTarget.scope,
            targetId: record.replyTarget.targetId,
            think: [],
            tool: [],
            reply: [],
            senderId: who?.id,
            senderName: who?.name,
            userEmo: who?.emo,
          };
          this.turnAcc.set(record.sessionKey, acc);
        }
        if (event.reasoning) acc.think.push(event.reasoning);
        if (toolText !== '') acc.tool.push(toolText);
        if (replyText !== '') acc.reply.push(replyText);
      }
    }

    // ── 回合活跃标记(消息聚合用, 2026-09-07 主人定) ──
    // LLM 回合进行中(turnActive=true): debounce 见忙就把该会话新消息全攒着;
    // turn/end 复位 false → 攒的消息才批量入站。assistant/tool 事件=回合活跃。
    if (event.type === 'turn/end') {
      record.turnActive = false;
      // 插话计数随回合结束清零（2026-10-09）→ 下一回合的第一次插话又用完整提示
      record.interjectSeq = 0;
      // 好感度结算：整个回合算**一次**（放在 silent/nothink 早退之前 —— "照常思考"也包括潜水）
      const acc = this.turnAcc.get(record.sessionKey);
      if (acc !== undefined) {
        this.turnAcc.delete(record.sessionKey);
        const thinkAll = acc.think.join('\n');
        const replyAll = acc.reply.join('\n');
        // ⚠️ 2026-09-14 修：原来**没把整回合的工具文本传过去** → 结算口径比按步记录少一截
        const toolAll = acc.tool.join('\n');
        void applyTurnAttitude(
          dataRootOf(this.config),
          {
            scope: acc.scope,
            peerId: acc.targetId,
            thinkChars: thinkAll.length,
            replyChars: replyAll.length,
            attitudeKey: acc.senderId ? `person:${acc.senderId}` : undefined,
            attitudeName: acc.senderName,
            userEmo: acc.userEmo,
          },
          { think: thinkAll, reply: replyAll, tool: toolAll, modelDir: this.config.localModel?.modelDir, logger: this.logger },
        );
      }
    } else if (event.type === 'assistant/chunk' || event.type === 'assistant/message'
      || event.type === 'tool/call' || event.type === 'tool/result') {
      record.turnActive = true;
    }

    // 完全不出站(silent)= 照常思考但所有回复不向 QQ 发(静默潜水; dock/web 仍可见思考流);
    // 完全不思考(nothink)= QQ 入站根本不唤醒 LLM(见 inbound), 这里防御性兜底同样吞。
    const mode = this.config.outboundMode || 'adaptive';
    if (mode === 'silent' || mode === 'nothink') {
      // 丢弃累积的文本缓冲(不留残渣), 后续事件全部静默
      const silentBuf = this.buffers.get(session.header.id);
      if (silentBuf !== undefined) {
        silentBuf.cancel();
        this.buffers.delete(session.header.id);
      }
      return;
    }

    switch (event.type) {
      case 'assistant/chunk':
        this.onChunk(session.header.id, record, event);
        break;
      case 'assistant/message':
        this.onMessage(session.header.id, record, event);
        break;
      case 'tool/call':
        this.onToolCall(record, event);
        break;
      case 'tool/result':
        this.onToolResult(record, event);
        break;
      case 'turn/end':
        this.onTurnEnd(session.header.id, record, event);
        break;
      case 'deliverables/presented':
        this.onDeliverables(record, event);
        break;
    }
  }

  /**
   * present 声明的交付物：轮末把文件逐个发到当前会话（2026-10-27）。
   *
   * 宿主在 turn/end **之前**发这个事件，所以直接投递即可；不 await（发送失败已内部降级）。
   * 闸门静默的回合不发（模型既然决定不出声，就别甩文件）。
   */
  private onDeliverables(record: SessionRecord, event: DeliverablesPresentedEvent): void {
    if (this.gateSilenced.has(record.sessionKey)) {
      this.logger.debug(`im-qqbot: 闸门静默回合 → 跳过 ${event.files.length} 个交付物`);
      return;
    }
    this.logger.debug(
      `im-qqbot: deliverables/presented turn=${event.turn} callId=${event.callId} files=${event.files.length}`,
    );
    // 登记已交付路径：正文里若还写了 [MEDIA:file|同一文件]，send() 会剔除，避免重复发送
    const key = record.sessionKey;
    let set = this.deliveredFiles.get(key);
    if (set === undefined) {
      set = new Set<string>();
      this.deliveredFiles.set(key, set);
    }
    for (const file of event.files) set.add(normalizePathForCompare(resolvePresentedPath(file.path, this.config.cwd)));
    void this.deliverables.deliver(record, event.files).catch((err: unknown) => {
      this.logger.error(
        `im-qqbot: deliverables deliver failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** 流式文本增量：累积到会话 buffer */
  private onChunk(sessionId: string, record: SessionRecord, event: ChunkEvent): void {
    let buffer = this.buffers.get(sessionId);
    if (buffer === undefined) {
      buffer = new OutboundBuffer(
        record,
        this.bot,
        this.config.textChunkLimit,
        this.logger,
        this.shouldStream(record),
        this.config.cwd,
        () => this.resolveTarget(record),
        this.chunkTargetFn(record),
        undefined,
        this.refLookupFor(record),
        // ★ 2026-11-19 issue #72：缓冲路径直发 sendRichOutbound，绕过了 send() 那道清洗，必须自己洗
        (t) => this.processOutboundText(t),
        // ★ CodeRabbit #87：回退路径也要带出站扩展能力（appendWake/appendSilent/apiCall），
        //   否则流式降级后扩展 annihilate() 掉正文依然没法通知模型
        { ...outboundExtCaps(record, this.manager as never) },
      );
      this.buffers.set(sessionId, buffer);
    }
    buffer.append(event.text);
  }

  /** 是否启用流式：配置开启 + c2c + 有 msgId（群聊不支持流式） */
  private shouldStream(record: SessionRecord): boolean {
    return this.config.streaming
      && record.replyTarget.scope === 'c2c'
      && !!record.replyTarget.msgId;
  }

  /** 完整 assistant 消息：有流式 buffer 则 flush，否则直接发送文本块 */
  private onMessage(sessionId: string, record: SessionRecord, event: MessageEvent): void {
    const buffer = this.buffers.get(sessionId);
    if (buffer !== undefined && buffer.text.trim()) {
      // 记账放**生成侧**(不看发送成败): 这块正文已经产生了, 就该入账
      this.noteGenerated(record.sessionKey, record.replyTarget.msgId ?? '', buffer.text);
      void this.trackSend(record, buffer.flush());
      this.buffers.delete(sessionId);
      return;
    }

    const textParts: string[] = [];
    for (const block of event.content) {
      if (block.type === 'text' && block.text) textParts.push(block.text);
    }
    const fullText = textParts.join('\n');
    if (!fullText.trim()) return;

    this.noteGenerated(record.sessionKey, record.replyTarget.msgId ?? '', fullText);
    void this.trackSend(record, this.send(record, fullText, 'sendMarkdown', 'assistant/message'));
    this.buffers.delete(sessionId);
  }

  /** 详细主动(detail, 2026-09-11 主人加): 发送行为与 adaptive 完全一致, 额外推送工具调用/结果 */
  private isDetail(): boolean {
    return (this.config.outboundMode || 'adaptive') === 'detail';
  }

  /** 工具结果是否推送: 显式开关(showToolResults) 或 详细主动 */
  private shouldShowToolResults(): boolean {
    return this.config.showToolResults === true || this.isDetail();
  }

  /** 详细主动: 记一条工具调用到聚合窗口(窗口结束统一推一条, 防一个回合刷几十条) */
  private queueToolCallNotice(record: SessionRecord, event: ToolCallEvent): void {
    const key = record.sessionKey;
    const line = `🔧 \`${event.name}\`${summarizeArgs(event.arguments)}`;
    const cur = this.toolNotices.get(key);
    if (cur !== undefined) {
      cur.lines.push(line);
      cur.record = record; // 以最新 record 为准(中途可能换了回复目标)
      return;
    }
    const timer = setTimeout(() => { this.flushToolNotices(key); }, OutboundRouter.TOOL_NOTICE_WINDOW_MS);
    try { timer.unref?.(); } catch { /* 非 Node 定时器忽略 */ }
    this.toolNotices.set(key, { record, lines: [line], timer });
  }

  /** 详细主动: 把聚合中的工具调用提示发出去(多个工具合成一条消息) */
  private flushToolNotices(key: string): void {
    const cur = this.toolNotices.get(key);
    if (cur === undefined) return;
    this.toolNotices.delete(key);
    clearTimeout(cur.timer);
    const max = OutboundRouter.TOOL_NOTICE_MAX;
    const shown = cur.lines.slice(0, max);
    const more = cur.lines.length > max ? `\n…等 ${cur.lines.length} 个工具` : '';
    void this.trackSend(cur.record, this.send(cur.record, `**🔧 工具调用**\n${shown.join('\n')}${more}`, 'sendToolCallNotice', 'tool/call'));
  }

  /** 工具调用：默认仅记录(避免刷屏, 等结果)；详细主动(detail)下额外推一条轻量提示 */
  private onToolCall(record: SessionRecord, event: ToolCallEvent): void {
    this.toolCalls.set(event.callId, { name: event.name, args: event.arguments });
    // 2026-09-14: 工具参数里的中文也算"内心活动"（主人口径），攒着等 assistant/message 一起判
    try {
      const inner = extractInnerText(event.arguments);
      if (inner) {
        const arr = this.innerToolText.get(record.sessionKey) ?? [];
        arr.push(inner);
        this.innerToolText.set(record.sessionKey, arr);
      }
    } catch { /* 抽取失败不影响主链 */ }
    if (this.isDetail() && !this.gateSilenced.has(record.sessionKey)) this.queueToolCallNotice(record, event);
  }

  /**
   * 工具结果：成功结果按开关（详细主动 detail 下强制），**报错则走 toolErrorMode 策略**（issue #77）。
   *
   * 复用现有的 `formatToolResult()` 渲染，不另造格式；策略只管「发原文 / 换一句人话 / 不发」。
   * 默认 `notify` = 与旧版逐字一致（报错原文照发）。
   */
  private onToolResult(record: SessionRecord, event: ToolResultEvent): void {
    const call = this.toolCalls.get(event.callId);
    this.toolCalls.delete(event.callId);
    if (call === undefined) return;

    // 回复闸门判定静默 → 本回合从这一刻起**所有工具结果都不发**
    //   （模型常在闸门后还想顺手记点东西，那些调用会被连带 abort；
    //    主人 2026-09-14："改成直接停止 llm 的回合，而不是报错"）
    if (call.name === 'reply_gate' && isGateSilence(call.args, record.scope)) {
      this.gateSilenced.add(record.sessionKey);
      this.logger.debug(`im-qqbot: 回复闸门判定静默 → 本回合工具展示全部静音 (${record.sessionKey})`);
      return;
    }
    if (this.gateSilenced.has(record.sessionKey)) return;

    const isError = event.error !== undefined;
    if (!isError && !this.shouldShowToolResults()) return;

    const text = formatToolResult(
      call.name,
      call.args,
      event.raw as unknown as ToolResultData,
      this.toolsRegistry,
      record.agent,
    );
    if (!text) return;

    // ★ 2026-11-21（issue #77）：报错也要能"不发/换一句" —— 群聊里一段 ❌ + 内部错误码很突兀，
    //   私聊却需要原文排查。策略按 `toolErrorMode` + `toolErrorModeByScope`（群/私聊可不同）。
    let outText: string | null = text;
    if (isError) {
      outText = resolveToolErrorMessage(this.config, text, String(record.scope));
      if (outText === null) {
        this.logger.warn(`im-qqbot: 工具报错已静音(toolErrorMode): ${call.name} ${text.slice(0, 160)}`);
        return;
      }
    }

    void this.trackSend(record, this.send(record, outText, 'sendToolResult', 'tool/result'));
  }

  /** 轮次结束：清理 buffer，异常结束时告知用户 */
  private onTurnEnd(sessionId: string, _record: SessionRecord, event: TurnEndEvent): void {
    // 2026-10-20：把"本回合有没有正文"告诉 reasoning 总线（扩展据此决定要不要转发 [汇报]）
    try {
      endReasoningTurn(sessionId, this.streamSawText.has(sessionId));
      this.streamSawText.delete(sessionId);
    } catch { /* 扩展抛错不影响出站 */ }
    // 闸门静默标记只在**本回合内**有效，清在最后（下面还要用它判断"这个回合本就不该出声"）
    const silenced = this.gateSilenced.has(_record.sessionKey);
    // 详细主动: 回合结束前把聚合中的工具调用提示发出去 —— 但静默回合不发
    if (!silenced) this.flushToolNotices(_record.sessionKey);
    // 兜底: 回合结束清掉未消费的"工具内心话"（正常在 assistant/message 就用掉了）
    this.innerToolText.delete(_record.sessionKey);
    const buffer = this.buffers.get(sessionId);
    // 收尾前等待本回合的正文发送完成
    if (buffer !== undefined) {
      if (buffer.text.trim()) {
        this.noteGenerated(_record.sessionKey, _record.replyTarget.msgId ?? '', buffer.text);
        void this.trackSend(_record, buffer.flush());
      } else {
        buffer.cancel();
      }
      this.buffers.delete(sessionId);
    }
    // 保留本回合快照，避免等待期间下一回合覆盖正文
    const turnBlocks = this.turnBlocks.get(_record.sessionKey);
    this.turnBlocks.delete(_record.sessionKey);
    const pending = this.pendingSends.get(_record.sessionKey);
    void Promise.allSettled(pending ? [...pending] : []).then(() => this.maybeResendLastBlock(_record.sessionKey, _record, turnBlocks));

    const failure = extractTurnError(event.reason);
    // 闸门静默导致的"取消"不是故障 —— 这个回合本来就不该出声（2026-09-14 主人要求）
    if (failure !== undefined && !SILENT_TURN_ERROR_CODES.has(failure.code) && !silenced) {
      // ★ 2026-11-19 issue #73：报错文案策略化。
      //   原来错误原文原样进群：`⚠️ 本轮异常结束 \`INVALID_REQUEST\`: 400: {...JSON...}`
      //   —— 群友看着突兀、暴露内部错误码和上游响应结构，活跃群里还反复出现。
      //   而且这条是 onTurnEnd 里**直接 this.send** 的，不走出站扩展链，用户侧没有拦截点。
      //   四档见 config.turnErrorMode：notify(默认) / friendly / silent / regex。
      const errText = resolveTurnErrorMessage(this.config, failure.code, failure.message, String(_record.scope));
      const errMode = String(this.config.turnErrorMode ?? 'notify').trim().toLowerCase();
      // ★ 2026-11-19 审查：**friendly 也要记原文**。
      //   原实现只在"不发"时记日志 ⇒ friendly 分支把 code/message 丢了，
      //   出事时开了 friendly 反而查不到是哪个 400 —— 与"细节只进日志"自相矛盾。
      if (errText === null || errMode === 'friendly') {
        this.logger.warn(
          `im-qqbot: 回合异常(turnErrorMode=${errMode}): ${failure.code}: ${failure.message}`,
        );
      }
      if (errText !== null) {
        void this.trackSend(_record, this.send(_record, errText, 'sendTurnEndError', 'turn/end'));
      }
    }

    this.gateSilenced.delete(_record.sessionKey);
    this.deliveredFiles.delete(_record.sessionKey);
    // ★ 2026-11-05：回合结束 → 清掉"来源/因插话解除静默"两个标记，
    //   下一回合重新判定（web 回合继续静默，QQ 入站回合由 handleInbound 重新置 'qq'）。
    _record.turnOrigin = undefined;
    _record.interjectLifted = false;
    this.logger.debug(`im-qqbot: turn/end sessionId=${sessionId}${silenced ? ' (闸门静默回合)' : ''}`);
  }

  /**
   * 出站失败回调：**只处理「内容违规」**（2026-11-07 主人要的功能）。
   * 违规时立刻往上下文注入一条通知，让 AI 知道自己那句话没发出去。
   */
  private onSendErrorFor(record: SessionRecord): (err: unknown, text: string) => void {
    return (err) => {
      try {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/内容违规/.test(msg)) return;
        const turnKey = record.turnStartAt ?? 0;
        if (violationNotified.get(record as object) === turnKey) return;   // 同一回合只提醒一次
        violationNotified.set(record as object, turnKey);
        const notice = buildViolationNotice();
        const message = createUserMessage({
          content: [{ type: 'text' as const, text: notice }],
          source: { kind: 'user' as const },
        });
        // ★ 2026-11-07 主人要"违规就**立马**重发"：原来只用 inject(=next-step + 不唤醒)，
        //   回合已结束的话要等下一次有人说话才看得到。
        //   宿主其实还留了一个正好对口的：`steer()` = send(msg,'next-step',**wakeup:true**) ——
        //   塞进下一步**并且唤醒**：回合还开着就在下个 step 读到；已经结束了就当场开新回合。
        //   逐级降级：steer → inject → followup。
        const ag = record.agent as unknown as {
          steer?: (m: unknown) => void;
          inject?: (m: unknown) => void;
          followup?: (m: unknown) => void;
        };
        if (typeof ag?.steer === 'function') ag.steer(message);
        else if (typeof ag?.inject === 'function') ag.inject(message);
        else ag?.followup?.(message);
        this.logger.info?.(`im-qqbot: 正文被判「内容违规」，已把原因注入上下文 (key=${record.sessionKey})`);
      } catch (e) {
        this.logger?.debug?.(`im-qqbot: 违规通知注入失败(忽略): ${e instanceof Error ? e.message : String(e)}`);
      }
    };
  }

  /** 跟踪尚未完成的发送，供回合收尾等待 */
  private trackSend(record: SessionRecord, operation: Promise<void>): Promise<void> {
    const pending = this.pendingSends.get(record.sessionKey) ?? new Set<Promise<void>>();
    this.pendingSends.set(record.sessionKey, pending);
    pending.add(operation);
    const done = (): void => {
      pending.delete(operation);
      if (!pending.size) this.pendingSends.delete(record.sessionKey);
    };
    void operation.then(done, done);
    return operation;
  }

  /** 统一发送：逐条自适应目标(适配主动) + 富媒体感知分块；媒体指令([MEDIA:..]/[RECALL])被剔除，失败降级记录 */
  private async send(_record: SessionRecord, text: string, tag: string, source: OutboundCtx['source']): Promise<void> {
    try {
      // ★★ 2026-11-05（主人定）：**web 回合静默**
      //   设置项 `webTurnSilent` 勾上后：不是由 QQ 入站触发的回合（`turnOrigin !== 'qq'`，
      //   即用户是在 DSH 的 web/桌面界面里打的字），它的**正文块不发到 QQ**。
      //   三个放行条件（任一成立就不静默）：
      //     ① 本回合由 QQ 入站触发（turnOrigin === 'qq'）；
      //     ② 该回合中途**插话**了 ⇒ interjectLifted（主人："插话后全部放行"）；
      //     ③ **本回合期间 QQ 侧有动静** —— lastInboundAt 晚于 turnStartAt。
      //        兜底用：扩展可能直接调宿主底层 API 注入消息（不走 injectToPeer / handleInbound），
      //        那种情况插件感知不到；但"群里确实有人说过话"就该放行，不该被连累。
      //   另外：带媒体标记的块照常发（图片/文件/视频/语音）；工具调用走 tool-presenter，本来就不受影响。
      //
      //   ⚠️ 2026-11-05 主人补充澄清：上面 ②「插话后放行」**只在会出站的模式里成立** ——
      //     adaptive / detail / passive（以及兼容的 active）。
      //     **silent（完全不出站）与 nothink（完全不思考）不可能触发它**：
      //       · silent：`onAgentEvent()` 在**事件入口**就 `return`（见上文 425 行），
      //         正文块压根不会流到 `send()`，所以这里根本轮不到；
      //       · nothink：QQ 入站不唤醒 LLM ⇒ 没有回合 ⇒ 也没有"插话"这一步。
      //     换句话说：这两个模式下 web 静默这个开关等于无效（本来也不出站）。
      if (this.config.webTurnSilent === true) {
        const qqActiveThisTurn = _record.turnOrigin === 'qq'
          || _record.interjectLifted === true
          || (typeof _record.turnStartAt === 'number'
              && (_record.lastInboundAt ?? 0) > _record.turnStartAt);
        if (!qqActiveThisTurn) {
          const hasMedia = containsMedia(normalizeMediaMarkers(text));
          if (!hasMedia) {
            this.logger.debug(
              `im-qqbot: [web静默] 跳过正文块 tag=${tag} key=${_record.sessionKey} len=${text.length}`,
            );
            return;
          }
        }
      }

      // 2026-10-27: 已被 present 直发的文件，正文里同路径的 [MEDIA:file|…] 标记剔除，避免一份文件发两遍
      const deduped = stripDeliveredFileMarkers(normalizeMediaMarkers(text), this.deliveredFiles.get(_record.sessionKey), this.config.cwd);
      if (deduped.trim() === '') return; // 整段只剩"已被 present 的同一文件"→ 不再发空消息
      text = deduped;

      // ★ 2026-11-19 issue #72：剔掉模型从入站渲染学来的痕迹（行首时间头 / 【表情: XX】）。
      //   模型会把入站时间头当成"群消息标准格式"自己披一个，而且**意识不到**；
      //   写群守则压不住（上下文里几十个示范一直在强化），只能在出站侧做结构级清洗。
      // ⚠️ 2026-11-19 审查：**只洗模型正文**（source === 'assistant/message'）。
      //    send() 是所有文本的共用漏斗 —— 工具结果、回合报错也走它，
      //    那些里面出现的时间戳是**真实内容**（如部署日志 `[2026-11-19 09:52] 启动失败`），
      //    不能一起削掉。issue #72 只想治"模型自己披的头"。
      const stripped = source === 'assistant/message'
        ? this.processOutboundText(text)
        : text;
      if (stripped !== text) {
        if (stripped.trim() === '') {
          this.logger.debug('im-qqbot: 清洗后整条为空 → 跳过发送（只剩时间头/表情占位符）');
          return;
        }
        this.logger.debug(`im-qqbot: 出站清洗 ${text.length} → ${stripped.length} 字符`);
        text = stripped;
      }

      // ★ 2026-10-30 主人要求：私聊出站时首行补一张**机器人自己的头像**
      //   （官方机器人在私聊里没有头像，群里才有）。开关 c2cShowBotAvatar，默认关。
      //   取不到头像 URL 就原样跳过（不塞占位、不多占 token）。
      try {
        const rt = _record.replyTarget as { scope?: string } | undefined;
        if (this.config.c2cShowBotAvatar === true && String(rt?.scope ?? '') === 'c2c') {
          const head = botAvatarMarkdown(dataRootOf(this.config), String(this.config.appId ?? ''));
          if (head && !text.startsWith(head)) text = head + '\n' + text;
        }
      } catch { /* 头像失败不影响正文 */ }

      // 2026-10-21: 正文里的本地图 markdown 自动传 QQ、转 qqbot-media 引用（失败保留原样）
      // 2026-10-21 修：不再依赖全局 factory（managersOf() 拿不到 groupAdmin），
      //   直接用本 router 自己的 manager —— 它一定就是这个会话实例的那个。
      let mdTarget: { apiCall: (m: string, p: string, b?: unknown) => Promise<unknown> } | undefined;
      try {
        // 2026-10-30: groupAdmin 只在群管理开着时才有；素材上传跟那个开关无关，所以回落 mediaApi
        const ga = this.manager.groupAdmin ?? this.manager.mediaApi;
        if (ga) mdTarget = { apiCall: ga.apiCall.bind(ga) as unknown as (m: string, p: string, b?: unknown) => Promise<unknown> };
      } catch { /* ignore */ }
      // 2026-10-31（主人实测）：模型常输出**畸形**图片语法（alt 里换行、尺寸注释重复、
      //   括号主体被折行拆断）→ QQ markdown 严格解析就会 400 → 回落纯文本。
      //   ⇒ 先规范化成单行合法语法，再上传/发送。
      const normalized = normalizeMarkdownImages(text);
      const outText = await rewriteLocalMarkdownImages(normalized, mdTarget as never);

      // 2026-10-21: 改写后含 qqbot-media 图片引用 → 必须走 markdown 通道(msg_type=2)，普通文本不渲染图片
      // ★ CodeRabbit #83/#84：正文里可能**同时**有 `qqbot-media://`（md 图）与 `[MEDIA:…]`（normalize 产出）：
      // 2026-10-21: 改写后含 qqbot-media 图片引用 → 必须走 markdown 通道(msg_type=2)，普通文本不渲染图片
      // ★ CodeRabbit #83/#84：正文里可能**同时**有 `qqbot-media://`（md 图）与 `[MEDIA:…]`（normalize 产出）：
      //   · 全交给 markdown 通道 ⇒ `[MEDIA:…]` 原样发群（路径泄漏、图也发不出）；
      //   · 全交给 sendRichOutbound ⇒ 丢掉"markdown 被拒 → 降级"的处理。
      //   ★ 第 2 轮复审：**必须按原文顺序逐段发** —— 原来先把所有文本合并再发媒体，图片后面的说明会跑到图片前面。
      //   现在：文本段（可能含 md 图）→ markdown + 失败降级；**连续的媒体段** 合并成一次 sendRichOutbound
      //   （表情包每轮上限与 passive/adaptive 回复模式都在它内部处理）。
      const _segs = containsMedia(outText) ? parseOutbound(outText) : undefined;
      const _hasMediaSeg = !!_segs && _segs.some((s) => s.type === 'media');
      if (_segs && _hasMediaSeg && outText.indexOf('qqbot-media://') >= 0) {
        // ★ CodeRabbit #84：**先把正文里所有 [RECALL] 执行掉，再发媒体** ——
        //   否则媒体先发出去、撤回落到了"刚发的那张图"（它已进发送历史），而不是发送前的那条消息。
        //   执行完后发送文本段时要把这些指令剔掉，避免 sendRichOutbound 再执行一次。
        // ★ CodeRabbit #84：**只从文本段收集撤回指令** ——
        //   媒体**路径**里可能正好含 `[RECALL]`（`C:\[RECALL]\a.txt` 这种目录名），
        //   扫整条正文会把它当成指令执行一次，而 `_flushMedia` 重建标记后 sendRichOutbound 又会识别一次。
        const _textForRecall = _segs.filter((s) => s.type !== 'media').map((s) => (s as { text?: string }).text ?? '').join('');
        const _recallIdx = collectRecallIndices(_textForRecall);
        if (_recallIdx.length > 0) {
          for (const idx of _recallIdx) {
            try {
              await this.bot.recallByIndex(this.activeTarget(_record) as never, idx);
            } catch { /* 单条失败不影响后续发送 */ }
          }
        }
        const _stripRecall = (s: string): string => s.replace(/\[RECALL(?::\s*\d+)?\]/g, '');
        const _mdSend = async (raw: string): Promise<void> => {
          const t = _stripRecall(raw);
          if (!t.trim()) return;
          if (t.indexOf('qqbot-media://') < 0) {
            await sendRichOutbound(
              this.bot, _record.replyTarget, t, this.config.textChunkLimit, this.config.cwd,
              (m) => this.logger.error(m), () => this.resolveTarget(_record), this.chunkTargetFn(_record),
              undefined, this.refLookupFor(_record), this.onSendErrorFor(_record), { source, ...outboundExtCaps(_record, this.manager as never) },
            );
            return;
          }
          try {
            await this.bot.sendMarkdown(this.activeTarget(_record), t);
          } catch (err) {
            this.logger.error('im-qqbot: markdown(含图) 失败，回落普通文本: ' + (err instanceof Error ? err.message : String(err)));
            // 2026-10-30/31：回落时绝不把 qqbot-media 引用或原始 markdown 当文本发出去 ——
            //   本地图 → [MEDIA:image|路径]；qqbot-media/http 图 → [图片：说明]。
            await sendRichOutbound(
              this.bot, _record.replyTarget,
              stripMarkdownImagesForPlainText(localMarkdownImagesToMediaMarkers(t)),
              this.config.textChunkLimit, this.config.cwd,
              (m) => this.logger.error(m), () => this.resolveTarget(_record), this.chunkTargetFn(_record),
              undefined, this.refLookupFor(_record), this.onSendErrorFor(_record), { source, ...outboundExtCaps(_record, this.manager as never) },
            );
          }
        };
        let _mediaBuf: Array<{ kind?: string; source?: string }> = [];
        const _flushMedia = async (): Promise<void> => {
          if (!_mediaBuf.length) return;
          const buf = _mediaBuf;
          _mediaBuf = [];
          // ★ CodeRabbit #84：路径里含 `[RECALL]` 的段**不能**走 sendRichOutbound ——
          //   它内部还会再扫一次 RECALL ⇒ 二次撤回（可能撤到本次刚发的文本段）。
          //   这类段改成直发 sendMedia（路径原样、指令不被解释）；其余段照旧走 sendRichOutbound
          //   （表情包每轮上限与 passive/adaptive 回复模式由它统一处理）。
          // ★ CodeRabbit #84：路径里含 `[RECALL]` 的段**不能**走 sendRichOutbound ——
          //   它内部还会再扫一次 RECALL ⇒ 二次撤回（可能撤到本次刚发的文本段）。
          //   这类段改成直发 sendMedia（路径原样、指令不被解释）；其余段照旧走 sendRichOutbound
          //   （表情包每轮上限与 passive/adaptive 回复模式由它统一处理）。
          //
          //   ★ CodeRabbit #84（再次）：**必须按 buf 的原始顺序发** —— 先发 normal 再发 raw 会把
          //   `[诀REcall路径][普通文件]` 的顺序调换成"普通文件→RECALL路径"。所以：普通段先攒着批量发，
          //   遇到 raw 段就把攒的发出去、再直发它，最后收尾。
          const isRaw = (s: { source?: string }): boolean => /\[RECALL(?::\s*\d+)?\]/.test(String(s.source ?? ''));
          let pending: Array<{ kind?: string; source?: string }> = [];
          const flushPending = async (): Promise<void> => {
            if (!pending.length) return;
            const mediaOnly = pending
              .map((s) => `[MEDIA:${String(s.kind ?? 'image')}|${String(s.source ?? '')}]`)
              .join('');
            pending = [];
            await sendRichOutbound(
              this.bot, _record.replyTarget, mediaOnly, this.config.textChunkLimit, this.config.cwd,
              (m) => this.logger.error(m), () => this.resolveTarget(_record), this.chunkTargetFn(_record),
              undefined, this.refLookupFor(_record), this.onSendErrorFor(_record), { source, ...outboundExtCaps(_record, this.manager as never) },
            );
          };
          for (const seg of buf) {
            if (!isRaw(seg)) {
              pending.push(seg);   // 连续普通段合并成一次发送（闸门/上限仍在）
              continue;
            }
            await flushPending();  // 先把它前面攒的普通段发掉，保住顺序
            try {
              const src = resolveSource(String(seg.source ?? ''), this.config.cwd);
              const sourceOpt = src.kind === 'url' ? { url: src.url } : { localPath: src.path };
              await this.bot.sendMedia(
                (this.resolveTarget(_record) ?? this.activeTarget(_record)) as never,
                String(seg.kind ?? 'image') as never,
                sourceOpt as never,
              );
            } catch (err) {
              this.logger.error('im-qqbot: 路径含 [RECALL] 的媒体段发送失败: ' + (err instanceof Error ? err.message : String(err)));
            }
          }
          await flushPending();
        };
        for (const seg of _segs) {
          if (seg.type === 'media') {
            _mediaBuf.push(seg as unknown as { kind?: string; source?: string });
            continue;
          }
          await _flushMedia();   // 保证"文字-图-文字"的原始顺序
          await _mdSend(String((seg as { text?: string }).text ?? ''));
        }
        await _flushMedia();
        return;
      }
      await sendRichOutbound(
        this.bot,
        _record.replyTarget,
        outText,
        this.config.textChunkLimit,
        this.config.cwd,
        (m) => this.logger.error(m),
        () => this.resolveTarget(_record),
        this.chunkTargetFn(_record),
        undefined,
        this.refLookupFor(_record),
        this.onSendErrorFor(_record),
        { source, ...outboundExtCaps(_record, this.manager as never) },
      );
    } catch (err) {
      this.logger.error(`im-qqbot: ${tag} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── present 直发去重（2026-10-27） ──
//   现象：模型常"既 present 又在正文写 [MEDIA:file|同一路径]"→ 同一份文件发两遍。
//   做法：turn 内记下已 present 的规范化路径，正文里同路径的 [MEDIA:file|…] 标记剔除。

/** present 给的路径 → 便于比较的绝对路径（file:// 剥前缀；相对路径按 cwd 解析） */
function resolvePresentedPath(p: string, cwd: string | undefined): string {
  const s = String(p ?? '').trim();
  if (s.startsWith('file://')) return s.replace(/^file:\/\//, '');
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\\\')) return s;
  return cwd ? resolvePath(cwd, s) : s;
}

/** 路径比较键：斜杠统一；仅 Windows 盘符路径折叠大小写（POSIX 大小写敏感，不动） */
function normalizePathForCompare(p: string): string {
  const s = String(p ?? '').trim().replace(/^file:\/\//, '').replace(/\\/g, '/');
  return /^[a-zA-Z]:\//.test(s) ? s.toLowerCase() : s;
}

/** 剔除正文里"已被 present 直发"的那部分 [MEDIA:file|…] 标记 */
export function stripDeliveredFileMarkers(
  text: string,
  delivered: Set<string> | undefined,
  cwd: string | undefined,
): string {
  if (delivered === undefined || delivered.size === 0) return text;
  let hit = false;
  // ★ CodeRabbit #84（outside diff range）：路径允许成对 `[...]`，与 `parseOutbound` 的边界保持一致 ——
  //   否则 `C:\pics\[旅行]\a.png` 会在第一个 `]` 处截断，比较键命中不了 delivered
  //   ⇒ 已发的文件又被正文里的标记重复发一遍。
  const out = String(text ?? '').replace(/\[MEDIA:file\|((?:[^\[\]]|\[[^\[\]]*\])+)\]/g, (whole, rawPath: string) => {
    const key = normalizePathForCompare(resolvePresentedPath(rawPath.trim(), cwd));
    if (delivered.has(key)) {
      hit = true;
      return '';
    }
    return whole;
  });
  if (!hit) return out;
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 工具参数摘要(详细主动推送用): 压成一行并截断 */
function summarizeArgs(rawArgs: string): string {
  const s = String(rawArgs ?? '').trim();
  if (s === '' || s === '{}') return '';
  const one = s.replace(/\s+/g, ' ');
  return `(${one.length > 60 ? `${one.slice(0, 60)}…` : one})`;
}

/**
 * 创建出站事件处理器
 *
 * 返回一个 handler 函数，应注册到 ctx.on('session/event', handler)。
 * toolsRegistry 用于工具结果的结构化展示（参考 dsh-TUI 的 presentResult）。
 */
/**
 * 返回一个 handler 函数，应注册到 ctx.on('session/event', handler)。
 * toolsRegistry 用于工具结果的结构化展示（参考 dsh-TUI 的 presentResult）。
 *
 * 额外带 `routeStreamFrame`：把宿主瞬态流式帧（agent/assistant-stream）喂给同一套出站缓冲。
 */
export function createOutboundHandler(
  manager: SessionManager,
  bot: QQBotSender,
  config: ImQQBotConfig,
  logger: Logger,
  toolsRegistry?: ToolsRegistryLike,
): OutboundHandler & { routeStreamFrame(agentId: string, delta: StreamDelta): void } {
  const router = new OutboundRouter(manager, bot, config, logger, toolsRegistry);
  const handler = ((session, event) => router.route(session, event)) as OutboundHandler & {
    routeStreamFrame(agentId: string, delta: StreamDelta): void;
  };
  handler.routeStreamFrame = (agentId, delta) => router.routeStreamFrame(agentId, delta);
  return handler;
}
