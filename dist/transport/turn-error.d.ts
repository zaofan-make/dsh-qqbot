/**
 * turn-error.ts — 回合异常提示的策略化（issue #73）
 *
 * ## 背景
 *
 * 上游审核拒绝、限流、网络抖动的错误原文，原来会原样发进群：
 *
 * ```
 * ⚠️ 本轮异常结束 `INVALID_REQUEST`: 400: {"message":"Invalid request parameters...","code":10013}
 * ```
 *
 * 三个问题：群友看着突兀、暴露内部错误码和上游响应结构、活跃群里会反复出现。
 *
 * 而这条消息走的是 `onTurnEnd` → `this.send()` → `sendRichOutbound(…, { source })`：
 * **会过出站扩展链**（装了扩展的话 `rewrite` / `annihilate` 都能挡它），
 * 但**默认部署下没人装这种扩展** ⇒ 用户侧实际没有拦截点。所以做成配置。
 *
 * ⚠️ 别照着"它不走扩展链"去推理 —— 那句话是错的（2026-11-19 审查抓到）。
 *
 * ## 四档
 *
 * | 模式 | 行为 |
 * |---|---|
 * | `notify`（默认） | 原文照发，行为与旧版完全一致 |
 * | `friendly` | 发一句人话，错误细节只进日志 |
 * | `silent` | 完全不发，只写日志 |
 * | `regex` | 按 `turnErrorSilentPattern` 匹配 `code + message`：命中→静默，其余→原文 |
 */
export type TurnErrorMode = 'notify' | 'friendly' | 'silent' | 'regex';
export interface TurnErrorConfig {
    turnErrorMode?: string;
    turnErrorSilentPattern?: string;
}
/** 默认的「人话」文案（friendly 模式） */
export declare const FRIENDLY_TURN_ERROR = "\u26A0\uFE0F \u8FD9\u8F6E\u5361\u4F4F\u4E86\uFF0C\u518D\u8BF4\u4E00\u6B21\u8BD5\u8BD5~";
/**
 * 决定这条回合异常要不要发、发什么。
 *
 * @param code    错误码（如 `INVALID_REQUEST`）
 * @param message 错误原文
 * @returns `null` = 不发；string = 发这个
 */
export declare function resolveTurnErrorMessage(cfg: TurnErrorConfig | undefined, code: string, message: string): string | null;
//# sourceMappingURL=turn-error.d.ts.map