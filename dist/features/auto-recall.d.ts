export interface AutoRecallCfg {
    enabled?: boolean;
    mode?: string;
    keywords?: string[];
    kinds?: string[];
    muteSeconds?: number;
    dryRun?: boolean;
}
/**
 * 解析自动撤回配置：**磁盘（面板值）优先 → 闭包兜底**。
 *
 * 注意：磁盘读失败（文件不存在 / JSON 坏）时退回闭包值，这是**故意**的 ——
 * 读不到盘不该让自动撤回整体失效。这与"实例归属解析必须 fail-closed"是两回事：
 * 这里兜的是同一实例内的两份配置副本，不是另一个实例的状态。
 */
export declare function resolveAutoRecall(cfg: unknown): AutoRecallCfg | undefined;
/** 测试用：清缓存 */
export declare function __resetAutoRecallCache(): void;
//# sourceMappingURL=auto-recall.d.ts.map