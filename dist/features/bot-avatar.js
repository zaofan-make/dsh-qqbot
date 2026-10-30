/**
 * bot-avatar.ts —— 机器人自己的头像（2026-10-30）
 *
 * 为什么需要：**官方机器人在私聊里没有头像**（群里才有），主人希望私聊出站时用正文首行补一张，
 * 让对话一眼看出来是谁在说话。开关 `c2cShowBotAvatar`（默认关）。
 *
 * 取图有两条路（按优先级）：
 *   ① `GET /users/@me` 返回的 `avatar` —— 带签名的完整 URL，直接能用，**不依赖任何人的 @**
 *   ② 退回用 appId + 机器人 openid 拼 qlogo：`https://thirdqq.qlogo.cn/qqapp/{appId}/{openid}/100`
 *      （openid 只能从"别人 @ 机器人"的消息里捡，捡到就缓存下来）
 *
 * 尺寸：主人实测「100 再小一半」⇒ markdown 里标 `#50px`，底图仍取 100（缩放比取 40 更清晰）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** 模块级缓存（每次发消息都问一遍太浪费） */
let cached = null;
const AVATAR_MD_SIZE = 50; // 显示尺寸（px）
const AVATAR_SRC_SIZE = 100; // 取图尺寸（qlogo 支持 40/100/640）
/** 头像缓存文件（{dataRoot}/.qqbot/bot-self.json） */
function cacheFile(dataRoot) {
    return join(dataRoot, '.qqbot', 'bot-self.json');
}
/** 读磁盘缓存（含 /users/@me 的 avatar 与捡到的 openid） */
export function loadBotSelf(dataRoot) {
    try {
        const f = cacheFile(dataRoot);
        if (!existsSync(f))
            return {};
        const o = JSON.parse(readFileSync(f, 'utf8'));
        if (o && typeof o === 'object') {
            if (o.avatar)
                cached = String(o.avatar);
            return o;
        }
    }
    catch { /* ignore */ }
    return {};
}
/** 写磁盘缓存（合并写） */
export function saveBotSelf(dataRoot, patch) {
    try {
        const f = cacheFile(dataRoot);
        mkdirSync(dirname(f), { recursive: true });
        const old = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
        const next = { ...(old && typeof old === 'object' ? old : {}), ...patch };
        writeFileSync(f, JSON.stringify(next, null, 2), 'utf8');
        if (patch.avatar)
            cached = String(patch.avatar);
    }
    catch { /* ignore */ }
}
/**
 * 用 appId + openid 拼 qlogo 头像（兜底路径）。
 * ⚠️ 必须 32 位 openid；19 位的 `id` 拼出来只有 1.5KB 的默认占位图（2026-10-30 实测）。
 */
export function qlogoOf(appId, openid, size = AVATAR_SRC_SIZE) {
    const a = String(appId ?? '').trim();
    const o = String(openid ?? '').trim();
    if (!a || !o)
        return '';
    return `https://thirdqq.qlogo.cn/qqapp/${encodeURIComponent(a)}/${encodeURIComponent(o)}/${size}`;
}
/**
 * 取「机器人头像的 markdown 首行」（不含换行）。取不到返回空串（调用方直接跳过，不塞占位）。
 */
export function botAvatarMarkdown(dataRoot, appId) {
    const self = loadBotSelf(dataRoot);
    const url = cached || self.avatar || (self.openid ? qlogoOf(appId, self.openid) : '');
    if (!url)
        return '';
    return `![${self.username || '机器人'} #${AVATAR_MD_SIZE}px #${AVATAR_MD_SIZE}px](${url})`;
}
//# sourceMappingURL=bot-avatar.js.map