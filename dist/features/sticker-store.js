/**
 * sticker-store.ts — 表情包图库存储服务（P0 底座）
 *
 * 职责：把 QQ 群里的图片消息自动收藏为本地表情包库。
 *  - 安全下载（仅 HTTPS + SSRF 防护 + 大小上限 + 超时）
 *  - SHA-1 指纹去重（同图只存一份）
 *  - 分层目录 lib/candidate | library | negative + index.json 元数据
 *  - search/list 供 list_stickers 工具查询
 *
 * ⚠️ 本地手改功能（fork 新增，SDK 无此能力）：维护清单见工作区根《插件改动维护注意事项.md》。
 * 运行时数据根默认 = {agent cwd}/表情包（config.sticker.dataDir 可覆盖）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import * as dns from 'node:dns';
/**
 * 从 QQ 图片/文件 URL 里抠出**稳定的 fileid**(2026-09-13 主人定, 解决"老是重复收藏"):
 * QQ 多媒体 URL 形如
 *   https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=EhS…&rkey=…&spec=0
 * —— **fileid 同一张图恒定不变**, 而 rkey 每次都换(所以直接比 URL 永远查不到"收藏过没")。
 * 传完整 URL 或纯 fileid 都可以。
 */
export function extractQqFileId(input) {
    const s = String(input || '').trim();
    if (!s)
        return '';
    const m = /[?&]fileid=([^&\s]+)/.exec(s);
    if (m && m[1])
        return decodeURIComponent(m[1]);
    return /^Eh[A-Za-z0-9_-]{8,}$/.test(s) ? s : '';
}
/**
 * 感知哈希 dHash(2026-09-13 主人定"又快又准"的图片去重):
 *   图片 → 缩成 9×8 灰度 → 逐行比较相邻像素明暗 → 64 位指纹(16 位 hex)。
 * 看的是**画面结构**而不是字节 → QQ 重压缩/改尺寸/转格式过的同一张图也能认出来。
 * 复用**宿主已装的 sharp**(零新增依赖); sharp 不可用 → 返回 undefined(调用方退化为逐字节 sha1 判重)。
 *
 * ⚠️ 2026-09-13 修(主人报启动刷屏 GLib-GObject-CRITICAL "value 32 ... property 'space' of type
 *    VipsInterpretation"): 根因是调了 sharp 的 `.grayscale()` —— 它会让 libvips 去设
 *    image.space=b-w, 某些 libvips/shar​p 版本组合下这个赋值触发 GLib critical 警告(不影响结果, 但刷屏)。
 *    改为 `.raw()` 直接拿 RGB 原始像素, **自己按亮度公式算灰度**(Y=0.299R+0.587G+0.114B),
 *    既绕开那次色彩空间赋值, 也少一步内部转换。同时设 VIPS_WARNING=0 兜底抑制 libvips 的非致命告警。
 */
