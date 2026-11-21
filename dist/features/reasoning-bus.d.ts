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
/** 装载扩展前由 ext-outbound 调用：标出接下来注册的回调属于哪个实例 */
export declare function setReasoningOwner(owner: string): void;
/** 注册思考增量回调（返回取消函数） */
export declare function onReasoningDelta(fn: ReasoningDeltaFn): () => void;
/** 注册回合结束回调（返回取消函数） */
export declare function onReasoningTurnEnd(fn: ReasoningTurnFn): () => void;
/** 内核调用：来了一段思考增量 */
export declare function feedReasoning(agentId: string, text: string, target?: ReasoningTarget): void;
/** 内核调用：本回合结束（hasReply = 该回合是否真的产出过正文增量） */
export declare function endReasoningTurn(agentId: string, hasReply: boolean): void;
/**
 * 清空**所有**思考回调（2026-11-21，issue #78）。
 *
 * 为什么需要它：扩展注册回调时拿到的是取消函数，但**调用方经常漏存**；
 * 出站扩展热重载（`/tools_reload`）后旧闭包仍在 Set 里继续跑 ——
 * 于是"已经注释掉的扩展"还在往外发消息（实测）。
 *
 * 只在**重载出站扩展前**调用：它清的是全部回调，装完会重新注册。
 */
export declare function clearReasoningHandlers(owner?: string): number;
//# sourceMappingURL=reasoning-bus.d.ts.map