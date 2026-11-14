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
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

const NL = String.fromCharCode(10);

/** 文件路径 → 常开的写入流 */
const streams = new Map<string, WriteStream>();

/**
 * 已确认存在的目录（`mkdirSync` 即使目录已存在也要一次系统调用，实测约 50~100µs）。
 * 每条群消息都会走到建目录这一步，缓存一下就是纯赚。
 */
const ensuredDirs = new Set<string>();

/** 确保目录存在（带进程内缓存，重复调用近乎免费） */
export function ensureDir(dir: string): void {
  if (!dir || ensuredDirs.has(dir)) return;
  try {
    mkdirSync(dir, { recursive: true });
    ensuredDirs.add(dir);
  } catch {
    /* 建不出来就让后续写入自己失败 */
  }
}

/** 追加一行（自动补换行、自动建目录）。出错只丢这一条，不抛。 */
export function appendLine(file: string, line: string): void {
  const text = String(line ?? '');
  if (!file || !text) return;
  let s = streams.get(file);
  if (!s) {
    try {
      ensureDir(dirname(file));
      s = createWriteStream(file, { flags: 'a' });
      // 流坏了就从表里摘掉，下次重新开（不然会一直往死流里写）
      s.on('error', () => {
        streams.delete(file);
      });
      streams.set(file, s);
    } catch {
      return;
    }
  }
  try {
    s.write(text.endsWith(NL) ? text : text + NL);
  } catch {
    streams.delete(file);
  }
}

/**
 * 关掉某个文件的写入流。
 * **重写 / 重命名 / 删除这个文件之前必须调**，否则数据会写进已经被替换的旧文件。
 */
export function closeFile(file: string): void {
  const s = streams.get(file);
  if (!s) return;
  streams.delete(file);
  try {
    s.end();
  } catch { /* 关不掉也没别的办法 */ }
}

/** 全部冲刷关闭（进程退出前用；best effort，不强求 fsync） */
export function flushAll(): void {
  for (const [k, s] of [...streams.entries()]) {
    streams.delete(k);
    try {
      s.end();
    } catch { /* ignore */ }
  }
}

// 正常退出时尽量把缓冲交出去。注意：'exit' 里不能做异步等待，
// 但 `write()` 的数据此时已经在 Node 的写队列里，`end()` 会触发一次同步刷。
process.on('exit', flushAll);
