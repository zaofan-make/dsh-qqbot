/** 插件侧用到的最小 session 抽象 */
interface SurfaceSessionLike {
    surface?: {
        nodes?: number[];
    };
    eventAt?: (seq: number) => unknown;
    append?: (type: string, data: unknown, opts?: unknown) => unknown;
}
interface SurfaceAgentLike {
    session?: SurfaceSessionLike;
}
interface SurfaceLogger {
    info?: (m: string) => void;
    debug?: (m: string) => void;
    warn?: (m: string) => void;
}
export interface ReplaceImagePathsOptions {
    /** 单次最多替换几条消息（防御：避免一次追加太多事件）。默认 8 */
    maxMessages?: number;
    /**
     * 扫描范围：
     *   'tail'（默认）= 只扫最后一条 assistant/message 之后（本回合新来的那几条）
     *   'all'        = 连历史一起扫（一般用不上）
     */
    scope?: 'tail' | 'all';
}
/**
 * 用 surfaceOp replace 把 session 尾部消息里的 QQ 图片 URL 替换成本地路径。
 *
 * @param agent 目标会话的 agent
 * @param logger 日志
 * @param turn 当前轮次号（仅用于日志；surfaceOp 本身不需要）
 * @param opts 范围控制
 * @returns 实际替换掉的 URL 个数
 */
export declare function replaceImagePathsInSurface(agent: SurfaceAgentLike | undefined, logger?: SurfaceLogger, turn?: number, opts?: ReplaceImagePathsOptions): Promise<number>;
export {};
//# sourceMappingURL=image-path-surface.d.ts.map