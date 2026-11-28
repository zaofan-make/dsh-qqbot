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

/** 正向意图：出现这些词 = 模型其实想开口。 */
const WANTS_REPLY_RE = /需要回复|要回复|该回|回复一下|回一下|回答|必须回|得回|需要回/u;

/**
 * 否定 / 已答语境：出现这些词说明是在解释「为什么不回」，**不是**"想回"。
 *
 * ⚠️ 必须比 `WANTS_REPLY_RE` **先判** —— 两者会同时命中
 * （「不需要回复」里既有"不需要"、也有"需要回复"）。
 */
const NO_REPLY_INTENT_RE =
  /不需要回|不用回|不必回|无需回|没必要回|不用搭理|别回|不要回|不该回|已经有|已有人|已经回|已答|回答过|群友已经|别人已经/u;

/**
 * `reply:false` 的 reason 是否与布尔值**自相矛盾**（= 其实想回复）。
 *
 * @returns `true` = 自相矛盾，**不应该**静默（让回合继续、模型直接开口）
 */
export function isContradictoryReplyFalse(reason: unknown): boolean {
  const s = typeof reason === 'string' ? reason : String(reason ?? '');
  if (!s.trim()) return false;
  // 否定/已答语境优先：「不需要回复」不该被判成"想回"
  if (NO_REPLY_INTENT_RE.test(s)) return false;
  return WANTS_REPLY_RE.test(s);
}
