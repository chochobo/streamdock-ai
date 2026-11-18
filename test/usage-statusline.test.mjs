import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const install = fileURLToPath(new URL('../scripts/install-usage-statusline.mjs', import.meta.url));
const capture = fileURLToPath(new URL('../scripts/usage-statusline.py', import.meta.url));
async function home() { return fs.mkdtemp(path.join(os.tmpdir(), 'streamdock-usage-test-')); }
const envFor = home => ({ ...process.env, HOME: home });
const runInstall = (h, args = []) => spawnSync(process.execPath, [install, ...args], { env: envFor(h), encoding: 'utf8' });
const settingsFile = h => path.join(h, '.claude', 'settings.json');

test('captures documented quota fields only and faithfully forwards stdin', async t => {
  const h = await home(); t.after(() => fs.rm(h, { recursive: true, force: true }));
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 0, resets_at: 1800000000 }, seven_day: { used_percentage: 42.5, resets_at: 1800600000 } }, secret: 'must-not-persist' });
  const out = spawnSync('/usr/bin/python3', [capture, '--tee'], { env: envFor(h), input, encoding: 'utf8' });
  assert.equal(out.status, 0); assert.equal(out.stdout, input); assert.equal(out.stderr, '');
  const p = path.join(h, '.cache', 'streamdock-ai', 'usage', 'claude-statusline.json');
  const raw = await fs.readFile(p, 'utf8');
  assert.equal(raw.includes('must-not-persist'), false);
  const q = JSON.parse(raw);
  assert.equal(q.fiveHour.usedPercentage, 0); assert.equal(q.sevenDay.usedPercentage, 42.5);
  assert.equal(q.fiveHour.resetsAt, '2027-01-15T08:00:00Z');
  assert.equal(q.account, 'unknown');
  assert.equal((await fs.stat(p)).mode & 0o777, 0o600);
  spawnSync('/usr/bin/python3', [capture, '--tee'], { env: envFor(h), input: '{"rate_limits":{}}', encoding: 'utf8' });
  assert.equal(await fs.readFile(p, 'utf8'), raw);
});

test('preserves original shell command, output and exit status; installs and removes idempotently', async t => {
  const h = await home(); t.after(() => fs.rm(h, { recursive: true, force: true }));
  await fs.mkdir(path.join(h, '.claude'));
  const initial = { statusLine: { type: 'command', command: 'cat; printf "diagnostic" >&2; exit 7 # trailing comment', padding: 2 }, hooks: { Existing: [] }, another: 42 };
  await fs.writeFile(settingsFile(h), JSON.stringify(initial));
  const first = runInstall(h); assert.equal(first.status, 0, first.stderr);
  const updated = JSON.parse(await fs.readFile(settingsFile(h), 'utf8'));
  assert.deepEqual(updated.hooks, initial.hooks); assert.equal(updated.another, 42); assert.equal(updated.statusLine.padding, 2);
  assert.equal(runInstall(h).status, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile(h), 'utf8')), updated);
  const payload = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 1800000000 } } });
  const result = spawnSync('/bin/sh', ['-c', updated.statusLine.command], { env: envFor(h), input: payload, encoding: 'utf8' });
  assert.equal(result.status, 7); assert.equal(result.stdout, payload); assert.equal(result.stderr, 'diagnostic');
  const removed = runInstall(h, ['--remove']); assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile(h), 'utf8')), initial);
  assert.equal(runInstall(h, ['--remove']).status, 0);
});

test('refuses to overwrite a status line changed after installation', async t => {
  const h = await home(); t.after(() => fs.rm(h, { recursive: true, force: true }));
  await fs.mkdir(path.join(h, '.claude'));
  await fs.writeFile(settingsFile(h), JSON.stringify({ statusLine: { type: 'command', command: 'cat' } }));
  assert.equal(runInstall(h).status, 0);
  const changed = JSON.parse(await fs.readFile(settingsFile(h), 'utf8'));
  changed.statusLine.command = 'new user command';
  await fs.writeFile(settingsFile(h), JSON.stringify(changed));
  assert.notEqual(runInstall(h, ['--remove']).status, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile(h), 'utf8')), changed);
});

test('removes its setting when there was no original status line', async t => {
  const h = await home(); t.after(() => fs.rm(h, { recursive: true, force: true }));
  await fs.mkdir(path.join(h, '.claude'));
  await fs.writeFile(settingsFile(h), '{"other":true}');
  assert.equal(runInstall(h).status, 0);
  assert.equal(runInstall(h, ['--remove']).status, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile(h), 'utf8')), { other: true });
});
