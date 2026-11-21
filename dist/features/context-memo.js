/**
 * context-memo.ts — 无上下文模式·智能判断下 **AI 自己的备忘**（2026-10-01 主人设计）。
 *
 * 设计要点（主人定）：
 *   · 摘要**可以叠加** —— AI 每次压缩历史都能追加一条要点，越聊越厚；
 *   · **AI 自己总结的绝不会被摒弃** —— 这是"摈弃上下文"时唯一的锚；
 *   · 因此需要能**查看 / 追加 / 修改 / 删除 / 清空**。
 *
 * 为什么单独落盘，而不是塞进会话事件（关键决策）：
 *   ① **压缩动不了它** —— 压缩只重写会话 surface，文件它碰不到
 *      ⇒ "总结不会被丢" 从**机制**上成立，不靠"小心别压到"；
 *   ② 天然可叠加（append 一条就是一层）；
 *   ③ 可编辑/删除（不用去改会话日志 —— 那正是历史上写坏过 5 次的地方）。
 *
 * 存储：`{dataRoot}/.qqbot/context-memo/<sessionKey 安全化>.jsonl`，一行一条 `{id, text, at}`。
 * 注入：每轮经 systemPrompt.context 进 **system 侧**（与群友小传同款姿势），不占 user 历史预算、
 *       也不参与压缩 —— 所以压缩后 AI 依然看得到自己的全部要点。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
/** 单个会话的备忘条数上限（**可配置**；超出自动丢最旧 —— 2026-10-02 主人要求"不要无限增加"） */
let MAX_ITEMS = 20;
/** 由插件配置设置（config.contextMemoMaxItems）；越界自动夹紧 */
export function setMemoMaxItems(n) {
    const v = Number(n);
    if (Number.isFinite(v) && v >= 1)
        MAX_ITEMS = Math.min(500, Math.floor(v));
}
export function getMemoMaxItems() { return MAX_ITEMS; }
/** 注入时的总字数上限（防备忘吃掉太多 system 预算） */
const INJECT_MAX_CHARS = 1800;
/** 单条字数上限 */
const ITEM_MAX_CHARS = 600;
/** 会话键 → 安全文件名（避免路径穿越/非法字符；保留可读前缀便于人工排查） */
function fileOf(dataRoot, sessionKey) {
    const raw = String(sessionKey ?? '');
    // ⚠️ 2026-10-01：**绝不能保留冒号** —— sessionKey 形如 qqbot:123:c2c:xxx，而 Windows
    //   文件名禁用 `:` ⇒ writeFileSync 抛 EINVAL 且被 catch 吞掉 ⇒ 备忘永远写不进去（但工具报成功）。
    const safe = raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
    const h = createHash('sha1').update(raw).digest('hex').slice(0, 8);
    return join(dataRoot, '.qqbot', 'context-memo', `${safe || 'session'}-${h}.jsonl`);
}
function load(file) {
    return loadSafe(file).items;
}
/**
 * 读文件并**带上"读成功没有"的标志**（CodeRabbit：注入侧要区分「读到空」和「读失败」——
 * 前者是用户清空了备忘，后者不能当成清空去作废现有备忘）。
 */
