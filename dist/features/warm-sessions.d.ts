import type { Logger } from '../types.js';
/** 一个待预热的会话 */
export interface WarmTarget {
    scope: 'group' | 'c2c';
    peerId: string;
    sessionKey: string;
}
/**
 * 从 sessionKey 里解析 scope/peerId。
 *
 * key 的形态不统一：可能是 `group:<gid>`、`c2c:<openid>`，
 * 也可能是 `qqbot:<appId>:group:<gid>`（issue #39 的实测形态）。
 * 统一按**最后一个** `group:` / `c2c:` 定位。
 */
export declare function parseSessionKey(key: string): {
    scope: 'group' | 'c2c';
    peerId: string;
} | undefined;
/** 读 model-prefs.json，列出已知的 QQ 会话（解析不出 scope 的跳过） */
export declare function listKnownTargets(dataRoot: string): WarmTarget[];
/**
 * 预热：给每个已知会话建出 record 并注册扩展工具。
 *
 * @param deps.getOrCreate  `manager.getOrCreate` 的封装（只建 record，不开回合）
 * @param deps.register     `(agentCtx, tag) => void`，通常是 `applyExtToolVisibility`
 * @param deps.tag          本实例的扩展 tag（空 = 不注册，直接跳过）
 */
export declare function warmSessions(opts: {
    dataRoot: string;
    tag: string;
    maxSessions: number;
    logger?: Logger;
    getOrCreate: (scope: 'group' | 'c2c', peerId: string) => Promise<{
        agentCtx?: unknown;
    } | undefined>;
    register: (agentCtx: unknown, tag: string) => void;
}): Promise<{
    total: number;
    warmed: number;
    failed: number;
}>;
//# sourceMappingURL=warm-sessions.d.ts.map