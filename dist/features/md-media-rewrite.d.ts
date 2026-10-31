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
 * 兜底降级（2026-10-31，主人实测截图）：把**任意** markdown 图片语法从要当纯文本发的内容里拿掉。
 *
 * 为什么要它：`localMarkdownImagesToMediaMarkers` 只认**本地路径**，而上传成功的图已经被改写成
 * `qqbot-media://image/v1/...` 远程引用 —— 那种引用**只有 markdown 消息（msg_type=2）能渲染**，
 * 一旦 markdown 通道失败、回落到普通文本，就会把整段
 * `![说明 #350 #1500px](qqbot-media://image/v1/xxx)` 原样发到群里（群友看到一堆语法）。
 *
 * 处理策略（尽量不丢信息）：
 *  - 本地路径的图 → 仍交给 `[MEDIA:image|路径]`（走普通发图通道真发出去）；
 *  - 已经是 `qqbot-media://` / http(s) 的 → 纯文本发不出去，就把整段语法换成 `[图片]`（保留 alt 作说明）。
 */
export declare function stripMarkdownImagesForPlainText(text: string): string;
/**
 * 扫描文本里的 markdown 图片；本地路径的替换成 QQ 引用。
 * @param explicitTarget 调用方自己的句柄（优先）；不传则用全局 factory
 */
export declare function rewriteLocalMarkdownImages(text: string, explicitTarget?: MdMediaTarget): Promise<string>;
//# sourceMappingURL=md-media-rewrite.d.ts.map