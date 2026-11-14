/**
 * ext-inbound 的回归（2026-10-12，入站中间件扩展点 —— 第五套扩展）。
 *
 * 锁七件事（前三条是"绝不能因用户脚本坏了就吞掉入站消息"派生出来的硬要求）：
 *  ① 目录不存在 / 为空 → **完全安静**，一条日志都不打；子目录与非 .js/.mjs/.cjs 不扫描；
 *  ② 四种导出写法都认（裸函数 / 具名 middleware 函数式&箭头式 / 对象默认导出）；
 *  ③ **单个扩展抛错 → 只告警，并继续往下走**（finalNext 照样被调）；缺中间件/import 就炸 → 只跳过它；
 *  ④ `next()` 幂等（误调两次只算第一次）、忘了 await 也由引擎兜住；
 *  ⑤ 扩展能读**写** `ctx.state`；**不调 next() = 整条拦掉**（finalNext 与后续扩展都不跑）；
 *  ⑥ 多扩展**按文件名顺序**串行；
 *  ⑦ dispose：逐个调用、逆序、单个抛错不阻断，并摘掉热重载入口。
 *
 * 末段用**真 SDK 中间件**（`mentionGate` + `runMiddlewareChain`）串起真链，验证示例扩展
 * `examples/ext-inbound/no-wake-on-child-quote.mjs` 的实际行为：
 *   群聊+引用子会话转发+原本 wasMentioned=true ⇒ false；引用普通消息 ⇒ 不动；
 *   真 @bot ⇒ 仍 true；非群聊（私聊）⇒ 不动。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MemoryHistoryStore,
  mentionGate,
  runMiddlewareChain,
  type Middleware,
  type MiddlewareContext,
} from '@tencent-connect/qqbot-nodejs';
import type { Logger } from '../types.js';
import {
  __resetInboundExtensionsForTest,
  disposeInboundExtensions,
  inboundExtensionsCount,
  inboundExtensionsDir,
  loadInboundExtensions,
  runEarlyInboundExtensions,
  runInboundExtensions,
  type ExtRunOptions,
  type InboundExtension,
} from './ext-inbound.js';
import { makeExtCaps } from './ext-capabilities.js';
import {
  BURST_MAX,
  __resetBreakersForTest,
  breakerStatus,
  checkDestructiveAllowed,
  extStatePath,
  noteDestructive,
  readAudit,
} from './ext-inbound-state.js';
import { mediaHistoryBuffer } from '../middleware/media-history.js';
import { hasExtInboundReloader, registerExtInboundReloader } from './ext-reload.js';

/** ★ 2026-11-14：注册/注销/卸载现在都要求带 dataRoot（按实例分桶），测试统一用这个 */
const TEST_DATA_ROOT = join(tmpdir(), 'dsh-qqbot-ext-inbound-test');

/** 记录所有日志行（用于断言"安静"与"可读"） */
function makeLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (lvl: string) => (msg: string) => { lines.push(`${lvl} ${msg}`); };
  return { logger: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }, lines };
}

/** 造一个满足 MiddlewareContext 形状的最小 ctx（不真起 SDK / 不真连 QQ） */
function makeCtx(
  message: Record<string, unknown>,
  state: Record<string, unknown> = {},
): MiddlewareContext {
  const ac = new AbortController();
  let stopped = false;
  let stopReason: string | undefined;
  return {
    bot: { appId: 'APPID' } as unknown,
    message,
    replyTarget: {},
    state,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    stop(reason?: string) { stopped = true; stopReason = reason; },
    get stopped() { return stopped; },
    get stopReason() { return stopReason; },
    signal: ac.signal,
    abort(reason?: string) { stopped = true; stopReason = reason ?? 'aborted'; ac.abort(); },
    get aborted() { return ac.signal.aborted; },
    receivedAt: Date.now(),
  } as unknown as MiddlewareContext;
}

/** 把"一个中间件函数"包成装载后的形状（引擎只读 middleware 字段） */
function asExt(file: string, middleware: Middleware, dispose?: () => unknown): InboundExtension {
  return { file, path: `/tmp/${file}`, name: file.replace(/\.mjs$/, ''), middleware, ...(dispose ? { dispose } : {}) };
}

let root = '';
let dataRoot = '';

function inboundDir(): string {
  return inboundExtensionsDir(dataRoot);
}

/** 写一个入站扩展文件（内容原样给） */
function writeExt(file: string, body: string): void {
  mkdirSync(inboundDir(), { recursive: true });
  writeFileSync(join(inboundDir(), file), body, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-ext-inbound-'));
  dataRoot = join(root, 'data');
  __resetInboundExtensionsForTest();
  // ⚠️ 熔断状态是**模块级**的（按文件名记），测试之间必须清 —— 否则前一个用例把 'a.mjs' 熔断了，
  //    后一个用例会莫名其妙"消灭不生效"。
  __resetBreakersForTest();
});

afterEach(async () => {
  __resetInboundExtensionsForTest();
  __resetBreakersForTest();
  registerExtInboundReloader(TEST_DATA_ROOT, undefined);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows 偶发占用，忽略 */ }
});

