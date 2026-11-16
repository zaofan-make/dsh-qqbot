/**
 * segment-ledger.ts — 「一段消息」的**内存台账**（2026-11-17 主人定）。
 *
 * ## 它解决什么
 *
 * 分段压缩（`contextless-trim` 的 segment 模式）和一个测试扩展都需要回答同一个问题：
 *
 * > **从上回合结束到现在，这段里都有谁说过话？主人说了没有？这次是被谁叫醒的？**
 *
 * 三处坑导致这问题不能"现查"：
 *   1. **宿主的 surface 没有发送者** —— `user/message` 的 `source` 只有 `{ kind: 'user' }`
 *      （见 `@deepseek-ai/dsh-llm` 的 `MessageSourceMap`），append 进去之后 senderId 就丢了；
 *   2. **防抖窗口有，但 flush 完就销毁**，而且只覆盖"还没派发的"，静默 append 的早不在里面；
 *   3. **反查落盘台账（msg-history）要读文件**，每条消息一次 IO —— 分段压缩每回合都要扫全段，太慢。
 *
 * 所以 senderId 只在**入站那一刻**存在于内存里：那时顺手记一笔，唤醒时读走并清空。
 *
 * ## 格式：**完全对齐群历史台账**（`msg-history.HistoryRec`）
 *
 * 主人要求：这套结构要能直接给别的扩展作者用，所以字段名一个字都不改 ——
 * `id / s / n / t / k / x / me`。将来想落盘，`JSON.stringify` 一下就是 msg-history 的行。
 *
 * ## 生命周期（主人的设计）
 *
 * ```
 * 消息入站（静默 append 或唤醒） → noteSegmentItem()  累加
 * 唤醒那一刻                   → captureSegment()   快照 + 清空
 * ```
 *
 * - **一个会话一条台账**（key = `sessionKey`，如 `group:<openid>`）
 * - **唤醒即清空** ⇒ 台账里永远只有"当前这一段"，不随消息数增长，**不需要容量上限**
 * - 不落盘、不挂 session 对象 ⇒ 重启天然为空（本来就该为空：内存里没有"这段"了）
 *
 * ## 给扩展用
 *
 * ```js
 * // 工具 env / 命令 env 上（见 segment-ledger 的导出）
 * const seg = getPrevSegment(env.peerSessionId ?? '')
 * seg?.hasOwner      // 上一段里主人说过话吗
 * seg?.wokeByOwner   // 这次是被主人叫醒的吗
 * seg?.items         // 那段消息本体（HistoryRec 同款：[{id,s,n,t,k,x,me}]）
 * ```
 */
/** 当前累积（还没唤醒的那一段） */
const pending = new Map();
/** 上一段的定格快照（唤醒时写入，下一段开始前一直可读） */
const lastSnap = new Map();
/** 单段条数上限：纯粹防"永远不唤醒的会话"把内存撑爆；正常对话远到不了 */
const MAX_PENDING = 500;
/** 快照保留条数（给扩展看的那份可以截断，hasOwner 等统计不受影响） */
const MAX_SNAPSHOT_ITEMS = 200;
/** 归一 key：群/私聊各一条台账 */
function keyOf(sessionKey) {
    return String(sessionKey ?? '').trim();
}
/**
 * 记一条入站消息（**静默 append 和唤醒都要记**）。
 *
 * @param sessionKey `group:<群openid>` / `c2c:<用户openid>`
 * @param item       群历史台账同款字段
 * @param isOwner    这条是不是主人发的（调用方用 owners 白名单算好，别在这里比）
 */
export function noteSegmentItem(sessionKey, item, isOwner) {
    const k = keyOf(sessionKey);
    if (!k || !item?.id)
        return;
    let seg = pending.get(k);
    if (!seg) {
        seg = { items: [], ownerCount: 0 };
        pending.set(k, seg);
    }
    // 同一条重复入站（重试/聚合）只记一次
    if (seg.items.some((it) => it.id === item.id))
        return;
    seg.items.push(item);
    if (isOwner)
        seg.ownerCount += 1;
    if (seg.items.length > MAX_PENDING)
        seg.items.splice(0, seg.items.length - MAX_PENDING);
}
/**
 * **唤醒那一刻**调用：把当前这段定格成快照，然后清空。
 *
 * @param sessionKey   同上
 * @param wokeById     触发唤醒的那条 message_id（不知道就传空）
 * @param wokeSenderId 触发唤醒那条的发送者 openid（用来判 `wokeByOwner`）
 * @param ownerOpenid  主人 openid（与 `wokeSenderId` 相等即 `wokeByOwner = true`）
 * @returns 定格出来的快照（拿不到也有个空壳，调用方不必判空）
 */
export function captureSegment(sessionKey, opts) {
    const k = keyOf(sessionKey);
    const seg = pending.get(k);
    const items = seg?.items ?? [];
    const ownerOpenid = String(opts?.ownerOpenid ?? '').trim();
    const wokeSenderId = String(opts?.wokeSenderId ?? '').trim();
    const snap = {
        items: items.slice(-MAX_SNAPSHOT_ITEMS),
        hasOwner: (seg?.ownerCount ?? 0) > 0,
        ownerCount: seg?.ownerCount ?? 0,
        total: items.length,
        wokeByOwner: !!ownerOpenid && !!wokeSenderId && ownerOpenid === wokeSenderId,
        wokeBy: String(opts?.wokeById ?? ''),
        capturedAt: Date.now(),
    };
    if (k) {
        lastSnap.set(k, snap);
        pending.delete(k); // ★ 唤醒即清空：下一段从零开始记
    }
    return snap;
}
/** 读上一段的快照（没唤醒过 / 已重启 → undefined） */
export function getPrevSegment(sessionKey) {
    const k = keyOf(sessionKey);
    return k ? lastSnap.get(k) : undefined;
}
/** 当前累积但还没唤醒的那段（调试/诊断用） */
export function peekPendingSegment(sessionKey) {
    const k = keyOf(sessionKey);
    const seg = k ? pending.get(k) : undefined;
    return seg ? { items: seg.items.slice(), ownerCount: seg.ownerCount } : undefined;
}
/** 清掉某会话的台账（会话销毁 / 重置时用） */
export function clearSegment(sessionKey) {
    const k = keyOf(sessionKey);
    if (!k)
        return;
    pending.delete(k);
    lastSnap.delete(k);
}
/** 供 /diag 之类看全貌 */
export function segmentLedgerStats() {
    return { pendingKeys: pending.size, snapshotKeys: lastSnap.size };
}
//# sourceMappingURL=segment-ledger.js.map