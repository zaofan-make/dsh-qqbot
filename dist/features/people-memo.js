/**
 * people-memo.ts — 「群友小传」（文字版好感度本体, 2026-09-13 主人定）
 *
 * 设计要点（详见 参考文档/dsh-qqbot-好感度系统设计_20260913.md §4.3）:
 *   · 一人一个本地 Markdown: `{dataRoot}/.qqbot/people/<uid>.md`（人可读、可手改、可删）
 *   · 八栏: 身份 / 本事 / 经历 / 成就 / 喜好与雷区 / 价值观 / 与该 AI 的关系 / 对该 AI 的期望
 *   · **只写旁人也复述得出来的事实** + 一句"她当时怎么接的"; 不写评价、不猜测
 *   · 原文留档: 摘要之上不动, 摘要改味了能对回来
 *   · 写入节流: 同一人**一天最多一条**(她顺手记, 不是台账)
 *   · 遗忘: 不删原文; 30 天没有新事件就沉底归档(归档不影响行为, 可按名字翻出)
 *   · 删除入口: 一句"别记人家" → 删整段 + 回执
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** 归档阈值(天): 小传最后修改超过这么久 → 沉底(仍在文件里, 只是不再优先召回) */
export const MEMO_ARCHIVE_DAYS = 30;
export function peopleDirOf(dataRoot) {
    return join(dataRoot, '.qqbot', 'people');
}
/** 文件名安全化(uid 一般是 hex, 但仍防穿越) */
function safeKey(key) {
    return String(key || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 64) || 'unknown';
}
export function memoPathOf(dataRoot, key) {
    return join(peopleDirOf(dataRoot), `${safeKey(key)}.md`);
}
export function readMemo(dataRoot, key) {
    const p = memoPathOf(dataRoot, key);
    try {
        return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
    }
    catch {
        return undefined;
    }
}
/** 列出全部小传(按最后修改时间新→旧) */
export function listMemos(dataRoot) {
    const dir = peopleDirOf(dataRoot);
    try {
        return readdirSync(dir)
            .filter((f) => f.endsWith('.md'))
            .map((f) => {
            const p = join(dir, f);
            const st = statSync(p);
            return {
                key: f.replace(/\.md$/, ''),
                path: p,
                bytes: st.size,
                mtime: st.mtimeMs,
                archived: Date.now() - st.mtimeMs > MEMO_ARCHIVE_DAYS * 86400_000,
            };
        })
            .sort((a, b) => b.mtime - a.mtime);
    }
    catch {
        return [];
    }
}
/** 每人每天最多记几条（2026-09-14 主人："只记一条怎么记得完" → 由 1 条放宽到 3 条） */
const MAX_PER_DAY = 3;
/** 今天的写入计数（内存；重启清零 → 最坏一天多记几条，观察期可接受） */
const writeCount = new Map();
/** 今天已经记了几条（含栏位条目） */
export function countWroteToday(key, now = Date.now()) {
    const day = new Date(now).toDateString();
    const hit = writeCount.get(key);
    return hit && hit.day === day ? hit.n : 0;
}
/** 兼容旧签名：今天是否已经记过（旧版按文件 mtime 判断，一天一条） */
export function wroteToday(_dataRoot, key, now = Date.now()) {
    return countWroteToday(key, now) > 0;
}
function bumpWriteCount(key, now = Date.now()) {
    const day = new Date(now).toDateString();
    const hit = writeCount.get(key);
    writeCount.set(key, hit && hit.day === day ? { day, n: hit.n + 1 } : { day, n: 1 });
}
/** 八栏映射：`line` 以栏名开头（"喜好：最近在玩 XX"）→ 归到该栏；否则进「## 记事」 */
const SECTIONS = [
    { title: '身份', aliases: ['身份', '是谁', '基本信息'] },
    { title: '本事', aliases: ['本事', '擅长', '技能'] },
    { title: '经历', aliases: ['经历', '做过'] },
    { title: '成就', aliases: ['成就', '成绩'] },
    { title: '喜好与雷区', aliases: ['喜好与雷区', '喜好', '雷区', '喜欢', '讨厌', '口味'] },
    { title: '价值观', aliases: ['价值观', '信念', '观念'] },
    { title: '与她的关系', aliases: ['与她的关系', '关系', '跟她的关系'] },
    { title: '对机器人的期望', aliases: ['对机器人的期望', '期望', '要求'] },
];
/** 拆栏目前缀："喜好：最近在玩 XX" → { section:'喜好与雷区', body:'最近在玩 XX' } */
function splitSection(line) {
    const m = /^([^：:]{1,12})[：:]\s*(.+)$/.exec(line.trim());
    if (m) {
        const head = m[1].trim();
        const hit = SECTIONS.find((s) => s.aliases.includes(head));
        if (hit)
            return { section: hit.title, body: m[2].trim() };
    }
    return { body: line.trim() };
}
/**
 * 追加一条。两种落法：
 *   · 带栏目前缀（"喜好：…"）→ 归到八栏（该栏已有一行 → 行尾用"；"并进去，保持"每栏一行"的摘要形态）
 *   · 不带前缀 → 进「## 记事」区（带日期，现状不变）
 * 节流：**同一人一天最多 3 条**（2026-09-14 放宽；原为 1 条，"只记一条怎么记得完"）。
 */
