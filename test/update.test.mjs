import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdater, readUpdateConfig } from '../src/update.mjs';

const ROOT = '/fixture/streamdock-ai';
const URL = 'https://github.com/example/streamdock-ai.git';
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

function mockGit(overrides = {}) {
  const state = { head: OLD, remoteHead: NEW, url: URL, branch: 'main', dirty: false, rewrite: false,
    filters: false, httpConfig: false, ancestor: true, diff: 'diff --git a/a b/a\n+new\n', files: ['a'], ...overrides };
  const calls = [];
  const run = async (cwd, args) => {
    calls.push({ cwd, args: [...args] });
    const [cmd, sub] = args;
    if (cmd === 'rev-parse' && sub === '--show-toplevel') return { stdout: ROOT + '\n' };
    if (cmd === 'symbolic-ref') return { stdout: `refs/heads/${state.branch}\n` };
    if (cmd === 'remote') return { stdout: state.url + '\n' };
    if (cmd === 'status') return { stdout: state.dirty ? '?? private\0' : '' };
    if (cmd === 'check-ref-format') return { stdout: '' };
    if (cmd === 'rev-parse' && args[2] === 'HEAD^{commit}') return { stdout: state.head + '\n' };
    if (cmd === 'rev-parse' && String(args[2]).startsWith('refs/remotes/origin/')) return { stdout: state.head + '\n' };
    if (cmd === 'config' && args.some(value => value.includes('insteadof'))) {
      if (state.rewrite) return { stdout: 'url.https://elsewhere/.insteadof https://github.com/\n' };
      throw Object.assign(new Error('not found'), { code: 1 });
    }
    if (cmd === 'config' && args.some(value => value.startsWith('^http'))) {
      if (state.httpConfig) return { stdout: 'http.extraheader credential\n' };
      throw Object.assign(new Error('not found'), { code: 1 });
    }
    if (cmd === 'config') {
      if (state.filters) return { stdout: 'filter.example.smudge external\n' };
      throw Object.assign(new Error('not found'), { code: 1 });
    }
    if (cmd === 'ls-remote') return { stdout: `${state.remoteHead}\trefs/heads/main\n` };
    if (cmd === 'fetch' || cmd === 'cat-file') return { stdout: '' };
    if (cmd === 'merge-base') { if (!state.ancestor) throw Object.assign(new Error('not ancestor'), { code: 1 }); return { stdout: '' }; }
    if (cmd === 'diff' && args.includes('--name-only')) return { stdout: state.files.map(name => name + '\0').join('') };
    if (cmd === 'diff') return { stdout: state.diff };
    if (cmd === 'merge') { state.head = args.at(-1); if (state.dirtyAfterMerge) state.dirty = true; return { stdout: '' }; }
    throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
  };
  return { state, calls, run };
}

function updater(fake, overrides = {}) {
  return createUpdater({ root: ROOT, remoteUrl: URL, branch: 'main', run: fake.run,
    canonicalize: async value => value, ...overrides });
}

test('no configured or trusted remote means unavailable and no command runs', async () => {
  let calls = 0;
  const app = createUpdater({ root: ROOT, run: async () => { calls++; throw new Error('unexpected'); } });
  assert.equal((await app.check()).code, 'not_configured');
  assert.equal((await app.check({ remote: true })).code, 'not_configured');
  assert.equal((await app.prepare()).code, 'not_configured');
  assert.equal(calls, 0);
  for (const remoteUrl of ['file:///tmp/repo', 'https://user:secret@example.com/repo', 'https://example.com/repo?token=x', 'ssh://example.com/repo']) {
    assert.equal((await createUpdater({ root: ROOT, remoteUrl, run: async () => { calls++; } }).check()).code, 'not_configured');
  }
  assert.equal(calls, 0);
});

test('check is local by default, and remote lookup is explicit', async () => {
  const fake = mockGit(); const app = updater(fake);
  const local = await app.check();
  assert.equal(local.status, 'local_only');
  assert.equal(fake.calls.some(call => call.args[0] === 'ls-remote' || call.args[0] === 'fetch'), false);
  const remote = await app.check({ remote: true });
  assert.equal(remote.status, 'update_available');
  assert.equal(remote.current, OLD);
  assert.equal(remote.latest, NEW);
  assert.equal(fake.calls.filter(call => call.args[0] === 'ls-remote').length, 1);
  assert.equal(fake.calls.some(call => call.args[0] === 'fetch'), false);
});

