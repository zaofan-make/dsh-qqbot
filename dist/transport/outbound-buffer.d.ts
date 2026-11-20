/**
 * OutboundBuffer — 出站文本缓冲
 *
 * 收集流式 chunk，流式优先投递（StreamingWriter），降级为静态发送。
 * 独立文件便于单测。
 */
import type { SessionRecord } from '../session/index.js';
import type { Logger, ReplyTarget } from '../types.js';
import type { OutboundCtx } from '../features/ext-outbound.js';
/** QQ 流式会话（openStream 返回） */
export interface StreamSessionLike {
    update(content: string): Promise<unknown>;
    complete(): Promise<unknown>;
}
/** QQ Bot 发送接口 */
export interface QQBotSender {
    sendMarkdown(target: ReplyTarget, content: string): Promise<unknown>;
    /**
     * 纯文本消息（`msg_type=0`）。
     *
     * ★ 2026-11-20 主人实测（本条注释曾是错的，已纠正）：
     *   **LaTeX 只有走 markdown 通道（msg_type=2）才渲染**；
     *   走纯文本（`msg_type=0`）时 `$$\textcolor{#E74C3C}{\text{红}}$$` 会原样显示成源码。
     *
     *   ⇒ 正文含成对 `$…$` 时**不许**被降级到这条；
     *     出站降级判定见 `gateway/bootstrap.ts` 的 `hasMarkdownSyntax`（内含 `hasLatexPair`）。
     *
     * 可选：老宿主/SDK 未必暴露，没有就继续用 markdown。
     */
    sendText?(target: ReplyTarget, content: string): Promise<unknown>;
    /** 发送带内联按钮(keyboard)的 markdown 消息 —— 审批卡片/提问卡片用 */
    sendMarkdownWithKeyboard(target: ReplyTarget, content: string, keyboard: unknown): Promise<unknown>;
    /**
     * 发**图文卡片**（官方 20261021 新增 msg_type=8）。
     * `card` 形如 `{ type:'tuwen', content:{ title, description, url, pic_url } }`
     * （官方四个字段都必填：title 1-50 / description 1-200 / url、pic_url 必 https ≤1024）。
     */
    sendTuwenCard?(target: ReplyTarget, card: {
        type: 'tuwen';
        content: {
            title: string;
            description: string;
            url: string;
            pic_url: string;
        };
    }): Promise<unknown>;
    openStream(target: ReplyTarget): StreamSessionLike;
    /** 发送富媒体(图片/语音/视频/文件)；url/localPath 二选一；返回新消息 id(若可得) */
    sendMedia(target: ReplyTarget, kind: 'image' | 'video' | 'voice' | 'file', source: {
        url?: string;
        localPath?: string;
    }): Promise<{
        id?: string;
    }>;
    /** 撤本 bot 最近发给该 peer 的消息；成功返回 true */
    recallLast(target: ReplyTarget): Promise<boolean>;
    /** 撤本 bot 发给该 peer 的最近第 index 条(index=1 最近一条, 2 倒数第二条...)；成功返回 true */
    recallByIndex(target: ReplyTarget, index: number): Promise<boolean>;
    /** c2c 主动召回消息(官方 is_wakeup:true, 30天窗; 群聊目标应走 sendMarkdown)。2026-09-10 修跨会话 c2c 发送 */
    sendC2cWakeup(target: ReplyTarget, content: string): Promise<unknown>;
}
export declare function hasLatexFormula(text: string): boolean;
export declare function sendRichOutbound(bot: QQBotSender, target: ReplyTarget, text: string, limit: number, cwd: string | undefined, logError?: (msg: string) => void, resolveTarget?: () => ReplyTarget, 
/** 逐文本块目标(2026-09-10 主人定 passive 收尾): 传 (块序号i, 总块数total)=>ReplyTarget,
 *  用于「正文块>5 时第 6 块起转主动发送」; undefined=所有块用 resolveTarget/固定 target */
chunkTarget?: (i: number, total: number) => ReplyTarget, 
/** 每成功发出一个正文块后回调(2026-09-10 主人定 passive 收尾 A 方案): outbound.ts 用它统计
 *  「**同一个 msg_id 下**已发出几个正文块」, 回合结束时决定是否把最后一块复制一份主动补发。
 *  带上 target 是因为 QQ 的被动回复 5 条上限**按 msg_id 计** —— msg_id 一变(群友中途发言)
 *  配额即重置, 计数必须跟着归零, 否则会误补发(2026-09-10 主人指出)。 */
onBlockSent?: (text: string, target: ReplyTarget) => void, 
/** 引用短号查表(2026-09-13 主人定): 传短号(如 0913a) → 完整 msg_id; 台账见 transport/msg-index.ts */
refLookup?: (index: string) => string | undefined, 
/**
 * ★ 2026-11-07 主人要的：**正文被平台判违规时告知 AI**。
 *   每块发送失败都会回调 (`err`, `该块文本`)，由上层判断是不是"内容违规"并注入提示；
 *   这里只是把异常**吞掉继续发后续块**（原来一抛就整段中断，后面的正文也全丢了）。
 */
onSendError?: (err: unknown, text: string) => void, 
/**
 * ★★ 2026-10-16 主人定：**出站扩展链**的上下文（第六套扩展点 `.qqbot-extensions/outbound/`）★★
 *
 * 挂在这里的原因：`sendRichOutbound` 是**所有出站**（AI 正文 / 媒体段 / 卡片文本）的必经之路，
 * 出站扩展才有机会"改正文、消灭这条、额外补发媒体"。
 *
 * 缺省（不传）也**照跑链** —— 扩展可能只想按文本/会话判断；`enabled:false` 才是显式关闭
 * （给内部回环调用用，避免"自己发的又被自己拦"）。
 */
extHook?: {
    enabled?: boolean;
    /** 本回合 id（同一回合的所有正文块共享） */
    turnId?: string;
    /** 本回合内第几个正文块（从 0 起） */
    chunkIndex?: number;
    /** 是否本回合最后一个正文块（示范"按正文配表情包"就看它） */
    isLastChunk?: boolean;
    /** 这条出站是什么（默认 text） */
    kind?: 'text' | 'markdown' | 'media' | 'card' | 'forward' | 'other';
    /** 产生本条消息的宿主事件（默认 unknown） */
    source?: OutboundCtx['source'];
    /** 数据根（扩展的 store 用它） */
    dataRoot?: string;
    /** 主人 openid 白名单 */
    owners?: string[];
    /** 插件自己的 cordis Context（扩展的 kernel） */
    kernel?: unknown;
    /** 带 token 的官方 API 调用 */
    apiCall?: unknown;
    /** 插件 logger */
    logger?: unknown;
}): Promise<void>;
export declare class OutboundBuffer {
    private readonly record;
    private readonly bot;
    private readonly limit;
    private readonly logger;
    private readonly cwd;
    private readonly resolveTarget?;
    /** 逐文本块目标(2026-09-10 passive 收尾; 正文块>5 第6块起转主动) */
    private readonly chunkTarget?;
    /** 每成功发出一个正文块后回调(见 sendRichOutbound 同名参数) */
    private readonly onBlockSent?;
    /** 引用短号查表(见 sendRichOutbound 同名参数; 2026-09-13 主人定) */
    private readonly refLookup?;
    /**
     * 出站正文清洗（issue #72）。
     *
     * ⚠️ 2026-11-19 审查抓到的缺口：缓冲区**直接**调 `sendRichOutbound`，
     *    绕过了 `OutboundRouter.send()` 里那道清洗 ⇒ 时间头照样漏出去（实测确认）。
     *    所以这里要再来一次。
     *
     * 局限：**流式（StreamingWriter）那条路修不了** —— 它是增量 update，
     * 分块到达时时间头可能被切成两半，逐块清洗会把正文切坏。
     * 好在流式只在 c2c + 有 msgId 时开，群里走的是下面这条静态路径。
     */
    private readonly stripFn?;
    private buffer;
    /** 缓冲过大只告警一次（见 append 的注释） */
    private warnedBig;
    private flushing;
    private readonly writer;
    constructor(record: SessionRecord, bot: QQBotSender, limit: number, logger: Logger, streamingEnabled: boolean, cwd?: string | undefined, resolveTarget?: (() => ReplyTarget) | undefined, 
    /** 逐文本块目标(2026-09-10 passive 收尾; 正文块>5 第6块起转主动) */
    chunkTarget?: ((i: number, total: number) => ReplyTarget) | undefined, 
    /** 每成功发出一个正文块后回调(见 sendRichOutbound 同名参数) */
    onBlockSent?: ((text: string, target: ReplyTarget) => void) | undefined, 
    /** 引用短号查表(见 sendRichOutbound 同名参数; 2026-09-13 主人定) */
    refLookup?: ((index: string) => string | undefined) | undefined, 
    /**
     * 出站正文清洗（issue #72）。
     *
     * ⚠️ 2026-11-19 审查抓到的缺口：缓冲区**直接**调 `sendRichOutbound`，
     *    绕过了 `OutboundRouter.send()` 里那道清洗 ⇒ 时间头照样漏出去（实测确认）。
     *    所以这里要再来一次。
     *
     * 局限：**流式（StreamingWriter）那条路修不了** —— 它是增量 update，
     * 分块到达时时间头可能被切成两半，逐块清洗会把正文切坏。
     * 好在流式只在 c2c + 有 msgId 时开，群里走的是下面这条静态路径。
     */
    stripFn?: ((text: string) => string) | undefined);
    /**
     * 追加文本增量。
     *
     * 2026-11-12 性能观察：`flush()` 是串行的（`flushing` 锁），发送慢时这段时间新到的
     * 增量会全部堆在 `buffer` 里。正常情况只有几 KB，但极端情况（QQ 端卡住 + AI 狂输出）
     * 可能涨到几 MB，再一次性 `chunkMarkdownText` 会有明显 GC 停顿。
     * 这里**只加可见性、不丢内容**：超过阈值打一条 warn（便于事后从日志确认"是不是堆积了"）。
     * 真正的背压应该在 AI 侧（流式输出本身就受限于上一个 flush），不在传输层做丢弃。
     */
    append(text: string): void;
    /** 获取当前累积文本 */
    get text(): string;
    /** 发送所有累积文本：流式优先，降级静态 */
    flush(): Promise<void>;
    /** 取消（异常/丢弃），中止流式并清空缓冲 */
    cancel(): void;
}
//# sourceMappingURL=outbound-buffer.d.ts.map