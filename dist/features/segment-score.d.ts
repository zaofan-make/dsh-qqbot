/** 记一条：某次 append 产生的 surface 节点 seq → 这条消息的价值分（0~1） */
export declare function noteSegmentScore(session: unknown, seq: unknown, score: unknown): void;
/** 查某节点的分值（没有就 undefined） */
export declare function getSegmentScore(session: unknown, seq: unknown): number | undefined;
//# sourceMappingURL=segment-score.d.ts.map