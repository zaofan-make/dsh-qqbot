/**
 * ext-hooks 的回归（2026-10-12，启动钩子扩展点）。
 *
 * 锁六件事（都是"绝不能影响插件启动"派生出来的硬要求）：
 *  ① 目录不存在 / 为空 → **完全安静**，一条日志都不打；
 *  ② 正常钩子被逐个执行，结果与名字都记账；
 *  ③ 单个钩子抛错 → 记 failure 并继续跑下一个（不影响启动、不影响别人）；
 *  ④ 钩子永远不返回 → 按超时记账并放行（不把启动挂住）；
 *  ⑤ 子目录不扫描（与 tools/ 的既有约定一致）；
 *  ⑥ dispose：registerDispose 与导出 dispose() 都被调用、逆序执行、单个抛错不阻断整体。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../types.js';
import {
  __resetStartupHooksForTest,
  disposeStartupHooks,
  extHooksDir,
  runStartupHooks,
  startupHooksDisposeCount,
} from './ext-hooks.js';

/** 记录所有日志行（用于断言"安静"与"可读"） */
function makeLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (lvl: string) => (msg: string) => { lines.push(`${lvl} ${msg}`); };
  return { logger: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }, lines };
}

let root = '';
let dataRoot = '';

function hooksDir(): string {
  return extHooksDir(dataRoot);
}

/** 写一个钩子文件（内容原样给） */
function writeHook(file: string, body: string): void {
  mkdirSync(hooksDir(), { recursive: true });
  writeFileSync(join(hooksDir(), file), body, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-ext-hooks-'));
  dataRoot = join(root, 'data');
  __resetStartupHooksForTest();
});

afterEach(async () => {
  __resetStartupHooksForTest();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows 偶发占用，忽略 */ }
});

describe('启动钩子：目录与安静性', () => {
  it('目录不存在 → 空汇总，且一条日志都不打', async () => {
    const { logger, lines } = makeLogger();
    const r = await runStartupHooks({ dataRoot, logger });
    expect(r).toEqual({ total: 0, ok: 0, failed: 0, timedOut: 0, skipped: 0, results: [] });
    expect(lines).toEqual([]);
  });

  it('目录存在但为空 → 同样完全安静', async () => {
    mkdirSync(hooksDir(), { recursive: true });
    const { logger, lines } = makeLogger();
    const r = await runStartupHooks({ dataRoot, logger });
    expect(r.total).toBe(0);
    expect(lines).toEqual([]);
  });

  it('非 .mjs/.js/.cjs 文件不参与扫描', async () => {
    mkdirSync(hooksDir(), { recursive: true });
    writeFileSync(join(hooksDir(), 'readme.md'), '# 这不是钩子', 'utf8');
    writeFileSync(join(hooksDir(), 'notes.txt'), 'x', 'utf8');
    const { logger, lines } = makeLogger();
    const r = await runStartupHooks({ dataRoot, logger });
    expect(r.total).toBe(0);
    expect(lines).toEqual([]);
  });

  it('子目录不扫描（与 tools/ 的既有约定一致）', async () => {
    writeHook('top.mjs', 'export function run() {}\n');
    mkdirSync(join(hooksDir(), 'lib'), { recursive: true });
    writeFileSync(join(hooksDir(), 'lib', 'inner.mjs'), 'throw new Error("子目录不该被执行");\n', 'utf8');
    const { logger } = makeLogger();
    const r = await runStartupHooks({ dataRoot, logger });
    expect(r.total).toBe(1);
    expect(r.results.map((x) => x.file)).toEqual(['top.mjs']);
  });
});