export async function computeDHash(buf) {
    // 应急开关(2026-09-13 主人踩过 sharp 拖挂宿主): 设 DSH_QQBOT_NODHASH=1 即可彻底停用 dHash 计算,
    // 去重自动退化为逐字节 sha1(库里已有 dhash 的老记录不受影响)。启动前设一次即可, 不改任何配置。
    if (process.env.DSH_QQBOT_NODHASH === '1')
        return undefined;
    try {
        if (!process.env.VIPS_WARNING)
            process.env.VIPS_WARNING = '0'; // 抑制 libvips 非致命告警刷屏
        const mod = (await import('sharp'));
        const sharp = (mod.default ?? mod);
        const out = await sharp(buf).resize(9, 8, { fit: 'fill' }).raw()
            .toBuffer({ resolveWithObject: true });
        const data = out?.data;
        const ch = out?.info?.channels ?? 3;
        if (!data || data.length < 9 * 8)
            return undefined;
        // 自己算灰度(不调 grayscale(), 避开那条 GLib 警告)
        const gray = (i) => {
            const o = i * ch;
            if (ch >= 3)
                return 0.299 * (data[o] ?? 0) + 0.587 * (data[o + 1] ?? 0) + 0.114 * (data[o + 2] ?? 0);
            return data[o] ?? 0;
        };
        let bits = '';
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                bits += gray(y * 9 + x) > gray(y * 9 + x + 1) ? '1' : '0';
            }
        }
        let hex = '';
        for (let i = 0; i < 64; i += 4)
            hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
        return hex;
    }
    catch {
        return undefined;
    }
}
/** 两个 dHash 的汉明距离(0~64); 任一为空或长度不等 → 999(视为完全不同) */
export function dhashDistance(a, b) {
    if (!a || !b || a.length !== b.length)
        return 999;
    let d = 0;
    for (let i = 0; i < a.length; i++) {
        let x = (parseInt(a[i] ?? '0', 16) || 0) ^ (parseInt(b[i] ?? '0', 16) || 0);
        while (x) {
            d += x & 1;
            x >>= 1;
        }
    }
    return d;
}
/** 搜索词拆分: 空格/中英文逗号/顿号/分号分隔, 去空去重 */
function splitTerms(raw) {
    return Array.from(new Set((raw ?? '').trim().toLowerCase().split(/[\s,，、;；]+/).filter(Boolean)));
}
/** 一条记录可搜索的拼接 hay(标签+描述+来源+发言者+原消息) */
function stickerHay(it) {
    return [it.tags.join(' '), it.desc ?? '', it.sourceGroup ?? '', it.senderName ?? '', it.msgText ?? ''].join(' ').toLowerCase();
}
/** 命中词数(0=无命中); 多词任一命中即可(OR), 命中越多越靠前 */
function hitCount(terms, hay) {
    let n = 0;
    for (const t of terms)
        if (hay.includes(t))
            n += 1;
    return n;
}
/** 图片大小上限（超过不收） */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 下载超时 ms */
const DOWNLOAD_TIMEOUT_MS = 15_000;
/** 目录层 */
const LAYER_DIRS = {
    candidate: 'lib/candidate',
    library: 'lib/library',
    negative: 'lib/negative',
    trash: 'lib/trash',
};
/** content_type → 扩展名 */
const MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
};
// ── SSRF 防护（阻断指向私有/保留地址的下载） ──
const PRIVATE_RANGES = [
    [0x0a000000n, 8], // 10.0.0.0/8
    [0xac100000n, 12], // 172.16.0.0/12
    [0xc0a80000n, 16], // 192.168.0.0/16
    [0x7f000000n, 8], // 127.0.0.0/8
    [0xa9fe0000n, 16], // 169.254.0.0/16
    [0xe0000000n, 4], // 224.0.0.0/4
];
function ipToBigInt(ip) {
    return ip.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}
