/**
 * quote-cache.ts — 引用消息原文缓存（省 token 用）
 *
 * 背景（2026-09-13 主人定）: 引用消息会把**被引用的原文**整段塞进上下文, 引用一长就很吃 token。
 * 现在入站只给**前 N 字**（inbound 里 QUOTE_KEEP, 默认 60), 完整原文落到本地缓存
 * （**每个会话最多 10 条**, 超出丢最旧), AI 需要时用 `quote_view` 工具取（默认最新一条）。
 *
 * 存储: `{dataRoot}/.qqbot/quote-cache.json`
 *   `{ seq: 自增编号, map: { "group:<gid>" | "c2c:<openid>": [{id,text,sender,at}, …] } }`
 * 编号全局自增（人也能在文件里直接看/对号), 每个会话各自留最近 10 条。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** 每个会话保留的条数（主人定: 最多 10 条） */
export const QUOTE_CACHE_MAX = 10;
const cache = new Map();
function fileOf(dataRoot) {
    return join(dataRoot, '.qqbot', 'quote-cache.json');
}
function load(dataRoot) {
    const hit = cache.get(dataRoot);
    if (hit)
        return hit;
    let data = { seq: 0, map: {} };
    try {
        const raw = JSON.parse(readFileSync(fileOf(dataRoot), 'utf8'));
        if (raw && typeof raw === 'object' && raw.map && typeof raw.map === 'object') {
            data = { seq: Number(raw.seq) || 0, map: raw.map };
        }
    }
    catch { /* 首次/损坏 → 空缓存 */ }
    cache.set(dataRoot, data);
    return data;
}
function save(dataRoot, data) {
    try {
        const p = fileOf(dataRoot);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(data), 'utf8');
    }
    catch { /* 缓存写失败不影响主链 */ }
}
/** 本地日期键 YYYY-MM-DD（编号按天重置的判据） */
function todayKey() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
/** 取下一个编号：当天内累加，跨天重置为 1 */
function nextId(data) {
    const today = todayKey();
    if (data.day !== today) {
        data.day = today;
        data.count = 0;
    }
    data.count = (Number(data.count) || 0) + 1;
    return data.count;
}
/** 存一条引用原文, 返回它的编号（超上限丢最旧） */
export function pushQuote(dataRoot, key, text, sender) {
    const data = load(dataRoot);
    const entry = { id: nextId(data), text: String(text || ''), sender, at: Date.now() };
    const list = Array.isArray(data.map[key]) ? data.map[key] : [];
    list.push(entry);
    data.map[key] = list.slice(-QUOTE_CACHE_MAX);
    save(dataRoot, data);
    return entry;
}
/** 某会话的引用列表（新→旧） */
export function listQuotes(dataRoot, key) {
    const list = load(dataRoot).map[key];
    return Array.isArray(list) ? [...list].reverse() : [];
}
/** 按编号取; 不传 id = 最新一条; 传了但不在本会话 = undefined */
export function getQuote(dataRoot, key, id) {
    const list = load(dataRoot).map[key];
    if (!Array.isArray(list) || list.length === 0)
        return undefined;
    if (typeof id === 'number' && Number.isFinite(id)) {
        // ★ 2026-11-01：编号改成按天重置后，**跨天会出现同一个 id**（昨天的 #5 / 今天的 #5）。
        //   原来 `list.find` 从头（旧）找 ⇒ 会命中昨天那条、把今天的内容顶掉。
        //   改成从尾（新）往前找：同 id 一律取**最新**那条。
        for (let i = list.length - 1; i >= 0; i--) {
            const e = list[i];
            if (e && e.id === id)
                return e;
        }
        return undefined;
    }
    return list[list.length - 1];
}
//# sourceMappingURL=quote-cache.js.map