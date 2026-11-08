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
            if (now - record.lastActivity > this.timeoutMs) {
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