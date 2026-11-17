/** 官方 group-admin 客户端的最小外形（只用到 getMemberInfo；避免与 api/group-admin 强耦合） */
type GroupAdminLike = {
    /** 带 token 的通用官方 API 调用（自定义事件模块的 ctx.api 就转调它） */
    apiCall?: (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<{
        ok: true;
        data: unknown;
    } | {
        ok: false;
        err: {
            code: string;
            human: string;
        };
    }>;
    getMemberInfo?: (gid: string, memberOpenid: string) => Promise<{
        ok: boolean;
        data?: {
            username?: string;
        };
        err?: {
            code?: string;
        };
    }>;
    /**
     * 拿用户基本信息（2026-11-17 官方新开放 `GET /v2/users/{openid}/info`）。
     *
     * ⚠️ 它给的是**账号名 username**，**不是群昵称**！群昵称（群名片）只有两条路：
     *   · 他在群里发言时，事件里的 `author.member_nickname`
     *   · 官方 `GET /v2/groups/{gid}/members/{mid}` —— 还在内邀中（`open: false`），走不通
     * 所以入群/点按钮时能补的是"这人叫什么"，要群名片仍然得等他说话。
     */
    getUserInfo?: (userOpenid: string) => Promise<{
        ok: boolean;
        data?: {
            username?: string;
            avatar?: string;
            allow_proactive_msg?: boolean;
        };
        err?: {
            code?: string;
            human?: string;
        };
    }>;
};
import type { ReplyTarget } from '@tencent-connect/qqbot-nodejs';
import type { QQBotSender } from '../transport/outbound-buffer.js';
import type { SessionManager } from '../session/index.js';
import type { Logger } from '../types.js';
import type { BotplayButtonConfig, BotplayEventConfig } from '../config.js';
export interface BotplayTriggerResult {
    ok: boolean;
    msg: string;
}
/**
 * 构造事件卡片 keyboard(官方 msg_type=2 + keyboard)。
 * QQ 限制: rows ≤5 行 × 5 按钮/行; 默认每行1个(竖排, 字宽不截断),
 * 事件 buttonsPerRow(1~5)可设每行多个(Phase2)。
 * permission: 按事件 perm 决定 —— all→type2所有人 / triggerer→type0 指定触发者 /
 * owner→type0 主人白名单 / users→type0 指定 openid。
 * 按钮 action.type 按 botAction 区分(Phase2):
 *   reply_text/callback/command → 1 回调按钮(点击回后台, data=bp:card:btn)
 *   jump_url                      → 0 跳转按钮(data=http(s) 链接, 点击直接跳不走回调)
 */
export declare function botplayKeyboard(cardId: string, buttons: BotplayButtonConfig[], perm: NonNullable<BotplayEventConfig['perm']>, ownerIds: string[], triggererId?: string, buttonsPerRow?: number): {
    content: {
        rows: unknown[];
    };
};
/** 从 interaction button_data 解析 cardId + buttonId; 非 botplay 按钮返回 null */
export declare function parseBotplayButton(data: string | undefined): {
    cardId: string;
    buttonId: string;
} | null;
export declare function parseCatalogButton(data: string | undefined): {
    page: number;
    key: string;
} | null;
export declare class BotplayController {
    private readonly manager;
    private readonly sender;
    private readonly logger;
    /** live 事件配置 getter(config.botplayEvents, 每次现读支持热更) */
    private readonly eventsGetter;
    /** 主人 openid 白名单 getter(config.groupAdmin.owners; perm=owner 用) */
    private readonly ownersGetter;
    /** 台账 dataDir getter(表情包目录; 点击人昵称反查, 与 dock 禁言面板同源) */
    private readonly ledgerDataDirGetter;
    /** 数据根 getter(2026-10-05: 自定义事件模块放 {dataRoot}/.qqbot-extensions/botplay/) */
    private readonly dataRootGetter;
    private readonly cards;
    constructor(manager: SessionManager, sender: QQBotSender, logger: Logger, 
    /** live 事件配置 getter(config.botplayEvents, 每次现读支持热更) */
    eventsGetter: () => BotplayEventConfig[], 
    /** 主人 openid 白名单 getter(config.groupAdmin.owners; perm=owner 用) */
    ownersGetter: () => string[], 
    /** 台账 dataDir getter(表情包目录; 点击人昵称反查, 与 dock 禁言面板同源) */
    ledgerDataDirGetter: () => string, 
    /** 数据根 getter(2026-10-05: 自定义事件模块放 {dataRoot}/.qqbot-extensions/botplay/) */
    dataRootGetter?: () => string);
    /** 指令型按钮执行器(bootstrap 注入: 执行斜杠命令并返回文本) */
    private commandExecutor;
    setCommandExecutor(fn: ((cmdName: string, target: ReplyTarget) => Promise<string>) | undefined): void;
    /** API 兜底查到的昵称缓存：`${peerId}|${openid}` → name */
    private readonly memberNameApiCache;
    /** 正在后台查的 key（防同一人并发重复查） */
    private readonly memberNameProbing;
    /** 官方 group-admin 客户端 getter（bootstrap 注入；没注入就跳过兜底） */
    private groupAdminGetter;
    setGroupAdminGetter(fn: (() => GroupAdminLike | undefined) | undefined): void;
    /** bot 凭证 getter（卡片 = 代码，直接把 appId/appSecret 给它，让它自己调官方 API） */
    private credentialsGetter;
    setCredentialsGetter(fn: (() => {
        appId: string;
        appSecret: string;
    }) | undefined): void;
    /**
     * 后台探测某人昵称（不阻塞调用方）。
     *   命中 → 写进 memberNameApiCache，下次同步调用就能拿到真名。
     *   未命中/无权限/网络错 → 静默（只记一行日志，避免刷屏）。
     *
     * ★ 2026-11-17 修（主人：现在能靠 openid 直接换名字了）：
     *   原来调的是 `getMemberInfo(gid, openid)` —— 那是**群内路径**
     *   `/v2/groups/{gid}/members/{mid}`，`FEATURE_GATES.getMemberInfo: open === false`，
     *   官方还挂在内邀中 ⇒ **永远命中不了**，这个兜底实际上一直是死的。
     *
     *   换成 `getUserInfo(openid)` → `GET /v2/users/{openid}/info`：
     *   不看群、不需要对方发过言，只要给 openid 就能拿 `username`。
     *   这是目前**唯一还开着**的"拿名字"接口。
     *
     *   注意它拿的是**账号名**（跨群通用），不是群名片 —— 对"这人是谁"这个用途足够。
     */
    private probeMemberNameAsync;
    /** 已加载模块缓存: 绝对路径 → 加载结果(按 mtime 判热重载; 不按时间戳刷 URL, 见 fileVersion 注释) */
    private readonly extModules;
    /** 每实例每按钮点击计数: `${cardId}|${buttonId}` → 次数(自定义事件的"是否点过"判据) */
    private readonly extClicks;
    /** 加载失败原因: 文件名 → 错误(面板展示红色摘要) */
    private readonly extErrors;
    /** 面板用: 每个自定义事件模块的状态(路径/是否存在/mtime/加载错误) —— settings-host 经此展示 */
    extStatus(): Array<{
        file: string;
        path: string;
        exists: boolean;
        mtime: number;
        loadedMtime: number;
        name: string;
        error: string;
        hooks: string[];
    }>;
    /** 诊断日志(自定义事件加载/点击/报错都落这个文件; 面板可读) */
    private extDiag;
    private statFile;
    /** 事件是否由自定义模块驱动(带 file 且文件名合法) */
    private extFileOf;
    /**
     * 取(或热重载)模块: mtime 没变就复用缓存实例(模块里的内存状态得以跨卡持有),
     * 变了就重新 import(`?v=<mtime>`)。加载失败**不抛**, 返回 {error}。
     */
    private loadExt;
    /** 热重载指定模块(文件名; 空=全部): 清缓存 → 下次解析卡片自动加载新版本 */
    reloadExt(file?: string): {
        ok: boolean;
        msg: string;
    };
    /** 列表(面板/命令共用): 带"是否自定义事件"标记 */
    listExtFiles(): string[];
    /** 列出所有事件(公开, dock/命令共用) */
    listEvents(): BotplayEventConfig[];
    /** 按事件 id 精确查(live 现读) */
    findEvent(eventId: string): BotplayEventConfig | undefined;
    /**
     * 触发发卡(/botplay 事件名)。定位会话用命令上下文所在 scope/peerId,
     * 归属人 = 触发者本人 openid(group=c2c 同 senderId)。
     *
     * 2026-10-05 加: 事件带 `file`(自定义事件模块)时, 按钮/正文先问模块要(见 resolveExtCard),
     *   模块挂了也不挡发卡(回落到事件自带的按钮配置)。
     */
    trigger(target: ReplyTarget, eventId: string, triggererId: string): Promise<BotplayTriggerResult>;
    /**
     * 解析自定义事件卡片: 加载模块 → 跑 onInit → 收下模块给的按钮/正文。
     *
     * 为什么整条 fail-soft 到底: 模块是主人(或 AI)手写的代码, 语法错了/钩子抛错都不该
     * 让"发个卡片"这种小事炸掉, 更不该影响其它事件与 QQ 正常聊天 —— 一律记诊断 + 回落。
     * 返回 state.buttons 一定非空(模块没给就用事件自带按钮)。
     */
    private resolveExtCard;
    /**
     * 构造自定义模块的 ctx(每个卡片实例一个)。
     * 说明: ctx.emit/markdown/image 都发往**该实例卡片所在的会话**(target), 不是点击人私聊 ——
     *   群里的签到统计就该发群里; 要私聊给某人可以 ctx.markdown 之外自己判断(本期不做)。
     */
    private buildExtCtx;
    /** 把模块给的按钮洗成合法形状(缺 id/label 的丢掉; 防止脏数据把 keyboard 生成搞炸) */
    private sanitizeExtButtons;
    /** 点击后按钮变了 ⇒ 重发卡片刷新(QQ 没有现成的"改卡片"接口, 重发是可靠做法) */
    private refreshCard;
    /** 清理一个卡片实例的扩展资源(点击计数/模块 onDispose) */
    private disposeCard;
    /** 发送事件目录卡(/botplay 无参 或 目录卡翻页; 点事件名按钮 → handleInteraction 直接触发) */
    sendCatalog(target: ReplyTarget, page?: number): Promise<BotplayTriggerResult>;
    /**
     * interaction 回调结算(bootstrap interaction 分发转发; type=11 消息按钮)。
     * 流程: 解析 bp:<cardId>:<buttonId> → 查卡(过期/点满) → 查事件配置(live)
     * → 校验按钮存在与点击人权限 → 执行 botAction → 按 llmEffect.mode append/唤醒。
     * @returns true = 已被 botplay 消费(调用方无需其它处理)
     */
    handleInteraction(event: unknown, replyTarget: ReplyTarget): Promise<boolean>;
    /** 内置三型按钮行为(reply_text / jump_url / command; 普通事件用) */
    private runBuiltinAction;
    /**
     * 跑自定义模块的 onClick(2026-10-05)。
     *
     * 顺序(为什么这么排):
     *   ① 计数先 ++, 让模块里的 ctx.clicked 立刻反映"这是第几次点"(签到判重的关键);
     *   ② 跑模块(它可能改按钮/正文/发消息/持久化);
     *   ③ 模块返回非空字符串 → 当普通文本回给点击者(比让模块自己 emit 更省事);
     *   ④ 模块把卡片改脏 → 重发卡片刷新按钮(QQ 没"改卡片"接口, 重发是可靠做法);
     *   ⑤ 模块抛错 → 回一句人话 + 落诊断, 绝不让一次点击把插件带崩(fail-soft)。
     */
    private runExtClick;
    /**
     * 点击人可读标签(与 dock 禁言面板/审批同源的昵称反查):
     *   ①群成员台账 group-members.jsonl(gid:mid → name, 由 chat-ledger 中间件持续记录)
     *   ②私聊台账 known-chats.jsonl(c2c:id → name)
     *   ③会话最近 user/message 消息壳 [昵称 (openid)] 兜底
     *   ④全 miss 回落 openid。
     */
    private clickerLabel;
    /**
     * 昵称反查(2026-10-05 从 clickerLabel 抽出来给自定义模块用): 只要**纯昵称**, 不带 openid 尾巴
     * (签到统计那种"列出所有签到者名字"的场景, 名字后面挂截断 openid 很难看)。
     * 数据源与 clickerLabel 同源(见其注释): 群成员台账 → 私聊台账 → 会话消息壳 → 回落 openid。
     */
    /**
     * 昵称反查 —— public（2026-10-23：提问卡片回执要显示作答人昵称，复用同一套台账→缓存→API 兜底）。
     */
    memberName(target: ReplyTarget, presser: string): string;
    /** 权限判定: all 放行 / triggerer=触发者本人 / owner=主人白名单 / users=指定 openid */
    private checkPerm;
    /**
     * append 三档落点: 往该 peer 的会话写上下文/唤醒 AI。
     * ⚠️ 会话不在内存(重启后未恢复/被 idle 回收)→ getOrCreate 恢复/重建(不触发回合),
     *    保证 append/injectToPeer 有 record 可挂 —— 这是"点击没反应"的常见根因。
     */
    /** ★ 内核句柄（遥控器）：bootstrap 构造本控制器后注入；卡片 ctx.kernel 就是它 */
    private _kernel?;
    setKernel(kernel: unknown): void;
    private applyEffect;
    private safeReply;
    /**
     * 通知自定义模块"这张卡片过期了"(onExpire; 2026-10-05)。
     * 为什么要有: 签到类事件常要"到点自动结算/清场", 模块没有这个回调就只能等主人手点。
     * fail-soft: 模块抛错只记日志。
     */
    private fireExtExpire;
    /** 清理全部活动卡(dispose 用; 自定义事件会收到 onDispose) */
    clear(): void;
    /** 扫掉过期卡(Phase2: 定期/触发时调用, 防内存积压; 2026-10-05 顺带通知模块 onExpire) */
    sweepExpired(): number;
    /** 活动卡数量(诊断用) */
    get cardCount(): number;
}
export declare function registerBotplayController(ns: string, c: BotplayController | undefined): void;
/** /botplay 命令触发入口: bootstrap 注册实现(带 sender/manager)。
 *  ⚠️ 2026-09-11 多实例修复: 原模块级单例会被多个实例互相覆盖(和 outbound writer 同款 bug,
 *  实测 /botplay 在 某实例会话执行却发卡到别的实例的群 86976C...)。改为按 ns 注册表。 */
type TriggerFn = (target: ReplyTarget, eventId: string, triggererId: string) => Promise<BotplayTriggerResult>;
export declare function setBotplayTriggerImpl(ns: string, fn: TriggerFn | undefined): void;
export declare function triggerBotplay(ns: string, target: ReplyTarget, eventId: string, triggererId: string): Promise<BotplayTriggerResult>;
/** 事件目录卡入口: bootstrap 注册实现(带 sender/manager); /botplay 无参调用 */
type CatalogFn = (target: ReplyTarget, page: number) => Promise<BotplayTriggerResult>;
export declare function setBotplayCatalogImpl(ns: string, fn: CatalogFn | undefined): void;
export declare function botplayCatalog(ns: string, target: ReplyTarget, page?: number): Promise<BotplayTriggerResult>;
/** 取某 ns 的事件列表(dock 装配器读; settings value 里其实已有, 此出口备用) */
export declare function listBotplayEventsAny(): Array<BotplayEventConfig & {
    ns: string;
}>;
/** 取某 ns 的 botplay 控制器(未注册返回 undefined) */
export declare function botplayControllerOf(ns: string): BotplayController | undefined;
/**
 * 面板用: 某实例的自定义事件模块状态(路径/是否存在/mtime/加载错误/hooks)。
 * 找不到实例时返回空数组(面板显示"未就绪"即可, 不报错)。
 */
export declare function botplayExtStatus(ns: string): Array<{
    file: string;
    path: string;
    exists: boolean;
    mtime: number;
    loadedMtime: number;
    name: string;
    error: string;
    hooks: string[];
}>;
/** 面板「🔄 重载模块」用: 热重载指定模块(空=全部); 不重启宿主 */
export declare function reloadBotplayExt(ns: string, file?: string): {
    ok: boolean;
    msg: string;
};
/**
 * 取指定实例的事件列表(命令层 /botplay 用)。
 * ⚠️ 2026-09-10 修复: 事件存储自 M4.3 起已迁到 {dataRoot}/botplay-events.json, 但命令层仍在读
 *    config.botplayEvents(settings 层, 迁移后已被清空) → /botplay 永远报"还没有装配任何互动事件"。
 *    控制器 listEvents() 是现读文件的(支持热更), 这里直接复用其数据源, 单一真相源。
 * 控制器未注册(插件未就绪)时返回 undefined, 调用方回退 config.botplayEvents。
 */
export declare function listBotplayEventsOfNs(ns: string): BotplayEventConfig[] | undefined;
/** 会话定位 → ReplyTarget(命令层用; senderId 即触发者) */
export declare function resolveCommandTarget(cmdCtx: {
    message?: {
        kind?: string;
        groupOpenid?: string;
        senderId?: string;
        messageId?: string;
    };
}): {
    target: ReplyTarget;
    triggererId: string;
};
export {};
//# sourceMappingURL=botplay.d.ts.map