/**
 * dsh-im-qqbot 插件配置 Schema
 *
 * 配置入口: profile 的 cordis.patch.yml → im-qqbot config(改动热重载, 无需重启)。
 * Web 可视化设置: 注册 im-qqbot settings 命名空间(可编辑项 = EditableConfigSchema:
 * behavior / sticker.gates / injectRules), 用户层存 ~/.dsh/settings.yaml, live 生效。
 * ⚠️ 本地手改功能(配置化改造, 2026-09-03)。
 */
import Schema from '@deepseek-ai/schemastery';
export interface AccessControlConfig {
    /** C2C 访问模式 */
    c2cMode: 'open' | 'allowlist' | 'disabled';
    /** C2C 白名单（user openid） */
    c2cAllow: string[];
    /** 群聊访问模式 */
    groupMode: 'open' | 'allowlist' | 'disabled';
    /** 群聊白名单（group openid） */
    groupAllow: string[];
}
/** 延迟聚合(debounce)配置 — 独立于群冷却的另一套机制 */
export interface DebounceConfig {
    /** 总开关。true=消息先进"待派发窗口", 静默/攒够才一次派发; false=关(走原逻辑) */
    enabled: boolean;
    /** 最近说话者停止发言多少秒后触发一次派发(默认3)。0=不停顿(立即派发, 等效关掉静默等待) */
    silenceSec: number;
    /** 窗口内消息攒满多少条立即触发(默认10), 不等人停 */
    maxMsgs: number;
    /** @bot 消息是否也走延迟(默认true)。false=@到秒回(不聚合) */
    mentionDelayed: boolean;
    /**
     * 回合(LLM 正在思考/输出)中群友新消息怎么处理(2026-10-07 主人定):
     *   'queue'     = 排队(默认/现状): 攒在窗口里等这轮回合结束(turn/end)再整批送入;
     *   'interject' = 插话: 照样先聚合(静默/条数), 但不等回合结束 —— 聚合好就 inject 到
     *                 当前回合的**下一个轮次边界**(宿主 next-step 队列), AI 本轮就能读到。
     */
    busySendMode: 'queue' | 'interject';
}
/** 回复调度(冷却)配置 */
export interface BehaviorConfig {
    /** 群普通(未@)消息回复最小间隔(秒)。0=不限制; 默认60 */
    freeIntervalSec: number;
    /** 被@消息回复最小间隔(秒)。0=@总是立即回 */
    mentionIntervalSec: number;
    /** 私聊(C2C)回复最小间隔(秒)。0=不限制 */
    directIntervalSec: number;
    /** 延迟聚合(防连发只回第一句; 与上面三项冷却互不干扰) */
    debounce: DebounceConfig;
}
/** 表情包主动发送闸门(默认不限制; 总开关 enabled=false 一票关闭) */
export interface StickerGatesConfig {
    enabled: boolean;
    perTurnMax: number;
    perWindowSec: number;
    maxPerWindow: number;
    dailyBudgetPerGroup: number;
    dupTTLHours: number;
    activityWindowSec: number;
    activityMinMsgs: number;
    bannedGroups: string[];
    libRoots: string[];
}
export interface StickerConfig {
    /** 是否自动收藏群图片（默认开，只存本地不外发） */
    collectEnabled: boolean;
    /** 图库数据根目录（默认 {agent cwd}/表情包） */
    dataDir: string;
    /** 主动发送闸门(默认不限制) */
    gates: StickerGatesConfig;
    /** 新图自动打标总开关 */
    autoTagEnabled: boolean;
    /** 视觉CLI命令模板(含{img}占位); 空=自动探测本机视觉CLI(modlens等); 探测不到则不自动打标 */
    visionCli: string;
}
/** 条件注入规则 */
export interface InjectRuleConfig {
    id: string;
    name?: string;
    enabled: boolean;
    conditions: {
        hasImage: boolean;
        hasLink: boolean;
        contentRegex: string;
        contentKeywords: string[];
        matchScope: 'any' | 'all';
    };
    prompt: string;
}
/** 定时唤醒时刻任务(M3): 一条时刻记录, 挂在某个目标(群/人)下面 */
export interface ScheduledWakeTask {
    id: string;
    /** 每天触发时刻, 24h 本地时区 "HH:MM" */
    time: string;
    enabled: boolean;
    /** 可选: 指定这次想让她聊的方向(空=自由发挥) */
    prompt?: string;
}
/** 定时唤醒目标(M3): 一个群/一个人, 号码只填一次, 下面挂多条时刻任务(分组) */
export interface ScheduleTargetConfig {
    id: string;
    /** 可选: 显示名/备注(帮认这个群/人) */
    name?: string;
    /** 目标会话: group=群(group_openid) / c2c=私聊(用户 openid) */
    scope: 'group' | 'c2c';
    targetId: string;
    tasks: ScheduledWakeTask[];
}
export interface ScheduleConfig {
    targets: ScheduleTargetConfig[];
}
/** botAction 行为类型: reply_text=回指定文本 | jump_url=跳转(官方action.type=0) | callback=仅回调结算无bot回复 | command=点击执行斜杠命令(host侧直发) */
export type BotplayActionType = 'reply_text' | 'jump_url' | 'callback' | 'command';
/** llmEffect.mode 三档: no_append=纯bot行为AI不知 / append_silent=记录不唤醒 / append_wake=记录并唤醒AI */
export type BotplayEffectMode = 'no_append' | 'append_silent' | 'append_wake';
/** perm.type: all=所有人 / triggerer=仅触发者本人 / owner=主人白名单 / users=指定openid列表 */
export type BotplayPermType = 'all' | 'triggerer' | 'owner' | 'users';
/** 一个按钮的完整定义 */
export interface BotplayButtonConfig {
    /** 按钮 id(回调 data 编码 事件id::按钮id; 建议 [a-zA-Z0-9_-] 避免分隔符冲突) */
    id: string;
    /** 按钮显示文字 */
    label: string;
    /** 点击后显示文字(visitedLabel), 留空=label */
    visitedLabel?: string;
    /** 0灰 1蓝 */
    style?: number;
    /** 点击后 bot(非LLM)直接做什么 */
    botAction: {
        type: BotplayActionType;
        /** reply_text 用(文本); command 用(斜杠命令名, 如 bot-status) */
        text?: string;
        /** jump_url 用 */
        url?: string;
    };
    /** 点击事件对 LLM 的影响(自定义三档) */
    llmEffect?: {
        mode: BotplayEffectMode;
        /** 自定义记录文本模板, 支持 {label} 占位; 空=默认可读描述 */
        contextText?: string;
    };
}
/** 一个可装配互动事件 */
export interface BotplayEventConfig {
    /** 事件唯一 id(斜杠触发用; 建议 [a-zA-Z0-9_-]) */
    id: string;
    /** 显示名(/botplay 列表显示) */
    name: string;
    /**
     * 卡片正文 markdown 模板(2026-09-10 M4): 支持 {name} 占位;
     * 空=默认模板(## 🎮 事件名 + 固定引导文案)。
     * 可嵌网络图 ![text #wpx #hpx](url); 按钮点击回调由按钮配置驱动。
     */
    contentText?: string;
    /** 接受点击数: 0=不限; N=单次触发实例最多点 N 次(点满失效) */
    maxClicks?: number;
    /** 发卡后有效期(秒): 超时按钮不再受理 */
    expireSec?: number;
    /** 每行几个按钮(Phase2: 1~5, 默认1=竖排; QQ 上限 5行×5钮) */
    buttonsPerRow?: number;
    /** 权限自定义(默认 all; triggerer=仅触发者本人) */
    perm?: {
        type: BotplayPermType;
        /** users 时填 openid 列表; owner 时可用(留空=取群主白名单) */
        userIds?: string[];
    };
    /**
     * 自定义事件模块文件名(2026-10-05): 填了 ⇒ 本事件由 AI 写的 JS 模块驱动,
     * 放在 {dataRoot}/.qqbot-extensions/botplay/<file>; 卡片按钮与点击行为都走模块钩子,
     * dock 编辑器对这类事件不再显示编辑表单(改为"模块路径 + 重载 + 看源码")。
     * 空/缺省 = 普通事件(走原来的按钮配置)。
     */
    file?: string;
    buttons: BotplayButtonConfig[];
}
/** QQ 群管理(2026-09-05): 总开关 + 主人 openid 白名单(空=不校验; 建议填主人与常用小号) */
export interface GroupAdminConfig {
    enabled: boolean;
    owners: string[];
    /**
     * 对话内"默认管理群"(group_openid): QQ 群会话里工具取当前群;
     * web/非群会话时工具回退用它 —— "对话里管一个群"不依赖会话形态(2026-09-05 主人定)。
     * 多群管理走设置 UI ⑥(P3 选群), 此字段只承载对话内单群。
     */
    manageGroup: string;
    /**
     * 订阅入群申请事件(GROUP_JOIN_REQUEST, intent GROUP_MEMBER_EVENT 1<<24)。
     * ⚠️ 涉及 gateway intents(连接建立时确定)→ **改后必须重启才生效**, 不是 live 热改。
     * 需要机器人为该群管理员才会推送; 若官方未授权该 intent, 连接可能被拒(4914/4915)。
     */
    watchJoinRequests: boolean;
    /** 收到新入群申请事件时是否在该群内发一条 bot 提醒消息(默认开; 需机器人=该群管理员) */
    notifyInGroup: boolean;
    /**
     * 群组管理器会话 id(2026-09-09 M2): 该机器人各群的"群事件"(入群申请/新成员加入/机器人被拉群)
     * 汇总注入到这一个会话(dock 群组管理 tab 一键设为当前 web 会话; 该会话须绑定某 QQ 群/私聊,
     * 注入姿势=whenIdle 回合空闲后 append user/message 不唤醒 —— web 流可见、不坏聊天记录)。
     * 配置了且注入成功 → 不再在该群内发提醒(统一收 hub, 避免重复打扰)。
     */
    hubSessionId: string;
    /** 群事件转发到群组管理器的开关(默认开; 置 false 后只在原群内提醒) */
    hubNotify: boolean;
    /**
     * 入群申请轮询(2026-09-09 主人定, 事件驱动的兜底):
     * 事件订阅依赖"机器人为群管理员"且可能漏推; 轮询定时拉取各群审批列表,
     * 攒够 minCount 个待审批就唤醒 LLM(伪造【审批轮询】入站消息走 handleInbound),
     * AI 按主人指令通过/拒绝 —— 不自动批, 唤醒后听主人的。
     */
    pollJoinRequests: {
        enabled: boolean;
        /** 轮询间隔(分钟), ≥1 */
        intervalMin: number;
        /** 待审批数 ≥ 此值才唤醒(攒批防打扰) */
        minCount: number;
        /** 达到阈值后是否唤醒 LLM(伪造入站消息; false=只落盘/通知, 不唤醒) */
        wakeLlm: boolean;
        /** 轮询到待审批时是否注入群组管理器会话(web 可见) */
        hubNotify: boolean;
        /** 是否同时在原群(普通群会话)发提醒。false=只注入群组管理器会话, 普通群不打扰 */
        notifyGroup: boolean;
        /** 是否唤醒普通群(申请所在群)会话的 AI(2026-09-11 主人要求与唤醒群管 AI 分开设置) */
        wakeGroup: boolean;
    };
    /**
     * 自动撤回（2026-10-20 主人定）: 命中关键词/附件类型就**立刻撤回**（不走 AI），可选顺带禁言。
     * `mode`:
     *   · `'keep'` = 消息仍然进 AI 上下文（只从聊天记录里消失）—— 默认，最安全；
     *   · `'drop'` = 连 AI 都不看（在**入站扩展之后**拦截，不破坏扩展契约）。
     */
    autoRecall: {
        enabled: boolean;
        mode: 'keep' | 'drop';
        /** 关键词（子串匹配正文；命中任一即撤回） */
        keywords: string[];
        /** 按附件类型命中（空数组=不按类型筛） */
        kinds: Array<'text' | 'image' | 'voice' | 'video' | 'file'>;
        /** 同时禁言发送者的秒数（0=不禁言） */
        muteSeconds: number;
        /** 演练：只记日志不真撤 */
        dryRun: boolean;
    };
}
/** Web 设置可编辑子集(不含 appId/appSecret 等敏感/底层字段) */
export interface EditableConfig {
    /** 插件数据根目录(可选; 缺省=cwd): 表情包/.qqbot/.qqbot-extensions 统一挂其下, 与工作区其他文件分离 */
    dataRoot?: string;
    behavior: BehaviorConfig;
    groupAdmin: GroupAdminConfig;
    sticker: {
        gates: StickerGatesConfig;
        /** 新图后台自动识图打标(消耗视觉额度; 默认关, 开=后台自动) */
        autoTagEnabled?: boolean;
        /** 视觉引擎命令模板(留空自动探测) */
        visionCli?: string;
    };
    injectRules: InjectRuleConfig[];
    /** 图片消息是否自动追加「看图」内置提示(默认 true)。关掉=不再注入「请把 URL 传给识图工具」那条
     *  —— 模型自己就能读图时可以关它。 */
    imageHint?: boolean;
    /** 引用消息总开关(默认 true): 开=入站消息带短消息号(台账索引) + 引用消息附原文 + 注入引用指令, 出站支持 [rf:短号] 标签 */
    messageReference?: boolean;
    /** 本地小模型(省 token; 2026-09-13 主人定): 开=本地先筛(价值评分/语义搜索), 模型缺失/加载失败则静默关闭 */
    localModel?: {
        enabled?: boolean;
        /**
         * **附件唤醒开关**（2026-09-15 主人定）：按附件类型决定"是否无视分数直接唤醒"。
         *
         * 起因：主人问「视频和文件不算是图片，为什么也默认唤醒了？」——
         *   原来收集"图片 URL"时不区分格式（只要是 QQ 多媒体链接就收），视频/文件跟着"带图一律不拦"沾了光。
         *
         * `true` = 该类附件无视分数直接唤醒；`false`/缺省 = 走正常评分。
         *   · `image` 默认 true（群友发图常是给她看的；图片本来也没文字可评）
         *   · `video`/`voice`/`file` 默认 false（视频/文件没文字就没分；语音有转录文字就用文字评）
         * ⚠️ 无分数时（纯附件）：**只有该类允许放行才唤醒** —— 否则"取消勾选"等于没勾。
         */
        attachmentPassthrough?: {
            image?: boolean;
            video?: boolean;
            voice?: boolean;
            file?: boolean;
        };
        /** 模型目录(留空=默认 {DSH_HOME|~/.dsh}/models/bge-small-zh) */
        modelDir?: string;
        /** 价值评分模式(账号默认): off=不评分 / log=只记录(默认) / block=低分不唤醒 */
        valueGate?: 'off' | 'log' | 'block';
        /** 价值评分门槛(0~1): 近邻相似度低于此值视为不值得回应 */
        valueMinScore?: number;
        /** 单会话覆盖(2026-09-13): key = "group:<群openid>" / "c2c:<私聊openid>"; 未覆盖则继承账号默认 */
        /** 兜底: 小模型不可用时改用纯程序(字符 n-gram)算向量(安卓等无 ONNX 环境仍可用) */
        lexicalFallback?: boolean;
        overrides?: Record<string, {
            enabled?: boolean;
            valueGate?: 'off' | 'log' | 'block';
            valueMinScore?: number;
        }>;
    };
    /** 群聊常驻守则(默认含表情包礼仪; QQ 通道级注入, 跨 preset 不碰 persona) */
    groupPrompt?: string;
    /** 定时唤醒任务(M3) */
    schedule: ScheduleConfig;
    /** QQ 远程审批开关(live 热生效: 对"保存后的新审批请求"即时生效, 无需重启) */
    enableApprovals?: boolean;
    /** 扩展工具按需取用(默认开): 全局只挂 gain_qq_tools 元工具; 关掉=全部 expose:'all' 工具全量全局注册 */
    extMetaTool?: boolean;
    /** QQ 权限申请等待时长(ms), 超时自动拒绝 */
    approvalTimeoutMs?: number;
    /** 出站模式: adaptive=适配主动(默认; 前5次带msg_id被动回复后自动转主动), detail=详细主动(adaptive 发送行为 + 额外推送工具调用/结果), passive=全被动回复, silent=完全不出站(思考但不发), nothink=完全不思考(QQ入站不唤醒LLM, 仅记录; 仅设置页可配防自锁) */
    outboundMode?: 'adaptive' | 'active' | 'passive' | 'detail' | 'silent' | 'nothink';
    /** botplay 互动事件列表(dock「🎮 互动事件」装配器编辑; live 热更, 无需重启) */
    botplayEvents: BotplayEventConfig[];
}
/**
 * 群聊默认常驻守则(表情包礼仪, P2 品味层)。
 * 由 qqbot 通道注入 agentBody(scope=group 时), 所有走 QQ 的 preset 通用, 不修改任何 persona。
 */
