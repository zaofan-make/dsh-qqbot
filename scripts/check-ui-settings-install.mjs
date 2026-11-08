// Run inside the buildtest container after packing QQBot. This checks the real
// tarball with pnpm, which DSH uses for profile plugin installation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const archive = resolve(process.argv[2] ?? `/artifacts/zaofan-dsh-qqbot-${version}.tgz`);
assert.ok(existsSync(archive), `Package does not exist: ${archive}`);
mkdirSync('.tmp', { recursive: true });
const root = mkdtempSync(resolve('.tmp/ui-settings-install-'));
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'qqbot-install-regression', private: true }));
// Stop pnpm from discovering the checkout's ancestor workspace and writing its
// lockfile there instead of keeping the installation fixture self-contained.
writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - '.'\n");
const settings = '@deepseek-ai/dsh-client-ui-settings';
const slots = '@deepseek-ai/dsh-client-ui-slots';
const pkg = '@zaofan/dsh-qqbot';
const qqbotManifest = join(root, 'node_modules', pkg, 'package.json');
const pnpm = (...args) => execFileSync('npm', [
  'exec', '--yes', '--package=pnpm@10.24.0', '--', 'pnpm',
  ...args, '--store-dir', join(root, '.pnpm-store'),
], { cwd: root, stdio: 'inherit', timeout: 240_000 });
const add = (...args) => pnpm('add', '--ignore-scripts', '--no-optional', ...args);
const manifest = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
function checkAbsent() {
  const qqbot = manifest(pkg);
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    assert.equal(qqbot[field]?.[settings], undefined, `QQBot must leave UI Settings to DSH (${field})`);
  }
  assert.equal(existsSync(join(root, 'node_modules', settings)), false);
  assert.equal(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8').includes(`${settings}@`), false,
    'UI Settings must also be absent from the transitive dependency graph');
  const slotsManifest = createRequire(qqbotManifest).resolve(`${slots}/package.json`);
  assert.equal(JSON.parse(readFileSync(slotsManifest, 'utf8')).version, '0.1.7-rc.1');
  assert.deepEqual(qqbot.dsh.client.inject, [settings, slots]);
  assert.ok(existsSync(join(root, 'node_modules', pkg, 'client/qqbot-settings.js')));
}

console.log(`Install fixture: ${root}`);
add(archive);
checkAbsent();
console.log('PASS: installing QQBot does not install UI Settings; UI Slots and client remain present');
add('dsh-mnemon@0.5.42');
checkAbsent();
console.log('PASS: installing Mnemon does not reintroduce UI Settings');
pnpm('install', '--frozen-lockfile', '--ignore-scripts', '--no-optional', '--force');
checkAbsent();
console.log('PASS: reinstalling the profile does not reintroduce UI Settings');
add(`${settings}@0.2.2-rc.1`);
assert.equal(manifest(settings).version, '0.2.2-rc.1');
pnpm('install', '--frozen-lockfile', '--ignore-scripts', '--no-optional');
assert.equal(manifest(settings).version, '0.2.2-rc.1');
const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
assert.equal(lock.includes(`${settings}@0.1.7-rc.1`), false);
console.log('PASS: an explicitly provided UI Settings 0.2.2-rc.1 is retained without an old copy');
console.log('Installation checks passed. This does not exercise DSH startup, browser rendering, or QQ transport.');