function loadSafe(file) {
    try {
        if (!existsSync(file))
            return { items: [], ok: true }; // 从没写过 = 空备忘，不算失败
        const out = [];
        for (const line of readFileSync(file, 'utf8').split('\n')) {
            const s = line.trim();
            if (!s)
                continue;
            try {
                const o = JSON.parse(s);
                if (o && typeof o.id === 'string' && typeof o.text === 'string' && o.text.trim()) {
                    out.push({ id: o.id, text: o.text, at: Number(o.at) || 0 });
                }
            }
            catch { /* 坏行跳过 */ }
        }
        return { items: out, ok: true };
    }
    catch {
        return { items: [], ok: false }; // EACCES 之类：读取失败，别当成"已清空"
    }
}
/** 原子重写（编辑/删除/清空都走它） */
function save(file, items) {
    try {
        mkdirSync(join(file, '..'), { recursive: true });
        const tmp = file + '.tmp-' + Date.now();
        writeFileSync(tmp, items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''), 'utf8');
        renameSync(tmp, file);
    }
    catch { /* 落盘失败不影响主链 */ }
}
function clip(text) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    return t.length > ITEM_MAX_CHARS ? t.slice(0, ITEM_MAX_CHARS) + '…' : t;
}
/** 列全部备忘（旧→新） */
export function listMemo(dataRoot, sessionKey) {
    if (!dataRoot || !sessionKey)
        return [];
    return load(fileOf(dataRoot, sessionKey));
}
/** 追加一条备忘；返回新条目（文本为空则返回 undefined） */
export function appendMemo(dataRoot, sessionKey, text) {
    const t = clip(text);
    if (!dataRoot || !sessionKey || !t)
        return undefined;
    const file = fileOf(dataRoot, sessionKey);
    const items = load(file);
    const item = { id: randomUUID().slice(0, 8), text: t, at: Date.now() };
    items.push(item);
    // 超上限丢最旧
    // 超上限丢最旧（保留最新 MAX_ITEMS 条）
    save(file, items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items);
    return item;
}
/** 改写某条（id 命中才改；返回是否改到） */
export function editMemo(dataRoot, sessionKey, id, text) {
    const t = clip(text);
    if (!dataRoot || !sessionKey || !id || !t)
        return false;
    const file = fileOf(dataRoot, sessionKey);
    const items = load(file);
    const hit = items.find((x) => x.id === String(id));
    if (!hit)
        return false;
    hit.text = t;
    hit.at = Date.now();
    save(file, items);
    return true;
}
/** 删除某条（返回是否删到） */
export function deleteMemo(dataRoot, sessionKey, id) {
    if (!dataRoot || !sessionKey || !id)
        return false;
    const file = fileOf(dataRoot, sessionKey);
    const items = load(file);
    const kept = items.filter((x) => x.id !== String(id));
    if (kept.length === items.length)
        return false;
    save(file, kept);
    return true;
}
/** 清空（返回清掉的条数） */
export function clearMemo(dataRoot, sessionKey) {
    if (!dataRoot || !sessionKey)
        return 0;
    const file = fileOf(dataRoot, sessionKey);
    const n = load(file).length;
    if (n > 0)
        save(file, []);
    return n;
}
/** 供注入：拼成一段 system 侧文本（空备忘返回空串）。超出上限从**最旧**开始丢。 */
export function memoTextForInject(dataRoot, sessionKey) {
    return memoForInject(dataRoot, sessionKey).text;
}
/**
 * 注入用：**文本 + 读取是否成功**。
 *
 * CodeRabbit：注入侧要区分「成功读到空」（用户清空了备忘，要补一条作废标记）
 * 与「读取失败」（EACCES 等，绝不能当作清空去覆盖现有备忘）。
 */
export function memoForInject(dataRoot, sessionKey) {
    if (!dataRoot || !sessionKey)
        return { ok: false, text: '' };
    const rd = loadSafe(fileOf(dataRoot, sessionKey));
    if (!rd.ok)
        return { ok: false, text: '' };
    const items = rd.items;
    if (!items.length)
        return { ok: true, text: '' };
    const lines = [];
    let used = 0;
    for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (!it)
            continue;
        const line = `· ${it.text}`;
        if (used + line.length > INJECT_MAX_CHARS)
            break;
        lines.unshift(line);
        used += line.length + 1;
    }
    if (!lines.length)
        return { ok: true, text: '' };
    return {
        ok: true,
        text: [
            '【你（机器人）自己的备忘 —— 无上下文模式下用来代替被压缩掉的历史】',
            ...lines,
            '（这些是你过去的总结，不会被压缩丢掉；要增改删请用 context_memo 工具）',
        ].join('\n'),
    };
}
/** 诊断：当前备忘条数与文件大小 */
export function memoStats(dataRoot, sessionKey) {
    const file = fileOf(dataRoot, sessionKey);
    let bytes = 0;
    try {
        bytes = statSync(file).size;
    }
    catch { /* 还没有文件 */ }
    return { count: listMemo(dataRoot, sessionKey).length, bytes, file };
}
//# sourceMappingURL=context-memo.js.map