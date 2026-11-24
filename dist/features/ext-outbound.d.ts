import type { Logger } from '../types.js';
export declare const EXT_OUTBOUND_SUBDIR = "outbound";
/** 其他扩展取"出站操控器"的全局键（Symbol.for ⇒ 跨模块实例单例，同 ext-inbound 的 HANDLER_KEY 手法） */
export declare const OUTBOUND_API_KEY: unique symbol;
/** 一条待发送内容 */
export interface OutboundMessage {
    text: string;
    kind: OutboundCtx['kind'];
    source: OutboundCtx['source'];
}
/** 同步内容变换；返回一条、多条或 null/[] */
export type OutboundTransform = (message: Readonly<OutboundMessage>) => OutboundMessage | OutboundMessage[] | null;
/** 一次出站的载体（正文 + 元信息），扩展可读写 `text` */
export interface OutboundCtx {
    /** 本条出站正文（扩展可读；改它请用 rewrite()） */
    text: string;
    /** 解析后的段（rich-media.parseOutbound 的结果；拿不到时是空数组） */
    segments: unknown[];
    /** 这条出站是什么 */
    kind: 'text' | 'markdown' | 'media' | 'card' | 'forward' | 'other';
    /** 产生本条消息的宿主事件 */
    source: 'assistant/message' | 'tool/call' | 'tool/result' | 'turn/end' | 'unknown';
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
    /** 登记同步内容变换（仅 send 阶段） */
    transform(fn: OutboundTransform): boolean;
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
    /** 发一条**纯文本**（优先 sendText，宿主没有就降级 markdown）。⚠️ 出站版**不支持** `emit(text, at)` 的 @ 参数 */
    emit?: (text: string) => unknown;
    markdown?: (text: string) => unknown;
    /** 发图：`image(url)` 或 `image({url}|{localPath})`（与 media 同口径判 url/本地路径） */
    image?: (src: string | {
        url?: string;
        localPath?: string;
    }) => unknown;
    media?: (kind: string, source: string, text?: string) => unknown;
    /**
     * 出站扩展的 KV。**兼容两种写法**（子代理审查 M1：此前只实现 keyed 形态，
     * 照文档写 `save(obj)` 会把 key 存成 "[object Object]" 并静默返回 true）：
     * - `load()` → 整对象；`load('k')` → 单键
     * - `save(obj)` → 整表覆盖；`save('k', v)` → 单键
     *
     * 按扩展名分文件（`outbound-<name>.json`）；坏文件不会被当成空表覆盖（读失败 → 写入返回 false）。
     */
    store?: {
        load: (k?: string) => unknown;
        save: (k: string | Record<string, unknown>, v?: unknown) => boolean;
    };
    identity?: {
        user?: unknown;
        owners?: string[];
        peer?: unknown;
    };
    api?: (path: string) => Promise<unknown>;
    appendSilent?: (text: string) => unknown;
    /**
     * 唤醒模型处理一条新消息（走正常回合，dsh 会先补人设）。
     *
     * ★ 2026-11-24（社区补丁 Bemly/dsh-plug 指出）：这个能力类型里早就有，但 `makeOutboundCtx`
     *   从来没挂上 ⇒ 扩展里 `typeof ctx.appendWake === 'function'` 恒为 false，
     *   `annihilate()` 掉正文后**无法告知模型**，消息静默蒸发、turn/end 还报 completed。
     *   现在由挂载点喂进来；拿不到就是 undefined，调用方自己判空。
     */
    appendWake?: (text: string) => Promise<boolean>;
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
    /**
     * 本次**命中 ESM 缓存**、模块没重新执行的文件（URL 与上次相同）。
     *
     * ★ CodeRabbit #80（第 3 轮）：思考回调清理后要不要恢复，全看这个 ——
     *   命中缓存 ⇒ 模块里那句 `onDelta(...)` 没再执行 ⇒ 得把旧回调放回去；
     *   没命中（文件改了）⇒ 以新模块的注册结果为准，**不恢复**（用户可能就是想删掉注册）。
     */
    cachedPaths: string[];
    /** 本次扫到的全部扩展文件（绝对路径；用来判断"哪些文件这次根本没装载"，例如被停用） */
    scannedPaths: string[];
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
    source?: OutboundCtx['source'];
    segments?: unknown[];
    apiCall?: unknown;
    kernel?: unknown;
    logger?: Logger;
    /** ★ 2026-10-16：'send'（正文发送前，默认）或 'turnEnd'（回合结束，可做配图） */
    phase?: 'send' | 'turnEnd';
    /**
     * ★ 2026-11-24（社区补丁指出）：挂载点喂进来的"唤醒模型"能力 ——
     *   扩展 `annihilate()` 掉正文后，靠它告诉模型"这条被拦了，重写一版"。
     *   缺了就降级成 undefined，扩展自己判空。
     */
    appendWake?: (text: string) => unknown;
    /**
     * ★ 2026-11-24：静默注入（只落上下文、不唤醒）—— 与能力包的 `appendSilent` 同义。
     *   由挂载点喂进来，缺了就 undefined。
     */
    appendSilent?: (text: string) => unknown;
}
export declare function outboundExtensionsDir(dataRoot: string): string;
/** 配置出站扩展的数据根与日志器（插件启动时调一次；热刷时复用） */
export declare function configureOutboundExtensions(opts: {
    dataRoot: string;
    logger: Logger;
    owner?: object;
    apiCall?: unknown;
}): void;
/** 当前已配置的出站扩展数据根（空串=没配）—— 供热刷判断"刷的是不是你要的那个实例" */
/**
 * 登记真正走发送链的对象，用于 runOutboundChain / notifyOutboundSent 反查桶。
 *
 * ★★ 2026-11-14（CodeRabbit）：**不能用 middleware-setup 里的 SDK bot 当 owner** ——
 *   实际走链的是 bootstrap 另建的 sender 字面量（createOutboundHandler 传的是它），
 *   两个对象不是同一个 ⇒ WeakMap 永远 miss ⇒ 多实例下所有出站都会跳过扩展。
 *   所以 sender 创建后要单独登记一次（SDK bot 可同时登记，无害）。
 */