test('dirty, wrong remote, rewrite and filters prevent network and update', async () => {
  for (const [overrides, code] of [[{ dirty: true }, 'dirty'], [{ url: 'https://other.invalid/x' }, 'remote_mismatch'],
    [{ branch: 'other' }, 'wrong_branch'], [{ rewrite: true }, 'url_rewrite'], [{ filters: true }, 'filter_config'], [{ httpConfig: true }, 'http_config']]) {
    const fake = mockGit(overrides);
    assert.equal((await updater(fake).prepare()).code, code);
    assert.equal(fake.calls.some(call => ['ls-remote', 'fetch', 'merge'].includes(call.args[0])), false);
  }
});

test('optional configuration is strict, local-only and never returns credentials', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamdock-update-config-'));
  const file = path.join(dir, 'update.json');
  try {
    assert.equal((await readUpdateConfig({ file })).code, 'not_configured');
    await fs.writeFile(file, JSON.stringify({ enabled: true, remoteUrl: URL, branch: 'main' }));
    assert.deepEqual(await readUpdateConfig({ file }), { enabled: true, status: 'configured', remoteUrl: URL, branch: 'main' });
    await fs.writeFile(file, JSON.stringify({ enabled: false }));
    assert.deepEqual(await readUpdateConfig({ file }), { enabled: false, status: 'disabled' });
    for (const value of [
      { enabled: true, remoteUrl: 'https://user:secret@example.com/repo', branch: 'main' },
      { enabled: true, remoteUrl: 'https://example.com/repo?token=secret', branch: 'main' },
      { enabled: true, remoteUrl: URL, branch: '../unsafe' },
      { enabled: true, remoteUrl: URL, branch: 'main', extra: 'secret' },
    ]) {
      await fs.writeFile(file, JSON.stringify(value));
      const result = await readUpdateConfig({ file });
      assert.equal(result.code, 'invalid_config');
      assert.equal(JSON.stringify(result).includes('secret'), false);
    }
    await fs.unlink(file);
    await fs.symlink('/etc/passwd', file);
    assert.equal((await readUpdateConfig({ file })).code, 'invalid_config');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('prepares complete diff and applies only a one-use confirmed fast-forward', async () => {
  const fake = mockGit(); const app = updater(fake);
  const prepared = await app.prepare();
  assert.equal(prepared.status, 'review');
  assert.deepEqual(prepared.plan.files, ['a']);
  assert.match(prepared.plan.diff, /\+new/);
  assert.equal(prepared.plan.current, OLD);
  assert.equal(prepared.plan.target, NEW);
  assert.equal(fake.calls.filter(call => call.args[0] === 'fetch').length, 1);
  assert.equal(fake.calls.some(call => call.args[0] === 'merge'), false);
  assert.equal((await app.apply('wrong-token')).code, 'invalid_confirmation');
  const result = await app.apply(prepared.token);
  assert.equal(result.status, 'updated');
  assert.equal(result.current, NEW);
  const merged = fake.calls.find(call => call.args[0] === 'merge');
  assert.deepEqual(merged.args, ['merge', '--ff-only', '--no-overwrite-ignore', NEW]);
  assert.equal((await app.apply(prepared.token)).code, 'expired');
});

test('reports local changes found after updating', async () => {
  const fake = mockGit({ dirtyAfterMerge: true }); const app = updater(fake);
  const prepared = await app.prepare();
  const result = await app.apply(prepared.token);
  assert.equal(result.status, 'updated_with_local_changes');
  assert.equal(result.current, NEW);
});

test('refuses non-fast-forward, stale remote, changed diff, dirty state and expired plans', async () => {
  let fake = mockGit({ ancestor: false });
  assert.equal((await updater(fake).prepare()).code, 'not_fast_forward');
  assert.equal(fake.calls.some(call => call.args[0] === 'merge'), false);
  for (const change of ['remote', 'diff', 'dirty', 'head']) {
    fake = mockGit(); const app = updater(fake); const prepared = await app.prepare();
    if (change === 'remote') fake.state.remoteHead = OTHER;
    if (change === 'diff') fake.state.diff += 'changed\n';
    if (change === 'dirty') fake.state.dirty = true;
    if (change === 'head') fake.state.head = OTHER;
    assert.equal((await app.apply(prepared.token)).ok, false);
    assert.equal(fake.calls.some(call => call.args[0] === 'merge'), false);
  }
  fake = mockGit(); let now = Date.now(); const app = updater(fake, { clock: () => now });
  const prepared = await app.prepare(); now += 120_001;
  assert.equal((await app.apply(prepared.token)).code, 'expired');
  assert.equal(fake.calls.some(call => call.args[0] === 'merge'), false);
});
