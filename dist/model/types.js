/**
 * 模型路由层类型定义
 */
/**
 * 路由没写思考强度时补的默认档（2026-11-27）。
 *
 * 为什么必须有一个默认值：宿主只认 `agentOptions = { provider, model, reasoningEffort }` 三个字段，
 * 缺 reasoningEffort 时 anthropic 适配器会显式下发 `thinking: { type: 'disabled' }`（不是"用模型默认"），
 * 于是本地 27B 完全不做判断，把 reply_gate 当成"开口开关"连传 `reply:false`，整轮被 hook 取消 ——
 * 用户看到的就是满屏 `tool call aborted` 且一个字都不回。
 */
export const DEFAULT_REASONING_EFFORT = 'medium';
//# sourceMappingURL=types.js.map