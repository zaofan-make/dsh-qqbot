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
 * 正向意图词：出现任一个 = 这句在说「该开口」。
 *
 * ⚠️ **刻意不含「回答」** —— 它太中性：`已经有群友回答了`、`群友回答了，我就不说了`
 * 都是正常静默理由。收窄成"必须/需要/要/该/得 + 回"这种明确的祈使语气，误伤面小得多。
 */
const WANTS_RE = /必须回|需要回|要回|该回|得回|回复一下|回一下/gu;

/** 就近否定的窗口：命中点往前看这么多字。 */
const NEG_WINDOW = 3;
/** 否定词（含"甭/勿"这类口语）。 */
const NEG_CHARS_RE = /[不没别无勿甭]/u;

/**
 * `reply:false` 的 reason 是否与布尔值**自相矛盾**（= 其实想回复）。
 *
 * @returns `true` = 自相矛盾，**不应该**静默（让回合继续、模型直接开口）
 */
export function isContradictoryReplyFalse(reason: unknown): boolean {
  const s = typeof reason === 'string' ? reason : String(reason ?? '');
  if (!s.trim()) return false;
  // 逐处检查：只要有一处正向意图**没被就近否定**，整句就是"想开口"。
  // （`matchAll` 需要 g 标志；这里遍历全部命中，不能命中第一处就收工 ——
  //   `已答过的不重复，但这条必须回` 的正向词在后半句。）
  for (const m of s.matchAll(WANTS_RE)) {
    const idx = m.index ?? 0;
    const before = s.slice(Math.max(0, idx - NEG_WINDOW), idx);
    if (!NEG_CHARS_RE.test(before)) return true;
  }
  return false;
}
