import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { Logger } from '../types.js';
/** 一个已装载的入站扩展 */
export interface InboundExtension {
    /** 文件名（含扩展名），日志与诊断用 */
    file: string;
    /** 绝对路径 */
    path: string;
    /** 展示名：模块导出的 `name` 优先，否则去扩展名的文件名 */
    name: string;
    /** **晚**挂点（onDecide / 默认导出 / middleware）—— 与 `bot.use(mw)` 同一个签名 */
    middleware: Middleware;
    /** **早**挂点（onInbound）—— 可选；没有就是纯晚挂点扩展 */
    onInbound?: Middleware;
    /** 可选：模块导出的 `dispose()`，插件卸载时调用 */
    dispose?: () => unknown;
}
/** 一次装载的汇总 */
export interface InboundLoadResult {
    /** 形状合法、已装载的扩展数 */
    total: number;
    /** 形状不合法（没有中间件）或 import 就炸，被跳过的数 */
    skipped: number;
    /** 装载到的**晚**挂点中间件，按文件名升序（直接交给 {@link runInboundExtensions}） */
    middleware: Middleware[];
    /** 装载到的**早**挂点中间件，按文件名升序（直接交给 {@link runEarlyInboundExtensions}） */
    early: Middleware[];
    /** 明细（诊断用） */
    extensions: InboundExtension[];
    /** 目录里被发现、扩展名合法的文件名（升序） */
    files: string[];
}
/** `loadInboundExtensions` 的入参 */
export interface LoadInboundOptions {
    dataRoot: string;
    logger: Logger;
}
/** 运行器入参：动作 API 需要的环境（缺 dataRoot 时名单/kv/审计一律降级为空操作，绝不往相对路径写盘） */
export interface ExtRunOptions {
    /** 数据根（状态文件 + 审计落它下面） */
    dataRoot?: string;
    /** 主人 openid 白名单（`config.groupAdmin.owners`）—— 白名单最高优先靠它 */
    owners?: string[];
    /** bot 的 appId（`ctx.platform.mentioned` 的内容兜底扫描用，与 SDK mentionGate 同款判据） */
    appId?: string;
    /** 当前会话的发送器（发消息/发富媒体用） */
    sender?: unknown;
    /** 当前这条消息的回复目标（被动回复优先） */
    replyTarget?: unknown;
    /** bot 密钥（`api()` 自建 token 兜底） */
    appSecret?: string;
    /** 带 token 的官方 API 调用（挂载点取 `manager.groupAdmin.apiCall`） */
    apiCall?: unknown;
    /** 插件自己的 cordis Context → 能力包里的 `kernel`（"遥控器"） */
    kernel?: unknown;
    /** `silentInto` 用：把"这条消息所属会话的宿主 agent"解析出来 */
    resolveAgent?: (ctx: MiddlewareContext) => unknown;
}
/** 入站扩展目录（相对数据根） */
export declare function inboundExtensionsDir(dataRoot: string): string;
/**
 * 扫描 `{dataRoot}/.qqbot-extensions/inbound/*.mjs` 并装载。
 *
 * 目录不存在 / 为空 → 返回空结果，**不打任何日志**。
 * 单个文件 import 失败或形状不合法 → 只记 `warn`，继续下一个；本函数**永不抛出**。
 * 重新调用 = 热重载：`loaded` 被整体替换成新一批（旧版模块留给 dispose 收尾），
 * 并**复位每个文件的熔断记录**（这是文档写明的熔断恢复通道）。
 */
export declare function loadInboundExtensions(opts: LoadInboundOptions): Promise<InboundLoadResult>;
/**
 * 跑一遍**早**挂点（`onInbound`）：挂载点在 quoteRef 之后、**记群历史之前**。
 *
 * 与晚挂点共用同一套兜底（单扩展 try/catch、next() 幂等且一定被 await、下游异常原样上抛），
 * 外加一条：`ctx.annihilate()` 置位后，**即便扩展又调了 next() 也不再往下走**
 * （消灭的语义是"不进历史、不进上下文、不占冷却"，只能靠"链停在这里"实现）。
 * 没导出 `onInbound` 的扩展自动跳过（不占一层 next）。
 */
export declare function runEarlyInboundExtensions(exts: InboundExtension[], ctx: MiddlewareContext, finalNext: () => Promise<void>, logger: Logger, opts?: ExtRunOptions): Promise<void>;
/**
 * 跑一遍**晚**挂点（`onDecide` / 默认导出）：挂载点在 mentionGate 之后、contentSanitizer 之前。
 *
 * 这是本扩展点自 2026-10-12 起的原有契约（洋葱模型：ext0 → ext1 → … → finalNext），
 * 挂载点与单元测试都直接调它（不依赖 SDK 的 `runMiddlewareChain`）。
 *
 * 三条兜底（见文件头"铁律"）：
 *   · 扩展抛错且**还没往下走** ⇒ 告警 + 替它 `next()`（用户脚本坏了，消息也绝不能被吞掉）；
 *   · 扩展抛错但**已经往下走** ⇒ 原样把下游的异常上抛（那是下游的错，不能记成"扩展坏了"）；
 *   · 扩展忘了 await `next()` ⇒ 引擎替它 await（保证中间件链的顺序语义）。
 * 扩展**不调** `next()` ⇒ 整条链到此为止（这是合法用法：这条消息被拦掉；但群历史**已经**记过）。
 */
export declare function runInboundExtensions(exts: InboundExtension[], ctx: MiddlewareContext, finalNext: () => Promise<void>, logger: Logger, opts?: ExtRunOptions): Promise<void>;
/**
 * 把已装载的扩展组合成一个中间件（等价于 {@link runInboundExtensions} 的中间件写法）。
 * 挂载点用的是"可变列表 + runInboundExtensions"（为了热重载），这个组合版给需要固定列表的场景用。
 */
export declare function composeInboundExtensions(exts: InboundExtension[], logger: Logger, opts?: ExtRunOptions): Middleware;
/**
 * 只把 ctx 的动作 API 提前挂上（不跑任何扩展）。
 * 正常使用不必调 —— 两个运行器都会自动挂；需要它的场景是调用方自己写了
 * "早挂点之后、晚挂点之前"的中间件，想读 `ctx.state.qqInboundForceWake` 之类由动作设置的标记。
 */
export declare function attachExtContext(ctx: MiddlewareContext, logger: Logger, opts?: ExtRunOptions): void;
/**
 * 调用所有入站扩展的 `dispose()`（插件卸载 / 宿主退出 / 保存连接设置后重建网关）。
 *
 * 纪律：**逆序**执行（后装载的先清理）、单个失败只告警、整体永不抛出、幂等、清空登记。
 * 返回本次真正调用成功的 dispose 数量（没有导出的 dispose 就不算）。
 * 同时把 ext-reload 里的热重载入口摘掉 —— 否则它会一直指向这个已经死掉的实例。
 */
export declare function disposeInboundExtensions(logger: Logger, dataRoot?: string): Promise<number>;
/** 重置模块级状态（仅供单元测试；生产不要调 —— 会把正在生效的扩展登记丢掉） */
export declare function __resetInboundExtensionsForTest(): void;
/** 当前登记在册的扩展数（诊断用） */
export declare function inboundExtensionsCount(): number;
/** 当前生效的那一批（诊断用；返回副本，防外部改动） */
export declare function currentInboundExtensions(): InboundExtension[];
//# sourceMappingURL=ext-inbound.d.ts.map