describe('启动钩子：执行与记账', () => {
  it('三种导出写法都能跑，并把结果记进 summary', async () => {
    writeHook('a-named.mjs', "export function run(env) { env.logger.info('a ran'); }\n");
    writeHook('b-object.mjs', "export default { name: '对象钩子', run() { return 1; } };\n");
    writeHook('c-bare.mjs', 'export default async () => { return 2; };\n');
    const { logger, lines } = makeLogger();
    const r = await runStartupHooks({ dataRoot, logger });

    expect(r.total).toBe(3);
    expect(r.ok).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.timedOut).toBe(0);
    expect(r.skipped).toBe(0);
    // 按文件名排序执行
    expect(r.results.map((x) => x.file)).toEqual(['a-named.mjs', 'b-object.mjs', 'c-bare.mjs']);
    // 名字：具名导出没写 name → 用文件名去扩展名；对象导出的 name 生效
    expect(r.results[0]!.name).toBe('a-named');
    expect(r.results[1]!.name).toBe('对象钩子');
    expect(r.results.every((x) => x.status === 'ok')).toBe(true);
    expect(lines.some((l) => l.includes('a ran'))).toBe(true);
    expect(lines.some((l) => l.includes('启动钩子执行完毕: 成功 3'))).toBe(true);
  });

  it('env 契约：ctx / dataRoot / config / pluginVersion / store 都拿得到', async () => {
    writeHook('env-check.mjs', `
export const name = 'env-check';
export async function run(env) {
  const seen = {
    hasCtx: env.ctx === globalThis.__extHookCtx,
    dataRoot: env.dataRoot,
    configHit: env.config?.marker === 'cfg',
    versionIsString: typeof env.pluginVersion === 'string' && env.pluginVersion.length > 0,
    storeSave: env.store.save({ from: 'env-check' }),
  };
  globalThis.__extHookEnvSeen = seen;
}`);
    const { logger } = makeLogger();
    const fakeCtx = { marker: 'ctx' };
    (globalThis as Record<string, unknown>).__extHookCtx = fakeCtx;
    const r = await runStartupHooks({ dataRoot, logger, ctx: fakeCtx, config: { marker: 'cfg' } });
    expect(r.ok).toBe(1);
    const seen = (globalThis as Record<string, unknown>).__extHookEnvSeen as Record<string, unknown>;
    expect(seen.hasCtx).toBe(true);
    expect(seen.dataRoot).toBe(dataRoot);
    expect(seen.configHit).toBe(true);
    expect(seen.versionIsString).toBe(true);
    expect(seen.storeSave).toBe(true);   // 落到 {dataRoot}/.qqbot-extensions/hooks/data/env-check.json
    delete (globalThis as Record<string, unknown>).__extHookCtx;
    delete (globalThis as Record<string, unknown>).__extHookEnvSeen;
  });

  it('缺 run 的模块 → 记 skipped（不执行、不失败）', async () => {
    writeHook('bad.mjs', "export default { name: 'bad', notRun() {} };\n");
    writeHook('good.mjs', 'export function run() {}\n');
    const { logger, lines } = makeLogger();
    const r = await runStartupHooks({ dataRoot, logger });
    expect(r.skipped).toBe(1);
    expect(r.total).toBe(1);
    expect(r.ok).toBe(1);
    expect(r.results.find((x) => x.file === 'bad.mjs')!.status).toBe('skipped');
    expect(lines.some((l) => l.startsWith('warn') && l.includes('没有可执行的 run'))).toBe(true);
  });
});

describe('启动钩子：健壮性（硬要求）', () => {
  it('单个钩子同步抛错 → 记失败，其它钩子照跑，不冒泡', async () => {
    writeHook('a-boom.mjs', "export function run() { throw new Error('boom-sync'); }\n");
    writeHook('b-ok.mjs', "export function run(env) { env.logger.info('b 还是跑了'); }\n");
    const { logger, lines } = makeLogger();
    const r = await runStartupHooks({ dataRoot, logger });

    expect(r.failed).toBe(1);
    expect(r.ok).toBe(1);
    const boom = r.results.find((x) => x.file === 'a-boom.mjs')!;
    expect(boom.status).toBe('error');
    expect(boom.error).toContain('boom-sync');
    expect(lines.some((l) => l.startsWith('warn') && l.includes('boom-sync'))).toBe(true);
    expect(lines.some((l) => l.includes('b 还是跑了'))).toBe(true);
    expect(lines.some((l) => l.includes('成功 1 / 失败 1'))).toBe(true);
  });

  it('单个钩子 reject → 同样只记失败', async () => {
    writeHook('a-reject.mjs', "export async function run() { throw new Error('boom-async'); }\n");
    const { logger } = makeLogger();
    const r = await runStartupHooks({ dataRoot, logger });
    expect(r.failed).toBe(1);
    expect(r.results[0]!.error).toContain('boom-async');
  });

  it('抛错的模块（import 阶段就炸）→ 记失败，不影响其它', async () => {
    writeHook('a-import-boom.mjs', "throw new Error('boom-import');\n");
    writeHook('b-ok.mjs', 'export function run() {}\n');
    const { logger } = makeLogger();
    const r = await runStartupHooks({ dataRoot, logger });
    expect(r.failed).toBe(1);
    expect(r.ok).toBe(1);
    expect(r.results[0]!.error).toContain('boom-import');
  });

  it('永不返回的钩子 → 按超时记账并放行（不挂住启动），后面的钩子照样跑', async () => {
    writeHook('a-hang.mjs', 'export function run() { return new Promise(() => { /* 永不 settle */ }); }\n');
    writeHook('b-ok.mjs', "export function run(env) { env.logger.info('b 在超时后仍然跑了'); }\n");
    const { logger, lines } = makeLogger();
    const t0 = Date.now();
    const r = await runStartupHooks({ dataRoot, logger, timeoutMs: 40 });
    const elapsed = Date.now() - t0;

    expect(r.timedOut).toBe(1);
    expect(r.ok).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.results.find((x) => x.file === 'a-hang.mjs')!.status).toBe('timeout');
    expect(elapsed).toBeLessThan(5000);            // 远小于默认 30s，说明超时真的生效
    expect(lines.some((l) => l.includes('超时'))).toBe(true);
    expect(lines.some((l) => l.includes('b 在超时后仍然跑了'))).toBe(true);
  });
});

