import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.js';
/**
 * 把一个会话从「归档」里拉回可见(幂等; 不在归档集合里就是 no-op)。
 * 走宿主同一条持久化链 → 侧边栏热刷新, 不需要重启宿主。
 * @returns true = 本次真的摘掉了(之前处于归档)
 */
export declare function unarchiveSession(ctx: Context, sessionId: string, logger: Logger): Promise<boolean>;
/** 供诊断: 归档/反归档统计 */
export declare function workspaceAttachState(): {
    unarchived: number;
    lastUnarchivedId: string;
    lastUnarchivedAt: number;
    archived: number;
    lastArchivedId: string;
    lastArchivedAt: number;
    lastError: string;
};
/**
 * 开新档后，把**被取代的旧会话**收进宿主的「已归档」集合。
 *
 * ★ 2026-11-15（群友提的补丁，本机验过方案）：现在 `/new`、`/bot-new`、换模型 fork 完，
 *   旧档还留在侧边栏，得自己一个个点归档。
 *
 * 安全性（与反归档同款）：
 *   · **幂等**：已在归档集合里直接返回 false；
 *   · **fail-soft**：整个 try/catch 包住，失败只 warn，绝不挡住开新档；调用处全是 `void`；
 *   · **不抢反向逻辑**：`unarchiveSession`（旧档被 QQ 消息再次触发时拉回可见）完全不动，两条腿并存；
 *   · **串行写**：走 `registry.enqueueOperation`，不会和宿主 UI 的归档写冲突。
 *
 * @returns true = 本次真的加进去了
 */
export declare function archiveSessionDurably(ctx: Context, sessionId: string, logger: Logger): Promise<boolean>;
/**
 * 会话可用性总入口: 挂到工作区 + 保证不在归档里(两者都幂等 + fail-soft)。
 * SessionManager.getOrCreate **创建/恢复**会话后调用, fire-and-forget 不阻塞主链。
 */
export declare function attachSessionToWorkspace(ctx: Context, cwd: string | undefined, sessionId: string, logger: Logger, 
/**
 * ★ 2026-11-15（CodeRabbit）：**有效性检查**。
 *
 * 背景：这个函数末尾会无条件 `unarchiveSession`（"顺带把误归档的会话拉回可见"）。
 * 而 `attachSessionToWorkspaceWithRetry` 会重试到 5 秒 —— 如果这期间用户 /new 换了新档、
 * 我们刚把旧档归档，旧档的重试链跑完时会把它**又拉回可见**（取消掉刚做的归档）。
 * 传了这个回调，就能在反归档前问一句"这个 sessionId 还是当前档吗"，不是就跳过。
 */
opts?: {
    isStale?: () => boolean;
}): Promise<boolean>;
export declare function attachSessionToWorkspaceWithRetry(ctx: Context, cwd: string | undefined, sessionId: string, logger: Logger, opts?: {
    isStale?: () => boolean;
}): void;
//# sourceMappingURL=workspace-attach.d.ts.map