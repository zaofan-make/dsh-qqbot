/**
 * session-registry.ts — 按实例(ns)注册 SessionManager 的模块级注册表
 *
 * 与 qq-approval.ts 的 registerApprovalController 同款模式:
 * qqbot 本体 bootstrap 里 registerSessionManager(ns, manager), effect 清理注销;
 * settings-host.js 动态 import 本模块后, 可跨"插件模块"拿到各实例的 SessionManager
 * (同一物理文件同一 ESM 实例, 无 realm 隔离 —— 已被 approval/questions 双通道验证)。
 *
 * 用途:
 *  - 线A(悬浮球自动选中): 按 web sessionId 反查 QQ 会话(精确命中含 fork 后 randomUUID);
 *  - 线B(用户代发插入上下文): 按 ns+scope+peerId 找会话 record, append user/message(模拟用户消息)。
 */
import type { SessionManager } from '../session/index.js';
import type { ChatScope } from '../types.js';
export declare function registerSessionManager(ns: string, m: SessionManager | undefined): void;
/** 遍历所有实例, 按 web sessionId 精确反查会话记录(唯一可靠源: record.sessionId 含 fork 后的 randomUUID) */
export declare function findSessionBySessionIdWeb(sessionId: string): Array<{
    ns: string;
    sessionId: string;
    scope: ChatScope;
    peerId: string;
    senderId: string;
    agentPreset?: string;
    lastActivity: number;
}>;
/** 按 ns+scope+peerId 找会话记录(线B: 用户代发后把消息 append 进该会话) */
export declare function findRecordByPeerWeb(ns: string, scope: ChatScope, peerId: string): {
    ns: string;
    sessionId: string;
    scope: ChatScope;
    peerId: string;
    senderId: string;
    agent?: unknown;
} | undefined;
/**
 * 遍历**所有**实例(ns)，找出「有该 peer 活跃会话」的记录。
 *
 * 2026-10-04 新增（主人实测：dock 聊天页只显示到几天前的最旧消息）：
 *   findRecordByPeerWeb 需要调用方给对 ns；一旦 ns 指到别的实例（多 bot 场景常见），
 *   拿到的就是那个实例里的**过期会话记录** ⇒ 聊天记录停在很久以前。
 *   这里提供跨实例兜底，由调用方按 seq 取「最新的那个」。
 */
export declare function listPeerRecordsWeb(scope: ChatScope, peerId: string): Array<{
    ns: string;
    sessionId: string;
    scope: ChatScope;
    peerId: string;
    senderId: string;
    agent?: unknown;
    seq: number;
}>;
/** 活跃表 miss(会话被回收/未建立)时恢复/重建会话 —— 与入群申请通知/定时任务同款 getOrCreate(不开回合, 只保证 log 存在) */
export declare function getOrCreateByPeerWeb(ns: string, scope: ChatScope, peerId: string, senderId?: string): Promise<{
    ns: string;
    sessionId: string;
    scope: ChatScope;
    peerId: string;
    senderId: string;
    agent?: unknown;
} | undefined>;
/** 标记某实例在线状态(bootstrap bot ready/error/resumed 事件驱动) */
export declare function setBotOnline(ns: string, on: boolean): void;
/** 某实例是否在线(未注册/未知 = false) */
export declare function isBotOnline(ns: string): boolean;
/** 是否已注册某 ns(诊断用) */
export declare function hasManager(ns: string): boolean;
/** 按实例 ns 精确取 manager（2026-11-06：预热不能靠 findManagerByPeer，会串到别的实例） */
export declare function getManagerByNs(ns: string): SessionManager | undefined;
export declare function listManagerNs(): string[];
/** 全部已注册 manager(通用插件: 跨实例枚举/寻址用, 同一 ESM 实例无 realm 隔离) */
export declare function managersOf(): SessionManager[];
/** 按 scope+peer 找目标实例的 manager(先活跃表; 再按群注册表/c2c台账归属匹配; 最后回退任意一个已注册) */
export declare function findManagerByPeer(scope: ChatScope, peerId: string): SessionManager | undefined;
/** 按 sessionId 找目标实例的 manager(活跃表精确命中) */
export declare function findManagerBySessionId(sessionId: string): SessionManager | undefined;
//# sourceMappingURL=session-registry.d.ts.map