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
export function isGateSilence(rawArgs: string): boolean {
  try {
    const a = JSON.parse(String(rawArgs ?? '')) as { reply?: unknown };
    return a?.reply === false;
  } catch {
    return false;
  }
}
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
import { rewriteLocalMarkdownImages, localMarkdownImagesToMediaMarkers } from '../features/md-media-rewrite.js';

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

/** 不展示给用户的轮次错误码（底层传输/网络错误，对用户无意义，且常被重试兜住） */
const SILENT_TURN_ERROR_CODES = new Set(['STREAM_CLOSED']);

/** 适配主动: 同一入站消息(msg_id)最多被动回复条数(QQ 回复同一消息上限 ~4-5 条), 超出自动转主动 */
const ADAPTIVE_MAX_PASSIVE = 5;
/** 适配主动: 「最近收到消息」判据(距上次入站活动 N ms 内才算; 过期旧 msg_id 不再被动引用, 防引用失效丢消息) */
const ADAPTIVE_RECENT_MS = 5 * 60_000;

/**
 * 出站路由器：持有会话级状态，按事件类型分发到处理器
 */
class OutboundRouter {
  private readonly buffers = new Map<string, OutboundBuffer>();

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
      feedReasoning(agentId, delta.text);
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
  private readonly turnBlocks = new Map<string, { msgId: string; count: number; last: string }>();
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
  private noteGenerated(sessionKey: string, msgId: string, text: string): void {
    const cur = this.turnBlocks.get(sessionKey);
    if (!cur || cur.msgId !== msgId) {
      this.turnBlocks.set(sessionKey, { msgId, count: 1, last: text });
      return;
    }
    cur.count += 1;
    cur.last = text;
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
  private maybeResendLastBlock(sessionKey: string, record: SessionRecord): void {
    const st = this.turnBlocks.get(sessionKey);
    this.turnBlocks.delete(sessionKey);
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
      void buffer.flush();
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
    void this.send(record, fullText, 'sendMarkdown');
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
    void this.send(cur.record, `**🔧 工具调用**\n${shown.join('\n')}${more}`, 'sendToolCallNotice');
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

  /** 工具结果：错误始终发送；成功结果按开关，详细主动(detail)下强制发送 */
  private onToolResult(record: SessionRecord, event: ToolResultEvent): void {
    const call = this.toolCalls.get(event.callId);
    this.toolCalls.delete(event.callId);
    if (call === undefined) return;

    // 回复闸门判定静默 → 本回合从这一刻起**所有工具结果都不发**
    //   （模型常在闸门后还想顺手记点东西，那些调用会被连带 abort；
    //    主人 2026-09-14："改成直接停止 llm 的回合，而不是报错"）
    if (call.name === 'reply_gate' && isGateSilence(call.args)) {
      this.gateSilenced.add(record.sessionKey);
      this.logger.debug(`im-qqbot: 回复闸门判定静默 → 本回合工具展示全部静音 (${record.sessionKey})`);
      return;
    }
    if (this.gateSilenced.has(record.sessionKey)) return;

    if (event.error === undefined && !this.shouldShowToolResults()) return;

    const text = formatToolResult(
      call.name,
      call.args,
      event.raw as unknown as ToolResultData,
      this.toolsRegistry,
      record.agent,
    );
    if (!text) return;

    void this.send(record, text, 'sendToolResult');
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
    // 先让残留 buffer flush 完(记账在 flush 里发生), 再判断 passive 收尾补发
    const finish = (): void => this.maybeResendLastBlock(_record.sessionKey, _record);
    if (buffer !== undefined) {
      if (buffer.text.trim()) {
        void buffer.flush().then(finish, finish);
      } else {
        buffer.cancel();
        finish();
      }
      this.buffers.delete(sessionId);
    } else {
      finish();
    }

    const failure = extractTurnError(event.reason);
    // 闸门静默导致的"取消"不是故障 —— 这个回合本来就不该出声（2026-09-14 主人要求）
    if (failure !== undefined && !SILENT_TURN_ERROR_CODES.has(failure.code) && !silenced) {
      void this.send(_record, `⚠️ 本轮异常结束\n\`${failure.code}\`: ${failure.message}`, 'sendTurnEndError');
    }

    this.gateSilenced.delete(_record.sessionKey);
    this.deliveredFiles.delete(_record.sessionKey);
    this.logger.debug(`im-qqbot: turn/end sessionId=${sessionId}${silenced ? ' (闸门静默回合)' : ''}`);
  }

  /** 统一发送：逐条自适应目标(适配主动) + 富媒体感知分块；媒体指令([MEDIA:..]/[RECALL])被剔除，失败降级记录 */
  private async send(_record: SessionRecord, text: string, tag: string): Promise<void> {
    try {
      // 2026-10-27: 已被 present 直发的文件，正文里同路径的 [MEDIA:file|…] 标记剔除，避免一份文件发两遍
      const deduped = stripDeliveredFileMarkers(text, this.deliveredFiles.get(_record.sessionKey), this.config.cwd);
      if (deduped.trim() === '') return; // 整段只剩"已被 present 的同一文件"→ 不再发空消息
      text = deduped;
      // 2026-10-21: 正文里的本地图 markdown 自动传 QQ、转 qqbot-media 引用（失败保留原样）
      // 2026-10-21 修：不再依赖全局 factory（managersOf() 拿不到 groupAdmin），
      //   直接用本 router 自己的 manager —— 它一定就是这个会话实例的那个。
      let mdTarget: { apiCall: (m: string, p: string, b?: unknown) => Promise<unknown> } | undefined;
      try {
        // 2026-10-30: groupAdmin 只在群管理开着时才有；素材上传跟那个开关无关，所以回落 mediaApi
        const ga = this.manager.groupAdmin ?? this.manager.mediaApi;
        if (ga) mdTarget = { apiCall: ga.apiCall.bind(ga) as unknown as (m: string, p: string, b?: unknown) => Promise<unknown> };
      } catch { /* ignore */ }
      const outText = await rewriteLocalMarkdownImages(text, mdTarget as never);
      // 2026-10-21: 改写后含 qqbot-media 图片引用 → 必须走 markdown 通道(msg_type=2)，普通文本不渲染图片
      if (outText.indexOf('qqbot-media://') >= 0) {
        try {
          await this.bot.sendMarkdown(this.activeTarget(_record), outText);
          return;
        } catch (err) {
          this.logger.error('im-qqbot: markdown(含图) 失败，回落普通文本: ' + (err instanceof Error ? err.message : String(err)));
          // 2026-10-30: 回落时不能把 qqbot-media 引用或原始 markdown 当文本发出去 ——
          //   本地图直接降级成 [MEDIA:image|路径]，走普通发图通道把图真发出来
          await sendRichOutbound(
            this.bot,
            _record.replyTarget,
            localMarkdownImagesToMediaMarkers(text),
            this.config.textChunkLimit,
            this.config.cwd,
            (m) => this.logger.error(m),
            () => this.resolveTarget(_record),
            this.chunkTargetFn(_record),
            undefined,
            this.refLookupFor(_record),
          );
          return;
        }
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
  const out = String(text ?? '').replace(/\[MEDIA:file\|([^\]\n]+)\]/g, (whole, rawPath: string) => {
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