export declare const DEFAULT_GROUP_PROMPT: string;
/**
 * 通道固定注入上下文(2026-09-09): 与可编辑群守则(groupPrompt)无关、无条件注入每个 QQ 会话,
 * 保证任何 AI/任何预设都会收到 QQ 通道的基础使用规则(即使群守则被清空/覆盖)。
 */
export declare const FIXED_CHANNEL_CONTEXT: string;
/**
 * 引用消息能力说明(2026-09-13 主人定; 短消息号版): 开启 messageReference 时随群守则一起注入。
 * 教 AI ①入站消息带短"消息号"(如 #0913a) ②出站用 [rf:消息号] 引用对方。
 */
export declare const REFERENCE_CONTEXT: string;
/** Web 设置页可编辑项的 schema(behavior/sticker.gates/injectRules/groupPrompt/schedule) */
export declare const EditableConfigSchema: Schema<EditableConfig>;
export interface ImQQBotConfig {
    /** QQ Bot AppID */
    appId: string;
    /** QQ Bot AppSecret */
    appSecret: string;
    /** dsh LLM 提供商名称 */
    provider?: string;
    /** 模型名称 */
    model?: string;
    /** Agent preset id */
    preset?: string;
    /** Agent 工作目录（缺省回落到进程 cwd） */
    cwd?: string;
    /** 插件数据根目录(可选): 表情包/.qqbot/扩展等数据统一挂其下, 不混进 cwd; 缺省=用 cwd(向后兼容)。设 cwd 下子目录(如 cwd/dshqqbot)即可把插件数据与工作区其他文件分开 */
    dataRoot?: string;
    /** Web 设置命名空间(多账号时每个实例唯一, 默认 im-qqbot; 同进程多实例必须互不相同) */
    settingsNs?: string;
    /** 是否启用群消息 @mention 门控 */
    requireMention: boolean;
    /** 群聊常驻守则(默认=表情包礼仪, 通道级注入; 空=关闭) */
    groupPrompt?: string;
    /** 私聊额外 system prompt */
    directPrompt?: string;
    /** 单条消息最大长度（QQ 限制约 5000 字符） */
    textChunkLimit: number;
    /**
     * 私聊（c2c）出站时，在首行插一张**机器人自己的头像**（markdown 图片，50px）。
     * 2026-10-30 主人要求：官方机器人私聊里没有头像，群里才有，所以私聊里用正文首行补一个。
     * 默认**关**。
     */
    c2cShowBotAvatar?: boolean;
    /** 是否启用流式输出（群聊始终不启用） */
    streaming: boolean;
    /** 每会话最大闲置时长(ms)，超时自动回收 */
    sessionIdleTimeout: number;
    /** 并发队列最大长度 */
    maxQueue: number;
    /** 处理超时(ms)，超时中断当前 LLM 调用 */
    processingTimeoutMs: number;
    /** 无上下文模式: 每轮不继承历史(只带「@ 之前 N 条群消息」+ 系统规则), 大幅省 token */
    contextlessMode?: boolean;
    /** 无上下文模式下携带的「@ 之前」群消息条数(0=完全不带) */
    contextlessWindow?: number;
    /**
     * 无上下文模式·智能判断(2026-10-01): **与 contextlessWindow 互斥**。
     * 开启后不按固定条数，而是让 AI 自己判断话题是否结束，自主调用
     * context_compact（压缩、保留最近几条）/ context_drop（丢弃全部历史），
     * 只留下它自己写的备忘（存独立文件，压缩碰不到）。
     */
    contextlessSmart?: boolean;
    /** 备忘条数上限（超出自动丢最旧 —— 主人要求：不要无限增加） */
    contextMemoMaxItems?: number;
    /** 群历史缓冲条数 */
    historyLimit: number;
    /** 访问控制 */
    access: AccessControlConfig;
    /** 回复调度(冷却) */
    behavior: BehaviorConfig;
    /** 表情包图库 */
    sticker: StickerConfig;
    /** 条件注入规则 */
    injectRules: InjectRuleConfig[];
    /** 图片消息是否自动追加「看图」内置提示(默认 true)。关掉=不再注入「请把 URL 传给识图工具」那条
     *  —— 模型自己就能读图时可以关它。 */
    imageHint?: boolean;
    /** 引用消息总开关(默认 true): 开=入站消息带短消息号(台账索引) + 引用消息附原文 + 注入引用指令, 出站支持 [rf:短号] 标签 */
    messageReference?: boolean;
    /** 本地小模型(省 token): 开=本地先筛(价值评分/语义搜索), 模型缺失自动关闭 */
    localModel?: {
        enabled?: boolean;
        /**
         * **附件唤醒开关**（2026-09-15 主人定）：按附件类型决定"是否无视分数直接唤醒"。
         *
         * 起因：主人问「视频和文件不算是图片，为什么也默认唤醒了？」——
         *   原来收集"图片 URL"时不区分格式（只要是 QQ 多媒体链接就收），视频/文件跟着"带图一律不拦"沾了光。
         *
         * `true` = 该类附件无视分数直接唤醒；`false`/缺省 = 走正常评分。
         *   · `image` 默认 true（群友发图常是给她看的；图片本来也没文字可评）
         *   · `video`/`voice`/`file` 默认 false（视频/文件没文字就没分；语音有转录文字就用文字评）
         * ⚠️ 无分数时（纯附件）：**只有该类允许放行才唤醒** —— 否则"取消勾选"等于没勾。
         */
        attachmentPassthrough?: {
            image?: boolean;
            video?: boolean;
            voice?: boolean;
            file?: boolean;
        };
        /** 模型目录(留空=默认 {DSH_HOME|~/.dsh}/models/bge-small-zh) */
        modelDir?: string;
        /** 价值评分模式(账号默认): off=不评分 / log=只记录 / block=低分不唤醒 */
        valueGate?: 'off' | 'log' | 'block';
        /** 价值评分门槛(0~1) */
        valueMinScore?: number;
        /** 单会话覆盖: key = "group:<群openid>" / "c2c:<私聊openid>" */
        /** 兜底: 小模型不可用时改用纯程序(字符 n-gram)算向量(安卓等无 ONNX 环境仍可用) */
        lexicalFallback?: boolean;
        overrides?: Record<string, {
            enabled?: boolean;
            valueGate?: 'off' | 'log' | 'block';
            valueMinScore?: number;
        }>;
    };
    /** 定时唤醒任务(M3) */
    schedule: ScheduleConfig;
    /** QQ 群管理(入群审批/禁言等; 需机器人=群管理员) */
    groupAdmin: GroupAdminConfig;
    /** 是否展示工具调用成功结果（工具错误始终展示） */
    showToolResults: boolean;
    /**
     * 交付文件直发（present → deliverables/presented，2026-10-27 加）。
     *   · maxFiles: 单轮最多投递几个文件，超出部分只提示不发（默认 4）
     * 宿主自带 present 工具时，模型声明交付物后插件在轮末自动把文件发到当前会话。
     */
    sendFile?: {
        /** 单轮最多投递几个文件（默认 4） */
        maxFiles?: number;
    };
    /** 调试模式 */
    debug: boolean;
    /**
     * 诊断日志落盘总开关（2026-10-06 加；**默认关**）。
     * 开了才写 `{DSH_HOME|~/.dsh}/<名字>.log`（单文件 2MB 自动轮转、只留 1 份旧档）；
     * 关着时所有诊断写入**零 I/O**。也可用环境变量 `DSH_QQBOT_DIAG=1` 临时打开。
     */
    diagLog: boolean;
    /** 通过 QQ 接收并处理 dsh 的一次性权限申请(远程审批; 思路来源见 features/qq-approval.ts 头注) */
    enableApprovals: boolean;
    /** 扩展工具按需取用（见 extMetaTool 说明） */
    extMetaTool: boolean;
    /** QQ 权限申请等待时长(ms), 超时自动拒绝 */
    approvalTimeoutMs: number;
    /** QQ 远程提问(ask_user_question → QQ 按钮卡片), 默认开; false=交回 Web UI */
    enableUserQuestions?: boolean;
    /**
     * 提问卡片工作方式(2026-10-07 主人定, 默认 async):
     *   'async'    = 后台提问: 卡片发出即把"占位答案"交回宿主, 她的回合**不被卡住** —— 可以继续和群友聊天/干活;
     *                对方答完后, 答案当作一条"回执消息"投递回会话(她忙 → 插进当前回合; 空闲 → 唤醒她处理);
     *   'blocking' = 旧行为: 工具挂起等对方作答(或超时)才继续 —— 期间她动不了。
     */
    questionsMode?: 'async' | 'blocking';
    /** 出站模式: adaptive=适配主动(默认) / detail=详细主动(adaptive + 工具调用/结果推送) / active=旧全主动(兼容) / passive=全被动回复 / silent=完全不出站 / nothink=完全不思考(仅设置页可配) */
    outboundMode?: 'adaptive' | 'active' | 'passive' | 'detail' | 'silent' | 'nothink';
    /** botplay 互动事件列表(运行时 live, 与 settings 同源) */
    botplayEvents: BotplayEventConfig[];
}
/**
 * 递归给 schema 所有字段标 volatile（2026-09-24，适配 dsh 0.1.7）。
 *
 * 为什么：0.1.7 的 `settings.update()` 只接受 **schema 里声明为 volatile** 的字段
 * （dsh-settings 源码：`const form = volatileForm(schema); if (!form) throw new Error('Plugin entry "x" has no volatile fields')`）。
 * 本插件原先一个都没标 → 保存必被拒，只能退化成"自己改 profile patch"，
 * 于是踩出一连串类型写坏/密钥被覆盖的坑。标上之后宿主的正道写回就能用了。
 *
 * 旧版 schemastery（<3.18.4）没有 `.volatile()` → 自动跳过，两代通吃。
 */
/**
 * ⚠️ 故意**不标 volatile** 的字段：改它们需要"重新挂载插件"（重建 bot / 重连）。
 * 不标 volatile → loader 在配置变化时走 remount（plugin 重新 apply → bootstrap 重建 bot），
 * 这正是我们想要的"改密钥自动重连"，比自己写重连逻辑可靠。
 */
/**

/** 顶层 appId/appSecret 不标 volatile：改它们走 remount（重建 bot 连接）。 */
/** 插件导出的 Config：宿主用它推导设置表单、校验并写回。 */
export declare const ConfigSchema: Schema<ImQQBotConfig>;
//# sourceMappingURL=config.d.ts.map