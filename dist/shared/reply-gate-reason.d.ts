/**
 * `reply_gate` 的 reason 语义判定 —— **两处共用这一份**（`outbound.ts` 的出站静默、
 * `channel-tools.ts` 的工具执行）。别再各写一份正则。
 *
 * 背景：本地 27B 在无思考档位下会把本工具当成"开口开关" —— `reason` 里明明写着"要回复"，
 * 布尔值却传了 `reply:false`。那种自相矛盾必须拦下来（否则 `agent.cancel` 直接取消整轮，
 * 用户只看到 `tool call aborted`）。
 *
 * 但两个方向都容易误伤，而且**误伤的后果不对称**：
 *   · 把"矛盾"漏判 ⇒ 该回的没回（群里 @ 完一个字不回）
 *   · 把"静默"错判成矛盾 ⇒ 不该开口时凭空说话
 *
 * ⚠️ 所以判法不是"reason 里有某某词"，而是 **逐处就近判否定**：
 *   找出每一处「正向意图词」，只看它**紧邻的前 3 个字**有没有否定词。
 *
 * 为什么不能用"整串出现否定词就否决"（第一版就是这么写的，复审实测打回）：
 * 否定是**分句局部**语义。`群友已经@我了，必须回复` 里确实有「已经」，
 * 但前半句说的是"已答"、后半句才是落点 —— 整串否决会把这句判成"想静默"，
 * 闸门真的 cancel，等于把 1.13.34 刚修掉的事故原样复活（只差一个前缀）。
 */
/**
 * `reply:false` 的 reason 是否与布尔值**自相矛盾**（= 其实想回复）。
 *
 * @returns `true` = 自相矛盾，**不应该**静默（让回合继续、模型直接开口）
 */
export declare function isContradictoryReplyFalse(reason: unknown): boolean;
//# sourceMappingURL=reply-gate-reason.d.ts.map