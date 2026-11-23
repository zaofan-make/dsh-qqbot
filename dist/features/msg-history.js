/**
 * msg-history.ts — 群消息历史台账（2026-10-20 主人定：独立台账 + 按会话分目录 + 一天一个文件）
 *
 * 目录结构（`{dataRoot}/.qqbot/msg-history/`）：
 *   group_<群openid>/2026-10-20.jsonl
 *   c2c_<对方openid>/2026-10-20.jsonl
 *
 * 设计要点（主人要求）：
 *   · **一会话一目录** → 群与群、群与私聊天然隔离，读的时候根本碰不到别人的文件；
 *   · **一天一个文件** → 不会反复读写同一个越滚越大的文件；
 *   · **默认只保留 7 天** → 启动时 + 每 200 次写顺手清掉过期日期文件；
 *   · 一行一条：`{"id":"message_id","s":"发送者","n":"昵称","t":毫秒,"k":"text|image|voice|video|file","x":"正文摘要","me":true?}`
 *
 * 用途：`group_recall`（撤某人最近一条）、`group_msg_search`（按关键词/类型搜）、
 *       `group_recall_batch`（批量撤 + 顺带禁言）。与引用补全用的 msg-content.jsonl **互不干扰**。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { md5sInText, normQuoteText } from '../shared/quote-match.js';
import { appendLine, closeFile, ensureDir, forgetDirTree, hasActiveStream } from '../shared/async-append.js';
/** 默认保留天数（主人定：7 天） */
export const KEEP_DAYS = 7;
/** 单日文件读取上限（防御：一天消息特别多时别把内存吃爆） */
const MAX_READ_LINES = 5000;
/** 正文摘要长度 */
const TEXT_MAX = 200;
/**
 * ★ 2026-11-23（主人实测）：带链接的记录**不能按 200 截断** ——
 *   合并转发（`[群聊的聊天记录]`）里全是 URL，切在 200 字等于只留下第一个 URL 的前半截，
 *   台账里那条记录直接"只剩一个坏链接"。
 *   带 URL 的正文放宽到这个上限（约 40 个附件仍能装下），无 URL 的照旧 200。
 */
const TEXT_MAX_WITH_URL = 20000;
/**
 * 跨平台下载脚本（随每个链接文件一起生成 `<同名>-dl.mjs`）。
 * 用法：`node "<文件>-dl.mjs"` —— 读同目录同名 .txt，下载到同名子目录。
 * 三平台通用（node 内置 fetch/fs），不需要 wget/curl。
 */