export declare function registerOutboundOwner(dataRoot: string, owner: unknown): void;
export declare function currentOutboundDataRoot(): string;
/** 重新装载（供热刷用）：没配置过则安静返回空结果 */
export declare function reloadOutboundExtensions(dataRoot?: string): Promise<OutboundLoadResult>;
/**
 * 扫描 `{dataRoot}/.qqbot-extensions/outbound/*.mjs` 并装载。
 *
 * 目录不存在 / 为空 → 返回空结果、**不打日志**；
 * 单文件失败 → 只 warn 并继续；本函数**永不抛出**。
 * 重新调用 = 热重载（`loaded` 整体替换）。
 */
export declare function loadOutboundExtensions(opts: LoadOutboundOptions): Promise<OutboundLoadResult>;
export declare function notifyOutboundSent(result: OutboundSentResult, owner?: unknown): Promise<void>;
export declare function listOutboundExtensions(): OutboundExtension[];
/** 改文件 + tools_reload = 复位通道 */
export declare function resetOutboundBreaker(name?: string): void;
/** 由 bootstrap 按配置设置（每个实例各自一份，互不影响） */
export declare function setOutboundLastCtxFallback(owner: unknown, v: boolean): void;
export declare function setOutboundSender(ns: string, sender: unknown): void;
export declare function outboundSenderOf(ns: string): object | null;
/** 诊断用：该发送器是否允许回落 */
export declare function outboundLastCtxFallbackEnabled(owner?: unknown): boolean;
/** 当前是否正在跑出站链（其他扩展可用于"别在我发消息时又触发我"） */
export declare function outboundActive(): boolean;
/** 最近一次出站的 ctx（其他扩展可用它拿 target 往同一个会话补发） */
export declare function lastOutboundCtx(): OutboundCtx | null;
interface OutboundChainState {
    text: string;
    killed: boolean;
    reason: string;
    transforms?: Array<{
        fn: OutboundTransform;
        extension?: OutboundExtension;
    }>;
    extension?: OutboundExtension;
}
/**
 * 构造一条出站的 ctx（**导出**出来，方便其他扩展/工具直接造一条去发）。
 */
export declare function makeOutboundCtx(initialText: string, opts?: RunOutboundOptions, state?: OutboundChainState): OutboundCtx;
/** 一条出站的执行结果 */
export interface OutboundRunResult {
    /** 最终要发的正文（可能被扩展改写） */
    text: string;
    /** 变换后的消息（省略时沿用 text） */
    messages?: OutboundMessage[];
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
    preferText?: boolean;
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
export {};
//# sourceMappingURL=ext-outbound.d.ts.map