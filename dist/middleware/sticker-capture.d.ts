/**
 * sticker-capture.ts — 表情包自动收藏中间件（P0）
 *
 * 群消息里的图片 → 收藏进本地表情包库（下载/去重/落盘在 sticker-store），
 * 并把「URL → 本地路径」记进 image-path-cache，供入站消息**直接写本地路径**
 * （2026-09-13 主人要求：看图不用再下载一次，token 也更短；下载失败自动回退 QQ 链接）。
 *
 * ⚠️ 时机关键：收藏调度必须放在 `await next()` 之前——
 * 未@机器人的群消息会在下游被 mentionGate 截断(链不走到结尾)，
 * 若收藏放在 next() 之后(finally)就永远不触发(线上已踩坑)。
 *
 * ⚠️ 2026-09-13 主人定稿：**只等"下载已发起"就放行**(即主链 0 等待)——
 *   下载 fire-and-forget 跑，落盘后把「URL→本地路径」补进 image-path-cache；
 *   消息组装时**检索得到就给本地路径，检索不到就回退 QQ 链接**(不影响正确性)。
 *   自动打标(视觉 CLI)同样永远后台，绝不挡主链。
 *
 * ⚠️ 2026-11-26 主人要求：**一条消息里的图不再只收前 3 张**。
 *   原实现两个硬限制叠加，导致 10 张图只落 3 张：
 *     ① `.slice(0, MAX_PER_MSG)` = 3 —— 后面 7 张压根没发起下载
 *     ② `if (inflight >= MAX_INFLIGHT) return undefined` —— 并发满了**直接丢弃**
 *   现在改为**排队**（不丢弃），后台 worker 按并发上限消化。
 *   时间窗口是现成的：debounce 静默期(默认 3s) + 群冷却等待，都是白捡的时间；
 *   消息组装在 handleInbound 里才查 `lookupImagePath`，所以**不需要事后改消息** ——
 *   组装那一刻下完几张就用几张，没下完的自然回退 QQ 链接。
 *
 * ⚠️ 本地手改功能（fork 新增）：维护清单见工作区根《插件改动维护注意事项.md》。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.js';
import type { Logger } from '../types.js';
export declare function stickerCapture(config: ImQQBotConfig, logger: Logger): (ctx: MiddlewareContext, next: () => Promise<void>) => Promise<void>;
//# sourceMappingURL=sticker-capture.d.ts.map