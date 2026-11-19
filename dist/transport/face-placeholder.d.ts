/**
 * 把正文里的 `【表情: 名字】` 换成真表情字符。
 *
 * - 表里有这个名字 → 换成真表情
 * - 表里没有 / 没装扩展 → **原样保留**（交给后面的 strip 决定要不要删）
 *
 * @param dataRoot 数据根（拼 `.qqbot-extensions/qq-faces.json`）
 */
export declare function replaceFacePlaceholders(text: string, dataRoot: string | undefined): string;
/** 表情表里有几个名字（给设置页/诊断用） */
export declare function faceMapSize(dataRoot: string | undefined): number;
//# sourceMappingURL=face-placeholder.d.ts.map