/**
 * IdleEvictor — 闲置会话回收器
 *
 * 定期检查会话最后活跃时间，超时则自动回收释放资源。
 */
import type { SessionRecord } from './types.js';

export class IdleEvictor {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sessions: Map<string, SessionRecord>,
    private readonly timeoutMs: number,
    private readonly onEvict: (key: string, record: SessionRecord) => void,
  ) {
    if (timeoutMs > 0) {
      this.timer = setInterval(() => this.check(), 60_000);
      // Background cleanup must not keep short-lived commands (e.g. --help) alive.
      this.timer.unref?.();
    }
  }

  /** 执行一轮回收检查 */
  check(): void {
    const now = Date.now();
    for (const [key, record] of this.sessions) {
      // ★★ 2026-11-14 修（审查发现）：还在跑回合的会话不能回收。
      //   原来只看 lastActivity（仅入站刷新）—— 长任务（生图/长命令）跑到第 30 分钟
      //   会被 onEvict 里 agent.cancel 掐掉，用户看到'任务半路没了'。
      if ((record as { turnActive?: boolean }).turnActive === true) continue;
      if (now - record.lastActivity > this.timeoutMs) {
        this.onEvict(key, record);
      }
    }
  }

  /** 停止回收定时器 */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
