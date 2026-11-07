/** 插件侧用到的最小 session 抽象 */
interface OffloadSessionLike {
    surface?: {
        nodes?: number[];
    };
    eventAt?: (seq: number) => unknown;
    append?: (type: string, data: unknown, opts?: unknown) => unknown;
}
interface OffloadAgentLike {
    session?: OffloadSessionLike;
}
interface OffloadLogger {
    info?: (m: string) => void;
    debug?: (m: string) => void;
    warn?: (m: string) => void;
}
/**
 * 把历史里的图片块全部换成文字占位。
 *
 * @param agent 目标会话的 agent
 * @param logger 日志
 * @param turn 当前打开的轮次号（compaction 事件必须与它一致，否则会写坏会话日志）
 * @returns 处理掉的图片块数量（0 = 没事可做）
 */
export declare function offloadHistoryImages(agent: OffloadAgentLike | undefined, logger?: OffloadLogger, turn?: number): Promise<number>;
export {};
//# sourceMappingURL=image-offload.d.ts.map