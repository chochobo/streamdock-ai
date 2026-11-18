import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPresenceProvider } from '../src/presence.mjs';

const rootId = '018f0011-2222-7333-8444-555555555555';
const claudeId = '018f0011-2222-7333-8444-666666666666';
const hash = (prefix, id) => `${prefix}-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-presence-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', '09');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-11-09T01-00-00-${rootId}.jsonl`);
  await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: rootId } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { secret: 'do-not-output' } }) + '\n');
  return { home, file };
}

function makeRun(file, { extraClaude = false, reused = false, failingLsof = false, unrelated = false } = {}) {
  const calls = [];
  let identityCalls = 0;
  const app = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  const code = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const claude = '/Applications/Claude.app/Contents/MacOS/claude';
  const list = [` 100 1 501 ${app}`, ` 200 ${unrelated ? '300' : '100'} 501 ${code}`, ` 201 200 501 ${claude}`, ...(extraClaude ? [` 202 200 501 ${claude}`] : []), ` 203 200 502 ${claude}`].join('\n');
  async function run(cmd, args) {
    calls.push({ cmd, args });
    if (cmd === '/bin/ps' && args.includes('-axo')) return { stdout: list };
    if (cmd === '/bin/ps' && args.includes('-p')) {
      const pid = args[args.indexOf('-p') + 1];
      if (args.includes('args=')) return { stdout: pid === '200' ? `${code} app-server` : pid === '201' ? `${claude} --resume=${claudeId}` : `${claude} -p` };
      if (pid === '200') { identityCalls++; if (reused && identityCalls > 1) return { stdout: `200 100 501 changed ${code}` }; }
      const parent = pid === '200' ? (unrelated ? '300' : '100') : '200';
      return { stdout: `${pid} ${parent} 501 stable-start ${pid === '200' ? code : claude}` };
    }
    if (cmd === '/usr/sbin/lsof') {
      if (failingLsof) throw new Error('permission denied');
      return { stdout: `p200\nn${file}\nn${file}\n` };
    }
    throw new Error('Unexpected command');
  }
  return { run, calls };
}

test('discovers only opaque IDs from matching live desktop processes and caches scans', async t => {
  const { home, file } = await fixture(t);
  const mock = makeRun(file);
  let clock = 10000;
  const provider = createPresenceProvider({ home, platform: 'darwin', uid: 501, run: mock.run, now: () => clock, cacheMs: 5000 });
  const first = await provider.read();
  assert.equal(first.codex.available, true);
  assert.deepEqual([...first.codex.ids], [hash('codex', rootId)]);
  assert.equal(first.claude.available, true);
  assert.deepEqual([...first.claude.ids], [hash('claude-code', claudeId)]);
  const count = mock.calls.length;
  first.codex.ids.clear();
  assert.equal((await provider.read()).codex.ids.size, 1, 'callers cannot mutate cached sets');
  assert.equal(mock.calls.length, count);
  clock += 5001;
  await provider.read();
  assert.ok(mock.calls.length > count);
});

test('partial Claude process evidence remains unknown and PID reuse fails closed', async t => {
  const { home, file } = await fixture(t);
  const mock = makeRun(file, { extraClaude: true, reused: true });
  const result = await createPresenceProvider({ home, platform: 'darwin', uid: 501, run: mock.run }).read();
  assert.equal(result.codex.available, false);
  assert.equal(result.codex.ids.size, 0);
  assert.equal(result.claude.available, false);
  assert.ok(result.claude.ids.has(hash('claude-code', claudeId)), 'positive evidence survives partial scan');
});

test('never checks unrelated app-server processes and failures are unknown', async t => {
  const { home, file } = await fixture(t);
  const unrelated = makeRun(file, { unrelated: true });
  const result = await createPresenceProvider({ home, platform: 'darwin', uid: 501, run: unrelated.run }).read();
  assert.equal(result.codex.available, true);
  assert.equal(result.codex.ids.size, 0);
  assert.equal(unrelated.calls.some(c => c.cmd === '/usr/sbin/lsof'), false);
  const failing = makeRun(file, { failingLsof: true });
  assert.equal((await createPresenceProvider({ home, platform: 'darwin', uid: 501, run: failing.run }).read()).codex.available, false);
  const unsupported = await createPresenceProvider({ home, platform: 'linux', uid: 501, run: unrelated.run }).read();
  assert.equal(unsupported.codex.available, false);
  assert.equal(unsupported.claude.available, false);
});

test('unreadable rollout metadata does not prove a session absent', async t => {
  const { home, file } = await fixture(t);
  await rm(file);
  const mock = makeRun(file);
  const result = await createPresenceProvider({ home, platform: 'darwin', uid: 501, run: mock.run }).read();
  assert.equal(result.codex.available, false);
  assert.equal(result.codex.ids.size, 0);
});
