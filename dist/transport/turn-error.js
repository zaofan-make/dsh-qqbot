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
/** 默认的「人话」文案（friendly 模式） */
export const FRIENDLY_TURN_ERROR = '⚠️ 这轮卡住了，再说一次试试~';
/**
 * 决定这条回合异常要不要发、发什么。
 *
 * @param code    错误码（如 `INVALID_REQUEST`）
 * @param message 错误原文
 * @returns `null` = 不发；string = 发这个
 */
export function resolveTurnErrorMessage(cfg, code, message) {
    const mode = String(cfg?.turnErrorMode ?? 'notify').trim().toLowerCase();
    if (mode === 'silent')
        return null;
    if (mode === 'friendly')
        return FRIENDLY_TURN_ERROR;
    if (mode === 'regex') {
        const pat = String(cfg?.turnErrorSilentPattern ?? '').trim();
        // 留空 = 等同于 notify（不拦截）。宁可多发，也不要因为没配正则就把所有错误吞掉。
        if (pat) {
            try {
                // 不区分大小写；匹配 `code + message` 整体，用户可只写 `400` 或 `内容违规`
                if (new RegExp(pat, 'i').test(`${code} ${message}`))
                    return null;
            }
            catch {
                // 正则写错时**不拦截**（fail-open）：不能因为配置手滑就让用户看不到任何异常
                // 具体 warn 由调用方记（这里保持纯函数，便于单测）
            }
        }
        return formatNotify(code, message);
    }
    return formatNotify(code, message);
}
function formatNotify(code, message) {
    return `⚠️ 本轮异常结束\n\`${code}\`: ${message}`;
}
//# sourceMappingURL=turn-error.js.map