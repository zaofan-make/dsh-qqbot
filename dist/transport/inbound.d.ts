import type { SessionManager } from '../session/index.js';
import type { ImQQBotConfig } from '../config.js';
import type { Logger } from '../types.js';
export interface ResolvedQuote {
    /** SDK 给的被引用消息索引（msg_idx）—— 本地台账回查用 */
    refKey?: string;
    text?: string;
    entry?: {
        senderId?: string;
        content?: string;
    };
    attachments?: {
        contentType?: string;
        url?: string;
        filename?: string;
        asrText?: string;
    }[];
}
/**
 * 群消息时间头：同一会话**同一分钟内只注入一次**。
 *
 * 2026-10-01 主人要求（省 token）：「同一分钟的消息或聚合消息不重复显示时间」。
 * 原来每轮入站都无条件在最前面加 `[YYYY-MM-DD 周X HH:MM]` —— 同一分钟里连发几轮 / 聚合一波，
 * 上下文里就堆出好几行一模一样的时间头（每行 ~25 字符，纯浪费）。
 * 现在同分钟内的后续回合不再重复注入：时间信息不变（最近那条时间头就是当前时间），信息量零损失。
 *
 * @param cache 会话 → 上次时间头（进程内缓存，重启自然清空 → 重启后第一条会重新带上）
 * @returns 要注入的时间行（形如 `[2026-10-01 周四 20:47]`），本次不需注入时返回 null
 */
export declare function groupTimeHead(cache: Map<string, string>, scope: string, peerId: string, now?: Date): string | null;
/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）
 */
export declare function handleInbound(rawMsg: unknown, manager: SessionManager, config: ImQQBotConfig, logger: Logger, state?: Record<string, unknown>): Promise<void>;
export declare function buildQuoteBlock(quote: ResolvedQuote | undefined, stickerDir: string): string;
/**
 * Layer 2 成品：引用块 + 紧随其后的 `[当前]`（短标记见 markers.ts）。
 * ⚠️ 历史行请用 {@link buildQuoteBlock} —— 那边不该出现 `[当前]` 标记。
 */
export declare function buildQuotePart(quote: ResolvedQuote | undefined, stickerDir: string): string;
/**
 * Layer 3: 带发送者标签的用户消息
 * 引用消息功能开启时, 每条入站都带**短消息号**(msgRef, 形如 0913a; 群聊挂发送者标签, 私聊独立一行)
 * —— AI 想引用对方时在正文写 [rf:短号](2026-09-13 主人定: 短号省 token, 台账见 msg-index.ts)。
 * 群聊标签的形状(2026-09-15 定稿, 与历史行同口径):
 *   没被 @  → `[昵称 #短号]`            ← 不带 openid(省 token; 32 位 id 每行 20+ token)
 *   被 @ 了 → `[昵称 (openid) #短号]` + 正文后 ` (@you)`  ← 要回 @ 他/认人才给 id
 *   短号两边都留(引用标记 + id_lookup 反查 openid 的入口, 不能省)。
 * ★ 2026-11-13：标签里的名字改用"显示名"（可带群名片后缀），`#短号` 位置与格式**不变**。
 */
export declare function buildUserMessage(userContent: string, quotePart: string, senderId: string, senderName: string | undefined, isGroup: boolean, wasMentioned: boolean, msgRef: string, memberNick?: string): string;
//# sourceMappingURL=inbound.d.ts.map