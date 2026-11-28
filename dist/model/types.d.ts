/**
 * 模型路由层类型定义
 */
/**
 * 思考强度（2026-11-08 主人要求）。
 * 取值以宿主实际支持的为准：deepseek 适配器是 `off | low | high | max`，
 * 其它 provider/模型可能有自己的档位；这里只透传，不做白名单限制。
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max' | (string & {});
/**
 * 路由没写思考强度时补的默认档（2026-11-27）。
 *
 * 为什么必须有一个默认值：宿主只认 `agentOptions = { provider, model, reasoningEffort }` 三个字段，
 * 缺 reasoningEffort 时 anthropic 适配器会显式下发 `thinking: { type: 'disabled' }`（不是"用模型默认"），
 * 于是本地 27B 完全不做判断，把 reply_gate 当成"开口开关"连传 `reply:false`，整轮被 hook 取消 ——
 * 用户看到的就是满屏 `tool call aborted` 且一个字都不回。
 */
export declare const DEFAULT_REASONING_EFFORT: ReasoningEffort;
/** 模型路由 */
export interface ModelRoute {
    provider: string;
    model: string;
    /** 思考强度：undefined = 用模型默认档（注意 ≠ 关闭思考） */
    effort?: string;
}
/** 模型信息条目 */
export interface ModelEntry {
    provider: string;
    id: string;
    name?: string;
}
//# sourceMappingURL=types.d.ts.map