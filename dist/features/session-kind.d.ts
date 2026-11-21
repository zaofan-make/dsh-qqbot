/**
 * session-kind.ts —— 「当前是什么渠道 + 对方/群叫什么」（issue #79，2026-11-21）
 *
 * 问题：私聊消息注入格式（`[昵称 #ref]: "正文"`）与群聊几乎同构，插件全程没有
 * 任何"这是私聊/群聊"的显式标注 ⇒ 模型只能靠猜，实测把私聊判成群聊（按群规矩回复）。
 *
 * 名字来源（主人 2026-11-21 定：**直接走官方 API，不读台账**）：
 *   · 群聊：`GET /v2/groups/{group_openid}/info` → `group_name`
 *     （`api/group-admin.ts` 已有 `getGroupInfo`；30 QPM、需白名单权限，11253 = 无权限）
 *   · 私聊：`GET /v2/users/{user_openid}/info` → `username`
 *     （2026-11-17 官方新增的 `getUserInfo`，唯一一条还开着的"拿名字"的路）
 * 两者都**缓存 + 后台预取**：注入是同步回调，绝不能在回合里等网络；
 * 拿不到就只写"群聊/私聊"，不编名字。
 *
 * 注入方式：由 `session-manager` 以**独立 user/message 事件**注入
 * （`source.kind = 'qqbot:session-kind'`；带 `qqbot:` 前缀是维护手册 §11.21 的硬要求，
 * 否则 dock 聊天视图会把注入内容当成对方说的话）。不拼进真实用户消息的 content。
 */
/** `getGroupInfo` / `getUserInfo` 的最小形状（只用到这两个） */
export interface SessionKindClient {
    getGroupInfo?: (gid: string) => Promise<{
        ok?: boolean;
        data?: {
            group_name?: string;
        };
    } | undefined>;
    getUserInfo?: (openid: string) => Promise<{
        ok?: boolean;
        data?: {
            username?: string;
        };
    } | undefined>;
}
/** 同步读群名缓存（注入时用）：未命中返回空串 */
export declare function cachedGroupName(gid: string): string;
/** 同步读使用者昵称缓存（注入时用） */
export declare function cachedUserName(openid: string): string;
/** 记下入站消息自带的昵称（私聊 `senderName`、群名片），比 API 快且免费 */
export declare function rememberUserName(openid: string, name: string): void;
/** 手动写入群名（别处已经拿到时用，例如群名接口的调用方） */
export declare function rememberGroupName(gid: string, name: string): void;
/**
 * 后台拉群名并缓存（**不阻塞**当前回合）。没有缓存时，这一轮注入只能写"群名未取到"，
 * 下一轮就有了。失败也写空串（短 TTL），免得对着没权限的群每轮打接口。
 */
export declare function prefetchGroupName(client: SessionKindClient | undefined, gid: string): void;
/** 后台拉用户名并缓存；已有入站昵称时直接跳过（省一次接口调用） */
export declare function prefetchUserName(client: SessionKindClient | undefined, openid: string): void;
export interface SessionKindInfo {
    /** `group` = QQ 群聊；`c2c` = QQ 私聊 */
    kind: 'group' | 'c2c';
    /** 群名 / 对方昵称；取不到为空串 */
    name: string;
    /** 群 openid / 用户 openid */
    peerId: string;
}
/**
 * 描述当前会话的渠道与名字（**同步**：只用缓存，绝不在回合里等网络）。
 *
 * @param scope    `group` / `c2c`
 * @param peerId   群 openid / 用户 openid
 * @param peerName 入站消息自带的昵称（私聊 senderName / 群名片），优先级高于缓存
 */
export declare function describeSessionKind(scope: string, peerId: string, peerName?: string): SessionKindInfo;
/**
 * 拼注入正文（调用方包进 `<system-reminder>`，放进**独立**的 user/message 事件）。
 *
 * 只陈述事实 + 一句用途提醒，不写"请按群规矩回复"这种指令 ——
 * 宿主实测：框架文本容易被模型当成模板复述出来。
 */
export declare function buildSessionKindHint(info: SessionKindInfo): string;
//# sourceMappingURL=session-kind.d.ts.map