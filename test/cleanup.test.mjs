import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCleanupService, parseMolePreview, runCleanupProcess } from '../src/cleanup.mjs';

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'streamdock-cleanup-test-'));
  const home = await fs.realpath(temporary);
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const target = path.join(home, 'Cache', 'example');
  await fs.mkdir(path.dirname(target));
  await fs.writeFile(target, 'fixture');
  return { home, target };
}

test('runs commands without a shell and terminates timeouts', async () => {
  const result = await runCleanupProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'literal $(touch no-file)'], { timeout: 2000 });
  assert.equal(result.stdout, 'literal $(touch no-file)');
  await assert.rejects(runCleanupProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 60 }), error => error.reason === 'timeout');
});

test('parses reviewed Mole targets, rejects partial, foreign and malformed data', async t => {
  const { home, target } = await fixture(t);
  const list = `# Mole Cleanup Preview - fixture\n\n=== Cache ===\n${target}  # 1 KB\n`;
  const result = parseMolePreview('clean', 'Potential space: 1 KB | Items: 1', list, home);
  assert.equal(result.complete, true);
  assert.deepEqual(result.targets, [{ path: target, estimatedBytes: 1024 }]);
  assert.equal(parseMolePreview('clean', 'Potential space: 1 KB+', list, home).complete, false);
  assert.equal(parseMolePreview('clean', 'Potential space: 1 KB', '# Mole Cleanup Preview\n/etc/passwd  # 1 KB\n', home).complete, false);
  assert.equal(parseMolePreview('clean', 'Potential space: 1 KB\nTrash skipped, grant Full Disk Access', list, home).complete, false);
  const purge = parseMolePreview('purge', `[DRY RUN] ${target}, 1 KB\nWould free approximately: 1 KB | Items: 1`, '', home);
  assert.equal(purge.complete, true);
  assert.equal(purge.targets[0].path, target);
  assert.equal(parseMolePreview('purge', `[DRY RUN] ${target}, 1 KB\nWould free approximately: 1 KB | Items: 2`, '', home).complete, false);
});

test('Mole targets are reviewable but no confirmation can execute cleanup', async t => {
  const { home, target } = await fixture(t);
  const calls = [];
  const list = `# Mole Cleanup Preview - fixture\n=== Cache ===\n${target}  # 1 KB\n`;
  const runMole = async (bin, args) => {
    calls.push({ bin, args: [...args] });
    if (args[0] === '--version') return { stdout: 'Mole version 1.64.0', stderr: '' };
    if (args[1] === '--dry-run') return { stdout: 'Potential space: 1 KB | Items: 1', stderr: '' };
    throw new Error('Destructive execution must never occur');
  };
  const service = createCleanupService({ home, locateMole: async () => '/fixture/mo', runMole, readPreview: async () => list });
  const initial = await service.preview('clean');
  assert.equal(initial.ok, true);
  assert.equal(initial.complete, true);
  assert.equal(initial.executable, false);
  assert.deepEqual(initial.targets.map(item => item.path), [target]);
  assert.equal((await service.prepare('clean')).code, 'execution_unavailable');
  assert.equal((await service.confirm('arbitrary')).code, 'execution_unavailable');
  assert.equal(calls.some(call => call.args.length === 1 && call.args[0] === 'clean'), false);
  assert.equal(await fs.readFile(target, 'utf8'), 'fixture');
});

test('trash entries can be reviewed but cannot be deleted', async t => {
  const { home } = await fixture(t);
  const trash = path.join(home, '.Trash');
  await fs.mkdir(trash);
  await fs.writeFile(path.join(trash, 'review-me'), 'important');
  const service = createCleanupService({ home });
  const preview = await service.preview('trash');
  assert.equal(preview.ok, true);
  assert.equal(preview.count, 1);
  assert.equal(preview.executable, false);
  assert.equal(preview.targets[0].path, path.join(trash, 'review-me'));
  assert.match(preview.scope, /외장 볼륨/);
  assert.equal((await service.prepare('trash')).code, 'execution_unavailable');
  assert.equal((await service.confirm('arbitrary')).code, 'execution_unavailable');
  assert.equal(await fs.readFile(path.join(trash, 'review-me'), 'utf8'), 'important');
});

test('missing Mole and unreadable trash are unavailable rather than zero', async t => {
  const { home } = await fixture(t);
  const service = createCleanupService({ home, locateMole: async () => null });
  assert.equal((await service.preview('clean')).code, 'mole_missing');
  assert.equal((await service.preview('trash')).code, 'trash_unavailable');
});
