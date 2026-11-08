import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionManager } from './session-manager.js';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('releases the eviction timer across repeated SessionManager initialization and shutdown', async () => {
  vi.useFakeTimers();
  mkdirSync('.tmp', { recursive: true });
  const root = mkdtempSync(resolve('.tmp/session-manager-lifecycle-'));
  type Args = ConstructorParameters<typeof SessionManager>;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  try {
    for (let i = 0; i < 10; i++) {
      const manager = new SessionManager(
        {} as Args[0], {} as Args[1],
        { sessionIdleTimeout: 30 * 60_000, dataRoot: root } as Args[2], logger,
      );
      try {
        expect(vi.getTimerCount()).toBe(1);
      } finally {
        await manager.disposeAll();
      }
      await manager.disposeAll();
      expect(vi.getTimerCount()).toBe(0);
      expect(manager.size).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
