/**
 * 出站处理器 — dsh session/event → QQ 消息发送
 *
 * 采用路由器模式：OutboundRouter 持有会话级状态（文本缓冲、工具调用记录），
 * 事件解析归一化在 events.ts，路由按事件类型分发到私有方法。
 */
import type { SessionManager } from '../session/index.js';
import type { ImQQBotConfig } from '../config.js';
import type { ChatScope, Logger } from '../types.js';
import { type QQBotSender } from './outbound-buffer.js';
import { type ToolsRegistryLike } from './tool-presenter.js';
/**
 * 判定「这次 `reply_gate` 是不是真的把回合静默了」。
 *
 * 为什么要静音：闸门一关就是 `agent.cancel`，模型后面"顺手记一笔"之类的调用会被连带中止，
 * 刷出一串 `❌ 工具 ... 执行失败 / Error: tool call aborted`。那些 abort **不是故障、
 * 是有意行为**（关闸就是要停），不该当报错展示给用户看。
 *
 * @param scope 会话类型。**私聊必须传 'c2c'** —— 闸门在私聊恒放行（工具侧返回
 *   `stopped:false` 且**不会** `agent.cancel`），即"静默"根本没发生。
 *   这里要是照样返回 true，调用方会把 sessionKey 记进 `gateSilenced`，
 *   后续所有工具结果 / 回合结束通知全被静音，而模型其实正在开口
 *   （CodeRabbit 2026-11-28 · Major）。
 */
export declare function isGateSilence(rawArgs: string, scope?: ChatScope): boolean;
import { type RawSessionEvent, type StreamDelta } from './events.js';
/**
 * 正文被 QQ 判「内容违规」时，把这件事**立刻注入上下文**告诉 AI。
 *
 * 背景（主人实测 2026-11-07）：违规只进日志，AI 毫不知情，于是它会以为"已经说出去了"，
 * 继续基于那句话往下聊 —— 观感非常怪。
 * 注入用 `agent.inject`（不唤醒、下个 step 就能看到）；没有 inject 才退回 followup。
 */
export declare function buildViolationNotice(): string;
export type { QQBotSender } from './outbound-buffer.js';
export type { ToolsRegistryLike } from './tool-presenter.js';
/** 出站处理器签名（注册到 ctx.on('session/event')） */
export type OutboundHandler = (session: SessionLike, event: RawSessionEvent) => void;
/** dsh Session 简化类型 */
export interface SessionLike {
    header: {
        id: string;
    };
}
/** 剔除正文里"已被 present 直发"的那部分 [MEDIA:file|…] 标记 */
export declare function stripDeliveredFileMarkers(text: string, delivered: Set<string> | undefined, cwd: string | undefined): string;
/**
 * 创建出站事件处理器
 *
 * 返回一个 handler 函数，应注册到 ctx.on('session/event', handler)。
 * toolsRegistry 用于工具结果的结构化展示（参考 dsh-TUI 的 presentResult）。
 */
/**
 * 返回一个 handler 函数，应注册到 ctx.on('session/event', handler)。
 * toolsRegistry 用于工具结果的结构化展示（参考 dsh-TUI 的 presentResult）。
 *
 * 额外带 `routeStreamFrame`：把宿主瞬态流式帧（agent/assistant-stream）喂给同一套出站缓冲。
 */
export declare function createOutboundHandler(manager: SessionManager, bot: QQBotSender, config: ImQQBotConfig, logger: Logger, toolsRegistry?: ToolsRegistryLike): OutboundHandler & {
    routeStreamFrame(agentId: string, delta: StreamDelta): void;
};
//# sourceMappingURL=outbound.d.ts.map