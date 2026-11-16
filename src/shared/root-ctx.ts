/**
 * 读取 cordis 的**根 ctx**（跨版本兼容）—— 2026-11-16（issue #64）。
 *
 * ## 背景
 *
 * `cordis@4.0.0-rc.12` 起**移除了 `ctx.root`**。上游迁移说明
 * （deepseek-harness `docs/upgrade-guide/v0.2.2-rc.2/cordis-root-and-intercept-metadata/guide.md`）：
 *
 * > `ctx.root` no longer exists. The root context is `ctx[Context.root]`;
 * > `Context.root` is a symbol exported on the `Context` class. Inside a plugin,
 * > reading `ctx.root` throws `cannot get property "root" without inject`.
 *
 * ## 为什么 `?? ctx` / `|| ctx` 救不了
 *
 * 我们的插件 `index.ts` 声明的是 `inject = ['agents', 'systemPrompt']`，`root` 不在其中，
 * 于是 cordis 的代理对象在**属性读取那一刻直接 throw** —— 不是返回 `undefined`。
 * 所以 `ctx.root ?? ctx` 和 `ctx.root || ctx` 里那个兜底**永远不会执行**：
 * 异常直接冒出去，把整段调用栈打断。
 *
 * 实际后果（issue #64 实测）：
 *   - `gateway/bootstrap.ts` 那处抛在 WebSocket 建立**之前** ⇒ 网关完全起不来
 *     （`Bot ready` 从不打印、`online=false`，但 REST 心跳照发、`api.sgroup.qq.com` 零连接）；
 *   - `channel-tools.ts` 两处 ⇒ 元工具注册失败刷屏、`expose:'all'` 挂到错误层；
 *   - `session-manager.ts` 一处 ⇒ 被 `?.catch?.(()=>{})` 吞掉，群守则/工具表注入**静默失效**。
 *
 * ## 正确读法
 *
 * 纯 JS 不需要 import：`ctx[Symbol.for('cordis.root')]`。
 * 但为了**同时兼容旧版 cordis**（那里只有 `ctx.root`、且读它不抛），这里按顺序两种都试：
 * **先读符号**（新版有值、旧版拿不到），符号没有才 try 读 `.root`（新版会抛 → 被 catch 吃掉）。
 *
 * ⚠️ 不要退回"只用 try/catch 读 `.root`"：那在新版上会一路落到**非根 ctx**，
 * 进程不崩了，但审批监听、群守则注入、全局工具注册全都静默降级 —— 比崩更难查。
 */
const ROOT_SYMBOL = Symbol.for('cordis.root');

/**
 * 取根 ctx；取不到就返回传入的那个（与旧行为一致，绝不抛）。
 * @param c 任意 ctx（可能是根，也可能是插件 ctx）
 */
export function rootOf<T>(c: T): T {
  if (c === null || c === undefined) return c;
  const t = typeof c;
  if (t !== 'object' && t !== 'function') return c;

  // ① cordis ≥ 4.0.0-rc.12：根 ctx 挂在 Symbol.for('cordis.root') 上
  try {
    const bySymbol = (c as unknown as Record<symbol, unknown>)[ROOT_SYMBOL];
    if (bySymbol) return bySymbol as T;
  } catch {
    /* 读符号理论上不会抛；真抛了也只是少一条路，继续走 ② */
  }

  // ② cordis < 4.0.0-rc.12：老字段 `ctx.root`（新版读它会抛，catch 吃掉）
  try {
    const legacy = (c as unknown as { root?: unknown }).root;
    if (legacy) return legacy as T;
  } catch {
    /* 新版 cordis 的正常路径：没有符号也没有 .root 可读 → 用自己 */
  }

  return c;
}
