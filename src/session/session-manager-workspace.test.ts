import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SessionManager } from './session-manager.js';
import type { DshAgentHandle, DshAgentRegistry } from './types.js';

it.each(['new session', 'model switch'] as const)(
  'attaches the forked child to the configured workspace after a %s, retrying until persisted',
  async (action) => {
    vi.useFakeTimers();
    mkdirSync('.tmp', { recursive: true });
    const root = mkdtempSync(resolve('.tmp/session-manager-workspace-'));
    const attachSession = vi.fn(async (_sessionId: string) => {});
    const createWorkspace = vi.fn(async (_cwd: string) => ({ attachSession }));
    const fork = vi.fn(() => ({ events: [{ type: 'user/message' }] }));
    const ctx = {
      get: (name: string) => {
        if (name === 'workspaceRegistry') return { create: createWorkspace };
        if (name === 'sessions') return { fork };
        return undefined;
      },
    };
    const handles: DshAgentHandle[] = [];
    const agents: DshAgentRegistry = {
      get: () => undefined,
      resume: async () => { throw new Error('No stored session'); },
      create: vi.fn(async ({ sessionId }) => {
        const handle: DshAgentHandle = {
          agent: {
            id: sessionId, ctx: ctx as DshAgentHandle['agent']['ctx'],
            session: { id: sessionId }, cancel: vi.fn(), followup: vi.fn(),
            whenIdle: async () => {},
          },
          dispose: vi.fn(async () => {}),
        };
        handles.push(handle);
        return handle;
      }),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    type Args = ConstructorParameters<typeof SessionManager>;
    const manager = new SessionManager(ctx as Args[0], agents, {
      appId: 'test', cwd: root, dataRoot: root, sessionIdleTimeout: 0,
      provider: 'test', model: 'initial',
    } as Args[2], logger);
    try {
      const record = await manager.getOrCreate('group', 'peer', 'sender', {
        scope: 'group', targetId: 'peer',
      });
      await vi.advanceTimersByTimeAsync(0);
      const parentId = record.sessionId;
      attachSession.mockClear();
      createWorkspace.mockClear();
      attachSession.mockRejectedValueOnce(new Error('session persistence holds no such session'));

      if (action === 'new session') {
        expect(await manager.startNewSession('group', 'peer')).toBe('forked');
      } else {
        await manager.setModelOverride('group', 'peer', { provider: 'test', model: 'next' });
      }
      const childId = record.sessionId;
      expect(childId).not.toBe(parentId);
      expect(agents.create).toHaveBeenLastCalledWith(expect.objectContaining({
        sessionId: childId, meta: expect.objectContaining({ cwd: root, parentSession: parentId }),
      }));
      expect(handles[0]!.dispose).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(0);
      expect(attachSession).toHaveBeenCalledExactlyOnceWith(childId);
      await vi.advanceTimersByTimeAsync(300);
      expect(attachSession.mock.calls).toEqual([[childId], [childId]]);
      expect(createWorkspace.mock.calls).toEqual([[root], [root]]);
    } finally {
      await manager.disposeAll();
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
