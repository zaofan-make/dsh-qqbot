/**
 * 模型路由层类型定义
 */

/**
 * 思考强度（2026-11-08 主人要求）。
 * 取值以宿主实际支持的为准：deepseek 适配器是 `off | low | high | max`，
 * 其它 provider/模型可能有自己的档位；这里只透传，不做白名单限制。
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max' | (string & {});

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
