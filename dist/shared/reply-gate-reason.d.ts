/**
 * `reply_gate` 的 reason 语义判定 —— **两处共用这一份**（`outbound.ts` 的出站静默、
 * `channel-tools.ts` 的工具执行）。别再各写一份正则。
 *
 * 背景：本地 27B 在无思考档位下会把本工具当成"开口开关" —— `reason` 里明明写着"要回复"，
 * 布尔值却传了 `reply:false`。那种自相矛盾必须拦下来（否则 `agent.cancel` 直接取消整轮，
 * 用户只看到 `tool call aborted`，一个字都收不到）。
 *
 * 但**不能拿"reason 里有'回复'字样"当判据** —— 正常静默的理由也长这样
 * （CodeRabbit 2026-11-28 · Major）：
 *
 *   · `"未@我，不需要回复"`  → 含「需要回复」，但意思是**不**回
 *   · `"已经有群友回答了"`    → 含「回答」，但意思是**别人已经答了**
 *
 * 所以必须**先判否定 / 已答语境**，再判正向意图。
 */
/**
 * `reply:false` 的 reason 是否与布尔值**自相矛盾**（= 其实想回复）。
 *
 * @returns `true` = 自相矛盾，**不应该**静默（让回合继续、模型直接开口）
 */
export declare function isContradictoryReplyFalse(reason: unknown): boolean;
//# sourceMappingURL=reply-gate-reason.d.ts.map