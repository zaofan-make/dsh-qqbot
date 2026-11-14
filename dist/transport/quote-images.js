/**
 * 被引用消息里的**图片预取**（2026-10-01 主人要求：「为什么没尽可能地转换成本地路径」）。
 *
 * 场景：有人引用一张图问"这是啥" —— 那张图我们**可能从没收藏过**（别人发的、闸门外、采集关过），
 *   image-path-cache 与图库台账都查不到 → 引用块里只能回退 QQ 的长链接
 *   （`multimedia.nt.qq.com.cn/download?…&rkey=…`，又长又会过期，AI 读不了图）。
 *
 * 做法：入站时（引用解析之后、**拼上下文之前**）异步把被引用的图片**下载到本地**
 *   `{dataRoot}/.qqbot/referenced/<sha1>.<ext>`，并 `rememberImagePath(url → 本地路径)` ——
 *   之后同步的 buildQuotePart / media-history 就能给出本地路径，AI 直接读图。
 *
 * 边界：只处理 http(s) 的**图片**附件；最多 {@link MAX_IMAGES} 张、每张 {@link TIMEOUT_MS} 超时；
 *   已缓存过的直接跳过；任何失败都静默（引用块照旧回退 URL，不影响主链）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lookupImagePath, rememberImagePath } from '../features/image-path-cache.js';
/** 一次最多预取几张（防有人引用一堆图拖慢入站） */
const MAX_IMAGES = 3;
/** 单张下载超时 */
const TIMEOUT_MS = 8000;
/**
 * 预取目录里保留多少天（★ 2026-11-14 修：原来**只写不删**，长跑后 `.qqbot/referenced/` 会无限涨）。
 * 内容寻址（sha1）所以同一张图不会重复写入；这里只负责回收"再也不会被引用到"的旧文件。
 * 每 24 小时最多清理一次，避免每次入站都读目录。
 */
const KEEP_DAYS = 7;
const PRUNE_INTERVAL_MS = 24 * 3600 * 1000;
let lastPruneAt = 0;
function isImageAtt(a) {
    const ct = String(a?.contentType ?? '').toLowerCase();
    const url = String(a?.url ?? '');
    if (ct.startsWith('image/'))
        return true;
    // contentType 不可信（QQ 群聊图片实测会报 'file'）→ 再用文件名 / URL 扩展名兜底
    const name = String(a?.filename ?? url).split(/[?#]/)[0] ?? '';
    return /\.(jpe?g|png|gif|webp|bmp)$/i.test(name);
}
function extOf(a) {
    const ct = String(a?.contentType ?? '').toLowerCase();
    if (ct.includes('png'))
        return '.png';
    if (ct.includes('gif'))
        return '.gif';
    if (ct.includes('webp'))
        return '.webp';
    if (ct.includes('bmp'))
        return '.bmp';
    const name = String(a?.filename ?? a?.url ?? '').split(/[?#]/)[0] ?? '';
    const m = name.match(/\.(jpe?g|png|gif|webp|bmp)$/i);
    return m && m[1] ? '.' + m[1].toLowerCase() : '.jpg';
}
/**
 * 把被引用的图片预取到本地（幂等；已缓存/非图片/非 http 的直接跳过）。
 * @returns 成功预取的张数
 */
export async function prefetchQuoteImages(quote, dataRoot, logger) {
    const atts = Array.isArray(quote?.attachments) ? quote.attachments : [];
    if (!atts.length || !dataRoot)
        return 0;
    let done = 0;
    // ★★ 2026-11-14（CodeRabbit）：**先清理，再检查/写入** ——
    //   原来清理在写入之后：同内容文件刚好超过 KEEP_DAYS 且 URL 缓存已过期时，
    //   会「判已存在 → 跳过写入 → 立刻被清理删掉 → 仍然 remember 这个已删路径」。
    //   放到循环前（内部有 24h 限流，只会真扫一次）。
    try {
        pruneOldReferenced(join(dataRoot, '.qqbot', 'referenced'));
    }
    catch { /* 清理失败不影响预取 */ }
    for (const a of atts) {
        if (done >= MAX_IMAGES)
            break;
        const url = String(a?.url ?? '').trim();
        if (!/^https?:\/\//i.test(url))
            continue; // 已经是本机路径 / 非 http → 无需预取
        if (!isImageAtt(a))
            continue;
        if (lookupImagePath(url))
            continue; // 缓存已有 → 同步侧本来就能命中
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!res.ok) {
                logger?.debug?.(`[引用图片预取] HTTP ${res.status}: ${url.slice(0, 80)}`);
                continue;
            }
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length === 0 || buf.length > 12 * 1024 * 1024) {
                logger?.debug?.(`[引用图片预取] 体积异常(${buf.length}B), 跳过`);
                continue;
            }
            const dir = join(dataRoot, '.qqbot', 'referenced');
            mkdirSync(dir, { recursive: true });
            const sha1 = createHash('sha1').update(buf).digest('hex').slice(0, 12);
            const file = join(dir, sha1 + extOf(a));
            // ★ 内容寻址：同内容只写一次（原来每次都 writeFileSync 覆盖同名文件，白写）
            if (!existsSync(file))
                writeFileSync(file, buf);
            rememberImagePath(url, file);
            done++;
            logger?.debug?.(`[引用图片预取] 已落盘 ${file} (${buf.length}B)`);
        }
        catch (e) {
            logger?.debug?.(`[引用图片预取] 失败(忽略): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return done;
}
/** 回收预取目录里的旧图片（超过 {@link KEEP_DAYS} 天；24 小时内最多扫一次） */
function pruneOldReferenced(dir) {
    const now = Date.now();
    if (now - lastPruneAt < PRUNE_INTERVAL_MS)
        return;
    lastPruneAt = now;
    const cutoff = now - KEEP_DAYS * 24 * 3600 * 1000;
    try {
        for (const name of readdirSync(dir)) {
            const f = join(dir, name);
            try {
                if (statSync(f).mtimeMs < cutoff)
                    unlinkSync(f);
            }
            catch { /* 单个失败不影响其它 */ }
        }
    }
    catch { /* 目录读不了就算了，别影响预取 */ }
}
//# sourceMappingURL=quote-images.js.map