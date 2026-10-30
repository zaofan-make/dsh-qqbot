import type { Context } from '@deepseek-ai/cordis';
import type { SessionManager } from './session/session-manager.js';
import type { QQBotSender } from './transport/outbound-buffer.js';
/** qqChannel service 形状：由 dsh-qqbot 在 QQ 会话 ctx 上 provide */
export interface QQChannel {
    manager: SessionManager;
    sender: QQBotSender;
}
export declare const name = "qqbot-channel-tools";
export declare const inject: string[];
/** 某实例的标识：优先**人设 id**（config.preset），没配才回落工作区目录名 */
export declare function instanceTagOfManager(m: unknown): string;
export declare function setContextlessSmartGlobal(v: boolean): void;
/** 读登记（session-manager 的 pre-step 用） */
export declare function readContextPending(dataRoot: string, sessionKey: string): {
    mode?: string;
    keep?: number;
} | undefined;
export declare function clearContextPending(dataRoot: string, sessionKey: string): void;
export declare function setChannelBridge(b: QQChannel | undefined): void;
/** 装载本插件时把 qqChannel 一并注入(由 dsh-qqbot setup 提供) */
export declare function apply(ctx: Context): Promise<void>;
/**
 * host 面板用(2026-09-13 主人要的「让ai写」按钮):
 * **照抄定时任务的做法** —— 伪造一条消息直接调 handleInbound 唤醒该群/私聊的 AI 回合
 * (见 features/scheduler.ts fireTask: 与 SDK 消息同形, messageId 空 → 出站自动走主动推送;
 *  senderName 用中性名、不打假 (@you), 防污染主人交互记忆)。
 *
 * 为什么不复用高层轮子: wakeSessionAgent 要先配"群组管理器会话"; injectSynthetic 是塞聚合窗口(要等人停口);
 *  而面板按钮要的是**立刻触发** —— 与"定时任务到点必须触发回合"同理, 直调 handleInbound 最贴合。
 *
 * host 半边(settings-host.js) 通过 import('@zaofan/dsh-qqbot/channel-tools') 调用(manager 只在插件侧)。
 */
export declare function askAiToWriteSamples(ns: string, scope: 'group' | 'c2c', peerId: string): Promise<{
    ok: boolean;
    msg: string;
}>;
/**
 * 「伪造一条用户消息 → 直调 handleInbound 唤醒该会话 AI」的共用实现(2026-10-05 抽出来)。
 *
 * 原实现只服务"让ai写样例库"; botplay 自定义事件也要同一条路(面板「🤖 让 AI 写」),
 * 于是把可复用的骨架抽到这里, 只有 senderName/正文不同 —— 两处行为完全一致, 少一套要维护的语义。
 *
 * 细节(继承自 2026-09-13 的样例库版本, 不要改):
 *   · messageId 留空 → 出站自动走**主动推送**(不受 5 条被动回复限制);
 *   · senderName 用中性名、正文不打假 (@you) → 防污染主人交互记忆;
 *   · 与定时任务 fireTask 同姿势(伪造消息唤醒回合), 而不是塞聚合窗口(那个要等人停口)。
 */
export declare function askAiToWriteFakeMsg(ns: string, scope: 'group' | 'c2c', peerId: string, senderName: string, prompt: string): Promise<{
    ok: boolean;
    msg: string;
}>;
/**
 * 面板用: 某实例的自定义事件模块状态(路径/是否存在/mtime/hooks/加载错误)。
 * 未注册实例返回 [] (面板显示"未就绪", 不报错)。
 */
export declare function botplayExtStatus(ns: string): {
    file: string;
    path: string;
    exists: boolean;
    mtime: number;
    loadedMtime: number;
    name: string;
    error: string;
    hooks: string[];
}[];
/** 面板「🔄 重载模块」用: 热重载指定模块(空=全部); 不重启宿主 */
export declare function reloadBotplayExt(ns: string, file?: string): {
    ok: boolean;
    msg: string;
};
export declare function setBotplayWritePrompt(text: string): void;
/**
 * 「让 AI 写」自定义事件: 把拼好的提示词当作**用户消息**唤醒该群/私聊的 AI 回合。
 *
 * 提示词由 host 现拼(需求原文 + 官方文档链接 + 自定义事件契约 + 环境信息 + 要求), 这里只负责"送进去"。
 * 参考资料给的是**官方文档链接**(不随包塞本地镜像) —— 理由见 settings-host.js 的 apiV2DocLinks 注释。
 */
export declare function askAiToWriteBotplayEvent(ns: string, scope: 'group' | 'c2c', peerId: string): Promise<{
    ok: boolean;
    msg: string;
}>;
export declare function setCtxSmartText(t: string): void;
export declare function getCtxSmartText(): string;
/**
 * 按会话开关**动态**注册/注销三个上下文工具（context_memo / context_compact / context_drop）。
 * 由 session-manager 在每个回合的 pre-step 里调用（拿 rec.agentCtx）。
 * 这样面板一改开关，**下一回合就生效**，不需要重启，也没有"apply 时读全局变量"的时序竞态。
 */
export declare function syncContextTools(agentCtx: unknown, shouldHave: boolean, env?: {
    dataRoot?: string;
    sessionKey?: string;
}, reminderText?: string): void;
/** 按当前会话的「已领取集合」重设一次剪枝（幂等：deny 名单没变就不动） */
export declare function applyExtToolVisibility(agentCtx: unknown, selfTag?: string): void;
export declare function ensureExtToolsGlobal(globalCtx: unknown): void;
export declare function ensureContextToolsGlobal(globalCtx: unknown): void;
/**
 * 按会话同步「上下文压缩三件套 + QQ 群管理」的**注册状态**（幂等）。
 *
 * @param agentCtx 该 QQ 会话的 agent 作用域（`record.agentCtx` 或 `agent.ctx`）
 * @param opts.ctxTools   要不要 context_memo / context_compact / context_drop（跟「无上下文·智能判断」开关）
 * @param opts.groupAdmin 要不要 qq_group_admin（跟 groupAdmin.enabled）
 * @param opts.dataRoot   会话坐标（工具执行时反查数据根用）
 * @param opts.sessionKey 会话坐标（备忘类工具要求非空）
 *
 * 失败策略：拿不到 `tools.register` 或注册抛错时**不记状态**（写 `__retry`），下一次 pre-step 重试；
 * 绝不影响会话主流程。
 */
export declare function syncChannelScopedTools(agentCtx: unknown, opts: {
    ctxTools: boolean;
    groupAdmin: boolean;
    dataRoot?: string;
    sessionKey?: string;
}): void;
export declare function applyExtDisabledRestrict(agentCtx: unknown, dataRoot: string, extToolNames: string[]): void;
export declare function restrictContextTools(agentCtx: unknown, shouldHave: boolean, env?: {
    dataRoot?: string;
    sessionKey?: string;
}): void;
//# sourceMappingURL=channel-tools.d.ts.map