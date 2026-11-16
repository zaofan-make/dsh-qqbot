import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.js';
import type { Logger } from '../types.js';
export declare function attributionLedger(logger: Logger): (ctx: MiddlewareContext, next: () => Promise<void>) => Promise<void>;
/**
 * 写消息历史台账 —— **必须挂在 early-inbound 扩展之后**（2026-11-15 CodeRabbit 第四轮）。
 *
 * 为什么和归属查询拆开：两者对"这条消息还在不在链路里"的要求不同 ——
 *   · 归属查询要**早**（要在 media-history 拼历史行之前回填 state.quote），
 *     而且被消灭的消息也该查（消灭与否不影响"被引的是谁"）；
 *   · 写历史要**晚**：用户扩展可以通过 `annihilate` 把一条消息整条吃掉，
 *     那种消息**一个字都不该进历史**。annihilate 的语义就是"不调 next、链停在这里"，
 *     所以只要把本中间件挂在那之后，被消灭的消息自然走不到。
 */
export declare function historyRecorder(config: ImQQBotConfig, logger: Logger): (ctx: MiddlewareContext, next: () => Promise<void>) => Promise<void>;
//# sourceMappingURL=attribution.d.ts.map