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
    /** 按渠道覆盖回合异常策略（issue #77）：`{ group: 'silent', c2c: 'notify' }`；空串/缺省 = 不覆盖 */
    turnErrorModeByScope?: Partial<Record<'group' | 'c2c', string>>;
}
/**
 * 工具报错（issue #77，2026-11-21）。
 *
 * `tool/result` 原来是「事件带 error 就直发」，没有策略 —— 与 #73 的回合异常同构，
 * 但多一层：**群聊和私聊的"正确行为"不一样**（群里该静默，私聊要留原文排查）。
 *
 * 所以除了自己的四档，还支持按渠道覆盖。
 */
export interface ToolErrorConfig {
    toolErrorMode?: string;
    toolErrorSilentPattern?: string;
    /** 按渠道覆盖工具报错策略：`{ group: 'silent', c2c: 'notify' }`；空串/缺省 = 不覆盖 */
    toolErrorModeByScope?: Partial<Record<'group' | 'c2c', string>>;
}
/** 合起来给调用方用（`this.config` 同时满足两个接口） */
export type ErrorPolicyConfig = TurnErrorConfig & ToolErrorConfig;
/**
 * 取生效的模式：**按渠道覆盖优先，其次全局默认**，非法值一律回落 `notify`（fail-open）。
 *
 * @param key   `turn` = 回合异常；`tool` = 工具报错
 * @param scope `group` / `c2c`（其它值视为不覆盖）
 */
export declare function effectiveErrorMode(cfg: ErrorPolicyConfig | undefined, key: 'turn' | 'tool', scope?: string): TurnErrorMode;
/** 默认的「人话」文案（friendly 模式） */
export declare const FRIENDLY_TURN_ERROR = "\u26A0\uFE0F \u8FD9\u8F6E\u5361\u4F4F\u4E86\uFF0C\u518D\u8BF4\u4E00\u6B21\u8BD5\u8BD5~";
/** 工具报错的「人话」文案（issue #77，toolErrorMode=friendly） */
export declare const FRIENDLY_TOOL_ERROR = "\u26A0\uFE0F \u6709\u4E2A\u5DE5\u5177\u6CA1\u8DD1\u901A\uFF0C\u8FD9\u8F6E\u5148\u8FD9\u6837~";
/**
 * 决定这条**工具报错**要不要发、发什么（issue #77）。
 *
 * 注意：入参 `rawText` 是现有 `formatToolResult()` **已经渲染好的** ❌ 文本 ——
 * 这里只做"发/不发/换一句"，不重新拼格式（别跟"详细主动"里的工具提示重复造轮子）。
 *
 * @param scope `group` / `c2c`（按渠道覆盖策略用）
 * @returns `null` = 不发；string = 发这个
 */
export declare function resolveToolErrorMessage(cfg: ErrorPolicyConfig | undefined, rawText: string, scope?: string): string | null;
/**
 * 决定这条回合异常要不要发、发什么。
 *
 * @param code    错误码（如 `INVALID_REQUEST`）
 * @param message 错误原文
 * @returns `null` = 不发；string = 发这个
 */
export declare function resolveTurnErrorMessage(cfg: TurnErrorConfig | undefined, code: string, message: string, scope?: string): string | null;
//# sourceMappingURL=turn-error.d.ts.map