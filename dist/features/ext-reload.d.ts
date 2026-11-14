/**
 * ext-reload.ts — 扩展命令的「热重载注册表」（2026-10-12 主人定）
 *
 * 起因：扩展命令表在 `middleware-setup` 里是**启动时加载一次**、塞进闭包里的 `cmdMap`，
 *   于是改完 `.qqbot-extensions/commands/*.js` 必须**重启插件**才生效；
 *   而扩展工具（`tools/`）早就能热刷 —— 同一套扩展机制、两套待遇，不对。
 *
 * 做法：`middleware-setup` 把"重建命令表"的函数注册到这里；
 *   任何热刷入口（斜杠 `/tools-reload`、工具 `tools_reload`、dock 面板热刷…）都会经过
 *   `SessionManager.reloadAllChannelTools()` —— 在那里顺带调用本模块，
 *   **命令与工具就一起热重载**，无需再新增入口，也不会漏掉某个入口。
 *
 * 为什么用注册表而不是直接 import：
 *   命令表活在 `middleware-setup` 的闭包里（每个 bot 实例一份），
 *   `SessionManager` 拿不到它，也不该反向依赖 gateway 层 —— 注册表是最轻的解耦方式。
 *
 * ⚠️ 与扩展工具一致的纪律：cache-bust 用文件 mtime（见 extension-store 的 fileVersion），
 *   改过的文件才会重新 import；没改的复用缓存，不会因反复热刷吃内存。
 */
export interface ExtCommandReloadResult {
    /** 本次加载到的扩展命令名（去重后，便于回执里展示） */
    names: string[];
}
/** 注册/注销重建器（注销传 undefined；插件重载时调用方会覆盖为新的） */
export declare function registerExtCommandReloader(dataRoot: string | undefined, fn: (() => Promise<ExtCommandReloadResult>) | undefined): void;
/**
 * 热重载扩展命令。
 * 返回 `{ error }` 表示"没装成"（比如插件还没启动完），由调用方决定怎么提示 —— 不抛错，
 * 因为热刷的主职是刷工具，命令刷不动也不该把整次热刷弄失败。
 */
export declare function reloadExtCommands(dataRoot?: string): Promise<ExtCommandReloadResult | {
    error: string;
}>;
/** 给回执文本用：把重载结果拼成一句人话（工具热刷的 summary 会带上它） */
export declare function describeExtCommandReload(r: ExtCommandReloadResult | {
    error: string;
}): string;
/** 一次入站扩展重载的结果（回执/日志用） */
export interface ExtInboundReloadResult {
    /** 本次装载到的扩展数 */
    count: number;
    /** 扩展展示名（去重前，便于回执里展示） */
    names: string[];
}
/** 注册/注销入站扩展重载器（注销必须带**自己的** dataRoot） */
export declare function registerExtInboundReloader(dataRoot: string | undefined, fn: (() => Promise<ExtInboundReloadResult>) | undefined): void;
/**
 * 热重载入站扩展。
 * 返回 `{ error }` 表示"没装成"（比如插件还没启动完）—— 不抛错，理由同 {@link reloadExtCommands}。
 */
export declare function reloadExtInbound(dataRoot?: string): Promise<ExtInboundReloadResult | {
    error: string;
}>;
/** 给回执文本用：把入站扩展重载结果拼成一句人话 */
export declare function describeExtInboundReload(r: ExtInboundReloadResult | {
    error: string;
}): string;
/** 当前是否已注册入站扩展重载器（诊断用） */
export declare function hasExtInboundReloader(): boolean;
/** 一次出站扩展重载的结果（回执/日志用） */
export interface ExtOutboundReloadResult {
    /** 本次装载到的扩展数 */
    count: number;
    /** 扩展展示名（便于回执里展示） */
    names: string[];
}
/**
 * ★ 2026-11-14：**删掉死单例** `outboundReloader` / `registerExtOutboundReloader` ——
 *   全仓无任何调用者（审查确认），出站热刷一直走下面的动态 import。
 *   但 `reloadExtOutbound()` 本身有活调用者（session-manager.reloadAllChannelTools），
 *   而且**它不传 dataRoot** ⇒ 在 A 上敲 /tools-reload 会刷到 B 的目录。现在补参数。
 */
export declare function reloadExtOutbound(dataRoot?: string): Promise<ExtOutboundReloadResult | {
    error: string;
}>;
/** 给回执文本用：把出站扩展重载结果拼成一句人话 */
export declare function describeExtOutboundReload(r: ExtOutboundReloadResult | {
    error: string;
}): string;
/** 当前是否已注册出站扩展重载器（诊断用） */
export declare function hasExtOutboundReloader(): boolean;
//# sourceMappingURL=ext-reload.d.ts.map