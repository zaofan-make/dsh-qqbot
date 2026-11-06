/** 插件侧用到的最小 session 抽象（避免绑定宿主类型） */
interface TrimSessionLike {
    surface?: {
        nodes?: number[];
        replaceGeneration?: number;
    };
    eventAt?: (seq: number) => unknown;
    append?: (type: string, data: unknown, opts?: unknown) => unknown;
    deriveEventMessage?: (event: unknown) => unknown;
}
interface TrimAgentLike {
    session?: TrimSessionLike;
    whenIdle?: () => Promise<void>;
}
interface TrimLogger {
    info?: (msg: string) => void;
    debug?: (msg: string) => void;
}
/** 宿主上下文（可选）：拿得到 tokenMeter 就用它的估价，拿不到退回字符估算 */
interface TrimContextLike {
    tokenMeter?: {
        estimateMessage?: (m: unknown) => number;
    };
    logger?: TrimLogger;
}
/**
 * 把「最近 keepRecent 条消息」之前的历史整段替换成一句固定文本（四事件协议）。
 *
 * @param agent      目标 agent（取 agent.session）
 * @param keepRecent 保留最近多少条消息（面板里的"带 @ 前 N 条"；<=0 表示全清只留替身）
 * @param logger     可选日志
 * @param ctx        可选宿主上下文（用于拿 tokenMeter 估价）
 * @returns 本次是否真的替换了
 */
export declare function trimHistoryForContextless(agent: TrimAgentLike | undefined, keepRecent: number, logger?: TrimLogger, ctx?: TrimContextLike, 
/** 当前打开的轮次号（来自 agent/pre-step 的 payload.turn）。
 *  ⚠️ 绝不能传 undefined/null：我们在 pre-step 里执行，回合是开着的，
 *  而 compaction/start、compaction/end 的 turn 必须与"开着的那个 turn"一致，
 *  否则会话日志会以 SessionFormatError 写坏（实测把两个群的会话都写崩了）。 */
turn?: number, 
/**
 * **分段压缩**用（2026-11-06）：显式指定从 surface 的第几个节点开始压。
 * 不给 = 老行为（从 node1 起、保留全局最后 keep 条）。
 * 给了 = 只压 [startIdx, ...) 这一段，**更早的前缀一个字都不动**（缓存不受影响）。
 *
 * `protectSeqs`：这些 seq 永不进替换区间（@ 我 / 扩展 forceWake 的入站消息）。
 */
opts?: {
    startIdxOverride?: number;
    protectSeqs?: Set<number>;
    /**
     * **精确区段**（按 surface 节点下标，闭区间）：给定时跳过"保留最近 N 条"的推算，
     * 直接压这一段。用于"价值分够高的消息要留着，所以一次要压好几段"的场景。
     */
    forceRange?: {
        startIdx: number;
        endIdx: number;
    };
    /** 允许同一 turn 内多次压缩（多段替换时用） */
    allowRepeat?: boolean;
}): Promise<boolean>;
/**
 * 回合空闲后执行清理（插件硬约束：回合中 append 会坏记录 —— inject.ts 的既有约定）。
 * fire-and-forget，不阻塞调用方。
 */
export declare function scheduleContextlessTrim(agent: TrimAgentLike | undefined, keepRecent: number, logger?: TrimLogger, ctx?: TrimContextLike): void;
export {};
//# sourceMappingURL=contextless-trim.d.ts.map