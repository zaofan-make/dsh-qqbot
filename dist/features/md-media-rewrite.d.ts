import { type MdMediaTarget } from './md-media.js';
/** 上一次重写的结果（供扩展/工具做回执；跨模块走 globalThis） */
export interface MediaRewriteResult {
    matched: number;
    converted: number;
    failed: number;
    hint?: string;
    at: number;
}
export declare function lastMediaRewrite(): MediaRewriteResult | undefined;
export declare function setMaterialTargetFactory(fn: (() => MdMediaTarget | undefined) | undefined): void;
/**
 * 兜底降级（2026-10-30）：把「本地图 markdown」改写成 `[MEDIA:image|本地路径]`。
 *   素材上传不可用 / 单张上传失败时用 —— 让图走普通发图通道(file_type=1)真发出去，
 *   而不是把 `![说明](D:\...\x.jpg)` 这段语法原样当文本发给群友。
 */
export declare function localMarkdownImagesToMediaMarkers(text: string): string;
/**
 * 扫描文本里的 markdown 图片；本地路径的替换成 QQ 引用。
 * @param explicitTarget 调用方自己的句柄（优先）；不传则用全局 factory
 */
export declare function rewriteLocalMarkdownImages(text: string, explicitTarget?: MdMediaTarget): Promise<string>;
//# sourceMappingURL=md-media-rewrite.d.ts.map