import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const hook = path.resolve('scripts/agent-hook.py');
function emit(home, event) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [hook, 'claude'], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`hook failed: ${code} ${error}`)));
    child.stdin.end(JSON.stringify(event));
  });
}

test('Claude subagent events cannot overwrite or delete the parent session state', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-hook-child-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const base = { session_id: 'parent-session', cwd: '/tmp/test-project' };
  await emit(home, { ...base, hook_event_name: 'PermissionRequest' });
  const directory = path.join(home, '.cache', 'streamdock-ai', 'agents');
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const read = async () => JSON.parse(await readFile(path.join(directory, files[0]), 'utf8'));
  const original = await read();
  assert.equal(original.status, 'blocked');
  assert.equal(original.event, 'PermissionRequest');
  assert.equal(original.confidence, 'inferred');
  for (const name of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'StopFailure', 'SessionEnd']) {
    await emit(home, { ...base, hook_event_name: name, agent_id: 'subagent-one' });
    assert.deepEqual(await read(), original, `${name} should not change parent`);
  }
  await emit(home, { ...base, hook_event_name: 'PostToolUse' });
  assert.equal((await read()).status, 'working');
  await emit(home, { ...base, hook_event_name: 'SessionEnd' });
  assert.deepEqual(await readdir(directory), []);
});

test('Claude Stop with active background work is not marked complete', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-hook-stop-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const base = { session_id: 'parent-session', cwd: '/tmp/test-project', hook_event_name: 'Stop' };
  const directory = path.join(home, '.cache', 'streamdock-ai', 'agents');
  await emit(home, { ...base, background_tasks: [{ status: 'running', description: 'PRIVATE BACKGROUND DESCRIPTION', command: 'PRIVATE COMMAND' }] });
  const [filename] = await readdir(directory);
  const raw = await readFile(path.join(directory, filename), 'utf8');
  const running = JSON.parse(raw);
  assert.equal(running.status, 'working');
  assert.equal(running.event, 'Stop');
  assert.equal(running.confidence, 'inferred');
  assert.ok(!raw.includes('PRIVATE'));
  await emit(home, { ...base, background_tasks: [] });
  const completed = JSON.parse(await readFile(path.join(directory, filename), 'utf8'));
  assert.equal(completed.status, 'done');
  assert.equal(completed.event, 'Stop');
  assert.equal(completed.confidence, undefined);
});

test('Claude delayed permission notification stays an inferred waiting status', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-hook-permission-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await emit(home, { session_id: 'parent-session', cwd: '/tmp/test-project', hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  const directory = path.join(home, '.cache', 'streamdock-ai', 'agents');
  const [filename] = await readdir(directory);
  const observed = JSON.parse(await readFile(path.join(directory, filename), 'utf8'));
  assert.equal(observed.status, 'blocked');
  assert.equal(observed.event, 'Notification');
  assert.equal(observed.confidence, 'inferred');
});
