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
 */
export declare function botAvatarMarkdown(dataRoot: string, appId: string): string;
//# sourceMappingURL=bot-avatar.d.ts.map