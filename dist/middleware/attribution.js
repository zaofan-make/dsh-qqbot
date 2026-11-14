import { findSenderByQuote } from '../features/msg-history.js';
import { md5OfFilename } from '../shared/quote-match.js';
export function attributionLedger(logger) {
    return async (ctx, next) => {
        try {
            const msg = ctx.message;
            const kind = String(msg.kind ?? '');
            const peerId = kind === 'group'
                ? String(msg.groupOpenid ?? '')
                : String(msg.senderId ?? '');
            if (peerId && (kind === 'group' || kind === 'c2c')) {
                const q = ctx.state.quote;
                // 只在"还没有发送者"的时候才查 —— SDK 真给了就不覆盖。
                const hasSender = Boolean(String(q?.senderName ?? '').trim()
                    || String(q?.senderId ?? '').trim()
                    || String(q?.entry?.senderId ?? '').trim());
                // 诊断：静默失败最难查（这段逻辑曾经吞掉整轮排查）
                if (!q) {
                    const looksLikeQuote = Number(msg.messageType ?? 0) === 103
                        || (Array.isArray(msg.msgElements) && msg.msgElements.length > 0);
                    if (looksLikeQuote) {
                        logger.debug?.('im-qqbot: 引用归属 → 像引用但 ctx.state.quote 不存在（SDK 没解出 refMsgIdx）');
                    }
                }
                else if (!hasSender) {
                    // 图片指纹：被引消息的图可能挂在 quote.attachments，也可能在 msg_elements 元素里
                    const probe = [];
                    const push = (fn) => {
                        const v = md5OfFilename(typeof fn === 'string' ? fn : undefined);
                        if (v && !probe.includes(v))
                            probe.push(v);
                    };
                    for (const a of Array.isArray(q.attachments) ? q.attachments : [])
                        push(a?.filename);
                    for (const el of Array.isArray(msg.msgElements) ? msg.msgElements : []) {
                        for (const a of Array.isArray(el?.attachments) ? el.attachments : [])
                            push(a?.filename);
                    }
                    const hit = findSenderByQuote(kind, peerId, q.text, probe);
                    if (hit) {
                        if (hit.senderName)
                            q.senderName = hit.senderName;
                        if (hit.senderId)
                            q.senderId = hit.senderId;
                        logger.debug?.(`im-qqbot: 引用归属回填 → ${hit.senderName || hit.senderId}`);
                    }
                    else {
                        logger.debug?.(`im-qqbot: 引用归属未命中 refKey=${String(q.refKey ?? '').slice(0, 20)}…`);
                    }
                }
            }
        }
        catch (err) {
            // ⚠️ 用 warn 而不是 debug：这个 catch 曾经把真问题吞掉整整一轮
            logger.warn?.(`im-qqbot: 引用归属回填异常: ${err instanceof Error ? err.message : String(err)}`);
        }
        await next();
    };
}
//# sourceMappingURL=attribution.js.map