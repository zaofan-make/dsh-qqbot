/**
 * StreamingWriter — QQ 流式文本写入器
 *
 * 边界条件设计：
 *   - 节流（throttle）：固定间隔 flush，避免每 token 发 HTTP，同时保证长文本分多次推送
 *   - 串行队列（chain）：保证 update 顺序，finish 前最后一次文本必达
 *   - 降级（sentChunkCount === 0）：只有从未成功发送分片才降级静态，
 *     避免"已流式部分 + 静态全量"的重复内容
 *   - 终态幂等（finished）：finish/abort 后忽略 append，重复 finish 不重复 complete
 *   - 中止关闭（abort）：abort 时若 session 已打开，串行 complete 关闭，避免悬挂
 */
import type { Logger, ReplyTarget } from '../types.js';
import type { QQBotSender } from './outbound-buffer.js';
export interface StreamingWriterDeps {
    bot: QQBotSender;
    target: ReplyTarget;
    /**
     * ★ 2026-11-06 主人实测抓到的 bug：流式通道**直接用固定的 target**（里面带着入站 msg_id），
     *   绕过了上层"适配主动"的判定 —— 于是重启 dsh 后过很久再说话时，
     *   仍拿几小时前的 msg_id 去被动回复 ⇒ QQ 直接丢弃 ⇒ **正文没到群，工具消息却到了**。
     *   给了这个解析器就每次开流前现算（走 resolveTarget，会把过期 msg_id 去掉转主动）。
     */
    resolveTarget?: () => ReplyTarget;
    logger: Logger;
    /** 节流间隔（ms）：连续 append 累积后，停顿该间隔才 update */
    throttleMs: number;
}
export declare class StreamingWriter {
    private readonly deps;
    private fullText;
    private session;
    private sentChunkCount;
    private failed;
    private finished;
    private aborted;
    private throttleTimer;
    private chain;
    constructor(deps: StreamingWriterDeps);
    /** 是否应降级为静态发送：从未成功发送过任何分片 */
    get shouldFallback(): boolean;
    /** 累积全文（降级静态发送时使用） */
    get text(): string;
    /** 追加增量文本，节流（throttle）后 update 全量 */
    append(delta: string): void;
    /** 结束：flush 最终文本 + complete 收尾 */
    finish(): Promise<void>;
    /** 中止（异常/取消）：关闭已打开的流式会话，避免悬挂 */
    abort(): void;
    /** 入队一次 update（串行，保证顺序） */
    private enqueue;
    /** 推送当前累积文本（首次 openStream + update 全量） */
    private pushUpdate;
}
//# sourceMappingURL=streaming-writer.d.ts.map