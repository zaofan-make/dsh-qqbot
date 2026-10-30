import type { Context } from '@deepseek-ai/cordis';
import type { ChatScope, Logger, ReplyTarget } from '../types.js';
import type { ImQQBotConfig } from '../config.js';
import type { ModelRoute, ModelEntry } from '../model/types.js';
import type { DshAgent, DshAgentRegistry, SessionRecord, SessionStatus, TokenUsageStats } from './types.js';
import type { QQBotSender } from '../transport/outbound-buffer.js';
import { createGroupAdmin } from '../api/group-admin.js';
export declare class SessionManager {
    private readonly ctx;
    private readonly agents;
    private readonly config;
    private readonly logger;
    private sessions;
    private readonly evictor;
    private readonly modelResolver;
    /** QQ 通道发送能力(由 bootstrap 注入)；仅作为 qqChannel service 暴露给通道工具，不在此注册工具 */
    private channelSender;
    /** 最近一次 setup 收到的 agent ctx(工具自愈用；getOrCreate 完成后读走并清空) */
    private lastSetupCtx;
    /** 群守则热更新: 每次 system prompt 渲染现读 settings.yaml(SettingsReader fresh 模式) */
    private liveSettingsReader;
    /** 注入 QQ 通道发送能力(供通道工具)；bootstrap 调用 */
    /**
     * 取本实例的**真发送器**（bootstrap 里那个 QQBotSender：sendMedia / sendTuwenCard /
     * recallLast 全套都在）。
     *
     * 2026-10-30 加：扩展命令以前拿到的 `sender` 是中间件 ctx 上的 SDK bot（只有
     * sendText / sendMarkdown），于是命令侧 `env.image()` / `env.card()` 全部静默返回 false
     * —— 现象就是「/头像 会注入文字、但图发不出来」。这里把真 sender 暴露出去，
     * capsForCmd 优先用它。
     */
    get sender(): QQBotSender | undefined;
    installChannelSender(sender: QQBotSender): void;
    /**
     * 最近一次"建会话"失败的原始错误（2026-10-24 加，issue #18）。
     * 起因：create 抛的错只在 logger 里留一行，命令层统一回「请稍后再试」，
     * 手机上完全没法自助排查（cwd 相对路径就是这么被藏住的）。
     */
    lastCreateError: string;
    /** 本实例工作目录(多账号独立; 缺省进程 cwd) */
    get cwd(): string;
    /** 插件数据根(表情包/.qqbot/扩展统一挂其下; config.dataRoot 缺省=cwd) */
    get dataRoot(): string;
    /** 本实例图库目录(多账号: 每实例数据根独立; config.sticker.dataDir 可覆盖) */
    get stickerDataDir(): string;
    /** 本实例定时任务目录(多账号: 每实例数据根独立) */
    get scheduleDataDir(): string;
    /** 本实例群管理客户端(懒建; groupAdmin.enabled=false 时 undefined) */
    get groupAdmin(): ReturnType<typeof createGroupAdmin> | undefined;
    private _groupAdmin?;
    /**
     * 素材上传专用的轻量客户端（2026-10-30）：
     *   md-media 只借它的 apiCall 走 `/v2/media-images` 传图，与「群管理功能开不开」无关。
     *   以前直接复用 groupAdmin，而 groupAdmin.enabled=false 时那个 getter 恒返回 undefined，
     *   于是本地图 markdown 永远不改写，正文把 `![说明](D:\...\x.jpg)` 原样当文本发给群友。
     */
    get mediaApi(): ReturnType<typeof createGroupAdmin> | undefined;
    private _mediaApi?;
    /** 对话内默认管理群(web/非群会话时群工具用它; 空=未配置) */
    get manageGroup(): string;
    /** 当前出站模式(adaptive/passive/silent/nothink; 命令与 channel 工具读它显示当前值) */
    get outboundMode(): string;
    /** 实例 settingsNs(多账号实例 id; 无则默认 im-qqbot) */
    get settingsNs(): string;
    constructor(ctx: Context, agents: DshAgentRegistry, config: ImQQBotConfig, logger: Logger);
    /**
     * 动态获取 sessions 服务（fork 能力，可选）
     */
    private getSessionsService;
    getEffectiveModel(scope: ChatScope, peerId: string): ModelRoute | undefined;
    /**
     * 切换模型（fork + 重建，对齐 dsh-TUI 的 switchModel）
     * ⚠️ 2026-09-11 主人定: 模型偏好改为绑定会话(sessionId)——override 存到 fork 后的
     *    新会话 id, 使新会话/新档不再继承 peer 级旧偏好(修复"新建会话默认火山")。
     */
    setModelOverride(scope: ChatScope, peerId: string, route: ModelRoute): Promise<void>;
    /**
     * 开新会话(2026-09-08 修 /bot-new 假实现; 同日加 preset 切换):
     * 当前会话 fork 成 childId(旧会话存档为 parent, 磁盘记录仍在可回看),
     * 用同模型建新 agent 替换活跃记录。inherit=true 继承旧对话上下文(切模型用);
     * false = 全新空档(不继承旧上下文, 旧会话存档可回看)。
     * presetId 给定时: 记录该会话的 preset 覆盖并用于新档(如 /new code 切人格);
     * 不传则沿用当前生效 preset(config 或之前会话覆盖)。
     * 无活跃记录(会话损坏/重启后没聊过)时不再失败: 轮换 sessionId 直接另起新档。
     * @returns 'forked'=从当前会话 fork 出新档 | 'rotated'=无活跃记录另起全新档 | 'failed'=创建失败
     */
    startNewSession(scope: ChatScope, peerId: string, inherit?: boolean, presetId?: string, fallback?: {
        replyTarget?: ReplyTarget;
        senderId?: string;
    }): Promise<'forked' | 'rotated' | 'failed'>;
    /** 当前会话生效 preset: 会话覆盖(/new 指定) > config.preset */
    private effectivePreset;
    /** 当前会话实际生效的人格(展示用): 会话记录 agentPreset(已挂载) > effectivePreset */
    getEffectivePreset(scope: ChatScope, peerId: string): string | undefined;
    /**
     * 热切换预设(2026-09-10 主人确认: 设置页就是这么热切的):
     * 直接调宿主 agentPresets.recompose(agent.ctx, id) —— 重绑 agent 的 scope 父级
     * 到目标 preset 的 standing mount, 立即生效、不丢会话历史、不 fork。
     * 这是宿主「账号和预设」设置页同款通道(实测语气即变)。
     * @returns 'ok' | 'no-session' | 'no-preset' | 'recompose-failed'
     */
    switchPreset(scope: ChatScope, peerId: string, presetId: string): Promise<string>;
    /** 列出宿主可用 agent presets(供 /presets 命令; 失败返回空) */
    listPresets(): Promise<Array<{
        id: string;
        name?: string;
        broken?: boolean;
    }>>;
    /** 校验 preset id 是否存在(供 /new <id>; 未知/损坏返回 false) */
    hasPreset(id: string): Promise<boolean>;
    private permissionPresetsService;
    /** 列出宿主权限档(如 workspace-write / danger-full-access / read-only) */
    listPermissionPresets(): Promise<Array<{
        value: string;
        name: string;
        description?: string;
    }>>;
    /** 当前会话权限档名 */
    currentPermissionPreset(scope: ChatScope, peerId: string): string;
    /** 切权限档: 校验名字 → svc.set(session, name) */
    switchPermissionPreset(scope: ChatScope, peerId: string, name: string): Promise<{
        ok: boolean;
        msg: string;
    }>;
    /** fork 当前会话 → 新 childId; inherit=true 用旧历史做 seed(切模型), false 全新空档; 失败降级 dispose */
    private forkCurrentSession;
    clearModelOverride(scope: ChatScope, peerId: string): void;
    listAvailableModels(): Promise<ModelEntry[]>;
    listProviders(): string[];
    getSessionRecord(scope: ChatScope, peerId: string): SessionRecord | undefined;
    getStatus(scope: ChatScope, peerId: string): SessionStatus;
    getTokenUsage(scope: ChatScope, peerId: string): TokenUsageStats;
    exportMarkdown(scope: ChatScope, peerId: string): string;
    private countMessages;
    private sessionKey;
    private deriveSessionId;
    private currentSessionId;
    private composePreset;
    /** 获取或恢复或创建会话（get → resume → create） */
    getOrCreate(scope: ChatScope, peerId: string, senderId: string, replyTarget: ReplyTarget, opts?: {
        forceNew?: boolean;
    }): Promise<SessionRecord>;
    /**
     * 2026-09-11: 把 QQ 侧 override 路由应用到 agent.options。
     * 仅当 QQ 侧 /bot-model 明确设过 override 时调用(QQ 设置优先, 持久生效);
     * 无 override 时**不覆盖** —— 尊重宿主/ web 设置的模型(重启后不回退)。
     */
    private applyModelRoute;
    /**
     * 通道工具自愈 + 固化(2026-09-05 升级): 每次消息都全量幂等注册 channel-tools(静态 import,
     * 进程加载的就是最新 dist) → 重启后"恢复"会话的第一条消息也会自动把 reply_gate 等正式工具
     * 全部注册上,**工具永久固化, 重启不再需要 /tools-reload**(热刷只留给进程内"新增"工具的即时生效)。
     * 已注册工具重复注册会被 channel-tools 内部静默跳过(already registered), 无副作用无噪音。
     */
    ensureChannelTools(record: SessionRecord): Promise<void>;
    /**
     * 工具热刷新(2026-09-05, 主人定 A 方案): cache-bust 动态重载最新 dist 的 channel-tools
     * 并注册到给定 agentCtx。DSH 工具表每步现收集 → 新工具**下一轮立即对 LLM 可见**, 无需重启宿主。
     * 说明: 新增工具即时生效; 与已有工具同名的注册会被 channel-tools 内部 try/catch 跳过(保留旧实现),
     *       想更新已有工具逻辑仍需正式重启(或临时换新工具名)。
     */
    /**
     * qqChannel 上下文自愈(2026-09-05): 重启后"恢复"的会话不跑 setup → agent.ctx 上没有
     * qqChannel → 通道工具路由不到本实例(channelOf 失败 → 图库/定时落到别的实例或 C 盘幽灵库)。
     * 每次消息补一次 provide(幂等: 已是本实例就跳过)。用 record.agent.ctx(恒有)。
     */
    ensureChannelContext(record: SessionRecord): Promise<void>;
    hotReloadChannelTools(agentCtx: Context): Promise<void>;
    /** 对所有活会话的 agentCtx 执行一次工具热刷新。返回给人看的摘要文本。 */
    reloadAllChannelTools(): Promise<string>;
    /** 数据根（pre-step 与 inbox/claimed 共用一份算法 —— 差一级就会一处写、一处读）。 */
    private resolveDataRootSmart;
    /**
     * ★ 2026-10-28：把「按会话注册 4 个工具」提前到**回合开始**。
     *
     * 主人实测：关掉无上下文模式后，回合**第一个 step** 模型仍拿到旧工具表 → 调 context_memo 报
     * `unknown tool`，之后才出现「工具已更新·移除 3 个」。根因是宿主的 step 顺序（dsh-agent-loop
     * lib/index.js 的 preStep）：
     *   ① inbox.claim()             ← emit 'agent/inbox/claimed'（**同步**派发，payload 自带 agent）
     *   ② systemPrompt.assemble()   ← 工具表在这里**快照**
     *   ③ dispatch.waterfall('agent/pre-step') ← 我们原来在这里注册 ⇒ 晚了一步
     * ⇒ 在 claimed 时同步一次注册表，本 step 的请求就能用上新表；
     *   pre-step 里那次照旧保留（turn 内中途改开关 / 会话 key 反查失败时的兜底）。
     * ⚠️ 只做同步动作（emit 不 await 监听器）；任何异常静默，绝不能影响入站主链。
     */
    private syncScopedToolsOnClaim;
    /** cwd 分流(通用, 不写死实例名): 只对本实例配置的 cwd 匹配的 agent 注入本实例群守则。
     *  每个实例在 patch 里配自己的 cwd + settingsNs, 即自动分流;
     *  其他实例/项目(web、别的 cwd)的 agent 一律不注入, 避免群守则污染非本 bot 会话。 */
    private nsForCwd;
    /** 群守则热更新: 现读 settings.yaml 对应 ns 的 groupPrompt; 读失败仅回退本实例 ns 的内存 config。 */
    private readLiveGroupPromptForNs;
    /**
     * 群守则/固定规则 pre-step 直注(幂等): 每次消息入站调用, 全局只装一次注入器。
     *
     * 2026-09-11 考古定稿(参考 deepseek-harness/packages/context/agent-instructions):
     *  - dsh 0.1.5 的 persona 是 complete section → assemble 只保留 persona,
     *    运行时注册的 section 全被丢弃(system/message 只有人设, 实证);
     *  - context() 快照链路(assemble → RuntimeContextProjection.project)实际不记录;
     *  - 官方 agent-instructions 用 ctx.on('agent/pre-step') 把带来源 user/message
     *    折入 decision.messages(紧随 claimed batch 之后) → 直接进模型请求, 绕开 assemble。
     *
     * 本实现:
     *  - 宿主根 ctx 监听 agent/pre-step; cwd 分流(只对本实例 config.cwd 匹配的 agent 注入本实例群守则);
     *  - 每回合现读 settings.yaml(热更新); 固定通道规则 + 群守则 拼成一条 <system-reminder> user/message;
     *  - 去重靠 KV cache: 本次 messages 或会话 surface 已有同 ns+同内容 → 不重复注入;
     *    热更新内容变化 → 注入新版(历史保留旧版, 后续回合靠新版 KV cache)。
     */
    ensureGroupRules(_record: SessionRecord): Promise<void>;
    /**
     * 主人 openid 白名单（config.groupAdmin.owners）。
     * 用于 QQ 审批卡片"谁可以点"的名单：发起者 + 这些主人。
     * @returns 非空字符串数组（配置缺失/异常时返回空数组）
     */
    adminOwners(): string[];
    findBySessionId(sessionId: string): SessionRecord | undefined;
    /** 查宿主全局 agent registry(进程内存活 agent, 含 web/hub 等非 QQ 会话): 跨会话唤醒兜底 */
    findHostAgent(sessionId: string): {
        agent: DshAgent;
    } | undefined;
    /**
     * 宿主持久化恢复会话(重启后唤起): 进程内无活 agent 时, 用宿主 registry.resume 把
     * 持久化会话拉回内存(与 getOrCreate 的 resume 路径同源)。web/hub 会话也能这样唤起。
     * @returns agent 或 undefined(会话不存在/恢复失败)
     */
    resumeHostAgent(sessionId: string): Promise<{
        agent: DshAgent;
    } | undefined>;
    /** 列出本 bot 全部活跃会话(通用插件能力: 供 session_list/跨会话唤醒等按 id 寻址) */
    listSessions(): Array<Pick<SessionRecord, 'sessionId' | 'scope' | 'peerId' | 'senderId' | 'lastActivity' | 'agentPreset'>>;
    /** 按 scope+peerId 解析 sessionId(与 getOrCreate 完全一致: 存在则用记录值, 否则确定性派生) */
    sessionIdFor(scope: ChatScope, peerId: string): string;
    findByAgent(agent: DshAgent): SessionRecord | undefined;
    /** 按会话键找活跃会话(group/c2c); 无则 undefined(会话被回收/未建立) */
    findByPeer(scope: ChatScope, peerId: string): SessionRecord | undefined;
    /**
     * 定时/主动注入: 向某会话塞一条新消息(像收到新消息, AI 带上下文处理并回复到 QQ)。
     * 会话当前不在(被回收/未建立)→ 返回 false, 由调用方决定(计数/跳过)。
     */
    injectToPeer(scope: ChatScope, peerId: string, text: string, sourceKind?: string): Promise<boolean>;
    remove(scope: ChatScope, peerId: string): Promise<void>;
    disposeAll(): Promise<void>;
    get size(): number;
}
//# sourceMappingURL=session-manager.d.ts.map