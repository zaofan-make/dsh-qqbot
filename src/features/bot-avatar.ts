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
let cached: string | null = null;

const AVATAR_MD_SIZE = 50;   // 显示尺寸（px）
const AVATAR_SRC_SIZE = 100; // 取图尺寸（qlogo 支持 40/100/640）

/** 头像缓存文件（{dataRoot}/.qqbot/bot-self.json） */
function cacheFile(dataRoot: string): string {
  return join(dataRoot, '.qqbot', 'bot-self.json');
}

/** 读磁盘缓存（含 /users/@me 的 avatar 与捡到的 openid） */
export function loadBotSelf(dataRoot: string): { avatar?: string; openid?: string; username?: string } {
  try {
    const f = cacheFile(dataRoot);
    if (!existsSync(f)) return {};
    const o = JSON.parse(readFileSync(f, 'utf8'));
    if (o && typeof o === 'object') {
      if (o.avatar) cached = String(o.avatar);
      return o as { avatar?: string; openid?: string; username?: string };
    }
  } catch { /* ignore */ }
  return {};
}

/** 写磁盘缓存（合并写） */
export function saveBotSelf(dataRoot: string, patch: { avatar?: string; openid?: string; username?: string }): void {
  try {
    const f = cacheFile(dataRoot);
    mkdirSync(dirname(f), { recursive: true });
    const old = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
    const next = { ...(old && typeof old === 'object' ? old : {}), ...patch };
    writeFileSync(f, JSON.stringify(next, null, 2), 'utf8');
    if (patch.avatar) cached = String(patch.avatar);
  } catch { /* ignore */ }
}

/**
 * 用 appId + openid 拼 qlogo 头像（兜底路径）。
 * ⚠️ 必须 32 位 openid；19 位的 `id` 拼出来只有 1.5KB 的默认占位图（2026-10-30 实测）。
 */
export function qlogoOf(appId: string, openid: string, size = AVATAR_SRC_SIZE): string {
  const a = String(appId ?? '').trim();
  const o = String(openid ?? '').trim();
  if (!a || !o) return '';
  return `https://thirdqq.qlogo.cn/qqapp/${encodeURIComponent(a)}/${encodeURIComponent(o)}/${size}`;
}

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
export function botAvatarMarkdown(dataRoot: string, appId: string): string {
  const self = loadBotSelf(dataRoot);
  const url = cached || self.avatar || (self.openid ? qlogoOf(appId, self.openid) : '');
  // 顺手踢一脚后台刷新（不 await、不阻塞、失败静默）
  try { kickAvatarRefresh(dataRoot, appId); } catch { /* ignore */ }
  if (!url) return '';
  return `![${self.username || '机器人'} #${AVATAR_MD_SIZE}px #${AVATAR_MD_SIZE}px](${url})`;
}

// ══════════════════════════════════════════════════════════════════════════
// 后台刷新（与缓存读取彻底分开）
// ══════════════════════════════════════════════════════════════════════════

/** 拉取 `GET /users/@me` 的能力（由 bootstrap 注入 —— 插件运行时才知道怎么发官方 API 请求） */
type AvatarFetcher = () => Promise<{ avatar?: string; username?: string; openid?: string } | undefined>;
let avatarFetcher: AvatarFetcher | undefined;
/** 注入取头像能力（bootstrap 里调一次） */
export function setAvatarFetcher(fn: AvatarFetcher | undefined): void { avatarFetcher = fn; }

/** 刷新节流：同一实例 5 分钟内最多一次，且不并发 */
const REFRESH_MIN_MS = 5 * 60 * 1000;
let refreshing = false;
let lastRefreshAt = 0;
/** 上次刷新是否因为「没 fetcher」而跳过（避免每发一条就试一遍） */
let noFetcherWarned = false;

/**
 * 后台刷新头像（fire-and-forget）。**任何情况下都不抛、不阻塞调用方**。
 * 触发条件：距上次刷新超过 5 分钟，或当前根本没有可用 URL。
 */
export function kickAvatarRefresh(dataRoot: string, appId: string): void {
  if (refreshing) return;
  if (!avatarFetcher) { noFetcherWarned = true; return; }
  const self = loadBotSelf(dataRoot);
  const has = !!(cached || self.avatar || (self.openid ? qlogoOf(appId, self.openid) : ''));
  const stale = Date.now() - lastRefreshAt > REFRESH_MIN_MS;
  if (has && !stale) return;         // 有值且不旧 → 什么都不做
  refreshing = true;
  lastRefreshAt = Date.now();
  void (async () => {
    try {
      const info = await avatarFetcher!();
      if (!info) return;
      const patch: { avatar?: string; openid?: string; username?: string } = {};
      if (info.avatar) patch.avatar = info.avatar;
      if (info.openid) patch.openid = info.openid;
      if (info.username) patch.username = info.username;
      if (Object.keys(patch).length > 0) saveBotSelf(dataRoot, patch);
    } catch { /* 后台刷新失败就失败，允许这条/这几条消息没头像 */ }
    finally { refreshing = false; }
  })();
}

/** 诊断用：当前缓存状态（不改任何东西） */
export function botAvatarState(dataRoot: string): { url: string; hasFetcher: boolean; refreshing: boolean; lastRefreshAt: number; noFetcherWarned: boolean } {
  const self = loadBotSelf(dataRoot);
  return {
    url: cached || self.avatar || '',
    hasFetcher: !!avatarFetcher,
    refreshing,
    lastRefreshAt,
    noFetcherWarned,
  };
}