export function appendMemoLine(dataRoot, key, line, opts = {}) {
    const text = String(line || '').trim().slice(0, 300);
    if (!text)
        return { ok: false, msg: '内容是空的' };
    const n = countWroteToday(key);
    if (!opts.force && n >= MAX_PER_DAY) {
        return { ok: false, msg: `这个人今天已经记过 ${n} 条了(一天最多 ${MAX_PER_DAY} 条, 明天再说)` };
    }
    const dir = peopleDirOf(dataRoot);
    const p = memoPathOf(dataRoot, key);
    const today = new Date();
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const { section, body } = splitSection(text);
    try {
        mkdirSync(dir, { recursive: true });
        let cur = existsSync(p) ? readFileSync(p, 'utf8') : undefined;
        const created = cur === undefined;
        if (cur === undefined) {
            cur = `# ${opts.name || key}\n\n> 小传（八栏：身份/本事/经历/成就/喜好与雷区/价值观/与该 AI 的关系/对该 AI 的期望）\n> 只写旁人也复述得出来的事实 + AI 当时怎么接的；不写评价与猜测。原文留档不动。\n\n## 记事\n`;
        }
        if (section) {
            // ① 归栏：该栏已有 → 行尾并进去；没有 → 插到「## 记事」之前（八栏在上、记事在下）
            const prefix = `- ${section}：`;
            const lines = cur.split('\n');
            const idx = lines.findIndex((l) => l.startsWith(prefix));
            if (idx >= 0) {
                // 行尾原有的句号/分号先去干净再并 —— 否则会出现"。；"这种双标点（实测踩到）
                lines[idx] = `${lines[idx].replace(/[\s。；;，,、]+$/, '')}；${body}`;
                writeFileSync(p, lines.join('\n'), 'utf8');
            }
            else {
                const insert = `- ${section}：${body}`;
                const anchor = cur.indexOf('\n## 记事');
                if (anchor > 0)
                    writeFileSync(p, `${cur.slice(0, anchor)}\n${insert}${cur.slice(anchor)}`, 'utf8');
                else
                    writeFileSync(p, `${cur.replace(/\s*$/, '')}\n${insert}\n`, 'utf8');
            }
            bumpWriteCount(key);
            return { ok: true, msg: (created ? '已新建小传，' : '') + `已记进「${section}」栏` };
        }
        // ② 无栏目 → 记事区（带日期），插到「## 原始自述」之前
        const bullet = `- ${stamp} ${text}`;
        const idx2 = cur.indexOf('\n## 原始自述');
        if (idx2 > 0)
            writeFileSync(p, `${cur.slice(0, idx2)}\n${bullet}${cur.slice(idx2)}`, 'utf8');
        else
            writeFileSync(p, `${cur.replace(/\s*$/, '')}\n${bullet}\n`, 'utf8');
        bumpWriteCount(key);
        return { ok: true, msg: created ? '已新建小传并记下这条' : '已记下' };
    }
    catch (e) {
        return { ok: false, msg: `写入失败: ${e instanceof Error ? e.message : String(e)}` };
    }
}
/**
 * 取该小传里最适合注入的 1~2 行: 有嵌入器就按"与当前消息最相关"排, 没有就取最近两条。
 * 若整份小传已归档(30 天没更新) → 不注入(沉底)。
 */
