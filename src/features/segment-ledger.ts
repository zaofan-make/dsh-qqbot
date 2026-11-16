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

/** 一条消息 —— 字段与 `msg-history.HistoryRec` **完全一致**（id/s/n/t/k/x/me） */
export interface SegmentItem {
  /** QQ message_id */
  id: string;
  /** 发送者 openid（机器人自己发时 'self'） */
  s: string;
  /** 昵称 */
  n: string;
  /** 毫秒时间戳 */
  t: number;
  /** 类型：text / image / voice / video / file */
  k?: string;
  /** 正文摘要 */
  x: string;
  /** 是否机器人自己发的 */
  me?: boolean;
}

/** 一段的快照（唤醒那一刻定格，之后不变） */
export interface SegmentSnapshot {
  /** 这一段的消息本体（群历史台账同款格式） */
  items: SegmentItem[];
  /** 这段里**主人说过话**吗 */
  hasOwner: boolean;
  /** 主人说了几条 */
  ownerCount: number;
  /** 这一段一共几条 */
  total: number;
  /** 这次唤醒是不是**主人**触发的（唤醒那条消息的发送者 === 主人） */
  wokeByOwner: boolean;
  /** 触发唤醒的那条 message_id（空 = 不是消息唤醒，比如定时/被动） */
  wokeBy: string;
  /** 快照时刻（ms） */
  capturedAt: number;
}

interface PendingSegment {
  items: SegmentItem[];
  ownerCount: number;
  /**
   * **独立累计**的去重后总条数（2026-11-17，CodeRabbit 指出）。
   *
   * 不能拿 `items.length` 当总数：`MAX_PENDING` 截断后它会停在 500，
   * 而 `ownerCount` 仍在涨 ⇒ 出现 `ownerCount > total` 这种自相矛盾的快照。
   */
  total: number;
  /**
   * **独立的去重集合**（2026-11-17，CodeRabbit）。
   *
   * 不能拿 `items` 判重：`items` 有 `MAX_PENDING` 截断，被挤出去的 id 再重投一次
   * 就会被当成"新消息"再计一次 `total`（实测应为 501 却变 502，`ownerCount` 也会重复累加）。
   * 这个集合只存 id，上限比 `items` 宽一档，足够覆盖重投窗口。
   */
  seen: Set<string>;
}

/** 当前累积（还没唤醒的那一段） */
const pending = new Map<string, PendingSegment>();
/** 上一段的定格快照（唤醒时写入，下一段开始前一直可读） */
const lastSnap = new Map<string, SegmentSnapshot>();

/** 单段条数上限：纯粹防"永远不唤醒的会话"把内存撑爆；正常对话远到不了 */
const MAX_PENDING = 500;
/** 快照保留条数（给扩展看的那份可以截断，hasOwner 等统计不受影响） */
const MAX_SNAPSHOT_ITEMS = 200;

/** 归一 key：群/私聊各一条台账 */
function keyOf(sessionKey: unknown): string {
  return String(sessionKey ?? '').trim();
}

/**
 * 记一条入站消息（**静默 append 和唤醒都要记**）。
 *
 * @param sessionKey `group:<群openid>` / `c2c:<用户openid>`
 * @param item       群历史台账同款字段
 * @param isOwner    这条是不是主人发的（调用方用 owners 白名单算好，别在这里比）
 */
export function noteSegmentItem(sessionKey: unknown, item: SegmentItem, isOwner: boolean): void {
  const k = keyOf(sessionKey);
  if (!k || !item?.id) return;
  let seg = pending.get(k);
  if (!seg) { seg = { items: [], ownerCount: 0, total: 0, seen: new Set() }; pending.set(k, seg); }
  // 同一条重复入站（重试/聚合）只记一次
  if (seg.items.some((it) => it.id === item.id)) return;
  seg.items.push(item);
  seg.total += 1;                     // ★ 独立累计（不受 items 截断影响）
  if (isOwner) seg.ownerCount += 1;
  if (seg.items.length > MAX_PENDING) seg.items.splice(0, seg.items.length - MAX_PENDING);
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
export function captureSegment(
  sessionKey: unknown,
  opts?: { wokeById?: string; wokeSenderId?: string; ownerOpenid?: string },
): SegmentSnapshot {
  const k = keyOf(sessionKey);
  const seg = pending.get(k);
  const items = seg?.items ?? [];
  const ownerOpenid = String(opts?.ownerOpenid ?? '').trim();
  const wokeSenderId = String(opts?.wokeSenderId ?? '').trim();
  const snap: SegmentSnapshot = {
    items: items.slice(-MAX_SNAPSHOT_ITEMS).map((it) => ({ ...it })),   // ★ 深拷贝一份，别把内部对象交出去
    hasOwner: (seg?.ownerCount ?? 0) > 0,
    ownerCount: seg?.ownerCount ?? 0,
    total: seg?.total ?? 0,            // ★ 用独立累计值，不是 items.length
    wokeByOwner: !!ownerOpenid && !!wokeSenderId && ownerOpenid === wokeSenderId,
    wokeBy: String(opts?.wokeById ?? ''),
    capturedAt: Date.now(),
  };
  Object.freeze(snap.items);           // 数组本身也冻上（元素已拷贝）
  Object.freeze(snap);                 // 「唤醒时定格，之后不变」—— 契约要真的成立
  if (k) {
    lastSnap.set(k, snap);
    pending.delete(k);   // ★ 唤醒即清空：下一段从零开始记
  }
  return snap;
}

/**
 * 读上一段的快照（没唤醒过 / 已重启 → undefined）。
 *
 * ★ 2026-11-17（CodeRabbit）：**返回独立副本，不把内部对象交出去**。
 *   以前直接返回 `lastSnap` 里的那个对象 —— 扩展一句 `seg.items.reverse()`
 *   或改 `seg.items[0].s`，别的扩展随后读到的就是被改过的内容，
 *   "唤醒时定格、之后不变" 这条契约实际是假的。
 */
export function getPrevSegment(sessionKey: unknown): SegmentSnapshot | undefined {
  const k = keyOf(sessionKey);
  const snap = k ? lastSnap.get(k) : undefined;
  if (!snap) return undefined;
  // 内部那份是冻结的，这里返回一份可写的浅拷贝（items 也复制一遍元素）
  return {
    ...snap,
    items: snap.items.map((it) => ({ ...it })),
  };
}

/** 当前累积但还没唤醒的那段（调试/诊断用） */
export function peekPendingSegment(sessionKey: unknown): { items: SegmentItem[]; ownerCount: number } | undefined {
  const k = keyOf(sessionKey);
  const seg = k ? pending.get(k) : undefined;
  return seg ? { items: seg.items.slice(), ownerCount: seg.ownerCount } : undefined;
}

/** 清掉某会话的台账（会话销毁 / 重置时用） */
export function clearSegment(sessionKey: unknown): void {
  const k = keyOf(sessionKey);
  if (!k) return;
  pending.delete(k);
  lastSnap.delete(k);
}

/** 供 /diag 之类看全貌 */
export function segmentLedgerStats(): { pendingKeys: number; snapshotKeys: number } {
  return { pendingKeys: pending.size, snapshotKeys: lastSnap.size };
}
