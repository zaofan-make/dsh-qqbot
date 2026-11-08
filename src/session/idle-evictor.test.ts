import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdleEvictor } from './idle-evictor.js';
import type { SessionRecord } from './types.js';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('IdleEvictor lifecycle', () => {
  it('continues sweeping idle sessions while preserving recently active sessions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const idle = { lastActivity: Date.now() - 90_001 } as SessionRecord;
    const active = { lastActivity: Date.now() } as SessionRecord;
    const sessions = new Map([['idle', idle], ['active', active]]);
    const onEvict = vi.fn((key: string) => { sessions.delete(key); });
    const evictor = new IdleEvictor(sessions, 90_000, onEvict);
    try {
      vi.advanceTimersByTime(60_000);
      expect(onEvict).toHaveBeenCalledExactlyOnceWith('idle', idle);
      expect(sessions.has('active')).toBe(true);

      active.lastActivity = Date.now();
      vi.advanceTimersByTime(60_000);
      expect(onEvict).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(onEvict).toHaveBeenLastCalledWith('active', active);
      expect(sessions.size).toBe(0);
    } finally {
      evictor.dispose();
    }
  });

  it('stops sweeping on disposal and allows repeated disposal', () => {
    vi.useFakeTimers();
    const sessions = new Map([['idle', { lastActivity: 0 } as SessionRecord]]);
    const onEvict = vi.fn();
    const evictor = new IdleEvictor(sessions, 1, onEvict);
    expect(vi.getTimerCount()).toBe(1);
    evictor.dispose();
    evictor.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(onEvict).not.toHaveBeenCalled();
  });

  it.each([0, -1])('does not schedule cleanup when timeout is %s', (timeoutMs) => {
    vi.useFakeTimers();
    const onEvict = vi.fn();
    const evictor = new IdleEvictor(new Map(), timeoutMs, onEvict);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(onEvict).not.toHaveBeenCalled();
    evictor.dispose();
  });

  it('allows Node to exit naturally with an undisposed compiled evictor', () => {
    // Exercise the build users install, with real Node timers and no process.exit().
    const moduleUrl = new URL('../../dist/session/idle-evictor.js', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { IdleEvictor } from ${JSON.stringify(moduleUrl)};
      new IdleEvictor(new Map(), 30 * 60_000, () => {});
      console.log('initialized');
    `], { encoding: 'utf8', timeout: 3_000 });
    expect(result.stdout.trim()).toBe('initialized');
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  }, 10_000);
});