function isPrivateIP(ip) {
    // IPv4 映射 (::ffff:a.b.c.d) 剥前缀按 IPv4 判
    if (ip.startsWith('::ffff:')) {
        const v4 = ip.slice(7);
        if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
            const val = ipToBigInt(v4);
            return PRIVATE_RANGES.some(([mask, prefix]) => (val >> (32n - BigInt(prefix))) === (mask >> (32n - BigInt(prefix))));
        }
        return true;
    }
    // IPv6 私有/本地/文档段：::1、fe8/fe9/fea/feb(link-local)、fc/fd(ULA)、2001:db8(文档)
    if (/^::1$/.test(ip))
        return true;
    if (/^fe[89ab]c/i.test(ip))
        return true;
    if (/^f[cd]/i.test(ip))
        return true;
    if (/^2001:db8/i.test(ip))
        return true;
    return false;
}
async function assertSafeHostname(hostname) {
    // v4+v6 全查（QQ 多媒体 CDN 域名常只有 AAAA 记录）
    const addrs = await dns.promises.lookup(hostname, { all: true }).catch(() => []);
    if (addrs.length === 0)
        throw new Error(`DNS resolution failed: ${hostname}`);
    for (const { address } of addrs) {
        if (isPrivateIP(address))
            throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${address}`);
    }
}
/** 魔数校验：仅接受 JPEG/PNG/GIF/WEBP/BMP（content_type 不可靠时的兜底，非图不入库） */
function isImageBuffer(buf) {
    if (buf.length < 12)
        return false;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
        return true; // JPEG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
        return true; // PNG
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)
        return true; // GIF
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
        && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)
        return true; // WEBP
    if (buf[0] === 0x42 && buf[1] === 0x4d)
        return true; // BMP
    return false;
}
/**
 * 按**真实字节**判定扩展名（2026-11-13，issue #47）。
 *
 * 为什么必须以魔数为准：QQ 下发的 `content_type` 与图片 URL 后缀**双向都可能说谎**
 * （实测 534 条图库里 7 张不符：png 存了 jpeg、jpg 存了 png）。
 * 宿主 DSH 0.2.2-rc.2 起 `dsh-attachment-local` 会按签名严格校验声明类型：
 *   detected.mediaType !== declaredMediaType ⇒ `IMAGE_TYPE_MISMATCH`
 * 而声明类型**只由扩展名决定** ⇒ 文件名说谎 = 这整张图读不出来（read_image / 发图全废）。
 */
function extFromMagic(buf) {
    if (buf.length < 12)
        return undefined;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
        return 'jpg'; // JPEG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
        return 'png'; // PNG
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)
        return 'gif'; // GIF
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
        && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)
        return 'webp'; // WEBP
    if (buf[0] === 0x42 && buf[1] === 0x4d)
        return 'bmp'; // BMP
    return undefined;
}
/** 只读文件头 12 字节（大图也不整读） */
function readHead12(path) {
    try {
        const fd = openSync(path, 'r');
        try {
            const head = Buffer.alloc(12);
            const n = readSync(fd, head, 0, 12, 0);
            return n > 0 ? head.subarray(0, n) : undefined;
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return undefined;
    }
}
export class StickerStore {
    logger;
    items = new Map();
    saveTimer = null;
    dirty = false;
    dataDir;
    constructor(dataDir, logger) {
        this.logger = logger;
        this.dataDir = dataDir;
        for (const dir of Object.values(LAYER_DIRS)) {
            mkdirSync(join(dataDir, dir), { recursive: true });
        }
        this.loadIndex();
        // ★ 2026-11-13（issue #47）：顺手把历史坏名的图自愈掉（按魔数改名 + 回写 ext）
        this.healExtensionMismatches();
    }
    indexPath() {
        return join(this.dataDir, 'index.json');
    }
    loadIndex() {
        try {
            const raw = readFileSync(this.indexPath(), 'utf8');
            const data = JSON.parse(raw);
            for (const it of data.items ?? []) {
                this.items.set(it.id, it);
            }
        }
        catch {
            this.items = new Map(); // 无 index：全新开始
        }
    }
    /** 防抖落盘 index.json（写操作先改内存） */
    save() {
        this.dirty = true;
        if (this.saveTimer)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            if (!this.dirty)
                return;
            this.dirty = false;
            try {
                const payload = { version: 1, items: [...this.items.values()] };
                writeFileSync(this.indexPath(), JSON.stringify(payload, null, 2), 'utf8');
            }
            catch (err) {
                this.logger?.warn?.(`[sticker-store] index save failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }, 500);
    }
    /** 关闭时立即落盘（进程退出兜底） */
    flush() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (!this.dirty)
            return;
        this.dirty = false;
        try {
            writeFileSync(this.indexPath(), JSON.stringify({ version: 1, items: [...this.items.values()] }, null, 2), 'utf8');
        }
        catch { /* ignore */ }
    }
    /**
     * 老库自愈（2026-11-13，issue #47）：扩展名与真实字节不符的图按魔数改名，并回写 index 的 `ext`。
     *
     * 为什么必须做迁移：宿主 0.2.2 起严格校验声明类型（`IMAGE_TYPE_MISMATCH`），扩展名说谎的图
     * read_image / 发图全废；而**改名后必须回写 ext**，否则 `pathOf()` 还指着改名前那个不存在的路径。
     * 四层都扫（candidate / library / negative / trash）；目标文件已存在时只回写 ext，不覆盖。
     */
    healExtensionMismatches() {
        const NAME_RE = /^([0-9a-f]{6,64})\.([a-z0-9]{2,5})$/i;
        let renamed = 0;
        let relinked = 0;
        for (const [layerKey, rel] of Object.entries(LAYER_DIRS)) {
            const dir = join(this.dataDir, rel);
            let names = [];
            try {
                names = readdirSync(dir);
            }
            catch {
                continue;
            }
            for (const name of names) {
                const m = NAME_RE.exec(name);
                if (!m)
                    continue;
                const id = m[1] ?? '';
                const curExt = (m[2] ?? '').toLowerCase();
                if (!id || !curExt)
                    continue;
                const full = join(dir, name);
                const head = readHead12(full);
                const ext = head ? extFromMagic(head) : undefined;
                if (!ext || ext === curExt)
                    continue;
                const target = join(dir, `${id}.${ext}`);
                try {
                    if (!existsSync(target)) {
                        renameSync(full, target);
                        renamed += 1;
                    }
                    const meta = this.items.get(id);
                    if (meta && meta.ext !== ext) {
                        meta.ext = ext;
                        meta.layer = layerKey;
                        relinked += 1;
                    }
                }
                catch { /* 单张失败不影响其余 */ }
            }
        }
        if (renamed || relinked) {
            this.save();
            this.logger?.info?.(`[sticker-store] 扩展名自愈: 改名 ${renamed} 张, 回写 ext ${relinked} 条`);
        }
    }
    filePathOf(meta) {
        return join(this.dataDir, LAYER_DIRS[meta.layer], `${meta.id}.${meta.ext}`);
    }
    /** 单条路径（给工具/发送用） */
    pathOf(id) {
        const it = this.items.get(id);
        return it ? this.filePathOf(it) : undefined;
    }
    /**
     * 收藏一张图：安全下载 → SHA-1 去重 → 存候选区 → 记 index。
     * 返回 'new' | 'dup' | 'error'。
     */
    async capture(url, input, contentType) {
        let buf;
        try {
            buf = await this.download(url);
        }
        catch (err) {
            return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
        // 魔数校验：非图片(误收的语音/视频/未知)直接拒，不入库
        if (!isImageBuffer(buf)) {
            return { status: 'error', error: 'not an image (magic bytes mismatch)' };
        }
        const hash = createHash('sha1').update(buf).digest('hex');
        const id = hash.slice(0, 12);
        const now = Date.now();
        const existing = this.items.get(id);
        if (existing) {
            existing.lastSeenAt = now;
            this.save();
            return { status: 'dup', id };
        }
        const fromUrl = extname(new URL(url).pathname).replace(/^\./, '').slice(0, 5) || 'jpg';
        // ★ 2026-11-13（issue #47）：**真实字节优先**，content_type / URL 后缀只做兜底。
        const ext = extFromMagic(buf) ?? ((contentType && MIME_EXT[contentType.toLowerCase()]) || fromUrl);
        const meta = {
            id,
            layer: 'candidate',
            hash,
            ext,
            size: buf.length,
            sourceGroup: input.sourceGroup,
            senderId: input.senderId,
            senderName: input.senderName,
            msgText: input.msgText,
            capturedAt: now,
            firstSeenAt: now,
            lastSeenAt: now,
            useCount: 0,
            tags: input.tags ?? [],
            desc: input.desc,
            needsDescribe: !input.desc,
            sourceUrl: input.sourceUrl,
            // 感知哈希(2026-09-13): 入库即算, 供"重压缩/改尺寸也算同一张"的去重; sharp 不可用则为 undefined
            dhash: await computeDHash(buf),
        };
        try {
            const dest = this.filePathOf(meta);
            const tmp = `${dest}.tmp-${now}`;
            writeFileSync(tmp, buf);
            renameSync(tmp, dest);
        }
        catch (err) {
            return { status: 'error', error: `write failed: ${err instanceof Error ? err.message : String(err)}` };
        }
        this.items.set(id, meta);
        this.save();
        return { status: 'new', id };
    }
    /** 安全下载：仅 HTTPS + SSRF + 上限 + 超时 */
    async download(url) {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:')
            throw new Error(`Only HTTPS allowed: ${parsed.protocol}`);
        await assertSafeHostname(parsed.hostname);
        const resp = await fetch(url, {
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        });
        if (!resp.ok)
            throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > MAX_IMAGE_BYTES)
            throw new Error(`Image exceeds 10MB (${buf.length})`);
        return buf;
    }
    /** 从本地已有文件入库（后续升级/负样本用） */
    addLocalFile(srcPath, meta) {
        const now = Date.now();
        const full = {
            id: meta.id,
            layer: meta.layer,
            hash: meta.hash ?? meta.id,
            ext: meta.ext,
            size: meta.size ?? 0,
            sourceGroup: meta.sourceGroup,
            senderId: meta.senderId,
            senderName: meta.senderName,
            msgText: meta.msgText,
            capturedAt: meta.capturedAt ?? now,
            firstSeenAt: meta.firstSeenAt ?? now,
            lastSeenAt: meta.lastSeenAt ?? now,
            useCount: meta.useCount ?? 0,
            tags: meta.tags ?? [],
            desc: meta.desc,
            needsDescribe: meta.needsDescribe,
            trashedAt: meta.trashedAt,
            prevLayer: meta.prevLayer,
        };
        if (existsSync(srcPath) && !existsSync(this.filePathOf(full))) {
            mkdirSync(join(this.dataDir, LAYER_DIRS[full.layer]), { recursive: true });
            renameSync(srcPath, this.filePathOf(full));
        }
        this.items.set(full.id, full);
        this.save();
    }
    /** 标记使用(候选→正式库并搬文件; 发送过=用过, 计入 useCount) */
    markUsed(id) {
        const it = this.items.get(id);
        if (!it)
            return;
        it.useCount += 1;
        it.lastSeenAt = Date.now();
        if (it.layer === 'candidate') {
            const from = it.layer;
            it.layer = 'library';
            this.moveFile(it, from);
        }
        this.save();
    }
    /** 主动收藏/打标认可: 升级到正式区(不计数; 正式区不参与自动滚动清理) */
    promote(id) {
        const it = this.items.get(id);
        if (!it || it.layer === 'library')
            return;
        if (it.layer === 'trash') {
            it.trashedAt = undefined;
            it.prevLayer = undefined;
        }
        const from = it.layer;
        it.layer = 'library';
        it.lastSeenAt = Date.now();
        this.moveFile(it, from);
        this.save();
    }
    markReaction(id, kind) {
        const it = this.items.get(id);
        if (!it)
            return;
        if (kind === 'dislike' && it.layer !== 'negative') {
            const from = it.layer;
            it.layer = 'negative';
            this.moveFile(it, from);
        }
        this.save();
    }
    /** 查询：q/tag/描述命中 或 最近入库(默认不含回收站/负样本) */
    search(opts) {
        const tag = (opts.tag ?? '').trim().toLowerCase();
        const limit = Math.max(1, Math.min(50, opts.limit || 10));
        let pool = [...this.items.values()].filter(it => it.layer !== 'negative'
            && (opts.includeTrash === true || it.layer !== 'trash')
            && !it.msgText?.startsWith('[系统'));
        if (tag) {
            pool = pool.filter(it => it.tags.some(t => t.toLowerCase().includes(tag)));
        }
        // 多词搜索: 拆词后"任一命中即可"(OR), 命中词越多排越前, 同分按最近入库
        const terms = splitTerms(opts.q);
        if (terms.length) {
            const scores = new Map();
            pool = pool.filter(it => {
                const n = hitCount(terms, stickerHay(it));
                if (n > 0) {
                    scores.set(it, n);
                    return true;
                }
                return false;
            });
            pool.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || (b.firstSeenAt - a.firstSeenAt));
        }
        else {
            pool.sort((a, b) => b.firstSeenAt - a.firstSeenAt);
        }
        const top = pool.slice(0, limit);
        return top.map(it => ({
            id: it.id,
            layer: it.layer,
            path: this.filePathOf(it),
            tags: it.tags,
            desc: it.desc,
            sourceGroup: it.sourceGroup,
            msgText: it.msgText,
            capturedAt: it.capturedAt,
            useCount: it.useCount,
        }));
    }
    /** 更新一张图的标签与详细描述(tags/desc 传 undefined 表示不动该项; 自动去重) */
    setDescTags(id, tags, desc) {
        const it = this.items.get(id);
        if (!it)
            return false;
        if (tags !== undefined) {
            const seen = new Set();
            const cleaned = [];
            for (const t of tags) {
                const c = (t ?? '').trim();
                if (c && !seen.has(c)) {
                    seen.add(c);
                    cleaned.push(c.slice(0, 20));
                }
                if (cleaned.length >= 20)
                    break;
            }
            it.tags = cleaned;
        }
        if (desc !== undefined) {
            const d = (desc ?? '').trim();
            if (d) {
                it.desc = d.slice(0, 300);
                it.needsDescribe = false;
            }
            else if (it.desc) {
                it.desc = undefined;
                it.needsDescribe = true;
            }
        }
        this.save();
        return true;
    }
    /** 把本地已有图片文件导入收藏(算hash去重, 复制进候选区); 返回 {status:'new'|'dup'|'error', id?} */
    async importLocalFile(srcPath, input) {
        try {
            if (!existsSync(srcPath))
                return { status: 'error', error: `文件不存在: ${srcPath}` };
            const buf = readFileSync(srcPath);
            if (!isImageBuffer(buf))
                return { status: 'error', error: 'not an image (magic bytes mismatch)' };
            const hash = createHash('sha1').update(buf).digest('hex');
            const id = hash.slice(0, 12);
            const existing = this.items.get(id);
            const now = Date.now();
            // 已存在 → 只更新"最近见到"; 若老记录还没有 dhash(功能上线前入的库)顺手补算
            if (existing) {
                existing.lastSeenAt = now;
                if (!existing.dhash) {
                    const dh0 = await computeDHash(buf);
                    if (dh0)
                        existing.dhash = dh0;
                }
                this.save();
                return { status: 'dup', id };
            }
            const fromName = input?.sourceUrl
                ? extname(new URL(input.sourceUrl).pathname).replace(/^\./, '').slice(0, 5)
                : extname(srcPath).replace(/^\./, '').toLowerCase().slice(0, 5);
            // ★ 2026-11-13（issue #47）：同 capture —— 扩展名以真实字节为准，文件名只是兜底。
            const ext = extFromMagic(buf) ?? (fromName || 'jpg');
            const meta = {
                id,
                layer: 'candidate',
                hash,
                ext,
                size: buf.length,
                sourceGroup: input?.sourceGroup,
                senderId: input?.senderId,
                senderName: input?.senderName,
                msgText: input?.msgText,
                capturedAt: now,
                firstSeenAt: now,
                lastSeenAt: now,
                useCount: 0,
                tags: input?.tags ?? [],
                desc: input?.desc,
                needsDescribe: !input?.desc,
                sourceUrl: input?.sourceUrl,
                // 感知哈希(2026-09-13): 入库即算, 供"重压缩/改尺寸也算同一张"的去重
                dhash: await computeDHash(buf),
            };
            const dest = this.filePathOf(meta);
            mkdirSync(join(this.dataDir, LAYER_DIRS.candidate), { recursive: true });
            if (!existsSync(dest)) {
                const tmp = `${dest}.tmp-${now}`;
                writeFileSync(tmp, buf);
                renameSync(tmp, dest);
            }
            this.items.set(id, meta);
            this.save();
            return { status: 'new', id };
        }
        catch (e) {
            return { status: 'error', error: e instanceof Error ? e.message : String(e) };
        }
    }
    /** 送回收站(可逆; prevLayer 记原层用于还原) */
    markTrash(id) {
        const it = this.items.get(id);
        if (!it || it.layer === 'trash')
            return false;
        const from = it.layer;
        it.prevLayer = it.layer;
        it.layer = 'trash';
        it.trashedAt = Date.now();
        this.moveFile(it, from);
        this.save();
        return true;
    }
    /** 从回收站还原(回到原层或候选区) */
    restore(id) {
        const it = this.items.get(id);
        if (!it || it.layer !== 'trash')
            return false;
        const from = it.layer;
        it.layer = it.prevLayer ?? 'candidate';
        it.trashedAt = undefined;
        it.prevLayer = undefined;
        this.moveFile(it, from);
        this.save();
        return true;
    }
    /** 物理删除回收站中超过 ttlMs 的条目(含文件+index) */
    purgeTrashed(ttlMs = 30 * 24 * 3600 * 1000) {
        const cutoff = Date.now() - ttlMs;
        let n = 0;
        for (const it of [...this.items.values()]) {
            if (it.layer === 'trash' && (it.trashedAt ?? it.lastSeenAt) < cutoff) {
                this.deleteFile(it);
                this.items.delete(it.id);
                n += 1;
            }
        }
        if (n > 0)
            this.save();
        return n;
    }
    /** 候选区超限清理: 超过 maxCandidates 时, 最久未见的滚进回收站(不物理删) */
    cleanupCandidates(maxCandidates) {
        const cands = [...this.items.values()].filter(it => it.layer === 'candidate');
        if (cands.length <= maxCandidates)
            return 0;
        const sorted = cands.sort((a, b) => a.lastSeenAt - b.lastSeenAt); // 最旧在前
        const excess = sorted.slice(0, cands.length - maxCandidates);
        for (const it of excess)
            this.markTrash(it.id);
        return excess.length;
    }
    /**
     * 回收站物理清理：trash 层超过 maxItems 时，按"进回收站的时间"从旧到新**真删文件**。
     *
     * ⚠️ 2026-10-05 主人要求：回收站必须有上限，超过的旧图自动删。
     *   之前只有 markTrash（把候选区挤下来的旧图滚进回收站）而**从不物理删**，
     *   于是回收站一路涨到 4000 张。
     * 说明：只动 trash 层 —— candidate/library/negative 不受影响；
     *   没记 trashedAt 的老条目按 0 处理（视为最旧，优先清）。
     * @returns 实际物理删除的条数
     */
    cleanupTrash(maxItems) {
        const tr = [...this.items.values()].filter(it => it.layer === 'trash');
        if (tr.length <= maxItems)
            return 0;
        const sorted = tr.sort((a, b) => (a.trashedAt ?? 0) - (b.trashedAt ?? 0)); // 最旧在前
        const excess = sorted.slice(0, tr.length - maxItems);
        let n = 0;
        for (const it of excess) {
            this.deleteFile(it); // 物理删文件
            this.items.delete(it.id);
            n += 1;
        }
        if (n > 0)
            this.save();
        return n;
    }
    /** 清理损坏/空文件条目(文件缺失或 0 字节) */
    cleanupBroken() {
        let n = 0;
        for (const it of [...this.items.values()]) {
            try {
                const p = this.filePathOf(it);
                if (!existsSync(p)) {
                    this.items.delete(it.id);
                    n += 1;
                    continue;
                }
                const st = statSync(p);
                if (st.size === 0) {
                    this.deleteFile(it);
                    this.items.delete(it.id);
                    n += 1;
                }
            }
            catch {
                this.items.delete(it.id);
                n += 1;
            }
        }
        if (n > 0)
            this.save();
        return n;
    }
    /** 按层统计(整理/仪表盘用) */
    stats() {
        const s = { total: 0, candidate: 0, library: 0, trash: 0, negative: 0, untagged: 0, totalBytes: 0 };
        for (const it of this.items.values()) {
            s.total += 1;
            if (it.layer === 'candidate')
                s.candidate += 1;
            else if (it.layer === 'library')
                s.library += 1;
            else if (it.layer === 'trash')
                s.trash += 1;
            else
                s.negative += 1;
            if (!it.tags?.length && !it.desc)
                s.untagged += 1;
            s.totalBytes += it.size;
        }
        return s;
    }
    /** 按来源 URL 反查条目(agent 拿群消息里的 URL 定位本地图) */
    findBySourceUrl(url) {
        const u = (url ?? '').trim();
        if (!u)
            return undefined;
        for (const it of this.items.values()) {
            if (it.sourceUrl === u)
                return it;
        }
        // 容错: URL 归一(去 spec/query 尾参)或前缀匹配
        const norm = u.split('&spec=')[0] ?? u;
        for (const it of this.items.values()) {
            if (it.sourceUrl && it.sourceUrl.startsWith(norm))
                return it;
        }
        return undefined;
    }
    /**
     * 按 QQ 图片 fileid 反查条目(2026-09-13 主人: 解决"老是重复收藏")。
     * 关键: QQ 图片 URL **每次都换 rkey**(临时参数), 直接比 URL 永远查不到 → AI 每次又收藏一遍;
     * 而 URL 里的 `fileid=` **同一张图恒定不变** → 用它当去重键。
     */
    findByFileId(fileId) {
        const fid = extractQqFileId(fileId);
        if (!fid)
            return undefined;
        for (const it of this.items.values()) {
            if (it.sourceUrl && extractQqFileId(it.sourceUrl) === fid)
                return it;
        }
        return undefined;
    }
    /**
     * 按**感知哈希**查近似重复(2026-09-13 主人定, 又快又准):
     * 遍历已存 dhash 的条目取最小汉明距离, ≤ maxDist(默认 5)即视为同一张图。
     * ⚠️ 老记录若没有 dhash 会跳过(它们入库时还没这功能); 新入库的都会带。
     */
    findByDHash(dhash, maxDist = 5, layer) {
        if (!dhash)
            return undefined;
        let best;
        let bestD = maxDist + 1;
        for (const it of this.items.values()) {
            if (!it.dhash)
                continue;
            if (layer && it.layer !== layer)
                continue;
            const d = dhashDistance(it.dhash, dhash);
            if (d < bestD) {
                bestD = d;
                best = it;
            }
        }
        return best;
    }
    /**
     * 后台惰性回填 dHash(2026-09-13): 从旧版本升级上来的库缺这个字段 → 去重会漏判。
     * 每次只补一小批(默认 20 张, 每张约 15ms), 不阻塞主流程; 返回本批补了几条(0 = 已补完)。
     */
    async backfillDHash(batch = 20) {
        let n = 0;
        for (const it of this.items.values()) {
            if (n >= batch)
                break;
            if (it.dhash)
                continue;
            const p = this.filePathOf(it);
            if (!p || !existsSync(p))
                continue;
            try {
                const dh = await computeDHash(readFileSync(p));
                if (dh) {
                    it.dhash = dh;
                    n += 1;
                }
            }
            catch { /* 单张失败跳过 */ }
        }
        if (n > 0)
            this.save();
        return n;
    }
    /** 全量查询(管理面板用): 可按层/关键词/未打标过滤, 默认不含回收站 */
    queryAll(opts = {}) {
        // 多词搜索(同 search): 任一命中即可, 命中多排前
        const terms = splitTerms(opts.q);
        let pool = [...this.items.values()].filter(it => {
            if (!opts.includeTrash && it.layer === 'trash')
                return false;
            if (opts.layer && opts.layer !== 'all' && it.layer !== opts.layer)
                return false;
            if (opts.untagged && (it.tags?.length || it.desc))
                return false;
            if (terms.length && hitCount(terms, stickerHay(it)) === 0)
                return false;
            return true;
        });
        if (terms.length) {
            const scores = new Map();
            for (const it of pool)
                scores.set(it, hitCount(terms, stickerHay(it)));
            pool.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || (b.firstSeenAt - a.firstSeenAt));
        }
        else {
            pool.sort((a, b) => b.firstSeenAt - a.firstSeenAt);
        }
        return pool.map(it => ({
            id: it.id,
            path: this.filePathOf(it),
            layer: it.layer,
            tags: it.tags,
            desc: it.desc,
            useCount: it.useCount,
            size: it.size,
            firstSeenAt: it.firstSeenAt,
        }));
    }
    get(id) {
        return this.items.get(id);
    }
    size() {
        return this.items.size;
    }
    deleteFile(it) {
        try {
            const p = this.filePathOf(it);
            if (existsSync(p))
                rmSync(p, { force: true });
        }
        catch { /* ignore */ }
    }
    /** 层间移动文件到新路径(目录自动建) */
    moveFile(it, fromLayer) {
        try {
            const from = join(this.dataDir, LAYER_DIRS[fromLayer], `${it.id}.${it.ext}`);
            const dir = join(this.dataDir, LAYER_DIRS[it.layer]);
            mkdirSync(dir, { recursive: true });
            const to = join(dir, `${it.id}.${it.ext}`);
            if (existsSync(from) && from !== to)
                renameSync(from, to);
        }
        catch { /* ignore */ }
    }
}
// ── 多例注册表(多账号支持, 2026-09-03): 每账号实例一个 dataDir → 各自独立的图库。
// Map<realpath(dataDir), StickerStore>; primary = 最早 configure 的实例(兼容原单账号无参调用)。
// ⚠️ 2026-09-11 B类修复: 单例时序坑 —— 多实例下"谁先 configure 谁定 primary",
//    无参 getStickerStore() 会拿到别的实例的库(多实例时序坑: list_stickers 串到别的实例图库)。
//    加 ns 维度: primary 按实例(ns)各记一份, 无参调用优先按调用者 ns 取。
const _stores = new Map();
const _primaryByNs = new Map();
let _primaryDir;
/**
 * 配置图库实例(启动期每账号按自己 dataDir 预初始化; 同目录幂等)。
 * ⚠️ 时序坑(线上踩坑)：必须启动早期按 config.cwd 解析的 dataDir 初始化，
 * 避免无参 getStickerStore 读到 process.cwd 的错目录(C盘幽灵库)。
 * ns: 实例标识(settingsNs), 多实例时用于无参调用精确取本实例库。
 */
