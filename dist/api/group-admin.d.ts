/** 已知官方未开放(内邀中)的能力门控元数据 —— UI 据此渲染红条/灰态; 开放后删除对应项即可点亮 */
export declare const FEATURE_GATES: Record<string, {
    open: boolean;
    human: string;
}>;
export interface MemberInfo {
    member_openid: string;
    username?: string;
    member_role?: string;
}
export interface JoinRequest {
    join_request_id: string;
    risk_tips?: string;
    union_openid?: string;
    member_openid: string;
    username?: string;
    apply_at?: string;
    apply_source?: 'self_apply' | 'invited';
    invited_by?: string;
    bot?: boolean;
    verify_info?: {
        method?: string;
        verify_message?: string;
        review_qa_list?: Array<{
            question: string;
            answer: string;
        }>;
    };
}
/**
 * 入群申请的"验证信息"人话化:
 *   - review_qa_list 有内容 → 逐条「问题:xxx / 答案:yyy」;
 *   - 否则 verify_message 有值 → 直接显示用户填的答案(如「我是小号」);
 *   - 否则 method 有值 → 翻译成中文(admin_review_qa 这类英文枚举不该露给用户);
 *   - 都没有 → ''(无验证, 调用方显示 '-' 或不显示)。
 */
export declare function verifyHuman(vi?: {
    method?: string;
    verify_message?: string;
    review_qa_list?: Array<{
        question?: string;
        answer?: string;
    }>;
}): string;
export interface MuteState {
    global_rule?: {
        mode?: 'none' | 'always' | 'schedule';
        schedule_rules?: unknown[];
        recurring_rules?: unknown[];
    };
    members?: Array<{
        member_openid: string;
        mute_expire_at?: string;
        username?: string;
        union_openid?: string;
    }>;
}
export type ApiResult<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    err: {
        code: string;
        human: string;
    };
};
/**
 * 官方错误码 → 人话(可扩充; code 映射不到时回落通用文案)。
 * 2026-09-12 增强(主人要求"错误人话化"): 不只说"哪里错了", 还要给**可执行的下一步** ——
 * 之前只覆盖群管理类码, 发消息类的报错会把裸码抛给用户/AI(如"被动回复时间或次数超过限制"),
 * 以致 AI 得自己猜怎么绕。
 */