const DOWNLOAD_SCRIPT = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const here = path.dirname(fileURLToPath(import.meta.url));",
    "const base = path.basename(fileURLToPath(import.meta.url)).replace(/-dl\\.mjs$/, '');",
    "const txt = path.join(here, base + '.txt');",
    "const outArg = process.argv[2];",
    "const out = outArg ? path.resolve(outArg) : path.join(here, base);",
    "fs.mkdirSync(out, { recursive: true });",
    "const urls = fs.readFileSync(txt, 'utf8').split(/\\r?\\n/).filter((l) => /^https?:/.test(l));",
    "let ok = 0, fail = 0;",
    "for (let i = 0; i < urls.length; i++) {",
    "  const ext = urls[i].includes('appid=1415') ? '.mp4' : '.jpg';",
    "  const name = String(i + 1).padStart(2, '0') + ext;",
    "  try {",
    "    const r = await fetch(urls[i]);",
    "    if (!r.ok) throw new Error('HTTP ' + r.status);",
    "    fs.writeFileSync(path.join(out, name), Buffer.from(await r.arrayBuffer()));",
    "    ok++;",
    "  } catch (e) { fail++; console.log('fail ' + (i + 1) + ': ' + e.message); }",
    "}",
    "console.log('done: ' + ok + ' ok, ' + fail + ' fail -> ' + out);",
    "",
].join('\n');
/** 已落盘的消息 id → 文件路径（幂等 + 入站/台账两条路复用） */
const LINKED = new Map();
/** 链接落盘目录名（与会话目录同级） */
const LINK_DIR = 'downloadlink';
/** 链接文件保留天数（主人定：7 天，与台账一致） */
const LINK_KEEP_DAYS = 7;
/** 从文本里抽出所有 http(s) 链接（去重、保序） */
export function extractUrls(text) {
    const out = [];
    const seen = new Set();
    const re = /https?:\/\/[^\s"'<>()\u3000，。；、]+/gi;
    let m;
    while ((m = re.exec(String(text ?? ''))) !== null) {
        const u = m[0].replace(/[.,;:]+$/, '');
        if (!u || seen.has(u))
            continue;
        seen.add(u);
        out.push(u);
    }
    return out;
}
/**
 * 按上限裁剪正文，但**绝不把 URL 切断**：
 * 有链接时放到 {@link TEXT_MAX_WITH_URL}；真要超，就退到最后一个完整 URL 结束处。
 */
function clipKeepUrls(text, max = TEXT_MAX) {
    const t = String(text ?? '').replace(/\s+/gu, ' ').trim();
    if (t.length <= max)
        return t;
    const urls = extractUrls(t);
    if (!urls.length)
        return t.slice(0, max);
    const limit = TEXT_MAX_WITH_URL;
    if (t.length <= limit)
        return t;
    // 超长：保留到"最后一个能完整放下的 URL"为止，避免切出半截链接
    let cut = limit;
    for (const u of urls) {
        const at = t.indexOf(u);
        if (at < 0)
            continue;
        const end = at + u.length;
        if (end <= limit)
            cut = end;
        else
            break;
    }
    return t.slice(0, cut) + ' …';
}
/**
 * ★ 2026-11-14（主人要求"22ms 还是太长，内存里塞今天的"）：**当天文件的行缓存**。
 *
 * 为什么需要：归属查询（引用别人一句话 → 这句话是谁说的）每次都要读当天那个
 *   1000+ 行的 jsonl 再逐行 JSON.parse，实测 22~28ms —— 一次引用跑两次就 50ms。
 *   把"今天这个文件解析后的行"放内存，命中时零 IO、零解析。
 *
 * 只缓存**今天**：昨天以前的消息不会再追加，但仍然按天换文件，
 *   缓存它们只会白占内存；查老消息走原路径（慢一点无所谓，那种查询很少）。
 * 只留最近 {@link CACHE_ROWS} 条：正文匹配永远是从新往旧找，老的两千条根本轮不到。
 * 内存估算：500 条 × 约 600 字节 ≈ **300KB/群**，且跨天自动失效。
 */
const CACHE_ROWS = 500;
/**
 * 文件路径 → { key, rows: 新→旧, sorted: 按归一化正文排序的索引 }
 *
 * `sorted` 是为**前缀二分**建的（2026-11-14，查过资料后的结论）：
 *   我们需要"哪条历史正文跟被引原话是同一句（允许一方是另一方的前缀）"，
 *   这是标准的**前缀查询**。业界实测（[Autocomplete in Node][1]）：
 *   排序数组 + 二分 = 0.2~0.8 微秒、几乎零额外内存；
 *   Trie 查询虽快但内存按字符节点膨胀（那篇实测 1.4GB vs 0.8MB）。
 *   中文长句上 Trie 更是灾难（一句 30 字＝30 个 Map 节点）。
 *   所以这里只存**字符串引用**的排序数组，不复制正文、不建树。
 *
 * [1]: https://www.nihardaily.com/posts/autocomplete-in-node-a-14-gb-trie-loses-to-a-08-mb-table
 */
const dayCache = new Map();
/**
 * 给一天的行建"双向前缀匹配"索引（2026-11-14，按官方深度检索的结论选的方案）。
 *
 * 为什么不建 Trie：Node.js 里对象式 Trie 每个节点是一个对象 + Map，
 *   300k 短语实测吃 **1.4 GB**；排序数组只要 0.8 MB 且查询 0.21~0.83 μs。
 *   我们一天才 500~1000 条，更没有理由付那个内存税。
 *
 * 两个方向拆开用最便宜的结构：
 *   ① **query 是记录前缀**（记录更长）→ 排序数组 + 二分 + 向后扫
 *   ② **记录是 query 前缀**（被引原文被平台截断）→ 枚举 query 的每个前缀查 Map
 *   两个都是 O(log n) / O(L)，内存只是字符串引用，不复制正文。
 */
function buildIndex(rows) {
    const byNx = new Map();
    const byMd5 = new Map();
    for (const r of rows) {
        // 图片指纹索引：引用纯图时靠它 O(1) 定位（扫行要 5ms，实测）
        for (const md of Array.isArray(r.f) ? r.f : []) {
            const k = String(md).toLowerCase();
            if (!k)
                continue;
            const ml = byMd5.get(k);
            if (ml)
                ml.push(r);
            else
                byMd5.set(k, [r]);
        }
        const nx = r._nx ?? normQuoteText(r.x);
        if (!nx)
            continue; // 纯图/纯表情 → 匹配不到任何文本查询，不进正文索引
        r._nx = nx;
        const list = byNx.get(nx);
        if (list)
            list.push(r);
        else
            byNx.set(nx, [r]);
    }
    const sorted = [...byNx.keys()].sort();
    return { sorted, byNx, byMd5 };
}
/**
 * 双向前缀匹配：找出所有"跟 `q` 算同一句"的记录。
 *
 *   · 方向一（q 是记录前缀）：`lowerBound` 定位后向后扫，直到不再以 q 开头 —— O(log n + k)
 *   · 方向二（记录是 q 前缀）：枚举 q 的每个前缀查 `byNx` —— O(L) 次哈希，L 最大 200
 *
 * 比"向前扫 + 首字剪枝"稳：那个剪枝依赖字典序相邻性，遇到空串/异体字容易漏；
 * 枚举前缀是**精确覆盖**，不会漏。
 */
function collectPrefixMatches(idx, q) {
    if (!q)
        return [];
    const hits = [];
    const { sorted, byNx } = idx;
    // ① q 是记录的前缀
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const v = sorted[mid];
        if (v === undefined)
            break;
        if (v < q)
            lo = mid + 1;
        else
            hi = mid;
    }
    for (let i = lo; i < sorted.length; i++) {
        const v = sorted[i];
        if (!v || !v.startsWith(q))
            break;
        const list = byNx.get(v);
        if (list)
            hits.push(...list);
    }
    // ② 记录是 q 的前缀（平台截断了被引原文）
    //    从长到短枚举；q 自身那一档上面已经覆盖，这里到 q.length-1 为止。
    const maxLen = Math.min(q.length - 1, 300);
    for (let len = 1; len <= maxLen; len++) {
        const list = byNx.get(q.slice(0, len));
        if (list)
            hits.push(...list);
    }
    return hits;
}
/** 命中多条时取**时间最新**的那条（同一句话说过很多次，要的是最近一次） */
function newestOf(rows) {
    let best;
    for (const r of rows)
        if (!best || Number(r.t) > Number(best.t))
            best = r;
    return best;
}
let historyRoot = '';
let writeTick = 0;
const pad = (n) => String(n).padStart(2, '0');
/** 本地日期 YYYY-MM-DD（不能用 toISOString，那是 UTC 会错日） */
function dayOf(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function safeId(id) {
    return String(id).replace(/[^0-9A-Za-z_-]/gu, '');
}
function dirOf(scope, peerId) {
    return join(historyRoot, `${scope}_${safeId(peerId)}`);
}
/** 初始化（bootstrap 启动时调一次）：建目录 + 清过期 */
export function initMsgHistory(dataRoot) {
    if (!dataRoot)
        return;
    historyRoot = join(dataRoot, '.qqbot', 'msg-history');
    try {
        mkdirSync(historyRoot, { recursive: true });
    }
    catch {
        historyRoot = '';
        return;
    }
    pruneOld();
}
/** 删掉超过 KEEP_DAYS 天的日期文件（顺带删空目录） */
export function pruneOld() {
    if (!historyRoot)
        return;
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    const cutoffDay = dayOf(cutoff);
    let dirs = [];
    try {
        dirs = readdirSync(historyRoot);
    }
    catch {
        return;
    }
    for (const d of dirs) {
        const dir = join(historyRoot, d);
        let files = [];
        try {
            const st = statSync(dir);
            if (!st.isDirectory())
                continue;
            // ★ 2026-11-15（CodeRabbit 第二轮）：**不能靠 mtime 判断目录是否活跃** ——
            //   追加写是 `open(file,'a')`，只更新**文件**的 mtime，目录 mtime 一直是旧的。
            files = readdirSync(dir);
        }
        catch {
            continue;
        }
        let alive = 0;
        for (const f of files) {
            if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(f))
                continue;
            if (f.slice(0, 10) < cutoffDay) {
                // ★ 2026-11-15（CodeRabbit 第三轮）：**逐文件**判断是否活跃，而不是整目录跳过。
                //   整目录跳过的话，一个一直在聊的群，它 8 天前的旧文件永远清不掉，
                //   KEEP_DAYS=7 对活跃群直接失效、文件无限累积。
                //   活跃判据：该文件还挂着写入流，或还在内存缓存里。
                const fp = join(dir, f);
                if (hasActiveStream(fp) || dayCache.has(fp)) {
                    alive += 1;
                    continue;
                }
                try {
                    closeFile(fp);
                    rmSync(fp, { force: true });
                }
                catch { /* ignore */ }
            }
            else {
                alive++;
            }
        }
        if (alive === 0) {
            try {
                // ★ 2026-11-15（CodeRabbit 抓到）：删掉整个会话目录后，必须把
                //   `ensuredDirs` / 写入流 / 本文件的 dayCache 全部作废 ——
                //   否则 `ensureDir` 一直以为目录还在，后续 append 直接失败且**静默重复**，
                //   那个群从此写不进历史（直到重启）。
                forgetDirTree(dir);
                for (const day of [...dayCache.keys()]) {
                    if (day.startsWith(dir))
                        dayCache.delete(day);
                }
                // marked 的键是 `scope:peerId`（如 group:xxx），目录名是 `group_xxx` —— 转换后清掉，
                // 这样下次 markSession 会重建名字文件。
                const base = dir.split(/[\\/]/).pop() ?? '';
                const us = base.indexOf('_');
                if (us > 0)
                    marked.delete(base.slice(0, us) + ':' + base.slice(us + 1));
                rmSync(dir, { recursive: true, force: true });
            }
            catch { /* ignore */ }
        }
    }
}
/** 已经写过名字文件的会话（避免每条消息都写） */
const marked = new Set();
/** 读 {dataRoot}/.qqbot/groups.json 拿群名 */
function groupNameOf(gid) {
    try {
        const f = join(historyRoot, '..', 'groups.json');
        const j = JSON.parse(readFileSync(f, 'utf8'));
        const n = j?.[gid]?.name;
        if (n)
            return String(n).trim();
    }
    catch { /* 没注册表就算了 */ }
    return '';
}
/** 根目录索引：所有群文件夹 ↔ 群名 对照（方便肉眼找） */
function refreshIndex() {
    if (!historyRoot)
        return;
    let dirs = [];
    try {
        dirs = readdirSync(historyRoot);
    }
    catch {
        return;
    }
    const lines = ['QQ 消息历史台账索引', '', '目录 → 群名（本目录只保留最近 ' + KEEP_DAYS + ' 天）', ''];
    for (const d of dirs.sort()) {
        if (!d.startsWith('group_') && !d.startsWith('c2c_'))
            continue;
        const id = d.slice(6);
        const name = d.startsWith('group_') ? (groupNameOf(id) || '未命名群') : ('私聊 ' + id.slice(0, 8));
        lines.push('  ' + d + '  →  ' + name);
    }
    lines.push('');
    try {
        writeFileSync(join(historyRoot, '_索引.txt'), lines.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
    }
    catch { /* ignore */ }
}
/**
 * 在该会话目录里放一个「<群名>.txt」（主人要求：打开文件夹一眼认出是哪个群）。
 * 群名变了会顺手删掉旧名字文件；同时刷新根目录 _索引.txt。
 */
export function markSession(scope, peerId) {
    if (!historyRoot || !peerId)
        return;
    const key = scope + ':' + peerId;
    if (marked.has(key))
        return;
    const dir = dirOf(scope, peerId);
    try {
        mkdirSync(dir, { recursive: true });
    }
    catch {
        return;
    }
    const rawName = scope === 'group' ? (groupNameOf(peerId) || '未命名群') : ('私聊_' + peerId.slice(0, 8));
    const BAD = String.fromCharCode(92) + '/:*?"<>|' + String.fromCharCode(13) + String.fromCharCode(10);
    const safe = rawName.split('').map((ch) => (BAD.indexOf(ch) >= 0 ? '_' : ch)).join('').slice(0, 40) || '未命名';
    try {
        for (const f of readdirSync(dir)) {
            if (f.endsWith('.txt') && f !== safe + '.txt')
                rmSync(join(dir, f), { force: true });
        }
    }
    catch { /* ignore */ }
    const body = [
        rawName,
        '',
        '群号(gid): ' + peerId,
        '类型: ' + (scope === 'group' ? 'QQ群' : '私聊'),
        '本目录保存最近 ' + KEEP_DAYS + ' 天的历史消息，每天一个 .jsonl（一行一条）。',
        '由 dsh-qqbot 自动生成，仅用于人工辨认；删掉会自动重建。',
        '',
    ].join(String.fromCharCode(10));
    try {
        writeFileSync(join(dir, safe + '.txt'), body, 'utf8');
    }
    catch { /* ignore */ }
    marked.add(key);
    refreshIndex();
}
/**
 * ★ 2026-11-23（主人定）：**链接单独落盘** —— 一条含链接的记录写一个文件，
 * 方便"一次性批量下载"：模型不用把一长串 URL 逐个抄进命令行（抄错还费 token）。
 *
 * 位置：`msg-history/<scope>_<peerId>/downloadlink/<日期>-<三位序号>.txt`
 * 格式：`#` 开头是注释（时间/发送者/条数），之后**一行一个 URL**
 *   —— `wget -i 文件` 原生支持这种格式；curl 用户 grep -v "^#" 即可。
 * 保留：7 天（按文件名日期前缀清理）。
 */
function writeDownloadLinks(scope, peerId, rec) {
    const urls = extractUrls(String(rec.x ?? ''));
    if (!urls.length)
        return undefined;
    // 幂等：同一条消息只落一次（入站拼提示先调一次，台账写入时再调一次）
    const id = String(rec.id ?? '');
    if (id) {
        const hit = LINKED.get(id);
        if (hit)
            return hit;
    }
    try {
        const dir = join(dirOf(scope, peerId), LINK_DIR);
        ensureDir(dir);
        const day = dayOf(rec.t);
        let seq = 1;
        try {
            for (const f of readdirSync(dir)) {
                const m = /^(\d{4}-\d{2}-\d{2})-(\d{3,})\.txt$/.exec(f);
                if (m && m[1] === day)
                    seq = Math.max(seq, Number(m[2]) + 1);
            }
        }
        catch { /* 目录读不到就从 1 开始 */ }
        const name = day + '-' + String(seq).padStart(3, '0') + '.txt';
        const head = [
            '# ' + new Date(rec.t).toISOString() + '  发送者=' + (rec.n || '未知') + '  链接数=' + urls.length,
            '# 一行一个 URL，# 开头为注释（wget -i 可直接使用）',
        ];
        const fp = join(dir, name);
        writeFileSync(fp, head.concat(urls).join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
        // ★ 2026-11-23（主人要求）：**再生成一个跨平台下载脚本** —— 模型只需执行
        //   `node "<同名>-dl.mjs"`（Windows / Linux / macOS 通用），不用读 txt、不用抄 URL。
        try {
            writeFileSync(join(dir, name.replace(/\.txt$/, '-dl.mjs')), DOWNLOAD_SCRIPT, 'utf8');
        }
        catch { /* 脚本写失败不影响 txt */ }
        pruneDownloadLinks(dir, rec.t);
        if (id) {
            LINKED.set(id, fp);
            if (LINKED.size > 2000) {
                const first = LINKED.keys().next();
                if (!first.done)
                    LINKED.delete(first.value);
            }
        }
        return fp;
    }
    catch { /* 落盘失败不影响台账 */ }
    return undefined;
}
/**
 * ★ 2026-11-23（主人要求）：**入站时就把链接落盘并拿到路径**，
 * 好在消息正文里告诉模型「链接存在这个文件里」，它读文件即可批量下载。
 */
export function exportLinksForMessage(scope, peerId, rec) {
    if (!historyRoot || !peerId)
        return undefined;
    return writeDownloadLinks(scope, peerId, rec);
}
/** 删掉 LINK_KEEP_DAYS 天前的链接文件（按文件名日期前缀判断） */
function pruneDownloadLinks(dir, now) {
    const cutoff = dayOf(now - LINK_KEEP_DAYS * 86400000);
    try {
        for (const f of readdirSync(dir)) {
            const m = /^(\d{4}-\d{2}-\d{2})-(\d{3,})\.txt$/.exec(f);
            if (m && String(m[1]) < cutoff) {
                try {
                    rmSync(join(dir, f), { force: true });
                }
                catch { /* ignore */ }
            }
        }
    }
    catch { /* ignore */ }
}
/** 记一条（写入当天文件） */
export function appendMsgHistory(scope, peerId, rec) {
    if (!historyRoot || !peerId || !rec?.id)
        return;
    markSession(scope, peerId);
    const now = Date.now();
    const row = {
        id: String(rec.id),
        s: String(rec.s ?? ''),
        n: String(rec.n ?? ''),
        t: Number(rec.t ?? now),
        k: (rec.k ?? 'text'),
        x: clipKeepUrls(String(rec.x ?? ''), TEXT_MAX),
        ...(rec.me ? { me: true } : {}),
        ...(rec.f && rec.f.length ? { f: rec.f.map((v) => String(v).toLowerCase()).filter(Boolean).slice(0, 4) } : {}),
    };
    try {
        const dir = dirOf(scope, peerId);
        ensureDir(dir);
        const fp = join(dir, `${dayOf(row.t)}.jsonl`);
        // ★ 2026-11-14：这里原来是 appendFileSync —— 实测 1465µs/次，而每条群消息都会走一遍。
        //   换成常开 WriteStream 后 4µs（差 366 倍）。
        appendLine(fp, JSON.stringify(row));
        // ★ 含链接的记录另存一份（一行一个 URL），便于批量下载
        writeDownloadLinks(scope, peerId, { t: row.t, n: row.n, x: String(rec.x ?? '') });
        // ★ 含链接的记录另存一份（一行一个 URL），便于批量下载
        writeDownloadLinks(scope, peerId, { t: row.t, n: row.n, x: String(rec.x ?? '') });
        // ★ 增量更新当天缓存：否则"写一条 → 下次查询判定 mtime 变了 → 重扫 1000 行"，
        //   群消息密集时等于每次查询都重扫一遍，缓存就白加了。
        // ★ 2026-11-15（CodeRabbit 抓到）：如果还没有缓存，**先载入一次**再增量加 ——
        //   否则"刚接受的消息"要等落盘才对同进程查询可见，紧接着的 findSenderByQuote 会漏掉它。
        const c = dayCache.get(fp) ?? (() => { readDayRows(fp, true); return dayCache.get(fp); })();
        if (c) {
            c.rows.unshift(row);
            // ⚠️ 不再按 CACHE_ROWS 截断：截断时 byNx/byMd5/sorted 里会残留已不在 rows 中的记录
            //   （CodeRabbit 指出）。行数由 MAX_READ_LINES 兜底。
            // 增量维护双向前缀索引（不然下次查询判定 mtime 变了 → 重扫 500 行重建）
            for (const md of Array.isArray(row.f) ? row.f : []) {
                const k = String(md).toLowerCase();
                if (!k)
                    continue;
                const ml = c.byMd5.get(k);
                if (ml)
                    ml.unshift(row);
                else
                    c.byMd5.set(k, [row]);
            }
            const nx = normQuoteText(row.x);
            if (nx) {
                row._nx = nx;
                const list = c.byNx.get(nx);
                if (list)
                    list.unshift(row);
                else {
                    c.byNx.set(nx, [row]);
                    // 有序数组插入（二分找位）
                    let lo = 0;
                    let hi = c.sorted.length;
                    while (lo < hi) {
                        const mid = (lo + hi) >>> 1;
                        const v = c.sorted[mid];
                        if (v !== undefined && v < nx)
                            lo = mid + 1;
                        else
                            hi = mid;
                    }
                    c.sorted.splice(lo, 0, nx);
                }
            }
            c.key = 'dirty';
        }
    }
    catch {
        return;
    }
    writeTick = (writeTick + 1) % 200;
    if (writeTick === 0)
        pruneOld();
}
/**
 * ★ 按「被引用的内容」反查原主（2026-11-14，主人定：归属就用历史台账，不另开独立账）。
 *
 * 两条路，都从**新→旧**走、命中即停：
 *   ① **图片指纹**（优先）—— 引用纯图时正文只剩 `[image: xxx.png]`，归一化后是空串，
 *      正文匹配走不通；QQ 的图片文件名就是内容 MD5，记在历史行的 `f` 字段里。
 *   ② **正文匹配** —— 被引原话是引用时一定拿得到的东西，比"赌两个索引相等"可靠得多
 *      （`ref_msg_idx` 与 `msg_idx` 不是同一个值，这点主人已经点破）。
 *
 * @param imageMd5s 额外指纹（从 `quote.attachments[].filename` 拿到的）
 */
export function findSenderByQuote(scope, peerId, text, imageMd5s) {
    if (!historyRoot || !peerId)
        return undefined;
    // ── ① 图片指纹：走 byMd5 索引，O(1) ──
    const mds = md5sInText(text);
    for (const v of Array.isArray(imageMd5s) ? imageMd5s : []) {
        const low = String(v ?? '').toLowerCase();
        if (low && !mds.includes(low))
            mds.push(low);
    }
    if (mds.length) {
        const now0 = Date.now();
        const dir0 = dirOf(scope, peerId);
        for (const day of [dayOf(now0), dayOf(now0 - 86400000)]) {
            const file = join(dir0, `${day}.jsonl`);
            if (!existsSync(file))
                continue;
            let rows;
            try {
                rows = readDayRows(file, true);
            }
            catch {
                continue;
            }
            const c = dayCache.get(file);
            const byMd5 = c ? c.byMd5 : buildIndex(rows).byMd5;
            const hits = [];
            for (const md of mds) {
                const list = byMd5.get(md);
                if (list)
                    hits.push(...list);
            }
            const r = newestOf(hits);
            if (r && (r.s || r.n))
                return { senderName: r.n, senderId: r.s };
        }
    }
    // ── ② 正文（双向前缀匹配：排序数组二分 + 前缀 Map，O(log n) / O(L)）──
    const q = normQuoteText(text);
    if (q.length < 2)
        return undefined;
    const now = Date.now();
    const dir = dirOf(scope, peerId);
    // 只看最近两天：引用目标几乎不会是更早的（群里一天上千条，两天足够）
    for (const day of [dayOf(now), dayOf(now - 86400000)]) {
        const file = join(dir, `${day}.jsonl`);
        if (!existsSync(file))
            continue;
        let rows;
        try {
            rows = readDayRows(file, true);
        }
        catch {
            continue;
        }
        const c = dayCache.get(file);
        const idx = c ? { sorted: c.sorted, byNx: c.byNx } : buildIndex(rows);
        const hit = newestOf(collectPrefixMatches(idx, q));
        if (hit && (hit.s || hit.n))
            return { senderName: hit.n, senderId: hit.s };
    }
    return undefined;
}
/**
 * 把 dayCache 控制在 8 项以内，并保住 `keep` 对应的文件。
 * ★ 2026-11-15（CodeRabbit 第二轮）：原来只有"成功读文件"那条路径会淘汰，
 *   "首建空缓存"的路径不会 —— 每来一个新会话就多一项，能突破上限。
 */
function evictDayCache(keep) {
    for (const k of [...dayCache.keys()]) {
        if (dayCache.size <= 8)
            break;
        if (k !== keep)
            dayCache.delete(k);
    }
}
/**
 * 读某一天的行（新→旧，最多 {@link MAX_READ_LINES} 行）。
 * `cacheable=true` 时把解析结果留在内存（只给"今天"用，见 {@link dayCache}）。
 */
function readDayRows(file, cacheable) {
    if (cacheable) {
        const hit = dayCache.get(file);
        if (hit) {
            // 'dirty' = 本进程刚追加过、内存比文件新
            if (hit.key === 'dirty')
                return hit.rows;
            let key = '';
            try {
                const st = statSync(file);
                key = st.mtimeMs + ':' + st.size;
            }
            catch {
                return hit.rows;
            }
            if (hit.key === key)
                return hit.rows;
        }
    }
    let text = '';
    try {
        text = readFileSync(file, 'utf8');
    }
    catch {
        // ★ 2026-11-15（CodeRabbit 抓到）：文件还不存在时，cacheable 也要**建一个空缓存** ——
        //   这样 append 拿到的就是同一份内存对象、能增量更新它；
        //   否则"刚接受的那条消息"对同进程的紧随查询不可见（要等它落盘）。
        if (cacheable && !dayCache.has(file)) {
            dayCache.set(file, { key: 'dirty', rows: [], sorted: [], byNx: new Map(), byMd5: new Map() });
            // ★ CodeRabbit 第二轮：首建空缓存也要走淘汰，否则新会话一条就加一个、能超 8 项
            evictDayCache(file);
        }
        return dayCache.get(file)?.rows ?? [];
    }
    const lines = text.split('\n');
    const start = Math.max(0, lines.length - MAX_READ_LINES);
    const rows = [];
    for (let i = lines.length - 1; i >= start; i--) {
        const line = lines[i];
        if (!line)
            continue;
        try {
            const r = JSON.parse(line);
            if (r?.id)
                rows.push(r);
        }
        catch { /* 坏行跳过 */ }
    }
    // ⚠️ 2026-11-15（CodeRabbit 抓到）：这里**不能**按 CACHE_ROWS 截断缓存 ——
    //   通用查询（撤回、历史注入）用的是同一个函数，截断会让它们只看到最近 500 条，
    //   比改动前少。缓存行数由 MAX_READ_LINES 兜底，一天的量远小于它。
    if (cacheable) {
        let key = 'dirty';
        try {
            const st = statSync(file);
            key = st.mtimeMs + ':' + st.size;
        }
        catch { /* 文件没了也无所谓 */ }
        // 建索引时顺手预归一化（`_nx`）：匹配时要拿每条正文跟被引原文比，
        // 若每次现算 `normQuoteText`（5 条正则替换），几百条就是上千次正则 —— 实测占 7ms 的大头。
        dayCache.set(file, { key, rows, ...buildIndex(rows) });
        evictDayCache(file);
    }
    return rows;
}
/** 读该会话的历史（**只碰它自己的目录**），新→旧 */
export function readMsgHistory(scope, peerId, q = {}) {
    if (!historyRoot || !peerId)
        return [];
    const dir = dirOf(scope, peerId);
    if (!existsSync(dir))
        return [];
    const now = Date.now();
    const within = q.withinMs ?? KEEP_DAYS * 24 * 60 * 60 * 1000;
    const from = now - within;
    const limit = Math.max(1, Math.min(200, q.limit ?? 20));
    const kw = String(q.keyword ?? '').trim().toLowerCase();
    // 只读窗口覆盖到的日期文件（新→旧）
    const days = [];
    for (let d = new Date(now); d.getTime() >= from && days.length <= KEEP_DAYS; d = new Date(d.getTime() - 24 * 60 * 60 * 1000)) {
        days.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    }
    const out = [];
    const maxScan = Number(q.maxScan ?? 0) > 0 ? Number(q.maxScan) : Number.POSITIVE_INFINITY;
    let scanned = 0;
    for (const day of days) {
        if (out.length >= limit || scanned >= maxScan)
            break;
        const f = join(dir, `${day}.jsonl`);
        if (!existsSync(f))
            continue;
        // 最近两天走内存缓存（今天在追加、昨天可能被引用），更早的没必要占内存
        const rows = readDayRows(f, day === dayOf(now) || day === dayOf(now - 86400000));
        // rows 已经是新→旧
        for (const r of rows) {
            if (out.length >= limit || scanned >= maxScan)
                break;
            scanned += 1;
            if (Number(r.t) < from)
                continue;
            if (q.fromSelf !== undefined && Boolean(r.me) !== q.fromSelf)
                continue;
            if (q.senderId && r.s !== q.senderId)
                continue;
            if (q.kind && (r.k ?? 'text') !== q.kind)
                continue;
            if (kw && !String(r.x ?? '').toLowerCase().includes(kw))
                continue;
            // 图片指纹筛选：老记录没有 `f` 字段 → 自然不命中
            if (q.imageMd5) {
                const want = String(q.imageMd5).toLowerCase();
                const has = Array.isArray(r.f) && r.f.some((v) => String(v).toLowerCase() === want);
                if (!has)
                    continue;
            }
            out.push(r);
        }
    }
    return out;
}
/** 找「某人最近一条」/「最近一条」 */
export function latestMsgHistory(scope, peerId, opts = {}) {
    return readMsgHistory(scope, peerId, { ...opts, limit: 1 })[0];
}
/** 诊断：会话目录 + 今天文件行数 */
export function historyDebug(scope, peerId) {
    if (!historyRoot)
        return '(台账未初始化)';
    const dir = dirOf(scope, peerId);
    if (!existsSync(dir))
        return `(该会话还没有台账目录: ${dir})`;
    const f = join(dir, `${dayOf(Date.now())}.jsonl`);
    let n = 0;
    try {
        if (existsSync(f))
            n = readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
    }
    catch { /* ignore */ }
    return `(台账 ${dir} · 今天 ${n} 条 · 保留 ${KEEP_DAYS} 天)`;
}
/**
 * 最近有消息写入的群目录对应的 gid（2026-10-20）。
 * 用途：web 会话里拿不到群会话记录时的兜底 —— 一般就是"当前正在聊的群"。
 */
export function latestGroupId() {
    if (!historyRoot)
        return '';
    let best = '';
    let bestT = 0;
    try {
        for (const d of readdirSync(historyRoot)) {
            if (!d.startsWith('group_'))
                continue;
            const st = statSync(join(historyRoot, d));
            if (st.mtimeMs > bestT) {
                bestT = st.mtimeMs;
                best = d.slice(6);
            }
        }
    }
    catch { /* ignore */ }
    return best;
}
//# sourceMappingURL=msg-history.js.map