describe('启动钩子：dispose 清理', () => {
  it('registerDispose 与导出 dispose() 都被调用，且逆序执行', async () => {
    writeHook('a-order.mjs', `
export const name = 'order';
export async function run(env) {
  env.registerDispose(() => { globalThis.__extHookOrder.push('first-registered'); });
  env.registerDispose(() => { globalThis.__extHookOrder.push('second-registered'); });
}
export async function dispose(env) {
  globalThis.__extHookOrder.push('exported-dispose');
}`);
    (globalThis as Record<string, unknown>).__extHookOrder = [];
    const { logger } = makeLogger();
    await runStartupHooks({ dataRoot, logger });

    expect(startupHooksDisposeCount()).toBe(1);
    const n = await disposeStartupHooks(logger, dataRoot);
    expect(n).toBe(1);
    // 同一钩子内：registerDispose 逆序（后注册先跑）→ 再跑导出的 dispose()
    expect((globalThis as Record<string, unknown>).__extHookOrder).toEqual([
      'second-registered', 'first-registered', 'exported-dispose',
    ]);
    expect(startupHooksDisposeCount()).toBe(0);
    delete (globalThis as Record<string, unknown>).__extHookOrder;
  });

  it('多个钩子逆序清理；单个清理抛错只告警，不阻断其它', async () => {
    writeHook('a-throw.mjs', `
export function run(env) { env.registerDispose(() => { throw new Error('cleanup-boom'); }); }
export function dispose() { globalThis.__extHookTrace.push('a'); }`);
    writeHook('b-ok.mjs', `
export function run(env) { env.registerDispose(() => { globalThis.__extHookTrace.push('b'); }); }`);
    (globalThis as Record<string, unknown>).__extHookTrace = [];
    const { logger, lines } = makeLogger();
    const r = await runStartupHooks({ dataRoot, logger });
    expect(r.ok).toBe(2);

    await disposeStartupHooks(logger, dataRoot);
    // b 先跑（逆序）；a 的清理抛错被吞掉，但 a 的 dispose() 仍执行
    expect((globalThis as Record<string, unknown>).__extHookTrace).toEqual(['b', 'a']);
    expect(lines.some((l) => l.startsWith('warn') && l.includes('cleanup-boom'))).toBe(true);
    delete (globalThis as Record<string, unknown>).__extHookTrace;
  });

  it('run 失败/超时的钩子，其已注册的清理函数仍然会被调用', async () => {
    writeHook('a-fail.mjs', `
export function run(env) {
  env.registerDispose(() => { globalThis.__extHookCleanupRan.push('ran'); });
  throw new Error('fail-after-register');
}`);
    (globalThis as Record<string, unknown>).__extHookCleanupRan = [];
    const { logger } = makeLogger();
    const r = await runStartupHooks({ dataRoot, logger });
    expect(r.failed).toBe(1);
    await disposeStartupHooks(logger, dataRoot);
    expect((globalThis as Record<string, unknown>).__extHookCleanupRan).toEqual(['ran']);
    delete (globalThis as Record<string, unknown>).__extHookCleanupRan;
  });

  it('没有登记任何钩子时 dispose 是空操作（不炸、不误报）', async () => {
    const { logger, lines } = makeLogger();
    __resetStartupHooksForTest();
    const n = await disposeStartupHooks(logger, dataRoot);
    expect(n).toBe(0);
    expect(lines).toEqual([]);
  });
});

/**
 * ★ 2026-10-12 真 bug 回归：**网关重建后不能把刚起来的钩子当场拆掉**。
 *
 * 触发链（v1.8.8「保存连接相关设置即重建网关」正好走到）：
 *   runStartupHooks → disposeStartupHooks()（disposed = true）→ 再 runStartupHooks
 * 若第二轮不把 disposed 复位，钩子里 `registerDispose(fn)` 会命中 pushDisposer 的
 * "卸载后登记 ⇒ 立即执行"分支 ⇒ **注册即被清理**（刚订阅就退订）。
 */
describe('启动钩子 · 网关重建后的第二轮（回归）', () => {
  it('dispose 之后再次 runStartupHooks，新钩子登记的清理函数不能被立刻执行', async () => {
    writeHook('rebuild.mjs', `
      export function run(env) {
        env.registerDispose(() => { globalThis.__rebuildCleaned = (globalThis.__rebuildCleaned ?? 0) + 1; });
        globalThis.__rebuildRan = (globalThis.__rebuildRan ?? 0) + 1;
        return 'ok';
      }
    `);
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.__rebuildRan; delete g.__rebuildCleaned;

    // 第一轮：启动
    const first = await runStartupHooks({ dataRoot, logger: makeLogger().logger });
    expect(first.ok).toBe(1);
    expect(g.__rebuildRan).toBe(1);

    // 网关重建：先 dispose（这一步会把 disposed 置 true）
    await disposeStartupHooks(makeLogger().logger, dataRoot);
    expect(g.__rebuildCleaned).toBe(1);        // 第一轮的清理确实跑了

    // 第二轮：重新启动
    const second = await runStartupHooks({ dataRoot, logger: makeLogger().logger });
    expect(second.ok).toBe(1);
    expect(g.__rebuildRan).toBe(2);
    // ★ 关键断言：这一轮刚登记的清理**不能**被立刻执行
    expect(g.__rebuildCleaned).toBe(1);
    expect(startupHooksDisposeCount()).toBe(1);
  });
});
