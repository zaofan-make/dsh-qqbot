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
export function attributionLedger(config, logger) {
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
                // ── ② 归属查询**之后**才写历史台账 ──
                // ★ 2026-11-15（CodeRabbit 第三轮抓到）：原来是"先写再查"，于是**当前这条消息自己**
                //   就是全表里"时间最新的匹配"。A 说「我喜欢鲸鱼」，B 引用同文再发一遍时，
                //   查出来的会是 B 自己，归属被错填。必须查完再写。
                //   写入放在查询之后、外层 try 之内：查询抛错时这条历史就丢了，
                //   所以这里单独包一层 try —— 写入失败不能反过来影响消息主链。
                try {
                    const h = classifyForHistory(msg);
                    appendMsgHistory(kind, peerId, {
                        id: String(msg.messageId ?? ''),
                        s: String(msg.senderId ?? ''),
                        // ★ 第三轮同时指出：C2C 的昵称原本是 `handleInbound` 后面才解析的
                        //   （`c2cNameOf`），搬到中间件后这里只拿得到 openid，历史里就把 openid 当昵称存了。
                        //   在这里补一次同样的解析，保持两边一致。
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
                catch { /* 写历史失败不影响消息主链 */ }
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