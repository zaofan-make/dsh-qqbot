import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureOutboundExtensions, loadOutboundExtensions, makeOutboundCtx, registerOutboundOwner, runOutboundChain } from './ext-outbound.js';
import type { Logger } from '../types.js';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
let root: string;
const inspectKey = Symbol.for('qqbot.test.outbound-metadata');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outbound-metadata-'));
  configureOutboundExtensions({ dataRoot: root, logger });
});
afterEach(async () => {
  await loadOutboundExtensions({ dataRoot: join(root, 'empty'), logger });
  Reflect.deleteProperty(globalThis, inspectKey);
  rmSync(root, { recursive: true, force: true });
});

describe('出站来源', () => {
  it('未传来源时明确使用 unknown', () => {
    expect(makeOutboundCtx('正文').source).toBe('unknown');
  });

  it('真实加载的中间件能收到前一个中间件改写后的正文和原始来源', async () => {
    const inspect = vi.fn();
    Reflect.set(globalThis, inspectKey, (ctx: { text: string; source: string }) => inspect(ctx.text, ctx.source));
    const dir = join(root, '.qqbot-extensions/outbound');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '01-rewrite.mjs'), 'export default (ctx, next) => { ctx.rewrite("**重点**"); return next(); };');
    writeFileSync(join(dir, '02-inspect.mjs'), 'export default (ctx, next) => { globalThis[Symbol.for("qqbot.test.outbound-metadata")](ctx); return next(); };');
    const loaded = await loadOutboundExtensions({ dataRoot: root, logger });
    expect(loaded.total).toBe(2);
    const sender = {};
    registerOutboundOwner(root, sender);
    await runOutboundChain('正文', { source: 'tool/result', sender, logger });
    expect(inspect).toHaveBeenCalledWith('**重点**', 'tool/result');
  });
});
