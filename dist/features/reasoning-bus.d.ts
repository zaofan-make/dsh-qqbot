/**
 * reasoning-bus.ts — 把「思考(reasoning)流」喂给扩展（2026-10-20）
 *
 * 背景：宿主瞬态通道 `agent/assistant-stream` 里除了 `text-delta` 还有 `reasoning-delta`。
 * 出站只用正文，思考一直是被丢掉的。但思考里往往写着"我打算怎么回答"，
 * 主人希望能在**不回正文**的情况下，把其中 `[汇报]…[/汇报]` 片段直接发到 QQ。
 *
 * 做法：内核只负责把 reasoning 增量与"本回合有没有正文"广播出来；
 * 解析与发送交给扩展（默认示例见 examples/ext-outbound/report-relay.mjs）——
 * 扩展用 `globalThis[Symbol.for('im-qqbot.outbound')].send(text)` 发送。
 *
 * 扩展侧用法：
 *   const rb = globalThis[Symbol.for('im-qqbot.reasoning')];
 *   rb.onDelta((agentId, text) => {...});
 *   rb.onTurnEnd((agentId, { hasReply }) => {...});
 */
/** 全局 API 键（与 im-qqbot.outbound 同风格） */
export declare const REASONING_API_KEY: unique symbol;
/** 回复目标（扩展发消息时用，避免"发到最近活跃的那个群"串群） */
export interface ReasoningTarget {
    scope: string;
    peerId: string;
}
export type ReasoningDeltaFn = (agentId: string, text: string, target?: ReasoningTarget) => void;
export type ReasoningTurnFn = (agentId: string, info: {
    hasReply: boolean;
}) => void;
/** 在"这批回调属于 owner"的上下文里执行装载（ext-outbound 用） */
export declare function runWithReasoningOwner<T>(owner: string, fn: () => T): T;
/** 兼容旧调用（同步设置 owners 已不适用，保留空实现避免外部报错） */
export declare function setReasoningOwner(owner: string): void;
/** 注册思考增量回调（返回取消函数） */
export declare function onReasoningDelta(fn: ReasoningDeltaFn): () => void;
/** 注册回合结束回调（返回取消函数） */
export declare function onReasoningTurnEnd(fn: ReasoningTurnFn): () => void;
/** 内核调用：来了一段思考增量 */
export declare function feedReasoning(agentId: string, text: string, target?: ReasoningTarget): void;
/** 内核调用：本回合结束（hasReply = 该回合是否真的产出过正文增量） */
export declare function endReasoningTurn(agentId: string, hasReply: boolean): void;
/** 该实例（含其下各文件）当前注册了多少回调 */
export declare function countReasoningHandlers(owner: string): number;
/** 一条待恢复的回调（带它自己的归属，恢复时按模块筛） */
export interface ReasoningSnapshotItem {
    fn: ReasoningDeltaFn | ReasoningTurnFn;
    owner: string;
    kind: 'delta' | 'turn';
}
export interface ReasoningSnapshot {
    items: ReasoningSnapshotItem[];
}
/** 取该实例（含其下各文件）的回调快照（清理前保存） */
export declare function snapshotReasoningHandlers(owner: string): ReasoningSnapshot;
/**
 * 恢复快照。
 *
 * ★ CodeRabbit #80（第 3 轮）：**不能看"该实例回调数为 0"就整批恢复** ——
 *   那分不清两种情形：① 文件没改、URL 未变 ⇒ ESM 缓存命中、模块根本没执行（该恢复）；
 *   ② 文件改了、模块删掉了 `onDelta` 注册 ⇒ 执行了但没注册（**不该恢复**，用户就是想禁用它）。
 *   所以由装载器报告"哪些文件命中了缓存"，这里只恢复 `allowOwners` 里的那些。
 */
export declare function restoreReasoningHandlers(snap: ReasoningSnapshot | undefined, allowOwners?: Set<string>): number;
export declare function clearReasoningHandlers(owner?: string): number;
//# sourceMappingURL=reasoning-bus.d.ts.map