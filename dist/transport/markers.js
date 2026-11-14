/**
 * markers.ts — 入站消息里的「块标记」**单一真源**（2026-09-15 主人要求省 token 后独立出来）
 *
 * 背景：原来这些标记是英文长句（`[Quoted message begins]` 之类），每轮都要原样喂给模型。
 *   实测（ARK 同文本只改标记）：一套标记 198 字符 → 109 字符，**每条省 ~14 token**。
 *   换成中文短标记后字符数再降，且**中文语义自解释**（引=引用 / 当前 / 历史），
 *   不需要额外花 token 在 system prompt 里教它。
 *
 * ⚠️ 两个都不能忘：
 *   ① 「改的时候代码里还有谁在用」——生产端(inbound)、解析端(trimQuoteBlock)、
 *      富文本清洗(cleanTextForScore)、以及 **dock 聊天视图**(settings-host.js 的
 *      chatSplitHistoryBlock / client 的渲染) 都认这些字面量。
 *   ② 「老会话里已经写进去的旧标记」——历史消息是**渲染时**解析的，
 *      所以 MK_LEGACY 那套必须长期保留（解析端认新旧两种），生产端只用新的。
 */
/** 现在生产用的短标记 */
export const MK = {
    QUOTE_BEGIN: '[引]',
    QUOTE_END: '[/引]',
    CURRENT: '[当前]',
    HISTORY_BEGIN: '[历史]',
    HISTORY_END: '[/历史]',
};
/** 2026-09-15 之前的英文长标记（**只读**：老会话/被引用原文里可能还有） */
export const MK_LEGACY = {
    QUOTE_BEGIN: '[Quoted message begins]',
    QUOTE_END: '[Quoted message ends]',
    CURRENT: '[Current message]',
    HISTORY_BEGIN: '[Chat history begins]',
    HISTORY_END: '[Chat history ends]',
};
export const QUOTE_BEGIN_ALL = [MK.QUOTE_BEGIN, MK_LEGACY.QUOTE_BEGIN];
export const QUOTE_END_ALL = [MK.QUOTE_END, MK_LEGACY.QUOTE_END];
export const CURRENT_ALL = [MK.CURRENT, MK_LEGACY.CURRENT];
export const HISTORY_BEGIN_ALL = [MK.HISTORY_BEGIN, MK_LEGACY.HISTORY_BEGIN];
export const HISTORY_END_ALL = [MK.HISTORY_END, MK_LEGACY.HISTORY_END];
/** 全部标记（清洗/判断用） */
export const ALL_MARKERS = [
    ...QUOTE_BEGIN_ALL, ...QUOTE_END_ALL, ...CURRENT_ALL, ...HISTORY_BEGIN_ALL, ...HISTORY_END_ALL,
];
/** 文本里出现过任一标记（大小写不敏感，兼容旧英文标记） */
/**
 * 标记解析的上限长度（2026-11-12 性能加固）。
 *
 * 这里全是"找第一个/最后一个标记"的线性扫描与正则；正常消息几百字，但一旦有人贴几万字
 * 的文本（日志、报错、聊天记录），这些扫描就会在事件循环上跑满几十毫秒。
 * 标记只可能出现在**开头或结尾附近**（[rf:] / [引用:] / [语音合成]），中间几万字对我们没有意义，
 * 所以超长时只保留头尾各一截，中间折叠 —— 结果与完整扫描一致，代价恒定。
 */
const MARKER_SCAN_LIMIT = 20_000;
export function clampForMarkerScan(text) {
    const t = String(text ?? '');
    if (t.length <= MARKER_SCAN_LIMIT)
        return t;
    const head = t.slice(0, MARKER_SCAN_LIMIT / 2);
    const tail = t.slice(-MARKER_SCAN_LIMIT / 2);
    return head + String.fromCharCode(10) + tail;
}
export function hasAnyMarker(text, needles = ALL_MARKERS) {
    text = clampForMarkerScan(text);
    const t = String(text ?? '');
    return needles.some((n) => t.toLowerCase().includes(n.toLowerCase()));
}
/** 找**第一个**出现的标记（认新旧），没有则返回 undefined */
export function findFirstMarker(text, needles) {
    // ★★ 2026-11-14 修（审查发现）：**超长文本返回 undefined，不要给下标** ——
    //   clampForMarkerScan 会把中间挖掉（头 + \n + 尾），算出来的 idx 是**截断后字符串**的下标，
    //   而调用方拿它去 slice **原始**内容（inbound.ts 切引用块）⇒ 超长消息的引用块必然切错位。
    if (String(text ?? "").length > MARKER_SCAN_LIMIT)
        return undefined;
    const t = String(text ?? '');
    let best;
    for (const n of needles) {
        const i = t.toLowerCase().indexOf(n.toLowerCase());
        if (i >= 0 && (!best || i < best.idx))
            best = { idx: i, len: n.length };
    }
    return best;
}
/** 找**最后一个**出现的标记（认新旧）—— 引用的"结束标记"必须取最后一个，否则会被原文里的假标记截断 */
export function findLastMarker(text, needles) {
    // ★ 同上：超长不给下标（调用方要拿它 slice 原串）
    if (String(text ?? "").length > MARKER_SCAN_LIMIT)
        return undefined;
    const t = String(text ?? '');
    let best;
    for (const n of needles) {
        const i = t.toLowerCase().lastIndexOf(n.toLowerCase());
        if (i >= 0 && (!best || i > best.idx))
            best = { idx: i, len: n.length };
    }
    return best;
}
/**
 * 引用原文里的块标记转义（2026-09-13 主人实测抓到的坑：AI 在代码块里示范过这些字面量，
 * 被引用后会混进引用块，让"第一个 begin + 第一个 end"的匹配切错位置）。
 * 方括号退化成圆括号：语义照旧看得懂，但不再参与结构匹配。
 */
export function escapeBlockMarkers(text) {
    text = clampForMarkerScan(text);
    let s = String(text ?? '');
    for (const m of ALL_MARKERS) {
        s = s.split(m).join(`(${m.slice(1, -1)})`); // [X] → (X)
        // 大小写变体（旧标记是英文，可能被写成小写）
        const lower = m.toLowerCase();
        if (lower !== m)
            s = s.split(lower).join(`(${m.slice(1, -1)})`);
    }
    return s;
}
/** 把块标记整段抹掉（打分文本/展示用；认新旧、大小写不敏感） */
export function stripBlockMarkers(text, replacement = ' ') {
    text = clampForMarkerScan(text);
    let s = String(text ?? '');
    for (const m of ALL_MARKERS) {
        s = s.split(m).join(replacement);
        const lower = m.toLowerCase();
        if (lower !== m) {
            // 大小写不敏感替换（旧英文标记）
            s = s.replace(new RegExp(m.replace(/[[\]]/g, '\\$&'), 'gi'), replacement);
        }
    }
    return s;
}
//# sourceMappingURL=markers.js.map