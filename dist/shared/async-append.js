/**
 * async-append.ts —— 把「每条消息都同步写盘」换成**常开 WriteStream**（2026-11-14）
 *
 * ── 为什么 ──────────────────────────────────────────────────────────────────
 * 本机实测（Windows 11 + 实时防护开启，Node 24）：
 *   · `appendFileSync`      **1465 µs / 次**
 *   · `WriteStream.write`   **   4 µs / 次**   ← 差 366 倍
 *   · `statSync`             56 µs / 次
 *
 * 而入站链路上一条普普通通的群消息至少有 3 处同步追加：
 *   消息历史（msg-history）、会话台账（chat-ledger ×2）、评分日志（value-score）。
 *   ⇒ **每条消息白等约 4.4ms**，群消息一密集就排队卡顿。
 *
 * ── 怎么用 ──────────────────────────────────────────────────────────────────
 *   `appendLine(file, line)` —— 语义等价于 `appendFileSync(file, line + '\n')`，
 *     但只把数据交给内核缓冲就返回（µs 级）。目录不存在会自动建。
 *   ⚠️ **重写/删除该文件之前必须先 `closeFile(file)`** ——
 *     否则旧 fd 还指向被替换掉的 inode，后续写入会落到"已消失的旧文件"里。
 *
 * ── 取舍 ────────────────────────────────────────────────────────────────────
 * 崩溃时最多丢最后几条还没落盘的行。这些都是**历史/日志类**数据，
 * 丢几条无所谓；用 4.4ms×每条消息 换这个，不值。
 */
import { createWriteStream, fsyncSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const NL = String.fromCharCode(10);
/** 文件路径 → 常开的写入流（Map 迭代顺序＝打开顺序，最旧的在前） */
const streams = new Map();
/**
 * 同时打开的写入流上限（CodeRabbit 审查指出）。
 * 流的键是**文件路径**，而历史台账是"群 × 天"一个文件 ——
 * 群一多、跑得久 fd 会一直涨。超限时把最旧的关掉，下次写它再重新开。
 */
const MAX_STREAMS = 64;
/**
 * 已确认存在的目录（`mkdirSync` 即使目录已存在也要一次系统调用，实测约 50~100µs）。
 * 每条群消息都会走到建目录这一步，缓存一下就是纯赚。
 *
 * ⚠️ **缓存必须能被失效**：`msg-history.pruneOld` 会删掉过期群的目录，
 *   如果这里还记着"已建"，后续 `ensureDir` 直接跳过 → 目录永远不会被重建 →
 *   **那个群从此写不进历史**（直到重启）。所以有 `forgetDirTree`。
 */
const ensuredDirs = new Set();
/** 确保目录存在（带进程内缓存，重复调用近乎免费） */
export function ensureDir(dir) {
    if (!dir || ensuredDirs.has(dir))
        return;
    try {
        mkdirSync(dir, { recursive: true });
        ensuredDirs.add(dir);
    }
    catch {
        /* 建不出来就让后续写入自己失败 */
    }
}
/**
 * ★ 目录被**删除**之后必须调这个（2026-11-15，CodeRabbit 抓到）。
 * 不清缓存的话，`ensureDir` 会一直以为目录还在、直接跳过 mkdir →
 * 之后每次 append 都写进不存在的路径、失败、而且**静默重复下去**。
 */
export function forgetDirTree(dir) {
    if (!dir)
        return;
    ensuredDirs.delete(dir);
    for (const key of [...streams.keys()]) {
        if (key.startsWith(dir))
            closeFile(key);
    }
}
/**
 * 空闲多久后自动关闭文件流（毫秒）。
 *
 * ★ 2026-11-15（主人实测反馈）：常开 WriteStream 会把文件**占住**，VS Code 打不开
 *   `.qqbot/msg-history/*.jsonl` —— 而历史台账本来就是给人翻的，这样等于把它锁死了。
 *   所以改成「写完等一会儿就关」：群消息密集时整段时间内只开一次流（还是微秒级），
 *   停下来 2 秒后自动 fsync + end，文件立刻可被其它程序打开。
 */
const IDLE_CLOSE_MS = 800;
/** 文件路径 → 空闲关闭定时器 */
const idleTimers = new Map();
/** 重置某个文件的"空闲关闭"计时器 */
function touchIdle(file) {
    const old = idleTimers.get(file);
    if (old)
        clearTimeout(old);
    const t = setTimeout(() => {
        idleTimers.delete(file);
        closeFile(file);
    }, IDLE_CLOSE_MS);
    // 不要因为这个定时器把进程吊住
    t.unref?.();
    idleTimers.set(file, t);
}
/** 这个路径当前是否挂着写入流（= 有写入正在进行/已排队，目录不能删） */
export function hasActiveStream(file) {
    return streams.has(file);
}
/** 关掉某个文件的流；**关之前先把内核缓冲刷到盘**（见函数内注释） */
export function closeFile(file) {
    const it = idleTimers.get(file);
    if (it) {
        clearTimeout(it);
        idleTimers.delete(file);
    }
    const s = streams.get(file);
    if (!s)
        return;
    streams.delete(file);
    try {
        // ★ 2026-11-15（CodeRabbit 抓到）：原来只有 `s.end()`，它是异步的 ——
        //   调用方紧接着 `readFileSync` 可能读到**还没落盘**的内容，
        //   压缩/滚动时据此生成快照就会把最新几行截掉。
        //   这里先对 fd 做一次同步 fsync，保证"关之前数据已经在盘上"。
        const fd = s.fd;
        if (typeof fd === 'number' && fd >= 0)
            fsyncSync(fd);
    }
    catch { /* 刷不动也只能继续 */ }
    try {
        s.end();
    }
    catch { /* ignore */ }
}
/** 追加一行（自动补换行、自动建目录）。出错只丢这一条，不抛。 */
export function appendLine(file, line) {
    const text = String(line ?? '');
    if (!file || !text)
        return;
    let s = streams.get(file);
    if (!s) {
        // 超上限：淘汰最旧的那条流
        if (streams.size >= MAX_STREAMS) {
            const oldest = streams.keys().next().value;
            if (oldest !== undefined)
                closeFile(oldest);
        }
        try {
            ensureDir(dirname(file));
            s = createWriteStream(file, { flags: 'a' });
            // 流坏了就从表里摘掉，下次重新开（不然会一直往死流里写）
            s.on('error', () => {
                streams.delete(file);
            });
            streams.set(file, s);
        }
        catch {
            return;
        }
    }
    try {
        s.write(text.endsWith(NL) ? text : text + NL);
        touchIdle(file);
    }
    catch {
        streams.delete(file);
    }
}
/** 全部冲刷关闭（进程退出前用；best effort，不强求 fsync） */
export function flushAll() {
    for (const [k, s] of [...streams.entries()]) {
        streams.delete(k);
        try {
            s.end();
        }
        catch { /* ignore */ }
    }
}
// 正常退出时尽量把缓冲交出去。注意：'exit' 里不能做异步等待，
// 但 `write()` 的数据此时已经在 Node 的写队列里，`end()` 会触发一次同步刷。
process.on('exit', flushAll);
//# sourceMappingURL=async-append.js.map