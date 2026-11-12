/**
 * image-url-ledger.ts — 「本地文件名(图库 id) ↔ QQ 图片链接」台账（兜底用）
 *
 * 背景（2026-09-13 主人要求）: 入站消息的图片现在直接给**本地路径**，但本地文件会消失 ——
 *   ● 候选区超 500 张滚动清理（文件搬进回收站，老路径失效）
 *   ● 图库整理 / 手动删除
 * 一旦路径失效，dock/网页端就什么都显示不出来。于是留一本**最近 1000 张图**的
 *   「图库 id → 当时那条 QQ 链接」台账兜底：本地读不到就拿 QQ 链接顶上。
 * 只记图片（主人明确: 音频/视频/文件不用）。
 *
 * 存储: `{表情包目录}/image-url-ledger.jsonl`，一行一条 `{"id","url","at"}`，**追加写**(便宜)，
 *   查表时从后往前找最新一条；文件超过 COMPACT_BYTES 时压缩成"最新 1000 条唯一 id"。
 *   ⚠️ 格式是跨进程契约: 宿主侧 settings-host.js 里有同格式的同步只读实现（那边不能 await）。
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, extname, join, sep } from 'node:path';
/** 台账文件名（放在表情包目录里，跟图库同生共死） */
export const IMAGE_URL_LEDGER = 'image-url-ledger.jsonl';
/** 上限（主人定: 1000 条） */
const MAX_ENTRIES = 1000;
/** 超过这个体积就压缩一次（追加太多次后回收） */
const COMPACT_BYTES = 1.5 * 1024 * 1024;
/** 台账绝对路径 */
export function ledgerFileOfStickerDir(stickerDir) {
    return join(stickerDir, IMAGE_URL_LEDGER);
}
/** 图库文件名 → id（`1456cfc6a256.jpg` → `1456cfc6a256`） */
export function stickerIdOfFile(file) {
    const b = basename(String(file || ''));
    const e = extname(b);
    return e ? b.slice(0, -e.length) : b;
}
/**
 * 从图片文件路径推回表情包目录:
 * `…\表情包\lib\candidate\1456cfc6a256.jpg` → `…\表情包`
 * （找不到 `lib` 段就退回上一级，宁可错也别抛异常）
 */
