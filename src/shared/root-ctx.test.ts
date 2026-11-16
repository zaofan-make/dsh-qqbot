/**
 * `rootOf()` 回归测试 —— issue #64。
 *
 * 这个 helper 存在的唯一理由：cordis 4.0.0-rc.12 起，插件里读 `ctx.root`
 * 会**直接抛异常**（`cannot get property "root" without inject`），
 * 而不是返回 undefined —— 所以 `ctx.root ?? ctx` 那种兜底永远执行不到。
 *
 * 后果（issue 里的实测）：
 *   - `gateway/bootstrap.ts` 那处抛在 WS 建立之前 ⇒ 网关完全起不来；
 *   - `channel-tools.ts` 两处 ⇒ 元工具注册失败刷屏；
 *   - `session-manager.ts` 那处被 catch 吞掉 ⇒ 群守则注入静默失效。
 */
import { describe, expect, it } from 'vitest';
import { rootOf } from './root-ctx.js';

const ROOT = Symbol.for('cordis.root');

/** 模拟 cordis ≥ 4.0.0-rc.12：读 .root 直接抛，根挂在 symbol 上 */
function modernCtx(root: object) {
  const self: Record<string | symbol, unknown> = {};
  self[ROOT] = root;
  Object.defineProperty(self, 'root', {
    get() {
      throw new Error('cannot get property "root" without inject');
    },
    configurable: true,
  });
  return self;
}

/** 模拟 cordis < 4.0.0-rc.12：只有 .root，没有 symbol */
function legacyCtx(root: object) {
  return { root } as Record<string | symbol, unknown>;
}

describe('rootOf (issue #64)', () => {
  it('新版 cordis：从 Symbol.for("cordis.root") 取，不会去碰 .root', () => {
    const root = { tag: 'root' };
    const ctx = modernCtx(root);
    expect(rootOf(ctx)).toBe(root);
  });

  it('新版 cordis 且没有 symbol：返回自身，且**不抛**', () => {
    const self: Record<string | symbol, unknown> = {};
    Object.defineProperty(self, 'root', {
      get() {
        throw new Error('cannot get property "root" without inject');
      },
      configurable: true,
    });
    expect(() => rootOf(self)).not.toThrow();
    expect(rootOf(self)).toBe(self);
  });

  it('旧版 cordis：回落 .root', () => {
    const root = { tag: 'legacy-root' };
    const ctx = legacyCtx(root);
    expect(rootOf(ctx)).toBe(root);
  });

  it('两种都有时优先 symbol（新版语义）', () => {
    const bySymbol = { tag: 'symbol' };
    const byField = { tag: 'field' };
    const ctx: Record<string | symbol, unknown> = { root: byField };
    ctx[ROOT] = bySymbol;
    expect(rootOf(ctx)).toBe(bySymbol);
  });

  it('null / undefined / 原始值 原样返回', () => {
    expect(rootOf(null)).toBe(null);
    expect(rootOf(undefined)).toBe(undefined);
    expect(rootOf('x' as never)).toBe('x');
    expect(rootOf(42 as never)).toBe(42);
  });

  it('空对象：拿不到根就返回自身（与旧 `?? ctx` 行为一致）', () => {
    const ctx = {};
    expect(rootOf(ctx)).toBe(ctx);
  });
});
