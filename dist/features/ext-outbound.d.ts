import type { Logger } from '../types.js';
/** 出站扩展子目录名（与 inbound / hooks / tools / botplay 并列的第六套） */
export declare const EXT_OUTBOUND_SUBDIR = "outbound";
/** 其他扩展取"出站操控器"的全局键（Symbol.for ⇒ 跨模块实例单例，同 ext-inbound 的 HANDLER_KEY 手法） */
export declare const OUTBOUND_API_KEY: unique symbol;
/** 一次出站的载体（正文 + 元信息），扩展可读写 `text` */
export interface OutboundCtx {
    /** 本条出站正文（扩展可读；改它请用 rewrite()） */
    text: string;
    /** 解析后的段（rich-media.parseOutbound 的结果；拿不到时是空数组） */
    segments: unknown[];
    /** 这条出站是什么 */
    kind: 'text' | 'markdown' | 'media' | 'card' | 'forward' | 'other';
    /** 回复目标（被动回复优先靠它自带的 msgId） */
    target: {
        scope?: string;
        peerId?: string;
        msgId?: string;
    } | null;
    /** 本回合 id（同一回合的所有正文块共享；没有回合概念时是空串） */
    turnId: string;
    /** 本回合内的第几个正文块（从 0 起） */
    chunkIndex: number;
    /** **是否本回合最后一个正文块** —— 示范（按正文配表情包）就看它，避免每块都配一张 */
    isLastChunk: boolean;
    /** 当前发送器（发媒体/文本用） */
    sender: unknown;
    /** 数据根 */
    dataRoot: string;
    /** 主人 openid 白名单 */
    owners: string[];
    /** 带 token 的官方 API 调用 */
    apiCall?: unknown;
    /** 插件自己的 cordis Context（能力包里的 kernel） */
    kernel?: unknown;
    /** 插件 logger */
    logger: Logger;
    /** 改写本条出站正文；返回 false = 已经消灭了（改也没意义） */
    rewrite(newText: string): boolean;
    /** 消灭本条出站（**之后不要调 next()**，否则引擎会记 warn）；返回 false = 已熔断/被拒 */
    annihilate(reason: string): boolean;
    /**
     * ★★ 2026-10-16 主人定的架构：**丢后台** ★★
     *
     * 出站链与"正文发送"唯一的联系就是**读一眼内容**；任何"选图/算分/发媒体"这类重活
     * **一律丢到后台独立跑**，绝不 await、绝不阻塞正文 —— 正文该多快就多快，
     * 图片是**事后补发**的（走 `ctx.sendMedia` 的"先被动后主动"独立通道）。
     *
     * 用法（扩展里）：
     * ```js
     * ctx.background(async () => {
     *   const kw = await 选图耗时逻辑(ctx.text);
     *   await ctx.sendMedia({ path });
     * });
     * return next();     // ← 立刻放行正文，不等上面跑完
     * ```
     */
    /**
     * ★★ 2026-10-16：**这一趟是哪个阶段**（主人实测指出：一段回复有多段正文，
     *   每段都各走一次 `sendRichOutbound` ⇒ "第一段"根本不是回合最后一块）★★
     *   · `'send'`    = 正文**发送前**（挂载点在 `sendRichOutbound` 入口）—— 只做**改写/消灭**
     *                   这类必须同步生效的事；**配图不要放这里**。
     *   · `'turnEnd'` = **回合真正结束**（挂载点在 `outbound.ts` 的 `turn/end`：flush 之后、
     *                   与 passive 收尾同一时机）—— 这里 `text` 就是 `turnBlocks.last`，
     *                   **是这一回合权威的最后一块正文**，且正文早发完了，配图随便慢。
     */
    phase: 'send' | 'turnEnd';
    background(task: () => unknown): void;
    /** 额外发一条媒体（**先被动后主动**）；返回是否成功 */
    sendMedia(input: {
        path?: string;
        url?: string;
        text?: string;
    }): Promise<boolean>;
    /** 额外发一条文本（**先被动后主动**）；返回是否成功 */
    send(text: string, opts?: {
        adaptive?: boolean;
    }): Promise<boolean>;
    /** 审计/诊断一行（走 logger.debug + 落盘审计，最坏也只是丢日志，绝不抛） */
    note(msg: string): void;
    emit?: (text: string) => unknown;
    markdown?: (text: string) => unknown;
    image?: (url: string) => unknown;
    media?: (kind: string, source: string, text?: string) => unknown;
    store?: {
        load: (k: string) => unknown;
        save: (k: string, v: unknown) => unknown;
    };
    identity?: {
        user?: unknown;
        owners?: string[];
        peer?: unknown;
    };
    api?: (path: string) => Promise<unknown>;
    appendSilent?: (text: string) => unknown;
    appendWake?: (text: string) => unknown;
}
/** 出站中间件签名：与 inbound 的 `(ctx, next)` 对称 */
export type OutboundMiddleware = (ctx: OutboundCtx, next: () => Promise<void>) => unknown;
/** 一个已装载的出站扩展 */
/** 一次出站的结果（给扩展的 `onSent`） */
export interface OutboundSentResult {
    /** 是否至少有一个块发成功 */
    ok: boolean;
    /** 最终发出去的正文（可能被扩展改写过） */
    text: string;
    /** 目标 */
    target?: unknown;
    /** 失败原因（ok=false 时有） */
    error?: string;
    /** 发失败的块数 */
    failedBlocks: number;
    /** 被杀（扩展 annihilate）时为 true，此时 ok=false */
    killed: boolean;
}
export interface OutboundExtension {
    /** 文件名（含扩展名） */
    file: string;
    /** 绝对路径 */
    path: string;
    /** 展示名：模块导出的 `name` 优先，否则去扩展名的文件名 */
    name: string;
    /** 中间件 */
    middleware: OutboundMiddleware;
    /** 可选：`dispose()` */
    dispose?: () => unknown;
    /**
     * 可选：**发送结果回执**（2026-11-11 新增）。
     * 出站链跑完、消息真的发出去之后调用，告诉扩展"这条到底发成了没有"。
     * 以前扩展只能看到"链内抛错"，看不到 transport 的最终结果（外部作者实测上报过）。
     */
    onSent?: (result: OutboundSentResult) => unknown;
}
/** 一次装载的汇总 */
export interface OutboundLoadResult {
    total: number;
    skipped: number;
    /** 按文件名升序（直接交给 runOutboundChain） */
    middleware: OutboundMiddleware[];
    extensions: OutboundExtension[];
    files: string[];
}
export interface LoadOutboundOptions {
    dataRoot: string;
    logger: Logger;
}
/** 跑链的入参（除正文外都可缺，缺了对应能力降级） */
export interface RunOutboundOptions {
    dataRoot?: string;
    owners?: string[];
    sender?: unknown;
    target?: unknown;
    turnId?: string;
    chunkIndex?: number;
    isLastChunk?: boolean;
    kind?: OutboundCtx['kind'];
    segments?: unknown[];
    apiCall?: unknown;
    kernel?: unknown;
    logger?: Logger;
    /** ★ 2026-10-16：'send'（正文发送前，默认）或 'turnEnd'（回合结束，可做配图） */
    phase?: 'send' | 'turnEnd';
}
export declare function outboundExtensionsDir(dataRoot: string): string;
/** 配置出站扩展的数据根与日志器（插件启动时调一次；热刷时复用） */
export declare function configureOutboundExtensions(opts: {
    dataRoot: string;
    logger: Logger;
}): void;
/** 重新装载（供热刷用）：没配置过则安静返回空结果 */
export declare function reloadOutboundExtensions(): Promise<OutboundLoadResult>;
/**
 * 扫描 `{dataRoot}/.qqbot-extensions/outbound/*.mjs` 并装载。
 *
 * 目录不存在 / 为空 → 返回空结果、**不打日志**；
 * 单文件失败 → 只 warn 并继续；本函数**永不抛出**。
 * 重新调用 = 热重载（`loaded` 整体替换）。
 */
