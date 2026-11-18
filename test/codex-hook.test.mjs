import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const hook = fileURLToPath(new URL('../scripts/codex-hook.py', import.meta.url));
const installer = fileURLToPath(new URL('../scripts/install-codex-hook.mjs', import.meta.url));
async function temporary(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-hook-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
function callHook(home, data) {
  const result = spawnSync('/usr/bin/python3', [hook], { env: { ...process.env, HOME: home }, input: JSON.stringify(data), encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
}
function callInstaller(home, ...args) { return spawnSync(process.execPath, [installer, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 5000 }); }

test('Codex lifecycle records inferred events without storing prompt or tool content', async t => {
  const home = await temporary(t);
  const session = 'abc-session';
  const digest = createHash('sha256').update(session).digest('hex').slice(0, 24);
  const file = path.join(home, '.cache/streamdock-ai/agents', `codex-lifecycle-${digest}.json`);
  const base = { session_id: session, cwd: '/work/demo', turn_id: 'turn-one' };
  const read = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  callHook(home, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE_PROMPT' });
  let record = await read();
  assert.equal(record.id, `codex-${digest}`); assert.equal(record.status, 'working'); assert.equal(record.presence, 'live');
  assert.equal(record.project, 'demo'); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(record).includes('PRIVATE_PROMPT'));
  callHook(home, { ...base, hook_event_name: 'PermissionRequest', tool_input: { command: 'PRIVATE_COMMAND' } });
  record = await read(); assert.equal(record.status, 'blocked'); assert.equal(record.confidence, 'inferred');
  assert.ok(!JSON.stringify(record).includes('PRIVATE_COMMAND'));
  callHook(home, { ...base, turn_id: 'child-turn', hook_event_name: 'PostToolUse', tool_response: 'PRIVATE_RESPONSE' });
  assert.equal((await read()).status, 'blocked');
  callHook(home, { ...base, agent_id: 'child', hook_event_name: 'PostToolUse' });
  assert.equal((await read()).status, 'blocked');
  callHook(home, { ...base, hook_event_name: 'PostToolUse' }); assert.equal((await read()).status, 'working');
  callHook(home, { ...base, hook_event_name: 'SessionStart', source: 'compact' }); assert.equal((await read()).status, 'working');
  callHook(home, { ...base, hook_event_name: 'Stop', last_assistant_message: 'PRIVATE_REPLY' });
  record = await read(); assert.equal(record.status, 'unknown'); assert.ok(!JSON.stringify(record).includes('PRIVATE_REPLY'));
  callHook(home, { ...base, hook_event_name: 'SessionEnd' }); record = await read();
  assert.equal(record.presence, 'ended'); assert.equal(record.status, 'unknown');
});

test('installer preserves existing hooks, backs up, is idempotent and removes only its own entries', async t => {
  const home = await temporary(t); const dir = path.join(home, '.codex'); const config = path.join(dir, 'hooks.json');
  await fs.mkdir(dir, { recursive: true });
  const original = { description: 'preserve', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } };
  await fs.writeFile(config, JSON.stringify(original));
  let result = callInstaller(home); assert.equal(result.status, 0, result.stderr);
  let value = JSON.parse(await fs.readFile(config, 'utf8'));
  assert.deepEqual(value.hooks.PreToolUse[0], original.hooks.PreToolUse[0]);
  assert.equal(value.hooks.PreToolUse.length, 2); assert.equal(value.hooks.SessionEnd.length, 1);
  assert.equal((await fs.stat(config)).mode & 0o777, 0o600);
  assert.ok((await fs.readdir(dir)).some(name => name.startsWith('hooks.json.streamdock-backup-')));
  result = callInstaller(home); assert.equal(result.status, 0); value = JSON.parse(await fs.readFile(config, 'utf8')); assert.equal(value.hooks.PreToolUse.length, 2);
  result = callInstaller(home, '--remove'); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')), original);
});

test('installer leaves malformed hooks untouched', async t => {
  const home = await temporary(t); const dir = path.join(home, '.codex'); const config = path.join(dir, 'hooks.json');
  await fs.mkdir(dir, { recursive: true }); await fs.writeFile(config, '{broken');
  const result = callInstaller(home); assert.notEqual(result.status, 0); assert.equal(await fs.readFile(config, 'utf8'), '{broken');
});