export async function recallLines(dataRoot, key, query, embed, topN = 2) {
    const text = readMemo(dataRoot, key);
    if (!text)
        return { lines: [], archived: false };
    let archived = false;
    try {
        archived = Date.now() - statSync(memoPathOf(dataRoot, key)).mtimeMs > MEMO_ARCHIVE_DAYS * 86400_000;
    }
    catch { /* 读不到当未归档 */ }
    const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('- ') && !/^>\s/.test(l) && !/^-\s*\d+\./.test(l));
    if (lines.length === 0)
        return { lines: [], archived };
    if (archived)
        return { lines: [], archived }; // 沉底: 不参与注入(可按名字显式翻出)
    if (lines.length <= topN || !embed || !embed.available())
        return { lines: lines.slice(-topN), archived };
    try {
        const qv = await embed.embedQuery(String(query || '').slice(0, 200));
        const vv = await embed.embedPassages(lines.map((l) => l.replace(/^-\s*/, '')));
        if (!qv || !vv)
            return { lines: lines.slice(-topN), archived };
        const dot = (a, b) => {
            let s = 0;
            const n = Math.min(a.length, b.length);
            for (let i = 0; i < n; i += 1)
                s += a[i] * b[i];
            return s;
        };
        const scored = lines.map((l, i) => ({ l, s: dot(qv, vv[i] ?? []) }));
        scored.sort((a, b) => b.s - a.s);
        return { lines: scored.slice(0, topN).map((x) => x.l), archived };
    }
    catch {
        return { lines: lines.slice(-topN), archived };
    }
}
/** 删掉整段小传(群里一句"别记人家" → 立刻执行 + 回执) */
export function deleteMemo(dataRoot, key) {
    try {
        const p = memoPathOf(dataRoot, key);
        if (!existsSync(p))
            return { ok: true, msg: '本来就没有记过这个人' };
        rmSync(p);
        return { ok: true, msg: '已删掉' };
    }
    catch (e) {
        return { ok: false, msg: `删除失败: ${e instanceof Error ? e.message : String(e)}` };
    }
}
// ─────────── 运行时上下文贡献（2026-09-13 主人定：与 auto-memory 同款姿势） ───────────
// dsh 的 systemPrompt.context() 是"每次组装都求值"的动态贡献, 挂在历史尾部(user-role 快照),
// 而 **system prompt 本体保持字节级稳定 → 前缀缓存不被打穿**。这里只放"本轮要注入的那一行"，
// 由 inbound 算好后暂存，短 TTL(90s) 内被读取一次即用，过期自动丢弃，避免污染后续轮次。
/**
 * ⚠️ 2026-11-10 修（主人实测：**别的群的小传串到了本群**）：
 * 原来是**模块级单个变量** —— 入站 A 群算好 `setPendingMemo(text)`，
 * 而任何会话的 pre-step 都会 `takePendingMemoText()` 拿走它。
 * 两个群同时有消息时，A 群的小传就会被 B 群的回合吃走：
 *   ① B 群看到的是**别人**的小传（"这个群根本没这个人"）；
 *   ② A 群自己反而拿不到（表现为"小传注入失效"）。
 * 现在按 **sessionKey**（`qqbot:<appId>:<scope>:<peerId>`）分开存，各取各的。
 */
const pendingMemoMap = new Map();
const PENDING_TTL_MS = 90_000;
/**
 * inbound 算好"候选小传行"后调用（按会话 key 暂存，90 秒内有效）。
 *
 * ★ 2026-11-10 主人指正：**不能把拼好的整段文本拿来判重** ——
 *   前 40 字符里基本只有 `[人家记得的 昵称:` 和第一条，后面换行了也判不出来，
 *   于是"之后新想起来的条目永远被去重掉"。
 *   所以这里只存**原始行数组 + 昵称**，由 pre-step 逐行判"这一条在不在上下文里"。
 */
export function setPendingMemo(key, name, lines) {
    const k = String(key || '');
    if (!k)
        return;
    const clean = (Array.isArray(lines) ? lines : [])
        .map((l) => String(l || '').replace(/^-\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 4);
    if (clean.length === 0)
        return;
    pendingMemoMap.set(k, { name: String(name || '他').slice(0, 40), lines: clean, at: Date.now() });
    if (pendingMemoMap.size > 64) {
        const now = Date.now();
        for (const [kk, v] of pendingMemoMap)
            if (now - v.at > PENDING_TTL_MS)
                pendingMemoMap.delete(kk);
    }
}
/** 供 pre-step 调用：只取**本会话**那一份候选；过期/为空返回 undefined */
export function takePendingMemo(key) {
    const k = String(key || '');
    if (!k)
        return undefined;
    const v = pendingMemoMap.get(k);
    if (!v)
        return undefined;
    pendingMemoMap.delete(k);
    if (Date.now() - v.at > PENDING_TTL_MS)
        return undefined;
    return { name: v.name, lines: v.lines };
}
//# sourceMappingURL=people-memo.js.map