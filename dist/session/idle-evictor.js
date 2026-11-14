export class IdleEvictor {
    sessions;
    timeoutMs;
    onEvict;
    timer = null;
    constructor(sessions, timeoutMs, onEvict) {
        this.sessions = sessions;
        this.timeoutMs = timeoutMs;
        this.onEvict = onEvict;
        if (timeoutMs > 0) {
            this.timer = setInterval(() => this.check(), 60_000);
            // Background cleanup must not keep short-lived commands (e.g. --help) alive.
            this.timer.unref?.();
        }
    }
    /** 执行一轮回收检查 */
    check() {
        const now = Date.now();
        for (const [key, record] of this.sessions) {
            // ★★ 2026-11-14 修（审查发现）：还在跑回合的会话不能回收。
            //   原来只看 lastActivity（仅入站刷新）—— 长任务（生图/长命令）跑到第 30 分钟
            //   会被 onEvict 里 agent.cancel 掐掉，用户看到'任务半路没了'。
            // ★ 2026-11-14（CodeRabbit 指出我修了一半）：**跳过必须是有界的**。
            //   只写 continue 的话，一个永远卡住的回合（turnActive 一直 true）会让会话**永不回收**，
            //   定时器/上下文全泄漏。给一个硬上限：超过 timeoutMs 的 4 倍仍算卡死，照常回收。
            const turnActive = record.turnActive === true;
            const idleFor = now - record.lastActivity;
            if (turnActive && idleFor <= this.timeoutMs * 4)
                continue;
            if (idleFor > this.timeoutMs) {
                this.onEvict(key, record);
            }
        }
    }
    /** 停止回收定时器 */
    dispose() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
//# sourceMappingURL=idle-evictor.js.map