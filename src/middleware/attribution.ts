/**
 * attribution — 把「引用的是谁说的话」回填进 `ctx.state.quote`（2026-11-14）
 *
 * ── 它解决什么 ──────────────────────────────────────────────────────────────
 * 主人反馈：**引用别人发的东西时，看不到原主是谁**。
 *
 * 三层来源全废，各有各的死法（都是实测，不是推测）：
 *   ① `msg_elements[].author` —— QQ 官方文档写了「该元素对应的消息发送者」，
 *      但 103 引用消息**实际下发里这个字段不存在**（元素 keys 只有
 *      `attachments / content / message_type / msg_idx`）。API 侧不给。
 *   ② SDK 的 `quoteRef` store —— 配了 `preferMsgElements: true` 时它**优先走 msg_elements
 *      分支，压根不查 store** ⇒ `quote.entry` 恒 undefined。
 *   ③ 按 `refKey` 查台账 —— 主人点破：**`ref_msg_idx` 和 `msg_idx` 不是同一个值**，
 *      拿索引当主键就是赌它们相等，实测赌输。
 *
 * ── 现在的做法 ──────────────────────────────────────────────────────────────
 *   数据源只有一个：**消息历史台账**（`features/msg-history`，主人定"不能独立台账"）。
 *     它本来就记了每条消息的 `s`（发送者）/ `n`（昵称）/ `x`（正文），
 *     这次又补了 `f`（图片内容 MD5）—— 引用纯图也能认人。
 *   匹配手段：图片指纹 → 正文归一化匹配（`findSenderByQuote`），全部新→旧、命中即停。
 *
 * ── 为什么挂在中间件、而且这么靠前 ──────────────────────────────────────────
 *   `media-history` 是链上第 4 步，它拼**历史行**的引用块时读的就是 `ctx.state.quote`
 *   （`foldMedia` → `buildQuoteBlock`）。在这一层回填好，**历史行和当前消息两条路都受益**，
 *   不用各自再查一遍。位置必须在 `quoteRef` **之后**（否则 quote 还没被赋值）。
 *
 * ⚠️ 只读 + 只回填，不写任何存储、不阻断消息，出错一律吞掉。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { Logger } from '../types.js';
import { appendMsgHistory, findSenderByQuote } from '../features/msg-history.js';
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
function classifyForHistory(msg: {
  content?: string;
  attachments?: Array<{ content_type?: string; contentType?: string; filename?: string }>;
}): { k: 'text' | 'image' | 'voice' | 'video' | 'file'; x: string; f: string[] } {
  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  const ct = (a: { content_type?: string; contentType?: string }): string =>
    String(a?.content_type ?? a?.contentType ?? '');
  const k: 'text' | 'image' | 'voice' | 'video' | 'file' = atts.length === 0
    ? 'text'
    : atts.some((a) => /image/i.test(ct(a))) ? 'image'
      : atts.some((a) => /audio|voice|silk/i.test(ct(a))) ? 'voice'
        : atts.some((a) => /video/i.test(ct(a))) ? 'video'
          : 'file';
  const x = k === 'text' ? String(msg.content ?? '') : `[${k}]`;
  // 图片内容 MD5（QQ 图片文件名＝内容 MD5）。逐附件按**扩展名**判断，不能只看 k ——
  // QQ 有时把图报成 content_type:'file'，那样整体被归成 file，指纹就漏了。
  const f: string[] = [];
  for (const a of atts) {
    const fn = typeof a?.filename === 'string' ? a.filename : undefined;
    const v = md5OfFilename(fn);
    if (!v) continue;
    const isImg = /\.(jpe?g|png|gif|webp|bmp)$/i.test(String(fn ?? '')) || /^image\//i.test(ct(a));
    if (isImg && !f.includes(v)) f.push(v);
  }
  return { k, x, f };
}

export function attributionLedger(logger: Logger) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    try {
      const msg = ctx.message as {
        kind?: string;
        groupOpenid?: string;
        senderId?: string;
        senderName?: string;
        messageId?: string;
        content?: string;
        me?: boolean;
        attachments?: Array<{ content_type?: string; contentType?: string; filename?: string }>;
        /** 103 引用消息的元素列表：每个元素自己也可能带附件 */
        msgElements?: Array<{ attachments?: Array<{ filename?: string }> }>;
        messageType?: number;
      };
      const kind = String(msg.kind ?? '');
      const peerId = kind === 'group'
        ? String(msg.groupOpenid ?? '')
        : String(msg.senderId ?? '');

      if (peerId && (kind === 'group' || kind === 'c2c')) {
        // ── ① 先写历史台账（每条消息必记，与她醒不醒无关）──
        //   这条在 debounce 之前，所以窗口里每一条都会进来，不会只剩最后一条。
        const h = classifyForHistory(msg);
        appendMsgHistory(kind as 'group' | 'c2c', peerId, {
          id: String(msg.messageId ?? ''),
          s: String(msg.senderId ?? ''),
          n: String(msg.senderName ?? msg.senderId ?? ''),
          t: Date.now(),
          k: h.k,
          x: h.x,
          ...(h.f.length ? { f: h.f } : {}),
          ...(msg.me ? { me: true } : {}),
        });

        const q = (ctx.state as {
          quote?: {
            refKey?: string;
            text?: string;
            senderId?: string;
            senderName?: string;
            entry?: { senderId?: string };
            attachments?: Array<{ filename?: string }>;
          };
        }).quote;

        // 只在"还没有发送者"的时候才查 —— SDK 真给了就不覆盖。
        const hasSender = Boolean(
          String(q?.senderName ?? '').trim()
          || String(q?.senderId ?? '').trim()
          || String(q?.entry?.senderId ?? '').trim(),
        );

        // 诊断：静默失败最难查（这段逻辑曾经吞掉整轮排查）
        if (!q) {
          const looksLikeQuote = Number(msg.messageType ?? 0) === 103
            || (Array.isArray(msg.msgElements) && msg.msgElements.length > 0);
          if (looksLikeQuote) {
            logger.debug?.('im-qqbot: 引用归属 → 像引用但 ctx.state.quote 不存在（SDK 没解出 refMsgIdx）');
          }
        } else if (!hasSender) {
          // 图片指纹：被引消息的图可能挂在 quote.attachments，也可能在 msg_elements 元素里
          const probe: string[] = [];
          const push = (fn: unknown): void => {
            const v = md5OfFilename(typeof fn === 'string' ? fn : undefined);
            if (v && !probe.includes(v)) probe.push(v);
          };
          for (const a of Array.isArray(q.attachments) ? q.attachments : []) push(a?.filename);
          for (const el of Array.isArray(msg.msgElements) ? msg.msgElements : []) {
            for (const a of Array.isArray(el?.attachments) ? el.attachments : []) push(a?.filename);
          }

          const hit = findSenderByQuote(kind as 'group' | 'c2c', peerId, q.text, probe);
          if (hit) {
            if (hit.senderName) q.senderName = hit.senderName;
            if (hit.senderId) q.senderId = hit.senderId;
            logger.debug?.(`im-qqbot: 引用归属回填 → ${hit.senderName || hit.senderId}`);
          } else {
            logger.debug?.(`im-qqbot: 引用归属未命中 refKey=${String(q.refKey ?? '').slice(0, 20)}…`);
          }
        }
      }
    } catch (err) {
      // ⚠️ 用 warn 而不是 debug：这个 catch 曾经把真问题吞掉整整一轮
      logger.warn?.(`im-qqbot: 引用归属回填异常: ${err instanceof Error ? err.message : String(err)}`);
    }
    await next();
  };
}
