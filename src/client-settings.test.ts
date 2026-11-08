import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const settings = '@deepseek-ai/dsh-client-ui-settings';
const slots = '@deepseek-ai/dsh-client-ui-slots';

describe('host-provided UI Settings', () => {
  it('does not install a private UI Settings copy and retains UI Slots', () => {
    expect(pkg.dependencies[settings]).toBeUndefined();
    expect(pkg.optionalDependencies[settings]).toBeUndefined();
    expect(pkg.peerDependencies[settings]).toBeUndefined();
    expect(pkg.devDependencies[settings]).toBeUndefined();
    expect(pkg.peerDependenciesMeta[settings]).toBeUndefined();
    expect(pkg.dependencies[slots]).toBe('0.1.7-rc.1');
    expect(pkg.dsh.client).toMatchObject({
      platform: 'web', immediately: true, inject: [settings, slots],
    });
    expect(pkg.exports['./client']).toBe('./client/qqbot-settings.js');
  });

  it('registers the QQ settings section through the host slot service', () => {
    let entry: any;
    const createElement = vi.fn((type, props) => ({ type, props }));
    const register = vi.fn(() => () => {});
    const warnings = vi.fn();
    const context = {
      window: {
        __ModuleLoader__: { load: (value: unknown) => { entry = value; } },
        addEventListener: vi.fn(),
      },
      document: { getElementById: () => ({}), addEventListener: vi.fn() },
      localStorage: { getItem: () => null },
      console: { log: vi.fn(), warn: warnings },
      fetch: vi.fn(async () => ({ json: async () => ({}) })),
      setTimeout: vi.fn(), setInterval: vi.fn(),
      clearTimeout: vi.fn(), clearInterval: vi.fn(),
    };
    runInNewContext(readFileSync(new URL('../client/qqbot-settings.js', import.meta.url), 'utf8'), context);
    expect(entry.id).toBe(pkg.name);
    const client = entry.factory((id: string) => {
      // QQBot must use the host services rather than importing a UI package.
      expect(id).toBe('react');
      return { createElement, useState: vi.fn(), useEffect: vi.fn() };
    });
    expect(client.inject).toEqual(['slots', 'sessions']);
    client.apply({
      slots: { inject: (_key: string, callback: () => unknown) => callback(), register },
      sessions: {},
    });
    expect(register).toHaveBeenCalledWith(
      { name: 'settings.section', id: 'qqbot', order: 32, label: 'QQ 机器人' },
      expect.any(Function),
    );
    const render = register.mock.calls[0]![1] as (props: unknown) => unknown;
    expect(render({ close: 'close-settings' })).toMatchObject({ props: { close: 'close-settings' } });
    expect(warnings.mock.calls.some(([message]) => String(message).includes('settings section degraded'))).toBe(false);
  });
});