export declare function loadOutboundExtensions(opts: LoadOutboundOptions): Promise<OutboundLoadResult>;
/** 当前已装载的出站扩展（诊断用） */
/**
 * 把一次出站的结果回执给所有出站扩展的 `onSent(result)`（2026-11-11）。
 *
 * 调用方是 `transport/outbound-buffer.ts`：**消息真的发完之后**才调。
 * 每个扩展独立 try/catch + 单次超时保护，**绝不因为扩展报错影响发送结果**。
 */
export declare function notifyOutboundSent(result: OutboundSentResult): Promise<void>;
export declare function listOutboundExtensions(): OutboundExtension[];
/** 改文件 + tools_reload = 复位通道 */
export declare function resetOutboundBreaker(name?: string): void;
/** 当前是否正在跑出站链（其他扩展可用于"别在我发消息时又触发我"） */
export declare function outboundActive(): boolean;
/** 最近一次出站的 ctx（其他扩展可用它拿 target 往同一个会话补发） */
export declare function lastOutboundCtx(): OutboundCtx | null;
/**
 * 构造一条出站的 ctx（**导出**出来，方便其他扩展/工具直接造一条去发）。
 */
export declare function makeOutboundCtx(initialText: string, opts?: RunOutboundOptions, state?: {
    text: string;
    killed: boolean;
    reason: string;
}): OutboundCtx;
/** 一条出站的执行结果 */
export interface OutboundRunResult {
    /** 最终要发的正文（可能被扩展改写） */
    text: string;
    /** 是否被消灭（调用方应**跳过发送**） */
    killed: boolean;
    /** 消灭原因（诊断用） */
    reason: string;
    /** 跑过的扩展数 */
    ran: number;
}
/**
 * 依次跑出站链（文件名升序，与 inbound 同款"链式 + 幂等 next"）。
 *
 * 语义（**与 inbound 对齐**）：
 *   · `next()` **幂等**：误调两次只算第一次；
 *   · `next()` 一定被 await（扩展忘 await 时引擎替它 await）；
 *   · 扩展**不调 next() 且没 annihilate** ⇒ 引擎替它放行（防新手卡死链）+ 记 warn；
 *   · `annihilate()` 之后**即便又调了 next() 也不再往下走**。
 */
