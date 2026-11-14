import { dataRootOf } from '../gateway/data-root.js';
import { appendMsgHistory, findSenderByQuote } from '../features/msg-history.js';
import { c2cNameOf } from '../features/c2c-name.js';
import { md5OfFilename } from '../shared/quote-match.js';
/**
 * 把一条入站消息归类成历史台账要的 `{k, x, f}`。
 *
 * ★ 2026-11-15（主人质疑"群历史为什么要用到 debounce"）：这段逻辑原本长在
 *   `transport/inbound.ts` 的 `handleInbound` 里，而 `handleInbound` **只由 debounce /
 *   scheduler / 工具伪造** 调用 —— 于是 debounce 攒窗口时，窗口里除最后一条外
 *   **全都没进历史**（CodeRabbit 也指了这一条）。
 *   当时的注释说"群消息会被 debounce consume，写在 bot.on('message') 里不执行" —— 对，
 *   但 `bot.on('message')` 不执行 ≠ 没有别的必经点：**中间件链上 debounce 之前的位置
 *   每条消息都会经过**。所以现在搬到这里，与"要不要唤醒她"彻底解耦。
 */
function classifyForHistory(msg) {
    const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
    const ct = (a) => String(a?.content_type ?? a?.contentType ?? '');
    const k = atts.length === 0
        ? 'text'
        : atts.some((a) => /image/i.test(ct(a))) ? 'image'
            : atts.some((a) => /audio|voice|silk/i.test(ct(a))) ? 'voice'
                : atts.some((a) => /video/i.test(ct(a))) ? 'video'
                    : 'file';
    const x = k === 'text' ? String(msg.content ?? '') : `[${k}]`;
    // 图片内容 MD5（QQ 图片文件名＝内容 MD5）。逐附件按**扩展名**判断，不能只看 k ——
    // QQ 有时把图报成 content_type:'file'，那样整体被归成 file，指纹就漏了。
    const f = [];
    for (const a of atts) {
        const fn = typeof a?.filename === 'string' ? a.filename : undefined;
        const v = md5OfFilename(fn);
        if (!v)
            continue;
        const isImg = /\.(jpe?g|png|gif|webp|bmp)$/i.test(String(fn ?? '')) || /^image\//i.test(ct(a));
        if (isImg && !f.includes(v))
            f.push(v);
    }
    return { k, x, f };
}
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
/**
 * 写消息历史台账 —— **必须挂在 early-inbound 扩展之后**（2026-11-15 CodeRabbit 第四轮）。
 *
 * 为什么和归属查询拆开：两者对"这条消息还在不在链路里"的要求不同 ——
 *   · 归属查询要**早**（要在 media-history 拼历史行之前回填 state.quote），
 *     而且被消灭的消息也该查（消灭与否不影响"被引的是谁"）；
 *   · 写历史要**晚**：用户扩展可以通过 `annihilate` 把一条消息整条吃掉，
 *     那种消息**一个字都不该进历史**。annihilate 的语义就是"不调 next、链停在这里"，
 *     所以只要把本中间件挂在那之后，被消灭的消息自然走不到。
 */
export function historyRecorder(config, logger) {
    return async (ctx, next) => {
        try {
            const msg = ctx.message;
            const kind = String(msg.kind ?? '');
            const peerId = kind === 'group'
                ? String(msg.groupOpenid ?? '')
                : String(msg.senderId ?? '');
            if (peerId && (kind === 'group' || kind === 'c2c')) {
                const h = classifyForHistory(msg);
                appendMsgHistory(kind, peerId, {
                    id: String(msg.messageId ?? ''),
                    s: String(msg.senderId ?? ''),
                    // C2C 昵称在这里补一次解析：原本在 handleInbound 后面才做，历史会拿 openid 当昵称。
                    n: String((kind === 'c2c' ? c2cNameOf(dataRootOf(config), String(msg.senderId ?? '')) : '')
                        || msg.senderName
                        || msg.senderId
                        || ''),
                    t: Date.now(),
                    k: h.k,
                    x: h.x,
                    ...(h.f.length ? { f: h.f } : {}),
                    ...(msg.me ? { me: true } : {}),
                });
            }
        }
        catch (err) {
            logger.debug?.(`im-qqbot: 写消息历史失败(忽略): ${err instanceof Error ? err.message : String(err)}`);
        }
        await next();
    };
}
//# sourceMappingURL=attribution.js.map