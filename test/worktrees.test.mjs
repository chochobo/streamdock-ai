import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanWorktrees, createWorktreeService } from '../src/worktrees.mjs';

const exec = promisify(execFile);
async function git(cwd, ...args) {
  return exec('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
}
async function fixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'streamdock-worktree-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'repo');
  const worktree = path.join(tmp, 'linked worktree');
  await fs.mkdir(repo);
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Fixture');
  await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(repo, 'README'), 'fixture\n');
  await git(repo, 'add', 'README');
  await git(repo, 'commit', '-m', 'fixture');
  await git(repo, 'worktree', 'add', '-b', 'fixture-branch', worktree, 'main');
  return { tmp, repo: await fs.realpath(repo), worktree: await fs.realpath(worktree) };
}

test('marks a clean merged linked worktree reviewable only with complete activity evidence', async t => {
  const { repo, worktree } = await fixture(t);
  let result = await scanWorktrees({ roots: [repo] });
  let item = result.items.find(entry => entry.path === worktree);
  assert.equal(result.items.length, 2);
  assert.equal(item.merged, true);
  assert.equal(item.dirty, 0);
  assert.equal(item.ignored, 0);
  assert.equal(item.eligible, false);
  assert.ok(item.reasons.some(reason => reason.includes('세션')));
  result = await scanWorktrees({ roots: [repo, worktree], activity: { complete: true, paths: [] } });
  assert.equal(result.items.length, 2, 'same repository is not duplicated');
  item = result.items.find(entry => entry.path === worktree);
  assert.equal(item.state, 'reviewable');
  assert.equal(item.eligible, true);
  assert.equal(item.executable, false);
  assert.equal(result.items.find(entry => entry.main).eligible, false);
  result = await scanWorktrees({ roots: [repo], activity: { complete: true, paths: [worktree] } });
  item = result.items.find(entry => entry.path === worktree);
  assert.equal(item.state, 'active');
  assert.equal(item.eligible, false);
});

test('blocks dirty, ignored, locked, unmerged and unknown worktrees', async t => {
  const { repo, worktree } = await fixture(t);
  const scan = () => scanWorktrees({ roots: [repo], activity: { complete: true, paths: [] } });
  await fs.writeFile(path.join(worktree, 'new-file'), 'unsaved');
  let item = (await scan()).items.find(entry => entry.path === worktree);
  assert.equal(item.state, 'dirty');
  assert.equal(item.eligible, false);
  await fs.unlink(path.join(worktree, 'new-file'));
  await fs.appendFile(path.join(repo, '.git', 'info', 'exclude'), '\nprivate-cache/\n');
  await fs.mkdir(path.join(worktree, 'private-cache'));
  await fs.writeFile(path.join(worktree, 'private-cache', 'saved'), 'keep');
  item = (await scan()).items.find(entry => entry.path === worktree);
  assert.equal(item.state, 'ignored');
  assert.equal(item.eligible, false);
  await fs.rm(path.join(worktree, 'private-cache'), { recursive: true });
  await git(repo, 'worktree', 'lock', worktree);
  item = (await scan()).items.find(entry => entry.path === worktree);
  assert.equal(item.state, 'locked');
  assert.equal(item.eligible, false);
  await git(repo, 'worktree', 'unlock', worktree);
  await fs.writeFile(path.join(worktree, 'feature'), 'commit\n');
  await git(worktree, 'add', 'feature');
  await git(worktree, 'commit', '-m', 'feature');
  item = (await scan()).items.find(entry => entry.path === worktree);
  assert.equal(item.merged, false);
  assert.equal(item.eligible, false);
  const unknown = await scanWorktrees({ roots: [repo], activity: { complete: true, paths: ['/no/such/session/path'] } });
  assert.equal(unknown.items.find(entry => entry.path === worktree).activityComplete, false);
});

test('returns a reviewable plan but blocks removal regardless of confirmation', async t => {
  const { repo, worktree } = await fixture(t);
  const service = createWorktreeService({ roots: [repo], getActivity: async () => ({ complete: true, paths: [] }) });
  const list = await service.list();
  const item = list.items.find(entry => entry.path === worktree);
  const proposed = await service.prepareRemoval(item.id);
  assert.equal(proposed.ok, true);
  assert.equal(proposed.stage, 'review');
  assert.equal(proposed.code, 'execution_unavailable');
  assert.equal(proposed.plan.path, worktree);
  assert.equal(proposed.plan.executable, false);
  assert.match(proposed.plan.blockedReason, /안전성/);
  for (const value of [undefined, 'first', 'second']) assert.equal((await service.confirmRemoval(value)).code, 'execution_unavailable');
  assert.equal((await fs.stat(worktree)).isDirectory(), true);
  await git(repo, 'show-ref', '--verify', 'refs/heads/fixture-branch');
});

test('returns a blocked plan for modified or active worktrees', async t => {
  const { repo, worktree } = await fixture(t);
  await fs.writeFile(path.join(worktree, 'new-file'), 'keep');
  const service = createWorktreeService({ roots: [repo], getActivity: async () => ({ complete: true, paths: [worktree] }) });
  const item = (await service.list()).items.find(entry => entry.path === worktree);
  const result = await service.prepareRemoval(item.id);
  assert.equal(result.ok, true);
  assert.equal(result.plan.eligible, false);
  assert.equal(result.plan.executable, false);
  assert.ok(result.plan.reasons.length > 0);
  assert.equal(await fs.readFile(path.join(worktree, 'new-file'), 'utf8'), 'keep');
});

test('rejects unscoped requests without changing a worktree', async t => {
  const { repo, worktree } = await fixture(t);
  const service = createWorktreeService({ roots: [repo] });
  assert.equal((await service.prepareRemoval('unknown')).code, 'not_found');
  assert.equal((await fs.stat(worktree)).isDirectory(), true);
  await assert.rejects(scanWorktrees({ roots: Array(17).fill(repo) }), TypeError);
});