export declare function runOutboundChain(text: string, opts?: RunOutboundOptions): Promise<OutboundRunResult>;
/**
 * ★★ 回合结束钩子（2026-10-16 主人定）★★
 *
 * 挂载点：`transport/outbound.ts` 的 `turn/end` —— 在 `buffer.flush()` 之后、
 * 与 passive 收尾（`maybeResendLastBlock`）**同一时机**。传进来的 `lastText`
 * 就是 `turnBlocks.last`，**是这一回合权威的最后一块正文**。
 *
 * 为什么需要它：一段 assistant 回复可能包含"正文 → 工具调用 → 正文"多段，
 * 每段都各走一次 `sendRichOutbound`。若把配图挂在入口（phase='send'），
 * 第一段就会被当成本回合正文拿去判定 —— **错得离谱**（主人 2026-10-16 实测抓到）。
 *
 * 扩展怎么写：在 `onOutbound(ctx, next)` 里判 `ctx.phase === 'turnEnd'` ⇒ 做配图；
 * `phase === 'send'` ⇒ 只做改写/消灭（或直接 `next()`）。
 */
export declare function runOutboundTurnEnd(lastText: string, opts?: RunOutboundOptions): Promise<OutboundRunResult>;
/**
 * 直接经"先被动后主动"通道发一条东西。
 *
 * ⚠️ 这条通道**不跑出站扩展链**（否则自己发的又会被自己拦，形成回环）；
 *    要走链请用 {@link runOutboundChain}。
 */
export declare function sendViaOutboundChannel(payload: {
    text?: string;
    path?: string;
    url?: string;
    kind?: string;
}, opts?: RunOutboundOptions, sendOpts?: {
    adaptive?: boolean;
}): Promise<boolean>;
/**
 * 其他扩展获取"出站操控器"的入口（`globalThis[OUTBOUND_API_KEY]`）。
 *
 * 用法（任何扩展里）：
 * ```js
 * const ob = globalThis[Symbol.for('im-qqbot.outbound')];
 * await ob?.send('补一句', { adaptive: true });
 * await ob?.sendMedia({ path: 'D:/pics/a.png' });
 * const target = ob?.last()?.target;   // 往"刚才那个会话"发
 * const scores = await ob?.embed('正文', ['标签A', '标签B']);  // 本地小模型语义分（可为 null）
 * ```
 */
export declare function installOutboundApi(): void;
//# sourceMappingURL=ext-outbound.d.ts.map