/**
 * segment-score.ts — 「分段压缩」用的**价值分台账**（2026-11-06 主人定）。
 *
 * 需求：分段压缩除了"固定留最后 N 条"，还要能**按价值分保命** ——
 *   比如门槛填 0.78，那么分值 ≥ 0.78 的群消息即使排在 N 条之外也照样留下。
 *
 * 数据从哪来：入站时本地小模型已经给每条消息打过分（`value-score`），
 *   但那个分数是**跟着 appendScoreLog 落盘**的、按 messageId 索引，
 *   surface 上的节点是 seq —— 这里在 **append 那一刻**把 seq → 分数记下来，
 *   压缩时就能直接按 seq 查。
 *
 * ⚠️ 用 WeakMap 挂在 session 对象上：会话没了自动回收，不会泄漏；也天然按会话隔离。
 */
const table = new WeakMap();
/** 记一条：某次 append 产生的 surface 节点 seq → 这条消息的价值分（0~1） */
export function noteSegmentScore(session, seq, score) {
    try {
        if (!session || typeof session !== 'object')
            return;
        const sq = Number(seq);
        const sc = Number(score);
        if (!Number.isFinite(sq) || !Number.isFinite(sc))
            return;
        let m = table.get(session);
        if (!m) {
            m = new Map();
            table.set(session, m);
        }
        m.set(Math.trunc(sq), sc);
        // 上限保护：只留最近 500 条，避免长会话里无限增长
        if (m.size > 500) {
            const keys = [...m.keys()].sort((a, b) => a - b);
            for (const k of keys.slice(0, m.size - 500))
                m.delete(k);
        }
    }
    catch { /* 记分失败不影响主链 */ }
}
/** 查某节点的分值（没有就 undefined） */
export function getSegmentScore(session, seq) {
    try {
        if (!session || typeof session !== 'object')
            return undefined;
        const m = table.get(session);
        if (!m)
            return undefined;
        return m.get(Number(seq));
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=segment-score.js.map