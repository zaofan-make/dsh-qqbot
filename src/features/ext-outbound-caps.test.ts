import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureOutboundExtensions,
  loadOutboundExtensions,
  makeOutboundCtx,
  resetOutboundBreaker,
  runOutboundChain,
} from '../features/ext-outbound.js';
import type { Logger } from '../types.js';

/**
 * 出站扩展「承诺了却没实现」那批能力的回归测试（2026-11-24）。
 *
 * 覆盖的都是**踩过坑的具体场景**，不是接口快照：
 *  - store 按扩展分文件（中文名不碰撞）
 *  - store 在 background / onSent 里也能落对自己的文件（AsyncLocalStorage）
 *  - store 的 load/save 双形态、坏文件不覆盖、dataRoot 为空不给 store
 *  - appendWake/appendSilent 必须明确返回 true 才算成功
 *  - emit 走纯文本、media 透传 kind、image 认本地路径
 */

const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

let root: string;
const dataDir = (): string => join(root, '.qqbot-extensions', 'data');
const files = (): string[] => (existsSync(dataDir()) ? readdirSync(dataDir()) : []);
const readFile = (f: string): string => readFileSync(join(dataDir(), f), 'utf8');

const bot = {
  sendText: async () => ({}),
  sendMarkdown: async () => ({}),
  sendMedia: async () => ({}),
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qqbot-outcaps-'));
  resetOutboundBreaker();
  configureOutboundExtensions({ dataRoot: root, logger, owner: bot });
});

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

const writeExt = (file: string, body: string): void => {
  const dir = join(root, '.qqbot-extensions', 'outbound');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body, 'utf8');
};

describe('store 按扩展分文件', () => {
  it('两个中文名扩展各自落盘，文件名不碰撞', async () => {
    writeExt('a.mjs', `export const name = '扩展甲';
export default async (ctx, next) => { ctx.store.save('who', 'jia'); return next(); }`);
    writeExt('b.mjs', `export const name = '扩展乙';
export default async (ctx, next) => { ctx.store.save('who', 'yi'); return next(); }`);

    const r = await loadOutboundExtensions({ dataRoot: root, logger });
    expect(r.total).toBe(2);
    await runOutboundChain('正文', { dataRoot: root, logger, sender: bot, target: { scope: 'group', peerId: 'G1' } });

    const all = files();
    expect(all.length).toBe(2);
    const bodies = all.map(readFile);
    // 一个文件里只有 jia，另一个只有 yi —— 证明没有互相覆盖
    expect(bodies.filter((b) => b.includes('jia')).length).toBe(1);
    expect(bodies.filter((b) => b.includes('yi')).length).toBe(1);
    expect(all.every((f) => !f.includes('shared'))).toBe(true);
  });

  it('background 里的 store 也写对文件（ALS 继承）', async () => {
    writeExt('bg.mjs', `export const name = '后台写';
export default async (ctx, next) => {
  ctx.background(() => ctx.store.save('fromBg', 'yes'));
  return next();
}`);
    await loadOutboundExtensions({ dataRoot: root, logger });
    await runOutboundChain('正文', { dataRoot: root, logger, sender: bot, target: { scope: 'group', peerId: 'G1' } });
    await new Promise((r) => setTimeout(r, 150));

    const all = files();
    expect(all.length).toBe(1);
    expect(all[0]).not.toContain('shared');
    expect(readFile(all[0])).toContain('fromBg');
  });

  it('onSent 里的 store 也写对文件（子代理复核抓到的漏点）', async () => {
    writeExt('sent.mjs', `export const name = '回执写';
export default async (ctx, next) => next();
export async function onSent() {
  // onSent 拿不到 ctx，用 globalThis 上挂的探针写 store
  const probe = globalThis.__qqbotOnSentProbe;
  if (probe) probe();
}`);
    // 用一个扩展里拿到的 ctx.store 在 onSent 阶段写（模拟真实用法：扩展闭包持有 ctx）
    writeExt('sent2.mjs', `export const name = '回执写2';
let held = null;
export default async (ctx, next) => { held = ctx; return next(); }
export async function onSent() {
  if (held) held.store.save('fromOnSent', 'yes');
}`);
    await loadOutboundExtensions({ dataRoot: root, logger });
    const { notifyOutboundSent } = await import('../features/ext-outbound.js');
    await runOutboundChain('正文', { dataRoot: root, logger, sender: bot, target: { scope: 'group', peerId: 'G1' } });
    await notifyOutboundSent({ ok: true, text: '正文', target: { scope: 'group', targetId: 'G1' } } as never, bot);
    await new Promise((r) => setTimeout(r, 150));

    const all = files();
    // 关键：不能出现 shared 文件
    expect(all.some((f) => f.includes('shared'))).toBe(false);
    const sent2 = all.find((f) => readFile(f).includes('fromOnSent'));
    expect(sent2).toBeTruthy();
  });
});

