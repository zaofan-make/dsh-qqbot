export type MediaKind = 'image' | 'video' | 'voice' | 'file';
/** 把带路径的尖括号媒体标记规范化成方括号形式；其余文本原样返回。 */
export declare function normalizeMediaMarkers(text: string): string;
/** 是否含撤回指令 */
export declare function containsRecall(text: string): boolean;
/** 收集文本里出现的所有撤回指令序号(按出现顺序)。[RECALL]→1。无则返回空数组。 */
export declare function collectRecallIndices(text: string): number[];
export type Segment = {
    type: 'text';
    text: string;
} | {
    type: 'media';
    kind: MediaKind;
    source: string;
};
/** 是否含富媒体指令 */
export declare function containsMedia(text: string): boolean;
/**
 * 把一段 agent 文本拆成 Segment[]：文本段与富媒体段交替。
 * 富媒体标记被剔除；[RECALL] 不在此拆分（由调用方单独处理，避免污染文本段）。
 */
export declare function parseOutbound(text: string): Segment[];
/**
 * 把标记文本清理成"仅剩要展示的纯文本"（去掉富媒体/撤回/引用指令），供降级/预览。
 */
export declare function stripDirectives(text: string): string;
/**
 * 提取引用消息标记：[rf:短消息号]（2026-09-13 主人定）。
 * 命中返回 { index, rest }；rest 为剔除该标记后的剩余文本。无标记返回 undefined。
 * 同一段文本只取第一个标记（一条消息只能引用一条）。
 */
export declare function extractRefTag(text: string): {
    index: string;
    rest: string;
} | undefined;
/**
 * 把 agent 给出的 source 解析为可直接喂给底层 sendImage/sendFile 的来源。
 * 规则：
 *   http(s)://  → 原样(URL)
 *   file://     → 本地绝对路径
 *   Windows 盘符/绝对路径 → 原样
 *   其余(相对) → 相对 cwd 解析为绝对路径
 * 返回 { kind: 'url', url } | { kind: 'localPath', path }，便于底层分发。
 */
export declare function resolveSource(source: string, cwd: string | undefined): {
    kind: 'url';
    url: string;
} | {
    kind: 'localPath';
    path: string;
};
//# sourceMappingURL=rich-media.d.ts.map