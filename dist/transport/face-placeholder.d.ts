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
/**
 * 清掉文件缓存（**仅供测试**）。
 *
 * 生产环境不需要：mtime + 5 秒 TTL 已经能保证用户改完表很快生效。
 * 测试里要逐个用例验证"改了文件应该读到新值"，TTL 会挡住，所以留个后门。
 */
export declare function _clearFaceCache(): void;
//# sourceMappingURL=face-placeholder.d.ts.map