import { existsSync } from 'node:fs';
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 800;
const cache = new Map();
/**
 * QQ 图片 URL 的"稳定键"（2026-09-24 修）。
 *
 * 实测：同一张图两次推送的 URL 里 `rkey`(临时凭证) 会变，**连 fileid 的后半段也不同**，
 * 只有 **前 40 字符**稳定：
 *   ...fileid=EhSNej89…FIP8KK[JXGg_SEhpcDMgRwcm9k]…&rkey=CAISONPs…
 *   ...fileid=EhSNej89…FIP8KK[PDVtrGFhpcDMgRwcm9k]…&rkey=CAQSODOc…
 * 只按完整 URL 缓存 → 每次都是 miss → 消息里只能显示长 URL（AI 还得自己下载、通常下不动）。
 */
function stableKey(u) {
    try {
        const parsed = new URL(String(u));
        const fid = parsed.searchParams.get('fileid');
        if (fid)
            return 'fid:' + fid.slice(0, 40);
    }
    catch { /* 非标准 URL */ }
    return undefined;
}
/** 记一条 URL → 本地路径(下载成功时调用) */
export function rememberImagePath(url, localPath) {
    if (!url || !localPath)
        return;
    const e = { p: localPath, t: Date.now() };
    cache.set(url, e);
    // 同时按稳定键存一份：URL 变了(新 rkey)也能命中
    const k = stableKey(url);
    if (k)
        cache.set(k, e);
    if (cache.size > MAX_ENTRIES) {
        // Map 保留插入顺序 → 最旧的就是第一个
        const over = cache.size - MAX_ENTRIES;
        let i = 0;
        for (const k of cache.keys()) {
            cache.delete(k);
            if (++i >= over)
                break;
        }
    }
}
/** 查本地路径(没有/过期 → undefined, 调用方回退原始 URL) */
export function lookupImagePath(url, logger) {
    if (!url)
        return undefined;
    // 先按完整 URL 查，miss 再按稳定键(fileid 前缀)查 —— 后者能跨 rkey/fileid 尾部变化命中
    const k = stableKey(url);
    const e = cache.get(url) ?? (k ? cache.get(k) : undefined);
    if (!e)
        return undefined;
    if (Date.now() - e.t > TTL_MS) {
        cache.delete(url);
        logger?.debug(`[img-path] 缓存过期, 回退 URL: ${url.slice(0, 60)}…`);
        return undefined;
    }
    // ★★ 2026-11-14（CodeRabbit）：缓存命中也要**确认文件还在** ——
    //   quote-images 的定期回收会删掉超过 KEEP_DAYS 的文件，而缓存时间没到，
    //   这里就会把一个已删除的路径返回给上层（AI 读图直接失败，还查不出原因）。
    if (!existsSync(e.p)) {
        cache.delete(url);
        if (k)
            cache.delete(k);
        logger?.debug(`[img-path] 缓存指向的文件已不存在, 回退 URL: ${String(e.p).slice(0, 80)}`);
        return undefined;
    }
    return e.p;
}
/** 当前缓存条数(诊断用) */
export function imagePathCacheSize() {
    return cache.size;
}
//# sourceMappingURL=image-path-cache.js.map