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
import type { QQBotSender, StreamSessionLike } from './outbound-buffer.js';

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

export class StreamingWriter {
  private fullText = '';
  private session: StreamSessionLike | null = null;
  private sentChunkCount = 0;
  private failed = false;
  private finished = false;
  private aborted = false;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  public constructor(private readonly deps: StreamingWriterDeps) {}

  /** 是否应降级为静态发送：从未成功发送过任何分片 */
  public get shouldFallback(): boolean {
    return this.sentChunkCount === 0;
  }

  /** 累积全文（降级静态发送时使用） */
  public get text(): string {
    return this.fullText;
  }

  /** 追加增量文本，节流（throttle）后 update 全量 */
  public append(delta: string): void {
    if (this.finished) return;
    this.fullText += delta;

    // throttle：仅在无 pending timer 时启动，固定间隔 flush。
    // 不用 debounce（否则 chunk 持续到达时永远憋着，流式退化成一次性全量发送）
    if (this.throttleTimer === null) {
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null;
        this.enqueue();
      }, this.deps.throttleMs);
    }
  }

  /** 结束：flush 最终文本 + complete 收尾 */
  public async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;

    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    // 立即把最终累积文本入队（覆盖节流未触发的场景）
    this.enqueue();
    await this.chain;

    // 只要 session 存在就 complete（关闭流式消息，无论是否降级）
    if (this.session) {
      try {
        await this.session.complete();
      } catch (err) {
        this.deps.logger.error(
          `im-qqbot: stream complete failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** 中止（异常/取消）：关闭已打开的流式会话，避免悬挂 */
  public abort(): void {
    if (this.finished) return;
    this.finished = true;
    this.aborted = true;

    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    // 串行 complete（排在 pending update 之后），关闭已打开的流式会话
    this.chain = this.chain.then(async () => {
      if (this.session) {
        try {
          await this.session.complete();
        } catch (err) {
          this.deps.logger.error(
            `im-qqbot: stream abort complete failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });
  }

  /** 入队一次 update（串行，保证顺序） */
  private enqueue(): void {
    this.chain = this.chain.then(() => this.pushUpdate());
  }

  /** 推送当前累积文本（首次 openStream + update 全量） */
  private async pushUpdate(): Promise<void> {
    if (this.aborted || this.failed || !this.fullText) return;

    if (!this.session) {
      try {
        // 开流前现算目标（适配主动会把"过期的 msg_id"去掉，转成主动消息）
        const tgt = this.deps.resolveTarget ? this.deps.resolveTarget() : this.deps.target;
        this.session = this.deps.bot.openStream(tgt);
        this.deps.logger.debug(`im-qqbot: stream opened (chars=${this.fullText.length})`);
      } catch (err) {
        // openStream 失败：标记 failed 避免重复尝试，后续走降级静态
        this.failed = true;
        this.deps.logger.warn(
          `im-qqbot: openStream failed, fallback to static: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }

    try {
      await this.session.update(this.fullText);
      this.sentChunkCount++;
    } catch (err) {
      // ★★ 2026-11-14 修（审查发现）：**最后一次 update 失败会让句尾永久丢失** ——
      //   update 抛错只 warn 不重试，而 shouldFallback 只看 sentChunkCount === 0，
      //   前面成功过一次就不再降级 ⇒ 后半句谁也收不到。
      //   这里先重试一次（网络抖动/频控大多是一次性的），仍失败则大声告警。
      this.deps.logger.warn(
        `im-qqbot: stream update failed (retrying once): ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        await new Promise((r) => setTimeout(r, 200));
        // ★ 2026-11-14（CodeRabbit）：等待期间可能已被 abort —— 不重查就会在
        //   abort 之后把全文再 update 一次，把 abort 排队的 complete() 覆盖掉。
        if (this.aborted) return;
        await this.session.update(this.fullText);
        this.sentChunkCount++;
      } catch (err2) {
        this.deps.logger.warn(
          `im-qqbot: stream update FAILED after retry —— 本次流式末尾可能缺内容: ${err2 instanceof Error ? err2.message : String(err2)}`,
        );
      }
    }
  }
}
