import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLaunchdPlan, manualLaunchdCommands } from '../src/launchd.mjs';

const exec = promisify(execFile);
const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(PROJECT, 'scripts', 'launchd-plan.mjs');
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamdock-launchd-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return fs.realpath(dir);
}

test('generates escaped reviewable user agent without starting or installing it', async t => {
  const dir = await temp(t);
  const plan = createLaunchdPlan({ root: '/tmp/A & B', node: '/usr/local/bin/node', home: '/tmp/User Home',
    uid: 501, codexDir: '/Applications/ChatGPT.app/Contents/MacOS', port: 4174, device: true });
  assert.match(plan.plist, /A &amp; B/);
  assert.match(plan.plist, /<string>--device<\/string>/);
  assert.match(plan.plist, /<key>KeepAlive<\/key><false\/>/);
  assert.equal(plan.destination, '/tmp/User Home/Library/LaunchAgents/local.streamdock-ai.plist');
  if (process.platform === 'darwin') {
    const file = path.join(dir, 'review.plist');
    await fs.writeFile(file, plan.plist);
    await exec('/usr/bin/plutil', ['-lint', file]);
  }
});

test('manual bootstrap is gated on identical plist and safely quoted', () => {
  const plan = createLaunchdPlan({ root: '/tmp/app', node: '/tmp/node', home: '/tmp/home', uid: 501 });
  const [command] = manualLaunchdCommands(plan, "/tmp/with ' quote $(touch nope).plist");
  assert.match(command, /cmp/);
  assert.ok(command.indexOf('cmp') < command.indexOf('launchctl'));
  assert.match(command, /&&/);
  assert.match(command, /'\\''/);
  assert.throws(() => manualLaunchdCommands(plan, 'relative.plist'), TypeError);
});

test('rejects invalid paths, ports, root identity and PATH separators', () => {
  const base = { root: '/tmp/app', node: '/tmp/node', home: '/tmp/home', uid: 501 };
  for (const options of [ { port: 0 }, { port: 65536 }, { root: 'relative' }, { uid: 0 },
    { node: '/tmp/node\nmalicious' }, { codexDir: '/tmp/x:/tmp/y' }, { device: 'yes' } ]) {
    assert.throws(() => createLaunchdPlan({ ...base, ...options }));
  }
});

test('CLI writes one review file only and does not overwrite or invoke launchctl', async t => {
  const dir = await temp(t);
  const target = path.join(dir, 'review.plist');
  const env = { ...process.env, HOME: dir, PATH: '/usr/bin:/bin' };
  const result = await exec(process.execPath, [SCRIPT, '--device', '--write', target], { env });
  assert.match(result.stdout, /Review file:/);
  const original = await fs.readFile(target, 'utf8');
  assert.match(original, /--device/);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  await assert.rejects(exec(process.execPath, [SCRIPT, '--write', target], { env }));
  assert.equal(await fs.readFile(target, 'utf8'), original);
  await assert.rejects(fs.stat(path.join(dir, 'Library', 'LaunchAgents')), error => error.code === 'ENOENT');
});

test('CLI refuses review output in an auto-load directory including a symlink', async t => {
  const dir = await temp(t);
  const parent = path.join(dir, 'Library');
  const actual = path.join(dir, 'linked-agent-dir');
  await fs.mkdir(parent);
  await fs.mkdir(actual);
  await fs.symlink(actual, path.join(parent, 'LaunchAgents'));
  const env = { ...process.env, HOME: dir, PATH: '/usr/bin:/bin' };
  const output = path.join(actual, 'candidate.plist');
  await assert.rejects(exec(process.execPath, [SCRIPT, '--write', output], { env }), /auto-load/);
  await assert.rejects(fs.stat(output), error => error.code === 'ENOENT');
});