describe('入站扩展：目录与安静性', () => {
  it('目录不存在 → 空结果，且一条日志都不打', async () => {
    const { logger, lines } = makeLogger();
    const r = await loadInboundExtensions({ dataRoot, logger });
    expect(r.total).toBe(0);
    expect(r.middleware).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('目录存在但为空 → 同样完全安静', async () => {
    mkdirSync(inboundDir(), { recursive: true });
    const { logger, lines } = makeLogger();
    const r = await loadInboundExtensions({ dataRoot, logger });
    expect(r.total).toBe(0);
    expect(lines).toEqual([]);
  });

  it('非 .js/.mjs/.cjs 文件不参与扫描', async () => {
    mkdirSync(inboundDir(), { recursive: true });
    writeFileSync(join(inboundDir(), 'readme.md'), '# 这不是扩展', 'utf8');
    writeFileSync(join(inboundDir(), 'notes.txt'), 'x', 'utf8');
    const { logger, lines } = makeLogger();
    const r = await loadInboundExtensions({ dataRoot, logger });
    expect(r.total).toBe(0);
    expect(lines).toEqual([]);
  });

  it('子目录不扫描（与 tools/hooks 的既有约定一致）', async () => {
    writeExt('top.mjs', 'export default async (ctx, next) => next();\n');
    mkdirSync(join(inboundDir(), 'lib'), { recursive: true });
    writeFileSync(join(inboundDir(), 'lib', 'inner.mjs'), 'throw new Error("子目录不该被装载");\n', 'utf8');
    const { logger } = makeLogger();
    const r = await loadInboundExtensions({ dataRoot, logger });
    expect(r.total).toBe(1);
    expect(r.extensions.map((e) => e.file)).toEqual(['top.mjs']);
  });
});

describe('入站扩展：装载与归一化', () => {
  it('四种导出写法都能装载，并按文件名排序', async () => {
    writeExt('a-bare.mjs', 'export default async (ctx, next) => next();\n');
    writeExt('b-named-fn.mjs', 'export async function middleware(ctx, next) { return next(); }\n');
    writeExt('c-named-const.mjs', 'export const middleware = async (ctx, next) => next();\n');
    writeExt('d-object.mjs', "export default { name: '对象扩展', middleware: async (ctx, next) => next() };\n");
    const { logger } = makeLogger();
    const r = await loadInboundExtensions({ dataRoot, logger });

    expect(r.total).toBe(4);
    expect(r.skipped).toBe(0);
    expect(r.extensions.map((e) => e.file)).toEqual([
      'a-bare.mjs', 'b-named-fn.mjs', 'c-named-const.mjs', 'd-object.mjs',
    ]);
    // 名字：裸函数默认导出会被规范命名成 "default"，所以这里必须回落文件名
    expect(r.extensions.map((e) => e.name)).toEqual([
      'a-bare', 'b-named-fn', 'c-named-const', '对象扩展',
    ]);
    expect(inboundExtensionsCount()).toBe(4);
  });

  it('缺中间件 → 记 skipped + 告警，其余照装', async () => {
    writeExt('bad.mjs', "export default { name: 'bad', notMiddleware() {} };\n");
    writeExt('good.mjs', 'export default async (ctx, next) => next();\n');
    const { logger, lines } = makeLogger();
    const r = await loadInboundExtensions({ dataRoot, logger });
    expect(r.skipped).toBe(1);
    expect(r.total).toBe(1);
    expect(lines.some((l) => l.startsWith('warn') && l.includes('没找到中间件'))).toBe(true);
  });

  it('文件在 import 阶段就炸 → 只跳过它，不影响其它', async () => {
    writeExt('a-boom.mjs', "throw new Error('boom-import');\n");
    writeExt('b-ok.mjs', 'export default async (ctx, next) => next();\n');
    const { logger, lines } = makeLogger();
    const r = await loadInboundExtensions({ dataRoot, logger });
    expect(r.skipped).toBe(1);
    expect(r.total).toBe(1);
    expect(r.extensions[0]!.file).toBe('b-ok.mjs');
    expect(lines.some((l) => l.startsWith('warn') && l.includes('boom-import'))).toBe(true);
  });

  it('重新装载 = 热重载：生效列表整体换新（旧版文件改了内容就换新版）', async () => {
    writeExt('hot.mjs', "export default async (ctx, next) => { ctx.state.mark = 'v1'; return next(); };\n");
    const { logger } = makeLogger();
    const first = await loadInboundExtensions({ dataRoot, logger });
    expect(first.total).toBe(1);

    // mtime 秒级取整 —— 内容变了但同一秒内 URL 会相同（复用缓存），所以这里只断言"能再装载一次且不报错"
    const second = await loadInboundExtensions({ dataRoot, logger });
    expect(second.total).toBe(1);
    expect(second.extensions[0]!.name).toBe('hot');
  });
});

describe('入站扩展：引擎兜底（硬要求）', () => {
  it('空列表 → 直接放行到 finalNext', async () => {
    const { logger } = makeLogger();
    const ctx = makeCtx({ kind: 'group' });
    let final = 0;
    await runInboundExtensions([], ctx, async () => { final += 1; }, logger);
    expect(final).toBe(1);
  });

  it('能读写 ctx.state', async () => {
    const { logger } = makeLogger();
    const ctx = makeCtx({ kind: 'group' }, { mention: { wasMentioned: true } });
    const exts = [
      asExt('a.mjs', async (c, next) => {
        (c.state as Record<string, unknown>).seen = (c.state.mention as { wasMentioned: boolean }).wasMentioned;
        (c.state.mention as { wasMentioned: boolean }).wasMentioned = false;
        await next();
      }),
    ];
    let final = 0;
    await runInboundExtensions(exts, ctx, async () => { final += 1; }, logger);
    expect((ctx.state as Record<string, unknown>).seen).toBe(true);
    expect((ctx.state.mention as { wasMentioned: boolean }).wasMentioned).toBe(false);
    expect(final).toBe(1);
  });

  it('扩展抛错 → 只告警，且**照样往下走**（消息绝不被吞掉）', async () => {
    const { logger, lines } = makeLogger();
    const ctx = makeCtx({ kind: 'group' });
    const exts = [
      asExt('boom.mjs', async () => { throw new Error('boom-sync'); }),
      asExt('b.mjs', async (c, next) => { (c.state as Record<string, unknown>).b = 1; await next(); }),
    ];
    let final = 0;
    await runInboundExtensions(exts, ctx, async () => { final += 1; }, logger);
    expect(final).toBe(1);
    expect((ctx.state as Record<string, unknown>).b).toBe(1);
    expect(lines.some((l) => l.startsWith('warn') && l.includes('boom-sync'))).toBe(true);
  });

  it('异步 reject 同样只告警并继续', async () => {
    const { logger } = makeLogger();
    const ctx = makeCtx({ kind: 'group' });
    const exts = [asExt('reject.mjs', async () => { throw new Error('boom-async'); })];
    let final = 0;
    await runInboundExtensions(exts, ctx, async () => { final += 1; }, logger);
    expect(final).toBe(1);
  });

  it('不调 next() → 整条拦掉：finalNext 与后续扩展都不跑', async () => {
    const { logger } = makeLogger();
    const ctx = makeCtx({ kind: 'group' });
    const exts = [
      asExt('stop.mjs', async () => { /* 故意不调 next() */ }),
      asExt('later.mjs', async (c, next) => { (c.state as Record<string, unknown>).later = 1; await next(); }),
    ];
    let final = 0;
    await runInboundExtensions(exts, ctx, async () => { final += 1; }, logger);
    expect(final).toBe(0);
    expect((ctx.state as Record<string, unknown>).later).toBeUndefined();
  });

  it('多扩展按顺序串行（洋葱：进入顺序 = 声明顺序，退出顺序相反）', async () => {
    const { logger } = makeLogger();
    const ctx = makeCtx({ kind: 'group' });
    const trace: string[] = [];
    const exts = [
      asExt('a.mjs', async (_c, next) => { trace.push('a-in'); await next(); trace.push('a-out'); }),
      asExt('b.mjs', async (_c, next) => { trace.push('b-in'); await next(); trace.push('b-out'); }),
    ];
    await runInboundExtensions(exts, ctx, async () => { trace.push('final'); }, logger);
    expect(trace).toEqual(['a-in', 'b-in', 'final', 'b-out', 'a-out']);
  });

  it('next() 幂等：误调两次只算第一次（否则 SDK 会 "next() called multiple times"）', async () => {
    const { logger, lines } = makeLogger();
    const ctx = makeCtx({ kind: 'group' });
    const exts = [
      asExt('twice.mjs', async (_c, next) => { await next(); await next(); }),
    ];
    let final = 0;
    await runInboundExtensions(exts, ctx, async () => { final += 1; }, logger);
    expect(final).toBe(1);
    expect(lines.some((l) => l.includes('调了多次 next()'))).toBe(true);
  });

  it('扩展忘了 await next() → 引擎替它 await（下游跑完才返回）', async () => {
    const { logger } = makeLogger();
    const ctx = makeCtx({ kind: 'group' });
    const order: string[] = [];
    const exts = [
      asExt('forget.mjs', (_c, next) => { void next(); order.push('ext-returned'); }),
    ];
    await runInboundExtensions(exts, ctx, async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('final-done');
    }, logger);
    // 引擎在扩展返回后仍等到了 final 跑完 ⇒ 顺序是 ext 先返回、final 后完成且被等到
    expect(order).toEqual(['ext-returned', 'final-done']);
  });

  it('下游抛错 → 原样上抛（不伪装成"扩展坏了"被吞掉）', async () => {
    const { logger, lines } = makeLogger();
    const ctx = makeCtx({ kind: 'group' });
    const exts = [asExt('a.mjs', async (_c, next) => { await next(); })];
    await expect(
      runInboundExtensions(exts, ctx, async () => { throw new Error('downstream-boom'); }, logger),
    ).rejects.toThrow('downstream-boom');
    // 不能把它记成"扩展执行异常"
    expect(lines.some((l) => l.includes('执行异常'))).toBe(false);
  });
});

describe('入站扩展：dispose', () => {
  it('调用各扩展导出的 dispose()，逆序执行；单个抛错不阻断', async () => {
    const trace: string[] = [];
    writeExt('a.mjs', `
export default async (ctx, next) => next();
export function dispose() { globalThis.__inboundDisposeOrder.push('a'); }
`);
    writeExt('b.mjs', `
export default async (ctx, next) => next();
export function dispose() { throw new Error('cleanup-boom'); }
`);
    writeExt('c.mjs', `
export default async (ctx, next) => next();
export function dispose() { globalThis.__inboundDisposeOrder.push('c'); }
`);
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inboundDisposeOrder = trace;
    const { logger, lines } = makeLogger();
    const r = await loadInboundExtensions({ dataRoot, logger });
    expect(r.total).toBe(3);

    const n = await disposeInboundExtensions(logger, TEST_DATA_ROOT);
    expect(n).toBe(3);
    // 逆序：c → b → a（b 抛错被吞，不阻断 a）
    expect(trace).toEqual(['c', 'a']);
    expect(lines.some((l) => l.startsWith('warn') && l.includes('cleanup-boom'))).toBe(true);
    expect(inboundExtensionsCount()).toBe(0);
    delete g.__inboundDisposeOrder;
  });

  it('没有登记任何扩展时 dispose 是空操作（不炸、不误报）', async () => {
    const { logger, lines } = makeLogger();
    const n = await disposeInboundExtensions(logger, TEST_DATA_ROOT);
    expect(n).toBe(0);
    expect(lines).toEqual([]);
  });

  it('dispose 会摘掉热重载入口（否则它会指向已经死掉的实例）', async () => {
    const { logger } = makeLogger();
    registerExtInboundReloader(TEST_DATA_ROOT, async () => ({ count: 1, names: ['x'] }));
    expect(hasExtInboundReloader()).toBe(true);
    await disposeInboundExtensions(logger, TEST_DATA_ROOT);
    expect(hasExtInboundReloader()).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// 示例扩展（examples/ext-inbound/no-wake-on-child-quote.mjs）
// ══════════════════════════════════════════════════════════════

/** 直接 import 仓库里的示例文件（顺带验证"示例本身可装载、形状合法"） */
const exampleMod = (await import(
  pathToFileURL(fileURLToPath(new URL('../../examples/ext-inbound/no-wake-on-child-quote.mjs', import.meta.url))).href
)) as { default: Middleware; isChildSessionForwardQuote: (t?: string | null) => boolean };

describe('示例·纯函数 isChildSessionForwardQuote', () => {
  const hit = (s?: string | null) => exampleMod.isChildSessionForwardQuote(s);

  it('完整标记（带右括号/id）命中', () => {
    expect(hit('【子会话 abc1】看这个')).toBe(true);
    expect(hit('前面还有别的话 【子会话 deadbeef】 后面')).toBe(true);
  });

  it('被 60 字截断、没有右括号也命中', () => {
    expect(hit('【子会话 abc1')).toBe(true);
  });

  it('只剩前缀（正好截在"【子会话"处）也命中', () => {
    expect(hit('【子会话')).toBe(true);
  });

  it('全角空格分隔也命中', () => {
    expect(hit('【子会话\u3000abc1】')).toBe(true);
  });

  it('各种 id 长度变体都命中（1 位 ~ 32 位 hex）', () => {
    for (const id of ['a', 'abc', 'abc1', 'deadbeef', '0123456789abcdef', '0123456789abcdef0123456789abcdef']) {
      expect(hit(`【子会话 ${id}】`)).toBe(true);
    }
  });

  it('只有"子会话"三个字、没有【 → 不命中（不误伤正常聊天）', () => {
    expect(hit('这个子会话真有意思')).toBe(false);
    expect(hit('子会话 abc1')).toBe(false);
    expect(hit('【子】子会话')).toBe(false);          // 有【但不是"【子会话"
    expect(hit('【子会话abc1】')).toBe(false);          // 前缀后直接跟 id（无空白）→ 按约定不命中
  });

  it('空串 / null / undefined / 非字符串 → 不命中', () => {
    expect(hit('')).toBe(false);
    expect(hit(null)).toBe(false);
    expect(hit(undefined)).toBe(false);
    expect(hit(123 as unknown as string)).toBe(false);
  });
});

describe('示例·中间件组链（真 SDK mentionGate + runMiddlewareChain）', () => {
  const ext = asExt('no-wake-on-child-quote.mjs', exampleMod.default);
  const GROUP_AT = 'GROUP_AT_MESSAGE_CREATE';

  /** 跑一条「mentionGate → 入站扩展」的真链（洋葱皮最后一片由 runMiddlewareChain 收尾） */
  async function runChain(
    message: Record<string, unknown>,
    state: Record<string, unknown> = {},
  ): Promise<{ ctx: MiddlewareContext; completed: boolean }> {
    const { logger } = makeLogger();
    const ctx = makeCtx(message, state);
    const chain: Middleware[] = [
      mentionGate({ requireMentionInGroup: true }),
      (c, n) => runInboundExtensions([ext], c, n, logger),
    ];
    // 返回 false = 链被短路了（门控拦下 / 扩展没调 next），不是错误，由各用例自己断言
    const completed = await runMiddlewareChain(chain, ctx);
    return { ctx, completed };
  }

  const childQuote = { text: '【子会话 abc1】[转发] 主人：帮我看看这个', source: 'store' };
  const normalQuote = { text: '今晚吃什么', source: 'store' };

  it('群聊 + 引用子会话转发消息 + 原本 wasMentioned=true ⇒ 变成 false', async () => {
    const { ctx, completed } = await runChain(
      { kind: 'group', groupOpenid: 'g1', senderId: 'u1', content: '<@APPID> 你看', rawEventType: GROUP_AT },
      { quote: childQuote },
    );
    expect(completed).toBe(true);         // 走完了整条链（消息没被吞）
    expect((ctx.state.mention as { wasMentioned: boolean }).wasMentioned).toBe(false);
  });

  it('群聊 + 引用普通消息 ⇒ 不变（仍 true）', async () => {
    const { ctx } = await runChain(
      { kind: 'group', groupOpenid: 'g1', senderId: 'u1', content: '<@APPID> 你看', rawEventType: GROUP_AT },
      { quote: normalQuote },
    );
    expect((ctx.state.mention as { wasMentioned: boolean }).wasMentioned).toBe(true);
  });

  it('群聊 + 没有引用 ⇒ 不变', async () => {
    const { ctx } = await runChain(
      { kind: 'group', groupOpenid: 'g1', senderId: 'u1', content: '<@APPID> 你看', rawEventType: GROUP_AT },
    );
    expect((ctx.state.mention as { wasMentioned: boolean }).wasMentioned).toBe(true);
  });

  it('真 @bot（内容里的 <@APPID>，无 rawEventType）⇒ 仍 true', async () => {
    const { ctx } = await runChain(
      { kind: 'group', groupOpenid: 'g1', senderId: 'u1', content: '早上好 <@APPID>' },
    );
    expect((ctx.state.mention as { wasMentioned: boolean }).wasMentioned).toBe(true);
  });

  it('非群聊（私聊）引用子会话转发 ⇒ 不动（私聊 passthrough 标记不是"被 @"判定）', async () => {
    const { ctx } = await runChain(
      { kind: 'c2c', senderId: 'u1', content: '你看这个' },
      { quote: childQuote },
    );
    expect((ctx.state.mention as { wasMentioned: boolean }).wasMentioned).toBe(true);
  });

  it('群聊但没被 @（门控直接拦下）⇒ 走不到入站扩展', async () => {
    const { ctx, completed } = await runChain(
      { kind: 'group', groupOpenid: 'g1', senderId: 'u1', content: '随便聊聊' },
      { quote: childQuote },
    );
    // mentionGate 判定 shouldAnswer=false → stop()（链被短路），ctx.state.mention 是门控写的原始判定
    expect(completed).toBe(false);
    expect(ctx.stopped).toBe(true);
    expect((ctx.state.mention as { wasMentioned: boolean }).wasMentioned).toBe(false);
    expect((ctx.state.mention as { reason: string }).reason).toBe('no_mention');
  });

  it('中间件不吞消息：无论是否命中，都继续调 next()', async () => {
    const { logger } = makeLogger();
    for (const quote of [childQuote, normalQuote]) {
      const ctx = makeCtx(
        { kind: 'group', groupOpenid: 'g1', senderId: 'u1', content: '<@APPID> 你看', rawEventType: GROUP_AT },
        { quote },
      );
      let final = 0;
      await runInboundExtensions([ext], ctx, async () => { final += 1; }, logger);
      expect(final).toBe(1);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 2026-10-12 扩展：早/晚两个挂点 + 四个动作 + 四条保命件
//   · annihilate（消灭）· rewrite（改写）· forceWake（强制入站）· decide（@ 覆盖）
//   · 白名单（owner 永不可被消灭/静默）· 熔断 · 审计（+截断）· 禁言名单（持久化/过期/坏文件）
// ══════════════════════════════════════════════════════════════

/** 主人 openid（测试里的白名单） */
const OWNER = 'OWNER_OPENID_0001';

/** 动作 API 的形状（挂在 ctx 上的那些；测试里用窄类型读，避免依赖 SDK 的扩展声明） */
interface ExtCtx {
  annihilate(o?: { reason?: string; ownerAck?: boolean }): boolean;
  rewrite(o?: { text?: string; reason?: string }): boolean;
  forceWake(o?: { reason?: string }): boolean;
  decide(o?: { mention?: string; reason?: string }): boolean;
  muteUser(o?: { id?: string; minutes?: number; reason?: string }): { id: string; until: number } | false;
  unmuteUser(o?: { id?: string }): boolean;
  isMuted(id?: string): { id: string; until: number; permanent: boolean; remainingMs: number | null; remainingMinutes: number | null; reason?: string } | null;
  mutedUsers(): Array<{ id: string; until: number; permanent: boolean; reason?: string }>;
  kv: { get(k: string): unknown; set(k: string, v: unknown): boolean };
  text: string;
  scope: string;
  sender: string;
  isOwner: boolean;
  groupId: string;
  quoted: { text: string; id: string; fromSelf: boolean };
  platform: { mentioned: boolean };
  logger: { warn(m: string): void };
  dataRoot: string;
}
const X = (c: MiddlewareContext): ExtCtx => c as unknown as ExtCtx;

/** 运行器环境：带 dataRoot（状态/审计落临时目录）与主人白名单 */
function runOpts(extra: Partial<ExtRunOptions> = {}): ExtRunOptions {
  return { dataRoot, owners: [OWNER], appId: 'APPID', ...extra };
}

/** 造一条群消息 */
function groupMsg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'group', groupOpenid: 'g1', senderId: 'u1', senderName: '群友',
    messageId: 'm1', content: '你好', timestamp: new Date().toISOString(), ...over,
  };
}

/** 组一个扩展（早/晚都能给；晚挂点缺省 = 直通） */
function asBoth(file: string, onInbound?: Middleware, onDecide?: Middleware): InboundExtension {
  return {
    file,
    // ★ 2026-11-14：熔断 key 已改为「绝对路径」，测试里的 path 也要与**真实装载路径**一致，
    //   否则「重新装载复位熔断」这条断言会跨两种 key 而永远失败。
    path: join(dataRoot, '.qqbot-extensions', 'inbound', file),
    name: file.replace(/\.mjs$/, ''),
    middleware: onDecide ?? (async (_c, n) => { await n(); }),
    ...(onInbound ? { onInbound } : {}),
  };
}

/**
 * 跑一条**真链**：早挂点 → mediaHistoryBuffer（真 MemoryHistoryStore）→ 晚挂点 → finalNext。
 * 关键价值：让"消灭 = 群历史里真的没有"这类断言落在**真 store** 上（而不是只看计数器）。
 */
async function runFullChain(
  exts: InboundExtension[],
  message: Record<string, unknown>,
  state: Record<string, unknown> = {},
  store = new MemoryHistoryStore(),
): Promise<{ ctx: MiddlewareContext; lines: string[]; final: number; trace: string[]; hist: Array<{ content?: string }> }> {
  const { logger, lines } = makeLogger();
  const ctx = makeCtx(message, state);
  const trace: string[] = [];
  let final = 0;
  const chain: Middleware[] = [
    (c, n) => runEarlyInboundExtensions(exts, c, n, logger, runOpts()),
    mediaHistoryBuffer({
      limit: 20,
      store,
      recordOnSkip: true,
      groupKey: (c) => (c.message.kind === 'group' && c.message.groupOpenid ? 'g1' : undefined),
      appId: 'APPID',
    }),
    (c, n) => runInboundExtensions(exts, c, n, logger, runOpts()),
    async () => { final += 1; trace.push('final'); },
  ];
  await runMiddlewareChain(chain, ctx);
  const hist = (await store.list('g1', 20)) as unknown as Array<{ content?: string }>;
  return { ctx, lines, final, trace, hist };
}

describe('入站扩展·两个挂点（早 onInbound / 晚 onDecide）', () => {
  it('两个挂点都会被调用，顺序 = 早（进）→ 记历史 → 晚（进）→ 下游 → 晚（出）→ 早（出）', async () => {
    const trace: string[] = [];
    const exts = [asBoth(
      'both.mjs',
      async (_c, n) => { trace.push('early-in'); await n(); trace.push('early-out'); },
      async (_c, n) => { trace.push('late-in'); await n(); trace.push('late-out'); },
    )];
    const { final, trace: tail } = await runFullChain(exts, groupMsg());
    expect(final).toBe(1);
    expect(trace).toEqual(['early-in', 'late-in', 'late-out', 'early-out']);
    expect(tail).toEqual(['final']);   // 下游跑到底了
  });

  it('export default 语义等同 onDecide（老写法：只有默认导出的扩展照旧生效，且没有早挂点）', async () => {
    writeExt('legacy.mjs', `
export default async (ctx, next) => {
  ctx.state.hit = (ctx.state.mention || {}).wasMentioned === true;
  return next();
};
`);
    const { logger } = makeLogger();
    const r = await loadInboundExtensions({ dataRoot, logger });
    expect(r.total).toBe(1);
    expect(r.early).toEqual([]);                    // ← 没导出 onInbound ⇒ 早挂点列表为空
    const ctx = makeCtx({ kind: 'group', groupOpenid: 'g1' }, { mention: { wasMentioned: true } });
    let final = 0;
    await runInboundExtensions(r.extensions, ctx, async () => { final += 1; }, logger, runOpts());
    expect(final).toBe(1);
    expect((ctx.state as Record<string, unknown>).hit).toBe(true);
  });

  it('只导出 onInbound 也能装载（晚挂点自动直通，不吞消息）', async () => {
    writeExt('early-only.mjs', 'export async function onInbound(ctx, next) { ctx.state.early = 1; return next(); }\n');
    const { logger } = makeLogger();
    const r = await loadInboundExtensions({ dataRoot, logger });
    expect(r.total).toBe(1);
    expect(r.early.length).toBe(1);
    const ctx = makeCtx({ kind: 'group', groupOpenid: 'g1' });
    let final = 0;
    await runEarlyInboundExtensions(r.extensions, ctx, async () => { final += 1; }, logger, runOpts());
    await runInboundExtensions(r.extensions, ctx, async () => { final += 1; }, logger, runOpts());
    expect(final).toBe(2);
    expect((ctx.state as Record<string, unknown>).early).toBe(1);
  });

  it('装载日志会说清"几个含早挂点"', async () => {
    writeExt('a.mjs', 'export async function onInbound(ctx, next) { return next(); }\n');
    writeExt('b.mjs', 'export default async (ctx, next) => next();\n');
    const { logger, lines } = makeLogger();
    const r = await loadInboundExtensions({ dataRoot, logger });
    expect(r.total).toBe(2);
    expect(lines.some((l) => l.includes('已装载 2 个入站中间件') && l.includes('1 个含早挂点 onInbound'))).toBe(true);
  });

  it('早挂点里读不到 ctx.state.mention（undefined）⇒ 不炸；且 decide 会被拒绝 + 告警', async () => {
    const exts = [asBoth('e.mjs', async (c, n) => {
      const st = c.state as Record<string, unknown>;
      st.mentionSeen = st.mention === undefined;                 // 早挂点确实读不到
      st.plat = X(c).platform.mentioned;                         // 但读得到平台信号
      st.decideOk = X(c).decide({ mention: 'ignore' });          // 早挂点调 decide → 必须被拒
      return n();
    })];
    const { ctx, lines, final, hist } = await runFullChain(exts, groupMsg({ rawEventType: 'GROUP_AT_MESSAGE_CREATE' }));
    const st = ctx.state as Record<string, unknown>;
    expect(st.mentionSeen).toBe(true);
    expect(st.plat).toBe(true);
    expect(st.decideOk).toBe(false);
    expect(final).toBe(1);                                        // 消息照常放行
    expect(hist.length).toBe(1);                                  // 历史照记
    expect(lines.some((l) => l.includes('decide 只在晚挂点'))).toBe(true);
  });

  it('早挂点能读被引原文（ctx.quoted.text / .id）', async () => {
    const exts = [asBoth('q.mjs', async (c, n) => {
      (c.state as Record<string, unknown>).q = X(c).quoted;
      return n();
    })];
    const { ctx } = await runFullChain(exts, groupMsg(), { quote: { text: '被引原文', entry: { senderId: 'U2' } } });
    const q = (ctx.state as Record<string, unknown>).q as ExtCtx['quoted'];
    expect(q.text).toBe('被引原文');
    expect(q.id).toBe('U2');
  });

  it('多扩展：早挂点也按文件名顺序串行（洋葱）', async () => {
    const trace: string[] = [];
    const exts = [
      asBoth('a.mjs', async (_c, n) => { trace.push('a-in'); await n(); trace.push('a-out'); }),
      asBoth('b.mjs', async (_c, n) => { trace.push('b-in'); await n(); trace.push('b-out'); }),
    ];
    const { final } = await runFullChain(exts, groupMsg());
    expect(final).toBe(1);
    expect(trace).toEqual(['a-in', 'b-in', 'b-out', 'a-out']);
  });
});

describe('入站扩展·消灭（annihilate）', () => {
  it('消灭 ⇒ 群历史**没被写**、后续中间件（含晚挂点）全都没跑', async () => {
    let lateRan = 0;
    const exts = [asBoth(
      'kill.mjs',
      async (c) => { X(c).annihilate({ reason: '广告' }); /* 故意不调 next() */ },
      async (_c, n) => { lateRan += 1; await n(); },
    )];
    const { final, hist, lines } = await runFullChain(exts, groupMsg({ content: '加微信 日赚300' }));
    expect(hist).toEqual([]);        // ★ 这条最关键：真 store 里一条都没有
    expect(final).toBe(0);           // 下游没跑
    expect(lateRan).toBe(0);         // 晚挂点也没跑
    // 审计里留了痕
    const audit = readAudit(dataRoot).map((l) => JSON.parse(l) as { action: string; result?: string; text?: string });
    expect(audit.some((a) => a.action === 'annihilate' && a.result === 'ok')).toBe(true);
    expect(lines.some((l) => l.includes('ext-inbound'))).toBe(false);  // 正常消灭不刷 warn
  });

  it('消灭后即便扩展**又调了 next()** 也不再往下走（消灭是真停，不是"看运气"）', async () => {
    const exts = [asBoth('kill2.mjs', async (c, n) => {
      X(c).annihilate({ reason: '刷屏' });
      await n();                 // ← 多此一举：引擎必须吃掉这次 next
    })];
    const { final, hist } = await runFullChain(exts, groupMsg());
    expect(final).toBe(0);
    expect(hist).toEqual([]);
  });

  it('晚挂点调 annihilate ⇒ 被拒（历史已记）+ 告警，消息照常放行', async () => {
    const exts = [asBoth('late-kill.mjs', undefined, async (c, n) => {
      (c.state as Record<string, unknown>).killOk = X(c).annihilate({ reason: '想拦' });
      await n();
    })];
    const { ctx, lines, final, hist } = await runFullChain(exts, groupMsg());
    expect((ctx.state as Record<string, unknown>).killOk).toBe(false);
    expect(final).toBe(1);           // 消息照常放行
    expect(hist.length).toBe(1);     // 历史里已经有它了（这正是"消灭要在早挂点"的原因）
    expect(lines.some((l) => l.includes('annihilate 只在早挂点'))).toBe(true);
  });
});

describe('入站扩展·改写（rewrite）', () => {
  it('早挂点改写 ⇒ **群历史里存的也是改后文本**', async () => {
    const exts = [asBoth('mask.mjs', async (c, n) => {
      X(c).rewrite({ text: '***', reason: '敏感词' });
      await n();
    })];
    const { hist, final } = await runFullChain(exts, groupMsg({ content: '敏感词原文' }));
    expect(final).toBe(1);
    expect(hist.length).toBe(1);
    expect(hist[0]!.content).toBe('***');       // ★ 真 store 里是改后的
  });

  it('改写写在晚挂点 ⇒ 历史里仍是原文（这就是"改写必须在早挂点"的原因）', async () => {
    const exts = [asBoth('mask-late.mjs', undefined, async (c, n) => {
      X(c).rewrite({ text: '***', reason: '敏感词' });
      await n();
    })];
    const { ctx, hist, final } = await runFullChain(exts, groupMsg({ content: '敏感词原文' }));
    expect(final).toBe(1);
    expect(hist[0]!.content).toBe('敏感词原文');  // 历史已记过 → 改不动它
    expect(X(ctx).text).toBe('***');             // 但下游看到的是改后的
  });

  it('rewrite 参数不合法（没有 text）⇒ 拒绝 + 告警，文本不动', async () => {
    const exts = [asBoth('bad-rw.mjs', async (c, n) => {
      (c.state as Record<string, unknown>).rwOk = (X(c).rewrite as (o?: unknown) => boolean)({ reason: '忘了写 text' });
      await n();
    })];
    const { ctx, lines } = await runFullChain(exts, groupMsg({ content: '原文' }));
    expect((ctx.state as Record<string, unknown>).rwOk).toBe(false);
    expect(X(ctx).text).toBe('原文');
    expect(lines.some((l) => l.includes('rewrite 需要'))).toBe(true);
  });
});

describe('入站扩展·强制入站（forceWake）', () => {
  /** 与 middleware-setup 里**同款**的门控：forceWake ⇒ 本条按"无需 @"放行 */
  function gateChain(exts: InboundExtension[], message: Record<string, unknown>, state: Record<string, unknown> = {}) {
    const { logger, lines } = makeLogger();
    const ctx = makeCtx(message, state);
    let final = 0;
    const chain: Middleware[] = [
      (c, n) => runEarlyInboundExtensions(exts, c, n, logger, runOpts()),
      mentionGate({
        requireMentionInGroup: true,
        resolveConfig: (c) => (c.state as { qqInboundForceWake?: unknown }).qqInboundForceWake === true
          ? { requireMentionInGroup: false }
          : {},
      }),
      async () => { final += 1; },
    ];
    return runMiddlewareChain(chain, ctx).then((completed) => ({ ctx, lines, final, completed }));
  }

  it('forceWake ⇒ 跳过 @ 门控：没被 @ 的群消息也放行（且不伪造 @）', async () => {
    const exts = [asBoth('wake.mjs', async (c, n) => {
      X(c).forceWake({ reason: '求助关键词' });
      return n();
    })];
    const { ctx, final, completed } = await gateChain(exts, groupMsg({ content: '救命啊' }));
    expect(completed).toBe(true);
    expect(final).toBe(1);                                    // ★ 门控放行了
    expect(ctx.stopped).toBe(false);
    // ★ 不伪造 @：wasMentioned 仍如实为 false（AI 不会看到假的 (@you)）
    expect((ctx.state.mention as { wasMentioned: boolean }).wasMentioned).toBe(false);
    // 标记落在 state 上，供 debounce 与价值评分读
    expect((ctx.state as Record<string, unknown>).qqInboundForceWake).toBe(true);
    expect((ctx.state as Record<string, unknown>).qqInboundForceWakeReason).toBe('求助关键词');
  });

  it('对照：没有 forceWake 时行为**完全不变** —— 同样的消息照旧被门控拦下', async () => {
    const exts = [asBoth('nowake.mjs', async (_c, n) => n())];
    const { ctx, final, completed } = await gateChain(exts, groupMsg({ content: '随便聊聊' }));
    expect(completed).toBe(false);
    expect(final).toBe(0);
    expect(ctx.stopped).toBe(true);
    expect((ctx.state.mention as { reason: string }).reason).toBe('no_mention');
    expect((ctx.state as Record<string, unknown>).qqInboundForceWake).toBeUndefined();
  });

  it('真 @ 的行为不受影响（真 @ 照旧放行）', async () => {
    const exts = [asBoth('noop.mjs', async (_c, n) => n())];
    const { ctx, final } = await gateChain(exts, groupMsg({ content: '早上好 <@APPID>' }));
    expect(final).toBe(1);
    expect((ctx.state.mention as { wasMentioned: boolean }).wasMentioned).toBe(true);
  });
});

describe('入站扩展·禁言名单（持久化 / 过期 / 坏文件 / 可撤销）', () => {
  const RULE = `
export async function onInbound(ctx, next) {
  const t = String(ctx.text || '');
  if (t === '禁言我') ctx.muteUser({ minutes: 5, reason: '试试' });
  if (t === '永久') ctx.muteUser({ minutes: 0, reason: '永久' });
  if (t === '短命') ctx.muteUser({ minutes: 0.01, reason: '很快过期' });   // ≈600ms
  if (t === '解禁') ctx.unmuteUser({ id: ctx.sender });
  const m = ctx.isMuted();
  ctx.state.muted = m ? { id: m.id, permanent: m.permanent, remainingMs: m.remainingMs, remainingMinutes: m.remainingMinutes } : null;
  ctx.state.list = ctx.mutedUsers().map((x) => x.id);
  return next();
}
`;
  async function runRule(runText: string, sender = 'U_SPAM', messageId = 'm1') {
    const { logger } = makeLogger();
    const r = await loadInboundExtensions({ dataRoot, logger });
    const ctx = makeCtx(groupMsg({ senderId: sender, content: runText, messageId }), {});
    await runEarlyInboundExtensions(r.extensions, ctx, async () => { /* 到这就够了 */ }, logger, runOpts());
    return ctx;
  }

  it('muteUser → isMuted 命中；**重新装载扩展后仍在**（热重载/重启都保留）', async () => {
    writeExt('mute-rule.mjs', RULE);
    const first = await runRule('禁言我');
    expect((first.state as Record<string, unknown>).muted).toMatchObject({ id: 'U_SPAM', permanent: false });
    // ★ 重新装载（模拟 /tools-reload 或重启）：名单在盘上，必须还在
    const again = await runRule('随便说句别的', 'U_SPAM', 'm2');
    const m = (again.state as Record<string, unknown>).muted as { id: string; remainingMinutes: number };
    expect(m.id).toBe('U_SPAM');
    expect(m.remainingMinutes).toBeGreaterThan(0);
    // 名单文件落在约定位置
    const raw = JSON.parse(readFileSync(extStatePath(dataRoot, 'mute-rule.mjs'), 'utf8')) as { mutes: Array<{ id: string; reason?: string; by?: string }>; kv: unknown };
    expect(raw.mutes.map((x) => x.id)).toEqual(['U_SPAM']);
    expect(raw.mutes[0]!.reason).toBe('试试');
    expect(raw.mutes[0]!.by).toBe('mute-rule');   // by 缺省 = 扩展名
    expect(raw.kv).toEqual({});
  });

  it('minutes<=0 = 永久（permanent=true、remainingMs=null、文件里 until=0）', async () => {
    writeExt('mute-rule.mjs', RULE);
    const ctx = await runRule('永久');
    expect((ctx.state as Record<string, unknown>).muted).toMatchObject({ permanent: true, remainingMs: null, remainingMinutes: null });
    const raw = JSON.parse(readFileSync(extStatePath(dataRoot, 'mute-rule.mjs'), 'utf8')) as { mutes: Array<{ until: number }> };
    expect(raw.mutes[0]!.until).toBe(0);
  });

  it('过期自动失效：读的时候惰性清理，文件里也一并删掉', async () => {
    writeExt('mute-rule.mjs', RULE);
    const ctx1 = await runRule('短命');
    expect((ctx1.state as Record<string, unknown>).muted).not.toBeNull();
    await new Promise((r) => setTimeout(r, 700));
    const ctx2 = await runRule('随便说', 'U_SPAM', 'm2');
    expect((ctx2.state as Record<string, unknown>).muted).toBeNull();
    expect((ctx2.state as Record<string, unknown>).list).toEqual([]);
    const raw = JSON.parse(readFileSync(extStatePath(dataRoot, 'mute-rule.mjs'), 'utf8')) as { mutes: unknown[] };
    expect(raw.mutes).toEqual([]);
  });

  it('坏文件不崩：状态文件是乱码 ⇒ 当空处理，而且还能继续写名单', async () => {
    writeExt('mute-rule.mjs', RULE);
    const p = extStatePath(dataRoot, 'mute-rule.mjs');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '{这不是 JSON', 'utf8');
    const ctx1 = await runRule('随便说');                   // 读坏文件：当空，不抛
    expect((ctx1.state as Record<string, unknown>).muted).toBeNull();
    const ctx2 = await runRule('禁言我', 'U_SPAM', 'm2');    // 还能正常写
    expect((ctx2.state as Record<string, unknown>).muted).toMatchObject({ id: 'U_SPAM' });
    expect(() => JSON.parse(readFileSync(p, 'utf8'))).not.toThrow();   // 文件被重写成合法 JSON
  });

  it('unmuteUser 能解掉（可撤销）', async () => {
    writeExt('mute-rule.mjs', RULE);
    await runRule('禁言我');
    const ctx = await runRule('解禁', 'U_SPAM', 'm2');
    expect((ctx.state as Record<string, unknown>).muted).toBeNull();
    const audit = readAudit(dataRoot).map((l) => JSON.parse(l) as { action: string; result?: string });
    expect(audit.some((a) => a.action === 'unmuteUser' && a.result === 'ok')).toBe(true);
  });

  it('对主人 muteUser ⇒ 被拒 + 告警（白名单最高优先）', async () => {
    const exts = [asBoth('own-mute.mjs', async (c, n) => {
      (c.state as Record<string, unknown>).muteOk = X(c).muteUser({ minutes: 10, reason: '试试' });
      return n();
    })];
    const { ctx, lines, final } = await runFullChain(exts, groupMsg({ senderId: OWNER }));
    expect((ctx.state as Record<string, unknown>).muteOk).toBe(false);
    expect(final).toBe(1);
    expect(X(ctx).isOwner).toBe(true);
    expect(lines.some((l) => l.includes('拒绝禁言') && l.includes('白名单'))).toBe(true);
  });

  it('kv 落在同一个文件里，能存能取', async () => {
    const exts = [asBoth('kv.mjs', async (c, n) => {
      const kv = X(c).kv;
      kv.set('n', Number(kv.get('n') ?? 0) + 1);
      (c.state as Record<string, unknown>).n = kv.get('n');
      return n();
    })];
    await runFullChain(exts, groupMsg());
    const { ctx } = await runFullChain(exts, groupMsg({ messageId: 'm2' }));
    expect((ctx.state as Record<string, unknown>).n).toBe(2);   // 第二次读到上次写进去的 1
    const raw = JSON.parse(readFileSync(extStatePath(dataRoot, 'kv.mjs'), 'utf8')) as { kv: Record<string, unknown> };
    expect(raw.kv.n).toBe(2);
  });
});

describe('入站扩展·白名单（owner 永不可被消灭）', () => {
  it('对 owner 调 annihilate ⇒ 拒绝执行 + warn + 消息照常放行（历史照记）', async () => {
    const exts = [asBoth('own-kill.mjs', async (c, n) => {
      (c.state as Record<string, unknown>).killOk = X(c).annihilate({ reason: '看他不顺眼' });
      return n();
    })];
    const { ctx, lines, final, hist } = await runFullChain(exts, groupMsg({ senderId: OWNER, content: '主人的消息' }));
    expect((ctx.state as Record<string, unknown>).killOk).toBe(false);
    expect(final).toBe(1);              // ★ 放行
    expect(hist.length).toBe(1);        // ★ 历史照记
    expect(lines.some((l) => l.startsWith('warn') && l.includes('拒绝消灭') && l.includes(OWNER))).toBe(true);
    const audit = readAudit(dataRoot).map((l) => JSON.parse(l) as { action: string; result?: string; target?: string });
    expect(audit.some((a) => a.action === 'annihilate' && a.result === 'refused-owner' && a.target === OWNER)).toBe(true);
  });

  it('非主人（不在名单里）照旧可以被消灭', async () => {
    const exts = [asBoth('other-kill.mjs', async (c) => {
      (c.state as Record<string, unknown>).killOk = X(c).annihilate({ reason: '广告' });
    })];
    const { ctx, final, hist } = await runFullChain(exts, groupMsg({ senderId: 'U_OTHER' }));
    expect((ctx.state as Record<string, unknown>).killOk).toBe(true);
    expect(final).toBe(0);
    expect(hist).toEqual([]);
  });

  it('★ ownerAck：扩展显式声明"内容已另行处置" ⇒ 允许消灭主人的消息，审计记 ok-owner-ack', async () => {
    const exts = [asBoth('own-ack.mjs', async (c, n) => {
      (c.state as Record<string, unknown>).killOk = X(c).annihilate({
        reason: '二档路由隔绝：已经投递到目标会话',
        ownerAck: true,
      });
      return n();
    })];
    const { ctx, final, hist, lines } = await runFullChain(exts, groupMsg({ senderId: OWNER, content: '主人的路由消息' }));
    expect((ctx.state as Record<string, unknown>).killOk).toBe(true);   // ★ 这次真的消灭了
    expect(final).toBe(0);              // 链停在这里（不调 next 也到不了终局）
    expect(hist).toEqual([]);           // ★ 不进群历史
    expect(lines.some((l) => l.includes('ownerAck 生效'))).toBe(true);  // 有迹可循的告警
    const audit = readAudit(dataRoot).map((l) => JSON.parse(l) as { action: string; result?: string });
    expect(audit.some((a) => a.action === 'annihilate' && a.result === 'ok-owner-ack')).toBe(true);
  });

  it('主人消息：扩展只调 annihilate、又没调 next() ⇒ **引擎替它放行**（白名单不是纸面承诺）', async () => {
    // 最常见的用户写法：调完动作就 return（不 next）。若只"拒绝 annihilate"，那个 return 仍然会吞掉主人的消息。
    const exts = [asBoth('own-kill2.mjs', async (c) => { X(c).annihilate({ reason: '想拦主人' }); /* 不调 next */ })];
    const { final, hist, lines } = await runFullChain(exts, groupMsg({ senderId: OWNER, content: '主人的消息' }));
    expect(final).toBe(1);           // ★ 放行
    expect(hist.length).toBe(1);     // ★ 历史照记
    expect(lines.some((l) => l.includes('引擎替它放行'))).toBe(true);
  });
});

describe('入站扩展·熔断（破坏性动作密度异常就停用）', () => {
  it('消灭占比超阈值 ⇒ 熔断：破坏性动作被停用、**消息仍放行**、有告警', async () => {
    const exts = [asBoth('breaker.mjs', async (c, n) => {
      (c.state as Record<string, unknown>).annihilated = X(c).annihilate({ reason: '刷' });
      return n();
    })];
    const { logger, lines } = makeLogger();
    let destroyed = 0;
    let passed = 0;
    for (let i = 0; i < 12; i += 1) {
      const ctx = makeCtx(groupMsg({ messageId: `m${i}` }), {});
      let final = 0;
      await runEarlyInboundExtensions(exts, ctx, async () => { final += 1; }, logger, runOpts());
      if ((ctx.state as Record<string, unknown>).annihilated === true) destroyed += 1;
      if (final > 0) passed += 1;
    }
    // 前 10 条真的被消灭了（第 10 条记完参与比例 → 触发熔断），之后 2 条只放行、不再执行破坏性动作
    expect(destroyed).toBe(10);
    expect(passed).toBe(2);
    expect(lines.some((l) => l.includes('⚠ 熔断') && l.includes('breaker.mjs'))).toBe(true);
    expect(breakerStatus('breaker.mjs').tripped?.reason).toContain('比例熔断');
  });

  it('熔断后审计留痕（result=refused-breaker），且消息仍然放行', async () => {
    const exts = [asBoth('breaker2.mjs', async (c, n) => {
      (c.state as Record<string, unknown>).annihilated = X(c).annihilate({ reason: '刷' });
      return n();
    })];
    const { logger } = makeLogger();
    for (let i = 0; i < 11; i += 1) {
      const ctx = makeCtx(groupMsg({ messageId: `m${i}` }), {});
      await runEarlyInboundExtensions(exts, ctx, async () => { /* 下游 */ }, logger, runOpts());
    }
    const audit = readAudit(dataRoot).map((l) => JSON.parse(l) as { action: string; result?: string });
    expect(audit.some((a) => a.action === 'annihilate' && a.result === 'refused-breaker')).toBe(true);
  });

  it('突发熔断：10 秒内破坏性动作打满上限 ⇒ 第 N+1 次当场被拦（不用等比例）', () => {
    const file = 'burst.mjs';
    for (let i = 0; i < BURST_MAX; i += 1) {
      expect(checkDestructiveAllowed(file).ok).toBe(true);
      noteDestructive(file);
    }
    const gate = checkDestructiveAllowed(file);
    expect(gate.ok).toBe(false);
    expect(gate.ok === false ? gate.reason : '').toContain('突发熔断');
    expect(breakerStatus(file).tripped?.reason).toContain('突发熔断');
  });

  it('熔断后：扩展只调 annihilate、又没调 next() ⇒ 引擎替它放行（"熔断后只放行"不是空话）', async () => {
    const exts = [asBoth('breaker4.mjs', async (c) => {
      X(c).annihilate({ reason: '刷' });   // 只调动作，不调 next（最常见的用户写法）
    })];
    const { logger, lines } = makeLogger();
    let lastFinal = -1;
    for (let i = 0; i < 11; i += 1) {
      const ctx = makeCtx(groupMsg({ messageId: `m${i}` }), {});
      let final = 0;
      await runEarlyInboundExtensions(exts, ctx, async () => { final += 1; }, logger, runOpts());
      lastFinal = final;
    }
    expect(lastFinal).toBe(1);   // 第 11 条：annihilate 被熔断拒绝 → 引擎替它放行
    expect(lines.some((l) => l.includes('引擎替它放行'))).toBe(true);
  });

  it('重新装载（热重载/重启）会复位熔断 —— 文档写明的恢复通道', async () => {
    const exts = [asBoth('reset.mjs', async (c, n) => {
      X(c).annihilate({ reason: '刷' });
      return n();
    })];
    const { logger } = makeLogger();
    for (let i = 0; i < 11; i += 1) {
      const ctx = makeCtx(groupMsg({ messageId: `m${i}` }), {});
      await runEarlyInboundExtensions(exts, ctx, async () => { /* ignore */ }, logger, runOpts());
    }
    expect(breakerStatus('reset.mjs').tripped).toBeTruthy();
    writeExt('reset.mjs', 'export async function onInbound(ctx, next) { return next(); }\n');
    await loadInboundExtensions({ dataRoot, logger });
    expect(breakerStatus('reset.mjs').tripped).toBeUndefined();
  });
});

describe('入站扩展·审计（audit.jsonl）', () => {
  it('每个动作一行，带时间/扩展名/动作/目标/原因；**文本摘要会截断**（不塞整条消息）', async () => {
    const long = 'x'.repeat(500);
    const exts = [asBoth('audit.mjs', async (c, n) => {
      X(c).rewrite({ text: long, reason: '和谐' });
      X(c).forceWake({ reason: '求助' });
      X(c).decide({ mention: 'ignore' });      // 早挂点 → 被拒（也会留痕）
      return n();
    })];
    await runFullChain(exts, groupMsg({ content: '原文' }));
    const raw = readAudit(dataRoot);
    expect(raw.length).toBeGreaterThanOrEqual(3);
    const rows = raw.map((l) => JSON.parse(l) as { at?: string; file?: string; action?: string; text?: string; reason?: string; result?: string });
    const rw = rows.find((r) => r.action === 'rewrite')!;
    expect(rw.file).toBe('audit.mjs');
    expect(rw.reason).toBe('和谐');
    expect(rw.text!.length).toBeLessThanOrEqual(120);           // ★ 截断
    expect(rw.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);               // ISO 时间
    expect(rows.some((r) => r.action === 'forceWake' && r.result === 'ok')).toBe(true);
    expect(rows.some((r) => r.action === 'decide' && r.result === 'refused-early-hook')).toBe(true);
    expect(raw.join('\n')).not.toContain('x'.repeat(200));      // 整条 500 字没被塞进去
  });

  it('审计文件有轮转上限（超过 512KB 就改名成 .1，不无限涨）', async () => {
    const exts = [asBoth('big.mjs', async (c, n) => {
      X(c).rewrite({ text: 'y'.repeat(100), reason: 'z'.repeat(200) });
      return n();
    })];
    // 直接往审计里灌到超过上限（比跑 4000 次动作快得多）
    const { appendAudit } = await import('./ext-inbound-state.js');
    for (let i = 0; i < 2200; i += 1) {
      appendAudit(dataRoot, { file: 'big.mjs', action: 'rewrite', text: 'y'.repeat(100), reason: 'z'.repeat(200) });
    }
    await runFullChain(exts, groupMsg());
    const rotated = join(dirname(extStatePath(dataRoot, 'big.mjs')), 'audit.jsonl.1');
    expect(() => readFileSync(rotated, 'utf8')).not.toThrow();   // 旧账被挪到 .1
  });
});

// ══════════════════════════════════════════════════════════════
// 示例·class-advisor.mjs（辅导员：四个动作全用上）
// ══════════════════════════════════════════════════════════════

const advisorMod = (await import(
  pathToFileURL(fileURLToPath(new URL('../../examples/ext-inbound/class-advisor.mjs', import.meta.url))).href
)) as {
  onInbound: Middleware;
  isHelpText: (t?: string | null) => boolean;
  isAdText: (t?: string | null) => boolean;
  maskText: (t?: string | null) => string | null;
  /** 总闸：示例**默认只观察不动手**（`DRY_RUN = true`），真链行为测试要显式打开 */
  setLive: (live: boolean) => boolean;
  isLive: () => boolean;
};

describe('示例·class-advisor 纯函数', () => {
  it('求助关键词识别', () => {
    expect(advisorMod.isHelpText('救命啊谁能帮我')).toBe(true);
    expect(advisorMod.isHelpText('今天天气不错')).toBe(false);
    expect(advisorMod.isHelpText('')).toBe(false);
    expect(advisorMod.isHelpText(null)).toBe(false);
  });

  it('广告识别（加微信/日赚/短链）', () => {
    expect(advisorMod.isAdText('加微信 日赚300')).toBe(true);
    expect(advisorMod.isAdText('来我主页看 https://t.cn/abc')).toBe(true);
    expect(advisorMod.isAdText('今晚吃火锅吗')).toBe(false);
  });

  it('和谐：敏感词与手机号打码；无可和谐的返回 null', () => {
    expect(advisorMod.maskText('你个傻逼')).toBe('你个**');
    expect(advisorMod.maskText('我的号 13812345678')).toBe('我的号 138****5678');
    expect(advisorMod.maskText('干净的话')).toBeNull();
  });
});

describe('示例·class-advisor 真链行为', () => {
  // ⚠️ 示例**默认 `DRY_RUN = true`（只观察不动手）**——见示例文件头「安全默认」那段。
  //    下面这些用例断言的是**真动手**时的行为，所以这里显式把总闸打开；
  //    每个用例跑完再恢复默认，免得污染其它用例、也顺带验证了 setLive 真能切换。
  beforeEach(() => { advisorMod.setLive(true); });
  afterEach(() => { advisorMod.setLive(false); });

  it('两个示例文件都能被装载器接受（形状合法 + 都有早挂点）', async () => {
    const src = (f: string) => fileURLToPath(new URL(`../../examples/ext-inbound/${f}`, import.meta.url));
    writeExt('class-advisor.mjs', readFileSync(src('class-advisor.mjs'), 'utf8'));
    writeExt('no-wake-on-child-quote.mjs', readFileSync(src('no-wake-on-child-quote.mjs'), 'utf8'));
    const { logger } = makeLogger();
    const r = await loadInboundExtensions({ dataRoot, logger });
    expect(r.skipped).toBe(0);
    expect(r.total).toBe(2);
    expect(r.early.length).toBe(2);
  });

  it('顺序即优先级：被禁言的人喊"救命" ⇒ forceWake 放行；普通闲聊 ⇒ 被名单消灭', async () => {
    const exts = [asBoth('class-advisor.mjs', advisorMod.onInbound)];
    const { logger } = makeLogger();
    // ① 先让他吃一次广告：消灭 + 进名单
    const ctx1 = makeCtx(groupMsg({ senderId: 'U_SPAM', content: '加微信 日赚300', messageId: 'm1' }), {});
    let f1 = 0;
    await runEarlyInboundExtensions(exts, ctx1, async () => { f1 += 1; }, logger, runOpts());
    expect(f1).toBe(0);
    expect(X(ctx1).isMuted()).toMatchObject({ id: 'U_SPAM' });
    // ② 同一个人的"救命" —— 求助判断在名单之前，必须放行 + forceWake
    const ctx2 = makeCtx(groupMsg({ senderId: 'U_SPAM', content: '救命 我的号被盗了', messageId: 'm2' }), {});
    let f2 = 0;
    await runEarlyInboundExtensions(exts, ctx2, async () => { f2 += 1; }, logger, runOpts());
    expect(f2).toBe(1);
    expect((ctx2.state as Record<string, unknown>).qqInboundForceWake).toBe(true);
    // ③ 对照：同一人发普通闲聊 ⇒ 名单生效，被消灭
    const ctx3 = makeCtx(groupMsg({ senderId: 'U_SPAM', content: '今天天气不错', messageId: 'm3' }), {});
    let f3 = 0;
    await runEarlyInboundExtensions(exts, ctx3, async () => { f3 += 1; }, logger, runOpts());
    expect(f3).toBe(0);
  });

  it('主人 /禁言 + 回复某人 ⇒ 对方进名单；指令消息**不被消灭**（白名单：主人消息必放行），只被改写留痕', async () => {
    const exts = [asBoth('class-advisor.mjs', advisorMod.onInbound)];
    const { ctx, final, hist } = await runFullChain(
      exts,
      groupMsg({ senderId: OWNER, content: '/禁言 30', messageId: 'm1' }),
      { quote: { text: '他上一条消息', entry: { senderId: 'U_TARGET' } } },
    );
    expect(final).toBe(1);            // ★ 主人的消息永远放行（哪怕扩展想消灭）
    expect(hist.length).toBe(1);
    // 改写留痕（历史里还带着引用块 —— 那是 media-history 折进去的，正常）
    expect(String(hist[0]!.content)).toContain('（辅导员：禁言指令已处理）');
    expect(String(hist[0]!.content)).not.toContain('/禁言 30');
    expect(X(ctx).isMuted('U_TARGET')).toMatchObject({ id: 'U_TARGET' });
    // 主人自己不受影响（白名单）
    expect(X(ctx).isMuted(OWNER)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ★★ 能力面对齐（2026-10-12 主人定）★★
//
// 入站扩展（第五套）必须和另外四套 —— 自定义命令 / 扩展工具 / botplay 卡片 /
// 启动钩子 —— 拿到**同一套**能力包。依据：`docs/USER-GUIDE.md`
// §「★ 统一能力包（v1.7.0+）」原文「写扩展时**不用再自己接生**」。
//
// 这一组就是"到底对齐了没有"的**证据**（不是文档承诺）：直接在入站挂点里
// 把 ctx 上那些成员的类型抓下来断言。哪天有人再把入站侧的 ctx 改成私有小 API，
// 这里会立刻红。
// ══════════════════════════════════════════════════════════════════════════
describe('能力面对齐 · 入站扩展拿到统一能力包', () => {
  let seen: Record<string, unknown> = {};
  let logger: Logger;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ext-inbound-align-'));
    dataRoot = join(root, 'dshqqbot');
    mkdirSync(dataRoot, { recursive: true });
    seen = {};
    logger = makeLogger().logger;
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** 观察型扩展：只记录"统一能力包那几个成员在不在、是什么类型"，不做任何动作 */
  const observer: Middleware = async (ctx, next) => {
    const c = ctx as unknown as Record<string, unknown>;
    const ns = c.caps as Record<string, unknown> | undefined;
    seen = {
      // ── 统一能力包（与另外四套同一份实现）──
      caps: typeof c.caps,
      appendSilent: typeof c.appendSilent,
      appendWake: typeof c.appendWake,
      canAppendSilent: typeof c.canAppendSilent,
      markdown: typeof c.markdown,
      image: typeof c.image,
      at: typeof c.at,
      api: typeof c.api,
      store: typeof c.store,
      user: typeof c.user,
      ownersIsArray: Array.isArray(c.owners),
      peer: typeof c.peer,
      kernel: typeof c.kernel,
      // ── 命名空间里也有一份 ──
      nsAppendSilent: typeof ns?.appendSilent,
      nsText: typeof ns?.text,
      // ── 入站专属的一个都不能少 ──
      annihilate: typeof c.annihilate,
      rewrite: typeof c.rewrite,
      forceWake: typeof c.forceWake,
      decide: typeof c.decide,
      silentInto: typeof c.silentInto,
      muteUser: typeof c.muteUser,
      kv: typeof c.kv,
      // ── 唯一同名冲突：text 保留"入站=读当前正文"的语义 ──
      textIsMessageText: typeof c.text === 'string',
    };
    return next();
  };

  const fullOpts = (): ExtRunOptions => runOpts({
    dataRoot,
    sender: { sendText: async () => true, sendMarkdown: async () => true },
    replyTarget: {},
    apiCall: async () => ({ ok: true as const, data: {} }),
    kernel: { get: () => undefined },
  });

  it('统一能力包的成员都在（appendSilent / store / api / at / user / kernel / caps）', async () => {
    const ctx = makeCtx({ kind: 'group', groupOpenid: 'G1', senderId: 'U1', content: 'hi' });
    await runEarlyInboundExtensions([asBoth('obs.mjs', observer)], ctx, async () => { /* 下游 */ }, logger, fullOpts());

    // ★ 主人点名要的那条：`appendSilent` = "进上下文（静默）、不唤醒" —— 契约里本来就有
    expect(seen.appendSilent).toBe('function');
    expect(seen.appendWake).toBe('function');
    expect(seen.canAppendSilent).toBe('function');
    expect(seen.nsAppendSilent).toBe('function');
    expect(seen.caps).toBe('object');
    // 其余同套能力
    expect(seen.markdown).toBe('function');
    expect(seen.image).toBe('function');
    expect(seen.at).toBe('function');
    expect(seen.api).toBe('function');
    expect(seen.store).toBe('object');
    expect(seen.user).toBe('object');
    expect(seen.ownersIsArray).toBe(true);
    expect(seen.peer).toBe('object');
    expect(seen.kernel).toBe('object');
  });

  it('入站专属动作一个都没被覆盖掉（annihilate / rewrite / forceWake / decide / silentInto / muteUser / kv）', async () => {
    const ctx = makeCtx({ kind: 'group', groupOpenid: 'G1', senderId: 'U1', content: 'hi' });
    await runEarlyInboundExtensions([asBoth('obs.mjs', observer)], ctx, async () => { /* 下游 */ }, logger, fullOpts());

    expect(seen.annihilate).toBe('function');
    expect(seen.rewrite).toBe('function');
    expect(seen.forceWake).toBe('function');
    expect(seen.decide).toBe('function');
    expect(seen.silentInto).toBe('function');
    expect(seen.muteUser).toBe('function');
    expect(seen.kv).toBe('object');
  });

  it('同名冲突按约定解：ctx.text 仍是"当前正文"（读），发文本走 ctx.caps.text', async () => {
    const ctx = makeCtx({ kind: 'group', groupOpenid: 'G1', senderId: 'U1', content: '你好呀' });
    await runEarlyInboundExtensions([asBoth('obs.mjs', observer)], ctx, async () => { /* 下游 */ }, logger, fullOpts());

    expect(seen.textIsMessageText).toBe(true);   // 入站语义保住了
    expect(seen.nsText).toBe('function');        // 发文本的能力在命名空间里
  });

  it('缺发送器/agent 时优雅降级：不抛、入站主链照常走完', async () => {
    let downstream = 0;
    const ctx = makeCtx({ kind: 'group', groupOpenid: 'G1', senderId: 'U1', content: 'hi' });
    // 故意只给 dataRoot：sender / replyTarget / agent / kernel 全缺
    await runEarlyInboundExtensions([asBoth('obs.mjs', observer)], ctx, async () => { downstream += 1; }, logger, runOpts({ dataRoot }));

    expect(downstream).toBe(1);                   // ★ 主链没被打断
    expect(seen.appendSilent).toBe('function');   // 方法照样在（内部拿不到 agent ⇒ 返回 false，契约写明不抛）
    expect(seen.silentInto).toBe('function');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ★★ 能力面对齐 · 第二半（2026-10-12 主人定）★★
//
// 「入站操控」这一组**也要进能力包**：契约是「一套包、五套扩展」，
// 不能只把公共部分写进包里、把入站那一块留在包外面。
//
// 断言的是 `ctx.caps.inbound.*`：它和 ctx 上平铺的 `ctx.annihilate` 等
// 是**同一份实现的两个入口**（不是两套代码），所以这里顺带把这条也钉住。
// ══════════════════════════════════════════════════════════════════════════
describe('能力面对齐 · 入站操控进了能力包（caps.inbound）', () => {
  let got: Record<string, unknown> = {};
  let logger: Logger;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ext-inbound-pack-'));
    dataRoot = join(root, 'dshqqbot');
    mkdirSync(dataRoot, { recursive: true });
    got = {};
    logger = makeLogger().logger;
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** 读 `ctx.caps.inbound` 那一组 */
  const reader: Middleware = async (ctx, next) => {
    const ns = (ctx as unknown as Record<string, unknown>).caps as Record<string, unknown> | undefined;
    const ib = ns?.inbound as Record<string, unknown> | undefined;
    const msg = ib?.message as Record<string, unknown> | undefined;
    got = {
      isObject: typeof ib,
      annihilate: typeof ib?.annihilate,
      rewrite: typeof ib?.rewrite,
      forceWake: typeof ib?.forceWake,
      decide: typeof ib?.decide,
      silentInto: typeof ib?.silentInto,
      muteUser: typeof ib?.muteUser,
      unmuteUser: typeof ib?.unmuteUser,
      isMuted: typeof ib?.isMuted,
      mutedUsers: typeof ib?.mutedUsers,
      kv: typeof ib?.kv,
      message: typeof ib?.message,
      // message 的只读视图：现算（不是快照）
      msgText: msg?.text,
      msgSender: msg?.sender,
      msgScope: msg?.scope,
      msgGroupId: msg?.groupId,
      // ★ 同一份实现：包里的和 ctx 上平铺的读的是**同一个 ctx / 同一套内核**。
      //   注：两者是各自的一层薄包装（闭包不同，引用不相等），所以这里验"行为等价"：
      //   读出来的东西必须一样（后面单独拿 annihilate 做动作验证）。
      flatText: (ctx as unknown as Record<string, unknown>).text,
      flatSender: (ctx as unknown as Record<string, unknown>).sender,
    };
    return next();
  };

  it('caps.inbound 的动作齐全，且与 ctx 上平铺的是同一份实现', async () => {
    const ctx = makeCtx({ kind: 'group', groupOpenid: 'G9', senderId: 'U9', content: '你好' });
    await runEarlyInboundExtensions([asBoth('reader.mjs', reader)], ctx, async () => { /* 下游 */ }, logger, runOpts({ dataRoot }));

    expect(got.isObject).toBe('object');
    expect(got.annihilate).toBe('function');
    expect(got.rewrite).toBe('function');
    expect(got.forceWake).toBe('function');
    expect(got.decide).toBe('function');
    expect(got.silentInto).toBe('function');
    expect(got.muteUser).toBe('function');
    expect(got.unmuteUser).toBe('function');
    expect(got.isMuted).toBe('function');
    expect(got.mutedUsers).toBe('function');
    expect(got.kv).toBe('object');
    // 同一份实现（不是各读各的快照）：包里的视图与 ctx 上的读出来的一致
    expect(got.flatText).toBe(got.msgText);
    expect(got.flatSender).toBe(got.msgSender);
  });

  it('caps.inbound.message 是只读视图，值就是这条消息的现场', async () => {
    const ctx = makeCtx({ kind: 'group', groupOpenid: 'G9', senderId: 'U9', senderName: '小明', content: '你好' });
    await runEarlyInboundExtensions([asBoth('reader.mjs', reader)], ctx, async () => { /* 下游 */ }, logger, runOpts({ dataRoot }));

    expect(got.message).toBe('object');
    expect(got.msgText).toBe('你好');
    expect(got.msgSender).toBe('U9');
    expect(got.msgScope).toBe('group');
    expect(got.msgGroupId).toBe('G9');
  });

  it('别的四套拿不到这一组：不给入站动作时 caps.inbound 就是 undefined（语义，不是缺失）', () => {
    // 直接调 makeExtCaps：不给 inbound ⇒ 包里就没有这一组
    const caps = makeExtCaps({ dataRoot, logger });
    expect(caps.inbound).toBeUndefined();
    // 而公共部分照旧在
    expect(typeof caps.markdown).toBe('function');
    expect(typeof caps.appendSilent).toBe('function');
  });
});