describe('store 语义', () => {
  it('load() 双形态 + 返回普通对象', () => {
    const ctx = makeOutboundCtx('x', { dataRoot: root });
    const s = ctx.store!;
    expect(s.load()).toBeUndefined(); // 没有文件 → undefined，不是 {}
    expect(s.save({ a: 1, b: 2 })).toBe(true);
    expect(s.load()).toEqual({ a: 1, b: 2 });
    expect(s.load('a')).toBe(1);
    expect(s.save('c', 3)).toBe(true);
    expect(s.load()).toEqual({ a: 1, b: 2, c: 3 });
    // 返回的是普通对象：这些方法必须可用（原来返回 Object.create(null) 会 TypeError）
    const obj = s.load() as Record<string, unknown>;
    expect(typeof obj.hasOwnProperty).toBe('function');
    expect(obj.hasOwnProperty('a')).toBe(true);
  });

  it('坏文件不被覆盖（save(k,v) 与 save(obj) 都要拒）', () => {
    const ctx = makeOutboundCtx('x', { dataRoot: root });
    const s = ctx.store!;
    expect(s.save('a', 1)).toBe(true);
    const f = files()[0];
    writeFileSync(join(dataDir(), f), '{"broken":', 'utf8');
    expect(s.save('b', 2)).toBe(false);
    expect(s.save({ b: 2 })).toBe(false);
    expect(readFile(f)).toBe('{"broken":'); // 原样保留
  });

  it('根表 toJSON 函数被拒绝', () => {
    const ctx = makeOutboundCtx('x', { dataRoot: root });
    const s = ctx.store!;
    expect(s.save('counter', 1)).toBe(true);
    expect(s.save('toJSON', () => [])).toBe(false);
    expect(s.load('counter')).toBe(1);
    expect(s.save('toJSON', 'plain')).toBe(true); // 非函数允许
  });

  it('dataRoot 为空时不给 store', () => {
    const ctx = makeOutboundCtx('x', {});
    expect(ctx.store).toBeUndefined();
  });

  it('getter 返回同一个对象（memoize）', () => {
    const ctx = makeOutboundCtx('x', { dataRoot: root });
    expect(ctx.store).toBe(ctx.store);
  });
});

describe('能力语义', () => {
  it('appendWake 只认明确的 true', async () => {
    const voidHook = makeOutboundCtx('x', { dataRoot: root, appendWake: () => {} });
    expect(await voidHook.appendWake!('t')).toBe(false); // 返回 void → 不算成功
    const trueHook = makeOutboundCtx('x', { dataRoot: root, appendWake: async () => true });
    expect(await trueHook.appendWake!('t')).toBe(true);
    const falseHook = makeOutboundCtx('x', { dataRoot: root, appendWake: async () => false });
    expect(await falseHook.appendWake!('t')).toBe(false);
  });

  it('emit 走纯文本通道，markdown 走 markdown 通道', async () => {
    const calls: string[] = [];
    const ctx = makeOutboundCtx('x', {
      dataRoot: root,
      target: { scope: 'group', peerId: 'G1' },
      sender: {
        sendText: async () => { calls.push('text'); return {}; },
        sendMarkdown: async () => { calls.push('markdown'); return {}; },
      },
    });
    await ctx.emit!('纯文本');
    await ctx.markdown!('**加粗**');
    expect(calls).toEqual(['text', 'markdown']);
  });

  it('image 认本地路径与对象形态', async () => {
    const got: unknown[] = [];
    const ctx = makeOutboundCtx('x', {
      dataRoot: root,
      target: { scope: 'group', peerId: 'G1' },
      sender: { sendMedia: async (_t: unknown, _k: unknown, s: unknown) => { got.push(s); return {}; } },
    });
    await ctx.image!('D:/a.png');
    await ctx.image!('https://x/a.png');
    await ctx.image!({ localPath: 'D:/b.png' });
    expect(got[0]).toEqual({ localPath: 'D:/a.png' });
    expect(got[1]).toEqual({ url: 'https://x/a.png' });
    expect(got[2]).toEqual({ localPath: 'D:/b.png' });
  });

  it('media 透传 kind 且配文真的发出去', async () => {
    const seq: string[] = [];
    const ctx = makeOutboundCtx('x', {
      dataRoot: root,
      target: { scope: 'group', peerId: 'G1' },
      sender: {
        sendMedia: async (_t: unknown, k: unknown) => { seq.push('media:' + String(k)); return {}; },
        sendText: async () => { seq.push('text'); return {}; },
      },
    });
    await ctx.media!('voice', 'D:/a.ogg', '这是配文');
    expect(seq).toEqual(['media:voice', 'text']);
  });

  it('identity 恒为对象且 user 字段存在（不再 TypeError）', () => {
    const ctx = makeOutboundCtx('x', { dataRoot: root });
    expect(ctx.identity).toBeTruthy();
    expect(() => (ctx.identity as { user: { openid: string } }).user.openid).not.toThrow();
    expect((ctx.identity as { user: { openid: string } }).user.openid).toBe('');
  });
});
