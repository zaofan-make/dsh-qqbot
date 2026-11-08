import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Exercise the shipped, hand-written browser bundle without starting a Desktop Host.
const source = readFileSync(new URL('../client/qqbot-settings.js', import.meta.url), 'utf8');
function functionSource(name: string): string {
  const start = new RegExp(`^([ ]*)function ${name}\\(`, 'm').exec(source);
  if (!start) throw new Error(`Missing browser function: ${name}`);
  const end = source.indexOf(`\n${start[1]}}`, start.index);
  if (end < 0) throw new Error(`Missing function end: ${name}`);
  return source.slice(start.index, end + start[1]!.length + 2);
}

function sessionHarness(snapshot: unknown, stored: unknown = null) {
  const context = vm.createContext({
    _extSessionsSvc: { list: { getSnapshot: () => snapshot } },
    sessionsSvc: { list: { getSnapshot: () => snapshot } },
    localStorage: { getItem: () => stored && JSON.stringify(stored) },
    state: {} as Record<string, unknown>,
  });
  const helper = /^\s*function sessionIdFromSnapshot\(/m.test(source) ? functionSource('sessionIdFromSnapshot') : '';
  vm.runInContext(helper + '\n' + ['curSessionId', 'curWorkspaceCwd', 'readCurrentSessionId'].map(functionSource).join('\n'), context);
  return { context, call: (name: string) => vm.runInContext(`${name}()`, context) };
}

describe('Desktop current session compatibility', () => {
  it('follows mainView instead of a stale localStorage session', () => {
    const h = sessionHarness({ byId: {
      background: { id: 'background', retainedBy: { qqbot: 1 }, cwd: '/background' },
      visible: { id: 'visible', retainedBy: { mainView: 1 }, cwd: '/workspace', displayTitle: 'QQ group' },
    } }, { sessionId: 'stale', cwd: '/stale' });
    expect(h.call('curSessionId')).toBe('visible');
    expect(h.call('curWorkspaceCwd')).toBe('/workspace');
    expect(h.call('readCurrentSessionId')).toBe('visible');
  });

  it('uses the same visible row for cwd and dock target detection', () => {
    const h = sessionHarness({ byId: {
      visible: { id: 'visible', retainedBy: { mainView: 2 }, cwd: '/workspace', displayTitle: 'QQ group' },
    } }, { sessionId: 'stale', cwd: '/stale' });
    expect(h.call('curWorkspaceCwd')).toBe('/workspace');
    expect(h.call('readCurrentSessionId')).toBe('visible');
    expect(h.context.state.detected).toEqual({ src: 'sessions.list', sid: 'visible', title: 'QQ group' });
  });

  it('keeps legacy current priority', () => {
    const h = sessionHarness({ current: 'legacy', byId: {
      legacy: { id: 'legacy', cwd: '/legacy' },
      other: { id: 'other', retainedBy: { mainView: 1 } },
    } });
    expect(h.call('curSessionId')).toBe('legacy');
    expect(h.call('curWorkspaceCwd')).toBe('/legacy');
    expect(h.call('readCurrentSessionId')).toBe('legacy');
  });

  it('falls back safely when the service is unavailable', () => {
    const h = sessionHarness(null, { sessionId: 'stored', cwd: '/stored' });
    h.context._extSessionsSvc = null;
    h.context.sessionsSvc = null;
    expect(h.call('curSessionId')).toBe('stored');
    expect(h.call('curWorkspaceCwd')).toBe('/stored');
    expect(h.call('readCurrentSessionId')).toBe('stored');
  });

  it('ignores background retention and missing rows', () => {
    const h = sessionHarness({ byId: { a: null, b: { id: 'b', retainedBy: { qqbot: 1 } } } });
    expect(h.call('curSessionId')).toBe('');
    expect(h.call('curWorkspaceCwd')).toBe('');
    expect(h.call('readCurrentSessionId')).toBe('');
  });
});

function dockHarness() {
  let now = 1000;
  const requests: { sid: string; cb: (hit: boolean) => void }[] = [];
  const context = vm.createContext({
    sid: 'a', wrap: { style: { display: '' } },
    Date: { now: () => now },
    qqHitOf: (sid: string, cb: (hit: boolean) => void) => requests.push({ sid, cb }),
  });
  vm.runInContext(`var _dockSid = '', _dockHit = null, _dockPending = 0, _dockCheckedAt = 0;
    function curSessionId() { return sid }
    ${functionSource('refreshDockVisibility')}`, context);
  return { context, requests, advance: (ms: number) => { now += ms; }, refresh: () => vm.runInContext('refreshDockVisibility()', context) };
}

describe('dock visibility recovery', () => {
  it('rechecks an expired miss on a later refresh, then shows a newly registered QQ session', () => {
    const h = dockHarness();
    h.refresh(); h.requests[0]!.cb(false);
    expect(h.context.wrap.style.display).toBe('none');
    h.advance(1999); h.refresh();
    expect(h.requests).toHaveLength(1);
    h.advance(1); h.refresh();
    expect(h.requests).toHaveLength(2);
    h.requests[1]!.cb(true);
    expect(h.context.wrap.style.display).toBe('');
    h.advance(3000); h.refresh();
    expect(h.requests).toHaveLength(2);
  });

  it('ignores an old response after switching A → B → A', () => {
    const h = dockHarness();
    h.refresh();
    h.context.sid = 'b'; h.refresh();
    h.context.sid = 'a'; h.refresh();
    h.requests[2]!.cb(true);
    h.requests[0]!.cb(false);
    h.requests[1]!.cb(false);
    expect(h.context.wrap.style.display).toBe('');
  });

  it('hides immediately when the active conversation disappears', () => {
    const h = dockHarness();
    h.refresh(); h.requests[0]!.cb(true);
    h.context.sid = ''; h.refresh();
    expect(h.context.wrap.style.display).toBe('none');
    h.requests[0]!.cb(true);
    expect(h.context.wrap.style.display).toBe('none');
  });
});
