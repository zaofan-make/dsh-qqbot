/**
 * markers.ts — 入站消息里的「块标记」**单一真源**（2026-09-15 主人要求省 token 后独立出来）
 *
 * 背景：原来这些标记是英文长句（`[Quoted message begins]` 之类），每轮都要原样喂给模型。
 *   实测（ARK 同文本只改标记）：一套标记 198 字符 → 109 字符，**每条省 ~14 token**。
 *   换成中文短标记后字符数再降，且**中文语义自解释**（引=引用 / 当前 / 历史），
 *   不需要额外花 token 在 system prompt 里教它。
 *
 * ⚠️ 两个都不能忘：
 *   ① 「改的时候代码里还有谁在用」——生产端(inbound)、解析端(trimQuoteBlock)、
 *      富文本清洗(cleanTextForScore)、以及 **dock 聊天视图**(settings-host.js 的
 *      chatSplitHistoryBlock / client 的渲染) 都认这些字面量。
 *   ② 「老会话里已经写进去的旧标记」——历史消息是**渲染时**解析的，
 *      所以 MK_LEGACY 那套必须长期保留（解析端认新旧两种），生产端只用新的。
 */
/** 现在生产用的短标记 */
export declare const MK: {
    readonly QUOTE_BEGIN: "[引]";
    readonly QUOTE_END: "[/引]";
    readonly CURRENT: "[当前]";
    readonly HISTORY_BEGIN: "[历史]";
    readonly HISTORY_END: "[/历史]";
};
/** 2026-09-15 之前的英文长标记（**只读**：老会话/被引用原文里可能还有） */
export declare const MK_LEGACY: {
    readonly QUOTE_BEGIN: "[Quoted message begins]";
    readonly QUOTE_END: "[Quoted message ends]";
    readonly CURRENT: "[Current message]";
    readonly HISTORY_BEGIN: "[Chat history begins]";
    readonly HISTORY_END: "[Chat history ends]";
};
export declare const QUOTE_BEGIN_ALL: readonly string[];
export declare const QUOTE_END_ALL: readonly string[];
export declare const CURRENT_ALL: readonly string[];
export declare const HISTORY_BEGIN_ALL: readonly string[];
export declare const HISTORY_END_ALL: readonly string[];
/** 全部标记（清洗/判断用） */
export declare const ALL_MARKERS: readonly string[];
export declare function clampForMarkerScan(text: string): string;
export declare function hasAnyMarker(text: string, needles?: readonly string[]): boolean;
/** 找**第一个**出现的标记（认新旧），没有则返回 undefined */
export declare function findFirstMarker(text: string, needles: readonly string[]): {
    idx: number;
    len: number;
} | undefined;
/** 找**最后一个**出现的标记（认新旧）—— 引用的"结束标记"必须取最后一个，否则会被原文里的假标记截断 */
export declare function findLastMarker(text: string, needles: readonly string[]): {
    idx: number;
    len: number;
} | undefined;
/**
 * 引用原文里的块标记转义（2026-09-13 主人实测抓到的坑：AI 在代码块里示范过这些字面量，
 * 被引用后会混进引用块，让"第一个 begin + 第一个 end"的匹配切错位置）。
 * 方括号退化成圆括号：语义照旧看得懂，但不再参与结构匹配。
 */
export declare function escapeBlockMarkers(text: string): string;
/** 把块标记整段抹掉（打分文本/展示用；认新旧、大小写不敏感） */
export declare function stripBlockMarkers(text: string, replacement?: string): string;
//# sourceMappingURL=markers.d.ts.map