export declare function mapErrHuman(code: string | number, gateHuman?: string): string;
export interface GroupAdminOptions {
    appId: string;
    appSecret: string;
    /** 非官方能力门控覆盖(测试/开放后置 true), 默认读 FEATURE_GATES */
    featureOverrides?: Record<string, boolean>;
    logDir?: string;
}
export declare class GroupAdminClient {
    private readonly opts;
    private readonly tokens;
    private readonly gates;
    constructor(opts: GroupAdminOptions);
    private gate;
    private call;
    /**
     * 获取【单个】群成员信息 —— 重点是它返回 `username`（昵称）。
     *
     * ⚠️ 2026-10-05：官方文档对该接口标注「该能力正在内邀接入中，敬请期待」，
     *   错误码 11253 = 应用无接口访问权限（仅白名单机器人可用）。
     *   所以它只适合当**兜底**：调用方拿到 FEATURE_NOT_OPEN / 11253 就静默回落，别报错。
     *   一旦申请到权限，把 FEATURE_GATES.getMemberInfo.open 改 true 即自动生效。
     */
    /**
     * 【给自定义事件模块用】带 token 的**通用**官方 API 调用。
     *
     * 价值：框架负责 access_token 的获取与缓存（per-appId + 并发单飞）—— 这是模块自己做不到的
     *   （它拿不到 appSecret）。模块只管给 path，就能调任意官方接口：查成员、发消息、撤回、
     *   上传媒体、禁言、入群审批……
     *
     * @param method GET/POST/PATCH/DELETE
     * @param path   不含 host 的路径，形如 /v2/groups/{group_openid}/members/{member_openid}
     * @param body   可选 JSON body
     * @returns { ok:true, data } | { ok:false, err:{ code, human } }（human 已是人话）
     *
     * ⚠️ 2026-10-05：**不做**能力门控（FEATURE_GATES 是给"已知未开放"的主流程用的）；
     *   未开放的接口会走官方错误码（如 11253），调用方自己看 err.code 判定。
     *   path 也不做白名单（模块是主人自己写的代码，沙箱边界不在这一层）。
     */
    apiCall(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<unknown>>;
    /**
     * 获取用户基本信息（2026-11-17 官方新增）
     *
     * `GET /v2/users/{user_openid}/info` → `{ username, allow_proactive_msg, avatar }`
     *
     * 和 `getMemberInfo` 的区别：**这个不需要在同一个群里**，只要 openid 就能查；
     * 而且它是**唯一一条还开着的**"拿名字"的路 —— `listMembers`/`getMemberInfo`
     * 都还在内邀中（`open: false`）。
     *
     * 实测用途：新成员入群时用它的 openid 查一次，把 username 填进群成员台账，
     * 从此不依赖"他在群里发过言"。
     */
    getUserInfo(userOpenid: string): Promise<ApiResult<{
        username?: string;
        allow_proactive_msg?: boolean;
        avatar?: string;
    }>>;
    getMemberInfo(gid: string, memberOpenid: string): Promise<ApiResult<MemberInfo>>;
    /** 获取群成员列表(🔴 未开放, 完整实现保留, 开放即用) */
    listMembers(gid: string, cursor?: string): Promise<ApiResult<{
        members: MemberInfo[];
        next_cursor: string;
    }>>;
    /**
     * 批量移除成员（踢人）
     *
     * ★ 2026-11-17：官方把这个能力从「内邀中，敬请期待」改成**正式开放**
     *   （旧文档那句"该能力正在内邀接入中"已删）。实测 `/kick2` 直接踢成功。
     *
     * ⚠️ 同日文档把 **`add_to_member_blacklist` 参数删掉了**，请求体只剩 `member_openids`。
     *   但实测响应里**仍然回 `add_to_member_blacklist_fail_openids`** ⇒ 服务端还认这个字段。
     *   处理：默认**不传**（跟文档一致），要拉黑就显式传——**当 deprecated 用**，
     *   别把它写进新逻辑里，官方随时可能真删。
     *
     * 新增错误码（这次文档补的）：
     *   40103011 机器人关闭了「移除群成员」→ 去 WEB 管理端打开
     *   40103012 群主关闭了操作权限     → 让群主在群设置里给机器人打开
     */
    removeMembers(gid: string, memberOpenids: string[], addToBlacklist?: boolean): Promise<ApiResult<{
        remove_members_result: string;
        add_to_member_blacklist_fail_openids: string[];
    }>>;
    /** 入群申请列表(🟡 群管理员) */
    listJoinRequests(gid: string, cursor?: string, limit?: number): Promise<ApiResult<{
        list: JoinRequest[];
        next_cursor: string;
    }>>;
    /** 审批入群申请(🟡 群管理员; op: approve | decline) */
    approveJoinRequest(gid: string, memberOpenid: string, op: 'approve' | 'decline', opts?: {
        join_request_id?: string;
        reject_reason?: string;
        add_to_blacklist?: boolean;
    }): Promise<ApiResult<Record<string, never>>>;
    /** 查询群禁言状态(🟡 群管理员) */
    getMuteState(gid: string): Promise<ApiResult<MuteState>>;
    /** 获取群基本信息(群名/人数等; 11255=群不存在或已注销, 用于注册表有效性校验与显示群名) */
    getGroupInfo(gid: string): Promise<ApiResult<{
        group_openid?: string;
        group_name?: string;
        group_finger_memo?: string;
        group_class_text?: string;
        group_tags?: string[];
        group_member_num?: number;
    }>>;
    /**
     * 设置群成员禁言(🟡 群管理员; 单次≤20 人; 只能操作普通成员, 不能禁群主/管理员/机器人; 最长 30 天)
     * @param memberOpenid 目标成员
     * @param muteExpireAt RFC3339 到期时间(如 '2026-08-05T11:23:05+08:00'); 传 null = 立即解除禁言(del)
     */
    setMemberMute(gid: string, memberOpenid: string | string[], muteExpireAt: string | null): Promise<ApiResult<Record<string, never>>>;
    /**
     * 以机器人身份向群发送消息(面板"代发消息"用; 官方被动消息接口, 建议群内先有交互)。
     * 自动选通道: 内容含 QQ 交互标签 → markdown 通道(msg_type:2, QQ 端才会渲染成可点标签;
     *   实测 2026-09-06: 高亮 @ 格式 = `<@openid>`(无斜杠) 或 `<qqbot-at-user id="openid" />`;
     *   纯文本 msg_type:0 会原样显示标签); 否则纯文本(msg_type:0)。
     */
    sendGroupText(gid: string, content: string): Promise<ApiResult<{
        id?: string;
    }>>;
    /**
     * 向群发送自定义 markdown 卡片(带可选 keyboard 按钮)(2026-09-10 主人实测验证:
     * markdown 嵌网络图+按钮可渲染, 按钮 type:2 点击后 data 以指令消息回到群里)。
     * keyboard 结构: { content: { rows: [{ buttons: [{ id, render_data:{label,style}, action:{type,permission,data,enter} }] }] } }
     * 官方限制: 最多 5 行 × 每行 5 按钮 = 25 个; 超限报 40034029。
     * @returns 消息 id
     */
    sendGroupCard(gid: string, markdown: string, keyboard?: Record<string, unknown>): Promise<ApiResult<{
        id?: string;
    }>>;
    /** 以机器人身份向用户发私聊文本(c2c 主动消息; 同 sendGroupText 的通道选择逻辑) */
    sendC2cText(userOpenid: string, content: string): Promise<ApiResult<{
        id?: string;
    }>>;
    /**
     * 向私聊(c2c)发送 markdown 卡片 + 可选 keyboard(2026-09-10 主人要求卡片支持私聊)。
     * 官方 c2c 与群共用同一套 markdown/keyboard 结构, 仅 base path 不同。
     */
    sendC2cCard(userOpenid: string, markdown: string, keyboard?: Record<string, unknown>): Promise<ApiResult<{
        id?: string;
    }>>;
    /**
     * 撤回机器人自己发的消息(官方撤回窗口 2 分钟, 仅能撤自己发的)。
     * ⚠️ 2026-09-12 修(主人实测报 **11001**): 原实现打的是 `/v2/messages/{id}` —— **官方没有这个路径**,
     * 正确路径按场景分(官方文档已核对):
     *   群聊 DELETE `/v2/groups/{group_openid}/messages/{message_id}`
     *   单聊 DELETE `/v2/users/{user_openid}/messages/{message_id}`
     * @param peerId 群 openid(scope=group) 或 用户 openid(scope=c2c)
     * @param msgId  发送成功时返回的 message_id
     */
    recallMessage(peerId: string, msgId: string, scope?: 'group' | 'c2c'): Promise<ApiResult<Record<string, unknown>>>;
}
/** 工厂: 每实例一个 client(配置来自各 bot config.appId/appSecret) */
export declare function createGroupAdmin(opts: GroupAdminOptions): GroupAdminClient;
/** 取本 bot 的群注册表路径(事件累积+绑群, UI 选群用) */
export declare function groupRegistryPath(cwd: string | undefined): string;
//# sourceMappingURL=group-admin.d.ts.map