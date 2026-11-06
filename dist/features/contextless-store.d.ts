/** 单个会话的无上下文设置 */
export interface ContextlessSetting {
    /** 是否对该会话开启"每轮丢历史" */
    enabled: boolean;
    /** 保留「@ 之前」多少条群消息（0 = 一条都不带，只留系统规则） */
    window: number;
    /**
     * 「智能判断」子模式（2026-10-01 主人设计）—— **与 window 互斥**。
     *   true  = 不按固定条数：交给 AI **每轮自己判断话题**，结束就调 `context_compact` /
     *           `context_drop` 自主压缩或丢弃历史，只需留下自己写的要点（存独立文件，压缩碰不到）；
     *   false/缺省 = 老行为：每轮只带「@ 之前 window 条」。
     * ⚠️ 互斥在**读取侧**保证：smart=true 时 window 不生效（见 keepWindowOf()），UI 也做成二选一。
     */
    smart?: boolean;
    /**
     * **分段压缩**（2026-11-06 主人定）：只压「上回合结束 → 本回合开始」这一段，
     * 更早的历史一个字都不动（前缀不变 ⇒ 缓存照样命中）。
     * 与 smart 互斥；与 window 也互斥（window 是"每轮只带 N 条"，分段压缩是"只压新的那段"）。
     */
    segment?: boolean;
    /** 分段压缩保留条数：这段里最后 N 条普通消息留下，更旧的压成一个占位节点 */
    segmentKeep?: number;
    /** 备忘条数上限（面板可设；超出自动丢最旧） */
    memoMax?: number;
}
/** 绑定 dataRoot（apply 时调一次；之后所有读写都落在这里） */
export declare function initContextlessStore(dataRoot: string): void;
/** 所有已知文件路径（诊断用） */
export declare function describeStorePaths(): string;
/**
 * 落盘追踪（2026-09-27 加，专治"静默失败"）：
 * 这个功能前后踩了 9 个坑，其中 8 个都不报错 —— 全靠反复试探。
 * 现在把「被调用 / 跳过原因 / 结果 / 异常」统统追加到 {dataRoot}/.qqbot/contextless-trace.log，
 * 一出问题先看这个文件，别再猜。
 */
export declare function traceContextless(line: string): void;
/** 诊断：当前绑定的文件路径（trace 用） */
export declare function describeStorePath(): string;
/** 读某会话的设置（未设置 → 默认关） */
export declare function getContextless(sessionKey: string): ContextlessSetting;
/** 写某会话的设置（dock 面板调用；只对有值的字段覆盖） */
export declare function setContextless(sessionKey: string, patch: Partial<ContextlessSetting>): ContextlessSetting;
/** 全表（给 dock 面板列出来） */
export declare function listContextless(): Record<string, ContextlessSetting>;
/** 删某会话的设置 */
export declare function clearContextless(sessionKey: string): boolean;
/** 会话是否处于"无上下文模式"（全局开 **或** 该会话单独开） */
export declare function isContextlessActive(sessionKey: string, globalEnabled?: boolean): boolean;
/**
 * 该会话是否用「智能判断」子模式（2026-10-01 主人设计）。
 *
 * ⚠️ **与 window 互斥**：返回 true 时，`contextlessWindowOf` 的条数**不生效** ——
 *   由 AI 每轮自己判断话题，自主调用 context_compact / context_drop。
 *   会话级优先；没设过时用全局默认（config.contextlessSmart）。
 */
/** 该会话的备忘条数上限（未设置则 undefined，由默认值兜底） */
export declare function contextlessMemoMaxOf(sessionKey: string): number | undefined;
export declare function contextlessSmartOf(sessionKey: string, globalDefault?: boolean): boolean;
/** 该会话应携带的「@ 之前」群消息条数（会话级优先，其次全局默认 5） */
export declare function contextlessWindowOf(sessionKey: string, fallback?: number): number;
/**
 * 该会话是否开启**分段压缩**（2026-11-06）。与 smart / window 互斥 ——
 * 它不改变"每轮带多少条历史"，只把「上回合结束 → 本回合开始」这段里的旧消息压成一行占位，
 * 更早的（缓存前缀）一个字都不动。
 */
export declare function contextlessSegmentOf(sessionKey: string): boolean;
/** 分段压缩保留的条数（默认 3） */
export declare function contextlessSegmentKeepOf(sessionKey: string, fallback?: number): number;
//# sourceMappingURL=contextless-store.d.ts.map