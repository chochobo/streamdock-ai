import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readClaudeUsage } from '../src/usage-claude.mjs';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-claude-usage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
async function file(home, relative, value) {
  const target = path.join(home, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
  return target;
}
const capture = '.cache/streamdock-ai/usage/claude-statusline.json';
const deck = '.cache/d200/claude_status.json';
const now = Date.parse('2026-11-09T01:00:00Z');

test('missing snapshots produce unavailable, never fabricated zero', async t => {
  const result = await readClaudeUsage({ home: await fixture(t), now });
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].status, 'unavailable');
  assert.deepEqual(result.accounts[0].windows, []);
});

test('reads captured official windows and never leaks other fields', async t => {
  const home = await fixture(t);
  await file(home, capture, { provider: 'claude', source: 'claude-statusline', account: 'unknown', observedAt: new Date(now - 1000).toISOString(), fiveHour: { usedPercentage: 0, resetsAt: '2026-11-09T03:00:00Z' }, sevenDay: { usedPercentage: 62.5, resetsAt: '2026-11-14T00:00:00Z' }, secret: 'DO_NOT_RETURN', prompt: 'DO_NOT_RETURN' });
  const { accounts } = await readClaudeUsage({ home, now });
  assert.equal(accounts[0].status, 'ok');
  assert.equal(accounts[0].windows[0].usedPercent, 0);
  assert.equal(accounts[0].windows[1].usedPercent, 62.5);
  assert.equal(accounts[0].windows[0].resetsAt, '2026-11-09T03:00:00.000Z');
  assert.match(accounts[0].label, /계정 미확인/);
  assert.doesNotMatch(JSON.stringify(accounts), /DO_NOT_RETURN/);
});

test('marks snapshots stale after age threshold or a reset time', async t => {
  const home = await fixture(t);
  await file(home, capture, { provider: 'claude', source: 'claude-statusline', observedAt: new Date(now - 60_000).toISOString(), fiveHour: { usedPercentage: 25, resetsAt: new Date(now - 1000).toISOString() } });
  assert.equal((await readClaudeUsage({ home, now })).accounts[0].status, 'stale');
  await file(home, capture, { provider: 'claude', source: 'claude-statusline', observedAt: new Date(now - 20 * 60_000).toISOString(), fiveHour: { usedPercentage: 25, resetsAt: new Date(now + 1000).toISOString() } });
  assert.equal((await readClaudeUsage({ home, now })).accounts[0].status, 'stale');
});

test('reads AgentDeck snapshot independently without treating it as the same account', async t => {
  const home = await fixture(t);
  await file(home, capture, { provider: 'claude', source: 'claude-statusline', observedAt: new Date(now).toISOString(), fiveHour: { usedPercentage: 30, resetsAt: new Date(now + 10000).toISOString() } });
  const legacy = await file(home, deck, { rate_limits: { five_hour: { used_percentage: 45, resets_at: (now + 30000) / 1000 } }, ignored: 'SECRET' });
  await utimes(legacy, new Date(now), new Date(now));
  const { accounts } = await readClaudeUsage({ home, now });
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.map(a => a.windows[0].usedPercent), [30, 45]);
  assert.notEqual(accounts[0].id, accounts[1].id);
  assert.doesNotMatch(JSON.stringify(accounts), /SECRET/);
});

test('invalid, oversized, future and symlink snapshots are rejected', async t => {
  const home = await fixture(t);
  await file(home, capture, '{bad');
  assert.equal((await readClaudeUsage({home, now})).accounts[0].status, 'unavailable');
  await file(home, capture, JSON.stringify({provider:'claude', source:'claude-statusline', observedAt:new Date(now + 120_000).toISOString(), fiveHour:{usedPercentage:12}}));
  assert.equal((await readClaudeUsage({home, now})).accounts[0].status, 'unavailable');
  const capturePath=await file(home, capture, 'x'.repeat(70_000));
  assert.equal((await readClaudeUsage({home, now})).accounts[0].status, 'unavailable');
  await rm(capturePath);
  const other = await file(home, 'other.json', { provider:'claude', source:'claude-statusline', observedAt:new Date(now).toISOString(), fiveHour:{usedPercentage:12} });
  await symlink(other, capturePath);
  assert.equal((await readClaudeUsage({home, now})).accounts[0].status, 'unavailable');
});
