/** 读磁盘缓存（含 /users/@me 的 avatar 与捡到的 openid） */
export declare function loadBotSelf(dataRoot: string): {
    avatar?: string;
    openid?: string;
    username?: string;
};
/** 写磁盘缓存（合并写） */
export declare function saveBotSelf(dataRoot: string, patch: {
    avatar?: string;
    openid?: string;
    username?: string;
}): void;
/**
 * 用 appId + openid 拼 qlogo 头像（兜底路径）。
 * ⚠️ 必须 32 位 openid；19 位的 `id` 拼出来只有 1.5KB 的默认占位图（2026-10-30 实测）。
 */
export declare function qlogoOf(appId: string, openid: string, size?: number): string;
/**
 * 取「机器人头像的 markdown 首行」（不含换行）。取不到返回空串（调用方直接跳过，不塞占位）。
 *
 * ★★ 2026-11-06（主人定：「刷新和缓存分开」+「不要让消息等待」+「允许个别消息没头像」）：
 *   **这个函数是同步的、只读缓存、绝不等待网络**。
 *   签名 URL 会过期，但刷新走 {@link kickAvatarRefresh} 在**后台**做：
 *     · 本回合读到的是上一次刷新留下的值（可能是旧的、也可能为空）
 *     · 允许这条消息**没有头像** —— 换来的是出站零延迟
 *     · 刷新成功后写盘 + 更新内存 ⇒ **下一条消息**才用上
 *
 *   为什么不用本地文件：markdown 里的本地图要先上传成 `qqbot-media://`，
 *   会占「单机器人最多 100 张」的素材配额（主人明确否掉）。
 */
export declare function botAvatarMarkdown(dataRoot: string, appId: string): string;
/** 拉取 `GET /users/@me` 的能力（由 bootstrap 注入 —— 插件运行时才知道怎么发官方 API 请求） */
type AvatarFetcher = () => Promise<{
    avatar?: string;
    username?: string;
    openid?: string;
} | undefined>;
/** 注入取头像能力（bootstrap 里调一次） */
export declare function setAvatarFetcher(fn: AvatarFetcher | undefined): void;
/**
 * 后台刷新头像（fire-and-forget）。**任何情况下都不抛、不阻塞调用方**。
 * 触发条件：距上次刷新超过 5 分钟，或当前根本没有可用 URL。
 */
export declare function kickAvatarRefresh(dataRoot: string, appId: string): void;
/** 诊断用：当前缓存状态（不改任何东西） */
export declare function botAvatarState(dataRoot: string): {
    url: string;
    hasFetcher: boolean;
    refreshing: boolean;
    lastRefreshAt: number;
    noFetcherWarned: boolean;
};
export {};
//# sourceMappingURL=bot-avatar.d.ts.map