export function configureStickerStore(dataDir, logger, ns) {
    const key = resolve(dataDir);
    let s = _stores.get(key);
    if (!s) {
        s = new StickerStore(dataDir, logger);
        _stores.set(key, s);
    }
    if (!_primaryDir)
        _primaryDir = key;
    if (ns)
        _primaryByNs.set(ns, key);
    return s;
}
/** 获取图库实例。带 dataDir → 按目录取(不在则容错新建); 带 ns → 按该实例的 primary 取;
 *  无参 → 全局 primary(兼容单账号旧调用)。 */
export function getStickerStore(dataDir, logger, ns) {
    if (dataDir) {
        const key = resolve(dataDir);
        let s = _stores.get(key);
        if (!s) {
            s = new StickerStore(dataDir, logger);
            _stores.set(key, s);
        }
        return s;
    }
    if (ns) {
        const p = _primaryByNs.get(ns);
        if (p) {
            const s = _stores.get(p);
            if (s)
                return s;
        }
    }
    if (_primaryDir) {
        const s = _stores.get(_primaryDir);
        if (s)
            return s;
    }
    if (_stores.size === 1)
        return _stores.values().next().value;
    const dir = join(process.cwd(), '表情包');
    const s = new StickerStore(dir, logger);
    _stores.set(resolve(dir), s);
    if (!_primaryDir)
        _primaryDir = resolve(dir);
    if (ns)
        _primaryByNs.set(ns, resolve(dir));
    return s;
}
//# sourceMappingURL=sticker-store.js.map