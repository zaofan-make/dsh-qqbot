/**
 * 会话管理层类型定义
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChatScope, ReplyTarget } from '../types.js';
/** AgentSetup hook 类型 */
export type AgentSetup = (agentCtx: Context) => Promise<void> | void;
/** dsh SessionEvent 简化类型（用于统计 token 用量 / 导出） */
export interface SessionEventLike {
    type: string;
    seq?: number;
    usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
    };
    message?: {
        content?: Array<{
            type: string;
            text?: string;
        }>;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
/** dsh Agent 简化接口 */
export interface DshAgent {
    readonly id: string;
    readonly ctx: Context;
    /** 底层 session（fork 时作为 source，events 用于统计/导出） */
    readonly session: {
        readonly id: string;
        readonly events?: readonly SessionEventLike[];
    };
    cancel(cause: {
        kind: string;
    }): void;
    followup(message: unknown): void;
    /** 宿主实例能力(可选探测): 注入消息不唤醒 agent, 排队到下个 step 组包(事件通知用) */
    inject?(message: unknown): void;
    whenIdle(): Promise<void>;
}
export interface DshAgentHandle {
    agent: DshAgent;
    dispose(): Promise<void>;
}
/** sessions 服务（fork 能力） */
export interface SessionsService {
    fork(source: unknown, boundary?: number): {
        events: readonly unknown[];
    };
}
export interface DshAgentRegistry {
    /** 获取进程内已存活的 agent */
    get(sessionId: string): DshAgent | undefined;
    /** 从持久化存储恢复 session */
    resume(options: {
        resumeSessionId: string;
        agentOptions?: {
            provider?: string;
            model?: string;
        };
        setup?: AgentSetup;
    }): Promise<DshAgentHandle>;
    /** 创建全新 session */
    create(options: {
        sessionId: string;
        meta?: {
            cwd?: string;
            parentSession?: string;
            seedLength?: number;
            agentPreset?: string;
        };
        seed?: readonly unknown[];
        agentOptions?: {
            provider?: string;
            model?: string;
        };
        setup?: AgentSetup;
    }): Promise<DshAgentHandle>;
}
/** agent-presets 服务接口（可选，部署中可能没有） */
export interface AgentPresetsLike {
    readonly defaultId: string;
    resolve(id?: string): Promise<{
        id: string;
    }>;
    mount(agentCtx: Context, id?: string): Promise<unknown>;
}
/** preset 组合结果 */
export interface PresetComposition {
    agentPreset?: string;
    setup?: AgentSetup;
}
/** 单个会话记录 */
export interface SessionRecord {
    sessionKey: string;
    sessionId: string;
    agent: DshAgent;
    handle: DshAgentHandle;
    replyTarget: ReplyTarget;
    scope: ChatScope;
    peerId: string;
    senderId: string;
    lastActivity: number;
    agentPreset?: string;
    /** 会话内最近一次真实入站(QQ 收到消息)时间戳; 定时注入/injectToPeer 不刷新 → 「适配主动」用它判最近 */
    lastInboundAt?: number;
    /** LLM 回合进行中标记: 出站事件(assistant/tool)期间=true, turn/end 复位 → debounce 见它忙就把新消息全攒着 */
    turnActive?: boolean;
    /**
     * 本回合已插话几次（2026-10-09 加，用于**逐次缩短**插话提示省 token）：
     * 0/undefined = 还没插过 → 用完整提示；≥1 → 用更短的提示（语义已在上下文里）。
     * 回合结束（turn/end）时由 outbound 清零。
     */
    interjectSeq?: number;
    /** setup 收到的 agent ctx(工具自愈用；setup 竞态失败时可能缺) */
    agentCtx?: unknown;
    /** 通道工具是否已确认装载(自愈幂等标记) */
    channelToolsReady?: boolean;
    /**
     * 本回合的**输入来源**（2026-11-05 加，配合设置项 `webTurnSilent`）。
     *
     * - `'qq'`：这一回合由 QQ 入站触发（含定时任务/面板任务那种伪造入站）→ 正常发 QQ
     * - `undefined`：没有 QQ 入站 → 视为 **web/外部界面发起的回合**
     *
     * 用途：勾了「web 回合静默」后，`undefined` 的回合**正文块不发 QQ**（见 outbound.send）。
     * 回合结束（turn/end）时清空。
     */
    turnOrigin?: 'qq' | 'external';
    /**
     * 本回合是否**因插话而解除静默**（2026-11-05 主人定：插话后**全部放行**，不是只放一块）。
     * `interjectBatch` 注入成功时置 true，turn/end 清零。
     */
    interjectLifted?: boolean;
}
/** 会话状态信息（/status 用） */
export interface SessionStatus {
    active: boolean;
    sessionId?: string;
    provider?: string;
    model?: string;
    preset?: string;
    lastActivity?: number;
    messageCount?: number;
}
/** token 用量统计（/cost 用） */
export interface TokenUsageStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}
//# sourceMappingURL=types.d.ts.map