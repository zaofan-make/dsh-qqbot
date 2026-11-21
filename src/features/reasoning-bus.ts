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
export const REASONING_API_KEY = Symbol.for('im-qqbot.reasoning');

/** 回复目标（扩展发消息时用，避免"发到最近活跃的那个群"串群） */
export interface ReasoningTarget {
  scope: string;
  peerId: string;
}
export type ReasoningDeltaFn = (agentId: string, text: string, target?: ReasoningTarget) => void;
export type ReasoningTurnFn = (agentId: string, info: { hasReply: boolean }) => void;

const deltaFns = new Set<ReasoningDeltaFn>();
const turnFns = new Set<ReasoningTurnFn>();

/** 注册思考增量回调（返回取消函数） */
export function onReasoningDelta(fn: ReasoningDeltaFn): () => void {
  deltaFns.add(fn);
  return () => deltaFns.delete(fn);
}

/** 注册回合结束回调（返回取消函数） */
export function onReasoningTurnEnd(fn: ReasoningTurnFn): () => void {
  turnFns.add(fn);
  return () => turnFns.delete(fn);
}

/** 内核调用：来了一段思考增量 */
export function feedReasoning(agentId: string, text: string, target?: ReasoningTarget): void {
  if (!agentId || !text) return;
  for (const fn of deltaFns) {
    try {
      fn(agentId, text, target);
    } catch { /* 扩展自己抛错不能影响消息流 */ }
  }
}

/** 内核调用：本回合结束（hasReply = 该回合是否真的产出过正文增量） */
export function endReasoningTurn(agentId: string, hasReply: boolean): void {
  if (!agentId) return;
  for (const fn of turnFns) {
    try {
      fn(agentId, { hasReply });
    } catch { /* 同上 */ }
  }
}

/**
 * 清空**所有**思考回调（2026-11-21，issue #78）。
 *
 * 为什么需要它：扩展注册回调时拿到的是取消函数，但**调用方经常漏存**；
 * 出站扩展热重载（`/tools_reload`）后旧闭包仍在 Set 里继续跑 ——
 * 于是"已经注释掉的扩展"还在往外发消息（实测）。
 *
 * 只在**重载出站扩展前**调用：它清的是全部回调，装完会重新注册。
 */
export function clearReasoningHandlers(): number {
  const n = deltaFns.size + turnFns.size;
  deltaFns.clear();
  turnFns.clear();
  return n;
}

const api = {
  onDelta: onReasoningDelta,
  onTurnEnd: onReasoningTurnEnd,
  feed: feedReasoning,
  turnEnd: endReasoningTurn,
};

try {
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (g[REASONING_API_KEY] === undefined) g[REASONING_API_KEY] = api;
} catch { /* 极端环境拿不到 globalThis 就算了 */ }
