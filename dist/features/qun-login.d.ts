export interface QunCookie {
    uin: string;
    skey: string;
    p_skey?: string;
}
export interface StartResult {
    ok: boolean;
    msg: string;
    /** 需要扫码时给出二维码图片路径（上层用 send_media 发给用户） */
    qrPath?: string;
    /** 自动点头像成功时直接给出凭据 */
    cookie?: QunCookie;
}
/** 找系统浏览器（Edge 优先：Windows 必装）。可用 QUN_BROWSER 环境变量覆盖。 */
export declare function findSystemBrowser(): string | null;
/** 由插件 apply() 设置：本进程当前实例的归属 token（传 undefined = 清除） */
export declare function setQunLoginOwner(owner: object | undefined): void;
/**
 * 供插件 dispose 生命周期调用：清理登录浏览器会话与空闲定时扫描器。
 *
 * @param owner 传入时只关掉**该实例创建**的会话（多实例/热重载安全）；
 *              不传则全局清理（进程级退出、历史外部调用保持旧行为）。
 *
 * 扫描器与退出钩子是**模块级共享资源**：只有当清理后已经没有任何会话了才撤掉，
 * 否则会误伤其他实例仍在用的会话（CodeRabbit #92）。
 */
export declare function disposeQunLogin(owner?: object): void;
export declare function qunLoginSessionAlive(dataRoot: string): boolean;
export declare function qunLoginSessionClose(dataRoot: string): void;
/**
 * 第一步：开浏览器 → 有头像就自动点（免扫码），没头像就出二维码。
 * 拿到凭据就返回 cookie 并关掉浏览器；需要扫码则**保留浏览器**，让上层把 qrPath 发给用户，
 * 之后用 qunBrowserLoginWait 继续等。
 */
export declare function qunBrowserLoginStart(dataRoot: string, opts?: {
    headless?: boolean;
    profileDir?: string;
    owner?: object;
}): Promise<StartResult>;
/**
 * 第二步：在已开的会话上继续等（扫码 or 点头像跳转完成）。
 * budgetMs 默认 25 秒 —— 别让工具调用卡太久，用户可以多次调。
 */
export declare function qunBrowserLoginWait(dataRoot: string, budgetMs?: number): Promise<{
    ok: boolean;
    done: boolean;
    msg: string;
    cookie?: QunCookie;
}>;
/** 退出登录：清掉浏览器 profile 里的 QQ 登录态（一般不用，留着以后"切换账号"用） */
export declare function clearBrowserProfile(dataRoot: string): void;
//# sourceMappingURL=qun-login.d.ts.map