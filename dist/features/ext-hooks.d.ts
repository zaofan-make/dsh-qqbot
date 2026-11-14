import type { Logger } from '../types.js';
import { makeExtCaps } from './ext-capabilities.js';
/** 单钩子默认超时（ms）：超过就只告警放行，绝不拖住插件启动 */
export declare const DEFAULT_HOOK_TIMEOUT_MS = 30000;
/** 一个钩子的执行结果 */
export interface HookRunResult {
    /** 文件名（含扩展名），日志与诊断用 */
    file: string;
    /** 绝对路径 */
    path: string;
    /** 展示名：模块导出的 `name` 优先，否则去掉扩展名的文件名 */
    name: string;
    /** 执行结果；`skipped` = 模块形状不合法（缺 run），没执行 */
    status: 'ok' | 'error' | 'timeout' | 'skipped';
    /** 耗时（ms）；skipped 为 0 */
    ms: number;
    /** status != 'ok' 时的人类可读原因 */
    error?: string;
}
/** 一次启动钩子装载的汇总（调用方可据此打一条总账日志） */
export interface HookRunSummary {
    /** 目录里被发现、且形状合法的钩子总数（不含 skipped） */
    total: number;
    ok: number;
    failed: number;
    timedOut: number;
    /** 被跳过（形状不合法）的数量 */
    skipped: number;
    /** 逐个钩子的明细（含 skipped） */
    results: HookRunResult[];
}
/** `runStartupHooks` 的入参 */
export interface RunStartupHooksOptions {
    dataRoot: string;
    logger: Logger;
    /** 插件 cordis Context（会原样交给钩子的 `env.ctx` / `env.caps.kernel`） */
    ctx?: unknown;
    /** 当前实例配置（会原样交给钩子的 `env.config`，只读用途） */
    config?: unknown;
    /** 单钩子超时（ms），缺省 {@link DEFAULT_HOOK_TIMEOUT_MS}（30s） */
    timeoutMs?: number;
    /** bot 的 AppID（落进 env.caps.appId / env.config.appId，钩子可自取凭证） */
    appId?: string;
    /** bot 的 AppSecret（同上） */
    appSecret?: string;
    /** 主人 openid 白名单（落进 env.caps.owners / env.config.owners） */
    owners?: string[];
    /**
     * ★ 唤指定会话的 AI：(scope, peerId, text) => Promise<boolean>。
     *
     * 钩子没有“当前消息”，所以必须显式点名目标会话 —— 这是它唯一能让 AI 开口的正当方式
     * （caps.appendWake 依赖“当前会话”，钩子里恒为 undefined）。
     * 由 bootstrapGateway 注入；宿主不接时 caps.wakeTo() 恒返回 false（不抛错）。
     */
    wakeTo?: (scope: string, peerId: string, text: string) => Promise<boolean>;
}
/** 传给钩子的 env（写扩展时看到的就是这个） */
export interface HookEnv {
    /** 插件自己的 cordis Context（等于 `makeExtCaps().kernel`） */
    ctx: unknown;
    /** 插件 logger —— 建议日志前缀写 `[ext-hook:<文件名>]` */
    logger: Logger;
    /** 数据根（= `{dataRoot}`，钩子目录的父目录） */
    dataRoot: string;
    /** 当前实例的配置对象（只读用途） */
    config: unknown;
    /** 注册清理函数（插件卸载 / 宿主退出时调用；逆序执行，单个失败不影响其它） */
    registerDispose: (fn: () => unknown | Promise<unknown>) => void;
    /** 插件包版本号，如 `1.8.9` */
    pluginVersion: string;
    /** 本钩子的绝对路径（调试/自报家门用） */
    hookFile: string;
    /** 扩展能力包（与 tools/commands 同一套：markdown/image/api/store/appendWake…） */
    caps: ReturnType<typeof makeExtCaps>;
    /** `caps.store` 的快捷方式（落 `{dataRoot}/.qqbot-extensions/hooks/data/<名字>.json`） */
    store: ReturnType<typeof makeExtCaps>['store'];
}
/** 扩展钩子目录（相对数据根） */
export declare function extHooksDir(dataRoot: string): string;
/**
 * 扫描 `{dataRoot}/.qqbot-extensions/hooks/*.mjs` 并**逐个执行**。
 *
 * 目录不存在 / 目录为空 → 直接返回空汇总，**不打任何日志**（这是最常见的正常状态）。
 * 单个钩子失败或超时 → 只记 `warn`，继续下一个；本函数**永不抛出**。
 */
export declare function runStartupHooks(opts: RunStartupHooksOptions): Promise<HookRunSummary>;
/**
 * 调用所有钩子登记的清理函数（导出 `dispose()` + `registerDispose(fn)`）。
 *
 * 由 `bootstrapGateway` 的 dispose 链路调用（插件卸载 / 宿主退出 / 保存连接设置后重建网关）。
 * 纪律：逆序执行（后启动的先清理）、**单个失败只告警**、整体永不抛出、幂等。
 */
export declare function disposeStartupHooks(logger: Logger, dataRoot?: string): Promise<number>;
/** 重置模块级状态（仅供单元测试；生产不要调 —— 会把正在跑的钩子的清理登记丢掉） */
export declare function __resetStartupHooksForTest(): void;
/** 当前已登记清理函数的钩子数（诊断用） */
export declare function startupHooksDisposeCount(): number;
//# sourceMappingURL=ext-hooks.d.ts.map