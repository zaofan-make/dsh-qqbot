/** reasoning-bus —— 思考流广播（issue #78 / CodeRabbit #80） */
import { AsyncLocalStorage } from 'node:async_hooks';
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
/**
 * 回调 → 归属实例（dataRoot）。
 *
 * ★ CodeRabbit #80：清理必须与"重载哪个实例"对齐 —— 全局 Set 一清就把**别的实例**的
 *   回调也删了，而那些实例不会重新加载扩展 ⇒ 它们的思考转发从此静默停摆。
 *   所以按归属记，`clearReasoningHandlers(owner)` 只删这个实例的。
 */
const deltaFns = new Map();
const turnFns = new Map();
/**
 * 当前正在装载哪个实例的扩展。
 *
 * ★ CodeRabbit #80（第 2 轮）：不能用一个普通全局变量 —— 装载是 `await import()`，
 *   两个实例并发装载时后一个会把前一个的 owner 覆盖掉，回调就被记到别人名下。
 *   用 AsyncLocalStorage：归属跟着这次异步调用走，天然不受并发影响。
 */
const ownerStore = new AsyncLocalStorage();
/** 在"这批回调属于 owner"的上下文里执行装载（ext-outbound 用） */
export function runWithReasoningOwner(owner, fn) {
    return ownerStore.run(String(owner || ''), fn);
}
const currentOwner = () => ownerStore.getStore() ?? '';
/** 兼容旧调用（同步设置 owners 已不适用，保留空实现避免外部报错） */
export function setReasoningOwner(owner) {
    void owner;
}
/** 注册思考增量回调（返回取消函数） */
export function onReasoningDelta(fn) {
    deltaFns.set(fn, currentOwner());
    return () => deltaFns.delete(fn);
}
/** 注册回合结束回调（返回取消函数） */
export function onReasoningTurnEnd(fn) {
    turnFns.set(fn, currentOwner());
    return () => turnFns.delete(fn);
}
/** 内核调用：来了一段思考增量 */
export function feedReasoning(agentId, text, target) {
    if (!agentId || !text)
        return;
    for (const fn of deltaFns.keys()) {
        try {
            fn(agentId, text, target);
        }
        catch { /* 扩展自己抛错不能影响消息流 */ }
    }
}
/** 内核调用：本回合结束（hasReply = 该回合是否真的产出过正文增量） */
export function endReasoningTurn(agentId, hasReply) {
    if (!agentId)
        return;
    for (const fn of turnFns.keys()) {
        try {
            fn(agentId, { hasReply });
        }
        catch { /* 同上 */ }
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
/** 该实例当前注册了多少回调（重载后判断"新扩展有没有重新注册"） */
export function countReasoningHandlers(owner) {
    const o = String(owner || '');
    let n = 0;
    for (const v of deltaFns.values())
        if (v === o)
            n += 1;
    for (const v of turnFns.values())
        if (v === o)
            n += 1;
    return n;
}
/** 取该实例的回调快照（清理前保存，热重载后若没重新注册就恢复） */
export function snapshotReasoningHandlers(owner) {
    const o = String(owner || '');
    const deltas = [];
    const turns = [];
    for (const [fn, v] of deltaFns)
        if (v === o)
            deltas.push(fn);
    for (const [fn, v] of turnFns)
        if (v === o)
            turns.push(fn);
    return { owner: o, deltas, turns };
}
/**
 * 恢复快照。
 *
 * ★ CodeRabbit #80（第 2 轮）：热重载用 `?v=${fileVersion(abs)}` 导入 —— **文件没改**时 URL 不变、
 *   ESM 缓存命中、模块根本不重新执行 ⇒ 不会重新注册 onDelta。若我们事先清掉了，
 *   该实例的思考转发就永久停摆。所以"重载后仍然没人注册"时把旧回调放回去。
 */
export function restoreReasoningHandlers(snap) {
    if (!snap)
        return 0;
    let n = 0;
    for (const fn of snap.deltas) {
        if (!deltaFns.has(fn)) {
            deltaFns.set(fn, snap.owner);
            n += 1;
        }
    }
    for (const fn of snap.turns) {
        if (!turnFns.has(fn)) {
            turnFns.set(fn, snap.owner);
            n += 1;
        }
    }
    return n;
}
export function clearReasoningHandlers(owner) {
    let n = 0;
    if (owner === undefined) {
        n = deltaFns.size + turnFns.size;
        deltaFns.clear();
        turnFns.clear();
        return n;
    }
    const o = String(owner || '');
    for (const fn of [...deltaFns.keys()]) {
        if ((deltaFns.get(fn) ?? '') === o) {
            deltaFns.delete(fn);
            n += 1;
        }
    }
    for (const fn of [...turnFns.keys()]) {
        if ((turnFns.get(fn) ?? '') === o) {
            turnFns.delete(fn);
            n += 1;
        }
    }
    return n;
}
const api = {
    onDelta: onReasoningDelta,
    onTurnEnd: onReasoningTurnEnd,
    feed: feedReasoning,
    turnEnd: endReasoningTurn,
};
try {
    const g = globalThis;
    if (g[REASONING_API_KEY] === undefined)
        g[REASONING_API_KEY] = api;
}
catch { /* 极端环境拿不到 globalThis 就算了 */ }
//# sourceMappingURL=reasoning-bus.js.map