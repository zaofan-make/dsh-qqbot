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
export declare function attributionLedger(logger: Logger): (ctx: MiddlewareContext, next: () => Promise<void>) => Promise<void>;
//# sourceMappingURL=attribution.d.ts.map