/**
 * 模型路由层类型定义
 */

/**
 * 思考强度（2026-11-08 主人要求）。
 * 取值以宿主实际支持的为准：deepseek 适配器是 `off | low | high | max`，
 * 其它 provider/模型可能有自己的档位；这里只透传，不做白名单限制。
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max' | (string & {});

// ⚠️ 2026-11-28：原来的 `DEFAULT_REASONING_EFFORT = 'medium'` **已删除，不要再加回来**。
//
// 它当初的动机是真的：宿主只认 `agentOptions = { provider, model, reasoningEffort }`，
// 缺 reasoningEffort 时适配器会显式下发 `thinking: { type: 'disabled' }`（不是"用模型默认"），
// 于是本地 27B 完全不做判断，把 reply_gate 当成"开口开关"连传 `reply:false`，整轮被取消。
//
// 但"缺档就补一个固定值"是错的：
//   ① **不同 provider/模型支持的档位不一样** —— 实测
//      `provider "opencode" model "deepseek-v4.1-flash" does not support reasoning effort "medium"`，
//      整个回合直接「本轮运行失败」；
//   ② 那个兜底自己的 fallback 列表是 `['off','low','high','max']`，**里面根本没有 medium**；
//   ③ 宿主没有"某模型支持哪些档"的查询接口（`llm.reasoningEfforts()` 是全局的），**猜不出来**。
//
// 现在的口径：**不自动补**。要让模型真的思考，就在模型路由里显式写 `effort`
// （面板「推理等级」/ `/bot-model` 都能设），那条路径一路透传、不受影响。
// 宁可"按宿主默认走（可能没思考）"，也不要"塞一个它会报错的值"。

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
  /**
   * 这个模型**实际支持**的思考档位名（如 `['off','low','high','max']`）。
   *
   * 来源：宿主 `llm.listModels(provider)` 返回的条目自带 `reasoningEfforts` 字段
   * （一条 `level → wire 值` 的映射；`false` = 该模型不支持思考，`null` = 空）。
   * **键就是档位名**，所以 `Object.keys()` 拿到的就是可选档。
   *
   * ⚠️ 2026-11-28：这个字段原来被 `listModels()` 丢掉了，于是「路由缺档时该补什么」
   *   只能靠硬编码猜 —— 猜错就是 `does not support reasoning effort "medium"`（整轮失败）。
   *   现在留着它，缺档时按**这个模型真实支持的**挑。
   */
  reasoningEfforts?: string[];
}
