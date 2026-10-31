/**
 * md-media-rewrite.ts — 出站自动把「本地图片 markdown」换成 QQ 能渲染的引用（2026-10-21）
 *
 * 主人口径：正文/卡片里直接写 `![说明](D:/path/x.jpg)`，发到 QQ 时自动：
 *   上传（prepare→PUT→complete→list 核实）→ 解析宽高 → 改写 `![文件名 #Wpx #Hpx](url)`
 *   配额满 100 张自动删最早。
 *
 * 兼容各种写法：正/反斜杠、尖括号、路径带空格、file://、尾部标题。
 * 只处理本地路径；http(s)/qqbot-media 原样放过。失败保留原样，绝不吞正文。
 */
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { uploadMarkdownImage, listMarkdownImages, deleteMarkdownImage } from './md-media.js';
function diag(msg) {
    try {
        appendFileSync(join(homedir(), '.dsh', 'md-media-diag.log'), new Date().toISOString() + ' ' + msg + String.fromCharCode(10));
    }
    catch { /* ignore */ }
}
let targetFactory;
let lastResult;
export function lastMediaRewrite() { return lastResult; }
function setLast(r) {
    lastResult = r;
    try {
        globalThis[Symbol.for('im-qqbot.md-media.last')] = r;
    }
    catch { /* ignore */ }
}
export function setMaterialTargetFactory(fn) {
    targetFactory = fn;
}
/** 尽量吃下各种写法：尖括号、空格、反斜杠、尾部标题都可选 */
const IMG_RE = /!\[([^\]]*)\]\(\s*<?((?:[^()"\n]|\[()])+?)>?(?:\s+"[^"\n]*")?\s*\)/g;
const MAX_IMAGES = 100;
function isLocalImagePath(u) {
    if (!u)
        return false;
    if (/^(https?:|qqbot-media:|data:)/i.test(u))
        return false;
    if (/^file:\/\//i.test(u))
        return true;
    // 2026-10-26 修：原来只认 `D:/` 正斜杠，Windows 原生的 `D:\` 反斜杠会被判成"远程图"直接跳过，
    //   表现为正文写反斜杠路径时根本不触发上传（diag 日志里就是 no local image）。
    if (/^[A-Za-z]:[\\/]/.test(u))
        return true;
    if (u.startsWith('/'))
        return true;
    return false;
}
function fromFileUrl(u) {
    try {
        const p = decodeURIComponent(u.replace(/^file:\/\/\/?/i, ''));
        return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
    }
    catch {
        return u.replace(/^file:\/\/\/?/i, '');
    }
}
/** 扫出文本里所有「本地图 markdown」（顺序与出现顺序一致） */
function localMarkdownImages(text) {
    if (!text || text.indexOf('![') < 0)
        return [];
    const out = [];
    IMG_RE.lastIndex = 0;
    let m;
    while ((m = IMG_RE.exec(text)) !== null) {
        const src = String(m[2] ?? '').trim();
        if (isLocalImagePath(src))
            out.push({ raw: m[0], alt: String(m[1] ?? ''), src });
    }
    return out;
}
/**
 * 兜底降级（2026-10-30）：把「本地图 markdown」改写成 `[MEDIA:image|本地路径]`。
 *   素材上传不可用 / 单张上传失败时用 —— 让图走普通发图通道(file_type=1)真发出去，
 *   而不是把 `![说明](D:\...\x.jpg)` 这段语法原样当文本发给群友。
 */
export function localMarkdownImagesToMediaMarkers(text) {
    const hits = localMarkdownImages(text);
    if (hits.length === 0)
        return text;
    let out = text;
    for (const h of hits) {
        const p = (/^file:\/\//i.test(h.src) ? fromFileUrl(h.src) : h.src).replace(/\|/g, '');
        out = out.split(h.raw).join('[MEDIA:image|' + p + ']');
    }
    return out;
}
/**
 * 兜底降级（2026-10-31，主人实测截图）：把**任意** markdown 图片语法从要当纯文本发的内容里拿掉。
 *
 * 为什么要它：`localMarkdownImagesToMediaMarkers` 只认**本地路径**，而上传成功的图已经被改写成
 * `qqbot-media://image/v1/...` 远程引用 —— 那种引用**只有 markdown 消息（msg_type=2）能渲染**，
 * 一旦 markdown 通道失败、回落到普通文本，就会把整段
 * `![说明 #350 #1500px](qqbot-media://image/v1/xxx)` 原样发到群里（群友看到一堆语法）。
 *
 * 处理策略（尽量不丢信息）：
 *  - 本地路径的图 → 仍交给 `[MEDIA:image|路径]`（走普通发图通道真发出去）；
 *  - 已经是 `qqbot-media://` / http(s) 的 → 纯文本发不出去，就把整段语法换成 `[图片]`（保留 alt 作说明）。
 */
export function stripMarkdownImagesForPlainText(text) {
    return String(text ?? '')
        // ![alt](src) —— alt 里可能有换行/尺寸注释，src 里不含右括号（QQ 引用串是 base64-ish）
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => {
        if (/^file:\/\//i.test(src) || /^[A-Za-z]:[\\/]/.test(src) || src.startsWith('\\\\')) {
            const p = (/^file:\/\//i.test(src) ? fromFileUrl(src) : src).replace(/\|/g, '');
            return '[MEDIA:image|' + p + ']';
        }
        const name = String(alt ?? '').replace(/#\s*\d+px/g, '').replace(/\s+/g, ' ').trim();
        return name ? `[图片：${name}]` : '[图片]';
    })
        .trim();
}
async function ensureQuota(target, need) {
    let deleted = 0;
    for (let guard = 0; guard < 20; guard++) {
        const r = await listMarkdownImages(target);
        if (!r.ok)
            return deleted;
        const d = (r.data ?? {});
        const list = Array.isArray(d.images) ? d.images : [];
        const total = Number(d.total ?? list.length);
        if (total + need <= MAX_IMAGES)
            return deleted;
        const oldest = list
            .filter((x) => typeof x.image_id === 'string' && x.image_id)
            .sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0))[0];
        if (!oldest || !oldest.image_id)
            return deleted;
        const del = await deleteMarkdownImage(target, String(oldest.image_id));
        if (!del.ok)
            return deleted;
        deleted += 1;
    }
    return deleted;
}
/** 取文件名（不含目录），用作 alt —— 实测 alt 用纯文件名时 QQ 才稳定渲染 */
function baseName(p) {
    const parts = p.split(/[\/]/);
    const last = parts.length ? parts[parts.length - 1] : '';
    return (last || 'image').trim() || 'image';
}
/**
 * 扫描文本里的 markdown 图片；本地路径的替换成 QQ 引用。
 * @param explicitTarget 调用方自己的句柄（优先）；不传则用全局 factory
 */
export async function rewriteLocalMarkdownImages(text, explicitTarget) {
    if (!text || text.indexOf('![') < 0)
        return text;
    const target = explicitTarget ?? targetFactory?.();
    if (!target) {
        // 2026-10-30: 没有素材句柄不再原样放行 —— 降级成 [MEDIA:image|本地路径]，
        //   交给普通发图通道把图真发出去（以前这里 return text，markdown 语法被当纯文本发给群友）
        const hits = localMarkdownImages(text);
        diag('no target（没有可用的素材句柄）→ 降级 [MEDIA:image] x' + hits.length);
        setLast({ matched: hits.length, converted: 0, failed: 0, at: Date.now() });
        return localMarkdownImagesToMediaMarkers(text);
    }
    const matches = [];
    IMG_RE.lastIndex = 0;
    let m;
    while ((m = IMG_RE.exec(text)) !== null) {
        const alt = String(m[1] ?? '');
        const src = String(m[2] ?? '').trim();
        if (isLocalImagePath(src))
            matches.push({ raw: m[0], alt, src });
    }
    if (matches.length === 0) {
        // 文本里本来就是 http(s)/qqbot-media 的图 —— 正常情况，不报错
        diag('no local image（全是远程/引用图，跳过）');
        setLast({ matched: 0, converted: 0, failed: 0, at: Date.now() });
        return text;
    }
    diag('matched ' + matches.length + ' local image(s): ' + matches.map((x) => x.src).join(' | '));
    await ensureQuota(target, matches.length);
    let out = text;
    let converted = 0;
    let failed = 0;
    for (const item of matches) {
        const path = /^file:\/\//i.test(item.src) ? fromFileUrl(item.src) : item.src;
        try {
            const up = await uploadMarkdownImage(target, path);
            if (!up.ok || !up.url) {
                diag('upload fail: ' + path + ' -> ' + String(up.msg || ''));
                failed += 1;
                continue;
            }
            diag('uploaded: ' + path + ' -> ' + String(up.url).slice(0, 60));
            const dim = up.width && up.height ? ' #' + up.width + 'px #' + up.height + 'px' : '';
            // 2026-10-22（主人口径）：源写法就是 ![说明 #宽px #高px](本地路径) ——
            //   转换后**保留原说明**（剥掉里面的 #Wpx #Hpx），再拼上真实解析出的尺寸。
            const srcAlt = String(item.alt || '').replace(/#s*d+s*px/gi, '').trim();
            const alt = srcAlt || baseName(path);
            const imgSrc = String(up.previewUrl || up.url);
            out = out.split(item.raw).join('![' + alt + dim + '](' + imgSrc + ')');
            converted += 1;
        }
        catch { /* 单张失败不影响其它 */ }
    }
    // 2026-10-30: 有图没传成功也不留 markdown 语法 —— 没转换成 qqbot-media 的本地图降级成
    //   [MEDIA:image|本地路径]，走普通发图通道（已转换的那些是 qqbot-media:// 引用，不会被碰到）
    if (failed > 0)
        out = localMarkdownImagesToMediaMarkers(out);
    setLast({ matched: matches.length, converted, failed, at: Date.now() });
    return out;
}
// 暴露给扩展工具（send_md 等）做"先重写、再决定发不发"
try {
    globalThis[Symbol.for('im-qqbot.md-media.rewrite')] =
        (text, target) => rewriteLocalMarkdownImages(text, target);
}
catch { /* ignore */ }
//# sourceMappingURL=md-media-rewrite.js.map