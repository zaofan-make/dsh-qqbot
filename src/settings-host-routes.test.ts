import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('QQBot settings host routes', () => {
  const routes = new Map<string, any>();
  const disposers: (() => void)[] = [];
  let root: string;

  beforeAll(async () => {
    mkdirSync(resolve('.tmp'), { recursive: true });
    root = mkdtempSync(resolve('.tmp/settings-routes-'));
    const profile = join(root, 'profiles', 'web');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n');
    vi.stubEnv('DSH_HOME', root);
    vi.stubEnv('DSH_PROFILE_DIR', profile);
    vi.stubEnv('DSH_PROFILE', 'web');
    const { apply } = await import('../settings-host.js');
    apply({
      settings: { describe: () => [{ ns: 'im-qqbot', value: { requireMention: true }, revision: 1 }] },
      webServer: {
        register: (route: any) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
      },
      effect: (callback: () => (() => void) | undefined) => {
        const dispose = callback();
        if (typeof dispose === 'function') disposers.push(dispose);
      },
      on: () => () => {}, emit: vi.fn(),
    });
  });

  afterAll(() => {
    for (const dispose of disposers.reverse()) dispose();
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function request(method: string, url: string, body?: unknown) {
    const handler = routes.get(new URL(url, 'http://localhost').pathname);
    expect(handler, `route must be registered: ${url}`).toBeTypeOf('function');
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method, url, headers: { host: 'localhost' },
    });
    let status: number | undefined;
    let contentType: string | undefined;
    let text = '';
    await handler(req, {
      writeHead: (code: number, headers: Record<string, string>) => {
        status = code; contentType = headers['content-type'];
      },
      end: (value: string) => { text = value; },
    });
    expect(contentType).toContain('application/json');
    return { status, body: JSON.parse(text) };
  }

  it('reads and saves configuration without depending on a UI Settings package', async () => {
    expect(await request('GET', '/api/qqbot-settings/read')).toMatchObject({
      status: 200, body: { value: { requireMention: true } },
    });
    expect(await request('POST', '/api/qqbot-settings/update', {
      patch: { requireMention: false },
    })).toMatchObject({ status: 200, body: { value: { requireMention: false }, mode: 'own' } });
    expect(await request('GET', '/api/qqbot-settings/read')).toMatchObject({
      status: 200, body: { value: { requireMention: false }, source: 'own' },
    });
  });

  it('registers the preset endpoints and returns JSON for missing presets', async () => {
    expect(await request('GET', '/api/qqbot-settings/presets')).toMatchObject({
      status: 200, body: { presets: [] },
    });
    expect(await request('GET', '/api/qqbot-settings/presets/files?id=missing')).toMatchObject({ status: 404 });
    expect(await request('GET', '/api/qqbot-settings/presets/file?id=missing&name=agent.cordis.yml')).toMatchObject({ status: 400 });
  });
});
