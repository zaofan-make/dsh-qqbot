/**
 * msg-history.ts — 群消息历史台账（2026-10-20 主人定：独立台账 + 按会话分目录 + 一天一个文件）
 *
 * 目录结构（`{dataRoot}/.qqbot/msg-history/`）：
 *   group_<群openid>/2026-10-20.jsonl
 *   c2c_<对方openid>/2026-10-20.jsonl
 *
 * 设计要点（主人要求）：
 *   · **一会话一目录** → 群与群、群与私聊天然隔离，读的时候根本碰不到别人的文件；
 *   · **一天一个文件** → 不会反复读写同一个越滚越大的文件；
 *   · **默认只保留 7 天** → 启动时 + 每 200 次写顺手清掉过期日期文件；
 *   · 一行一条：`{"id":"message_id","s":"发送者","n":"昵称","t":毫秒,"k":"text|image|voice|video|file","x":"正文摘要","me":true?}`
 *
 * 用途：`group_recall`（撤某人最近一条）、`group_msg_search`（按关键词/类型搜）、
 *       `group_recall_batch`（批量撤 + 顺带禁言）。与引用补全用的 msg-content.jsonl **互不干扰**。
 */
import type { MsgKind } from './msg-recent.js';
/** 默认保留天数（主人定：7 天） */
export declare const KEEP_DAYS = 7;
/** 从文本里抽出所有 http(s) 链接（去重、保序） */
export declare function extractUrls(text: string): string[];
export interface HistoryRec {
    /** QQ message_id */
    id: string;
    /** 发送者 openid（机器人自己发时 'self'） */
    s: string;
    /** 昵称 */
    n: string;
    /** 毫秒时间戳 */
    t: number;
    /** 类型 */
    k: MsgKind;
    /** 正文摘要 */
    x: string;
    /** 是否机器人自己发的 */
    me?: boolean;
    /**
     * ★ 2026-11-14：图片内容指纹（QQ 图片文件名就是内容 MD5，通常 1 个）。
     *
     * 为什么塞进**历史台账**而不是另开一本：主人定过"不能独立台账" ——
     *   历史台账本来就记了每条消息的 `s`（发送者）/ `x`（正文），
     *   唯一缺的就是"这张图是哪张"。补上这一格，归属查询就能全在这一个数据源里完成。
     * 为什么不放进 `x`：`x` 是要注入上下文的正文摘要，塞 40 个字符的文件名纯属浪费 token；
     *   单独字段只在"有人引用这张图"时才被读。
     */
    f?: string[];
}
/** 初始化（bootstrap 启动时调一次）：建目录 + 清过期 */
export declare function initMsgHistory(dataRoot: string): void;
/** 删掉超过 KEEP_DAYS 天的日期文件（顺带删空目录） */
export declare function pruneOld(): void;
/**
 * 在该会话目录里放一个「<群名>.txt」（主人要求：打开文件夹一眼认出是哪个群）。
 * 群名变了会顺手删掉旧名字文件；同时刷新根目录 _索引.txt。
 */
export declare function markSession(scope: 'group' | 'c2c', peerId: string): void;
/**
 * ★ 2026-11-23（主人要求）：**入站时就把链接落盘并拿到路径**，
 * 好在消息正文里告诉模型「链接存在这个文件里」，它读文件即可批量下载。
 */
export declare function exportLinksForMessage(scope: 'group' | 'c2c', peerId: string, rec: {
    id?: string;
    t: number;
    n?: string;
    x?: string;
}): string | undefined;
/** 记一条（写入当天文件） */
export declare function appendMsgHistory(scope: 'group' | 'c2c', peerId: string, rec: Partial<HistoryRec> & {
    id: string;
}): void;
/**
 * ★ 按「被引用的内容」反查原主（2026-11-14，主人定：归属就用历史台账，不另开独立账）。
 *
 * 两条路，都从**新→旧**走、命中即停：
 *   ① **图片指纹**（优先）—— 引用纯图时正文只剩 `[image: xxx.png]`，归一化后是空串，
 *      正文匹配走不通；QQ 的图片文件名就是内容 MD5，记在历史行的 `f` 字段里。
 *   ② **正文匹配** —— 被引原话是引用时一定拿得到的东西，比"赌两个索引相等"可靠得多
 *      （`ref_msg_idx` 与 `msg_idx` 不是同一个值，这点主人已经点破）。
 *
 * @param imageMd5s 额外指纹（从 `quote.attachments[].filename` 拿到的）
 */
export declare function findSenderByQuote(scope: 'group' | 'c2c', peerId: string, text: string | undefined, imageMd5s?: string[]): {
    senderName?: string;
    senderId?: string;
} | undefined;
export interface HistoryQuery {
    /** 只看多少毫秒内（默认 7 天） */
    withinMs?: number;
    /** 最多几条（默认 20，上限 200） */
    limit?: number;
    /** 关键词（子串，忽略大小写） */
    keyword?: string;
    /** 类型筛选 */
    kind?: MsgKind;
    /** true=只机器人自己发的；false=只别人发的；不填=都算 */
    fromSelf?: boolean;
    /** 只看某个发送者 */
    senderId?: string;
    /**
     * ★ 2026-11-14：按**图片内容指纹**筛（QQ 图片文件名 = 内容 MD5）。
     * 用于"有人引用了某张图 → 这张图是谁发的"。命中 `f` 字段，不看正文。
     */
    imageMd5?: string;
    /**
     * ★ 2026-11-14：**扫描行数上限**（不是命中数上限）。
     *
     * 为什么要单独这个：原来的 `limit` 是"命中多少条就停"，于是
     * **今天 500 条一条都没匹配上时，会继续把昨天、前天……7 个文件全读一遍**
     * （实测 20+ms，缓存也救不了，因为老文件本来就不缓存）。
     * 归属查询只需要"最近的那条"，扫够就停，别为了找更老的去翻整周。
     */
    maxScan?: number;
}
/** 读该会话的历史（**只碰它自己的目录**），新→旧 */
export declare function readMsgHistory(scope: 'group' | 'c2c', peerId: string, q?: HistoryQuery): HistoryRec[];
/** 找「某人最近一条」/「最近一条」 */
export declare function latestMsgHistory(scope: 'group' | 'c2c', peerId: string, opts?: {
    senderId?: string;
    withinMs?: number;
    kind?: MsgKind;
}): HistoryRec | undefined;
/** 诊断：会话目录 + 今天文件行数 */
export declare function historyDebug(scope: 'group' | 'c2c', peerId: string): string;
/**
 * 最近有消息写入的群目录对应的 gid（2026-10-20）。
 * 用途：web 会话里拿不到群会话记录时的兜底 —— 一般就是"当前正在聊的群"。
 */
export declare function latestGroupId(): string;
//# sourceMappingURL=msg-history.d.ts.map