export function stickerDirFromImagePath(imgPath) {
    const p = String(imgPath || '');
    const s = p.includes('\\') ? '\\' : sep;
    const parts = p.split(/[\\/]/);
    const i = parts.lastIndexOf('lib');
    if (i > 0)
        return parts.slice(0, i).join(s);
    return dirname(p);
}
/** 记录一条「id → QQ 链接」（追加写，失败静默；不影响主链） */
export function recordImageUrl(stickerDir, id, url) {
    const sid = stickerIdOfFile(id);
    if (!sid || !/^https?:\/\//i.test(String(url || '')))
        return;
    const file = ledgerFileOfStickerDir(stickerDir);
    try {
        mkdirSync(stickerDir, { recursive: true });
        appendFileSync(file, JSON.stringify({ id: sid, url: String(url), at: Date.now() }) + '\n', 'utf8');
    }
    catch {
        return; // 台账纯兜底，写不进去也不影响收藏/入站
    }
    try {
        if (statSync(file).size > COMPACT_BYTES)
            compact(file);
    }
    catch { /* ignore */ }
}
/** 压缩: 只留最新 MAX_ENTRIES 条唯一 id（新→旧顺序不变，最新的在最后） */
function compact(file) {
    // ★ 2026-11-12 性能：**只读尾部**再解析，不把整个文件读进内存。
    //   压缩的目标本来就是"保留最新 MAX_ENTRIES 条"，头部那几 MB 的旧记录读进来也全会被丢掉。
    //   取 `MAX_ENTRIES * 4` 条行的保守切片（单行 ~150 字节 ⇒ 600KB 级别），
    //   既保证够用，又避免文件长大后一次同步读几十 MB 卡住事件循环。
    const items = loadTail(file, MAX_ENTRIES * 4);
    const uniq = new Map();
    for (const it of items) {
        if (uniq.has(it.id))
            uniq.delete(it.id); // 重插到末尾 = 视为更新
        uniq.set(it.id, it);
    }
    const kept = [...uniq.values()].slice(-MAX_ENTRIES);
    try {
        // ★ 2026-11-12：改成 tmp + rename 原子写（原来直接覆盖）。
        //   直接覆盖的窗口里进程被杀/断电会留半个文件 ⇒ 下次 loadAll 只读到一部分，
        //   「图库 id → QQ 链接」的兜底台账就静默丢一批。rename 同分区是原子的。
        const tmp = file + '.tmp-' + Date.now();
        writeFileSync(tmp, kept.map(x => JSON.stringify(x)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
        renameSync(tmp, file);
    }
    catch { /* ignore */ }
}
/** 读全量（坏行跳过） */
function loadAll(file) {
    let txt = '';
    try {
        txt = readFileSync(file, 'utf8');
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of txt.split('\n')) {
        const s = line.trim();
        if (!s)
            continue;
        try {
            const o = JSON.parse(s);
            if (o && typeof o.id === 'string' && typeof o.url === 'string')
                out.push({ id: o.id, url: o.url, at: Number(o.at) || 0 });
        }
        catch { /* 坏行跳过 */ }
    }
    return out;
}
// ── 同步查表 + 缓存（按 mtime/size 失效，跨进程也能拿到最新） ──
const cache = new Map();
function indexOfFile(file) {
    let key = 'missing';
    try {
        const st = statSync(file);
        key = `${st.mtimeMs}:${st.size}`;
    }
    catch { /* 文件还不存在 */ }
    const hit = cache.get(file);
    if (hit && hit.key === key)
        return hit.index;
    const index = new Map();
    for (const it of loadAll(file))
        index.set(it.id, it.url); // 后出现的覆盖前面的 = 最新链接
    cache.set(file, { key, index });
    return index;
}
/**
 * 只读文件**尾部**若干行（性能用；2026-11-12）。
 *
 * 为什么不做真正的 seek：`image-url-ledger.jsonl` 是追加写的行文本，
 * 从末尾按字节窗口回溯 + 找到第一个换行就够，不需要完整 fs 定位 API。
 * 拿不到（文件小于窗口）就退化成整份读 —— 结果一致。
 */
function loadTail(file, maxLines) {
    try {
        const st = statSync(file);
        // 单行按 200 字节保守估；窗口最小 64KB，最大 4MB
        const window = Math.min(4 * 1024 * 1024, Math.max(64 * 1024, maxLines * 200));
        if (st.size <= window)
            return loadAll(file);
        const fd = openSync(file, 'r');
        try {
            const buf = Buffer.alloc(window);
            readSync(fd, buf, 0, window, st.size - window);
            let txt = buf.toString('utf8');
            const nl = txt.indexOf('\n');
            if (nl >= 0)
                txt = txt.slice(nl + 1); // 丢掉被截断的半行
            const out = [];
            for (const line of txt.split('\n')) {
                const t = line.trim();
                if (!t)
                    continue;
                try {
                    out.push(JSON.parse(t));
                }
                catch { /* 坏行跳过 */ }
            }
            return out;
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return loadAll(file);
    }
}
/** 按「图库 id」或「图片文件路径」查 QQ 链接（查不到返回 undefined） */
export function lookupImageUrl(stickerDir, idOrPath) {
    const id = stickerIdOfFile(idOrPath);
    if (!id)
        return undefined;
    return indexOfFile(ledgerFileOfStickerDir(stickerDir)).get(id);
}
/** 直接给图片文件路径也能查（内部自己推表情包目录） */
export function lookupImageUrlByPath(imgPath) {
    return lookupImageUrl(stickerDirFromImagePath(imgPath), imgPath);
}
// ── 反向查: QQ 链接 → 图库 id（省 token: 历史里那条几百字符的长链接能换成短标记/本地路径） ──
// 2026-09-24 修复: QQ 图片 URL 的 fileid 参数对同一张图是**稳定的**，但完整 URL 会因
// 临时 rkey 之类每次推送都变 → 只按完整 URL 精确匹配会永远查不到(历史里全被折叠成 [图片])。
// 故额外建一份 fileid → id 的反向索引，查找时先按 fileid 命中，再退回完整 URL。
function stableUrlKey(u) {
    try {
        const p = new URL(String(u));
        const fid = p.searchParams.get('fileid');
        if (fid)
            return 'fid:' + fid.slice(0, 40); // 实测: 同一张图两推的 fileid 只有前 40 字符稳定
    }
    catch { /* 非标准 URL */ }
    return undefined;
}
const revCache = new Map();
/** QQ 链接 → 图库 id（查不到返回 undefined; 反向索引按 mtime/size 缓存） */
export function lookupStickerIdByUrl(stickerDir, url) {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u))
        return undefined;
    const file = ledgerFileOfStickerDir(stickerDir);
    let key = 'missing';
    try {
        const st = statSync(file);
        key = `${st.mtimeMs}:${st.size}`;
    }
    catch { /* 没有台账 */ }
    const hit = revCache.get(file);
    const sk = stableUrlKey(u);
    if (hit && hit.key === key)
        return (sk ? hit.fids.get(sk) : undefined) ?? hit.rev.get(u);
    const rev = new Map();
    const fids = new Map();
    for (const it of loadAll(file)) {
        rev.set(it.url, it.id);
        const k = stableUrlKey(it.url);
        if (k)
            fids.set(k, it.id);
    }
    revCache.set(file, { key, rev, fids });
    return (sk ? fids.get(sk) : undefined) ?? rev.get(u);
}
//# sourceMappingURL=image-url-ledger.js.map