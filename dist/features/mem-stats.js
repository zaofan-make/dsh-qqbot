/**
 * mem-stats.ts —— 内存自检快照（2026-11-13 主人要求）
 *
 * 背景：宿主 OOM 崩过一次（`Ineffective mark-compacts near heap limit`，堆涨到 3.4GB），
 * 但崩之前没有任何"谁在涨"的证据。这里提供一个**跨模块可读**的快照函数：
 *
 *   globalThis[Symbol.for('im-qqbot.memstats')]()  →  {
 *     rss / heapUsed / heapTotal / external（process.memoryUsage）
 *     sessions：活跃会话数
 *     imagePathCache：图片路径缓存条数
 *     stickerItems：图库索引条数
 *     pendingEffort / memoPending：本插件的小型待办表长度
 *   }
 *
 * 为什么挂 globalThis：扩展命令（`.qqbot-extensions/commands/*.mjs`）跑在**同一个进程**，
 * 但它是独立 ESM 模块、拿不到插件内部变量 —— 符号键是两边唯一都认的通道（同 ext-inbound 手法）。
 *
 * 成本：全部是 O(1) 读数，**不做遍历、不做序列化大对象**，可以随便调。
 */
const MEM_STATS_KEY = Symbol.for('im-qqbot.memstats');
/** 由 bootstrap 在启动时注册一个采集器（内部持有 manager 等） */
export function registerMemStats(collector) {
    try {
        globalThis[MEM_STATS_KEY] = () => {
            try {
                const s = collector();
                return { ...s, at: Date.now() };
            }
            catch (e) {
                return { error: e instanceof Error ? e.message : String(e), at: Date.now() };
            }
        };
    }
    catch { /* 注册失败不影响主流程 */ }
}
/** 进程级兜底快照（没注册采集器时也能给出内存数字） */
export function readProcessMemory() {
    try {
        const m = process.memoryUsage();
        return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external };
    }
    catch {
        return { rss: 0, heapUsed: 0, heapTotal: 0, external: 0 };
    }
}
//# sourceMappingURL=mem-stats.js.map