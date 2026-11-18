import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCredits } from '../src/credits.mjs';

const NOW = Date.parse('2026-11-09T00:00:00Z');
async function fixture(t) { const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-credits-')); t.after(() => rm(home, { recursive: true, force: true })); return home; }
async function write(home, relative, value) { const file = path.join(home, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); return file; }

test('sources stay disabled until explicitly configured and never read incidental cache', async t => {
  const home = await fixture(t);
  await write(home, '.cache/d200/flow.json', { checked: new Date(NOW).toISOString(), credits: 22 });
  const r = await readCredits({ home, now: NOW });
  assert.deepEqual(r.services.map(s => s.status), ['not-configured', 'not-configured']);
  assert.equal(r.services[0].balance, null);
});

test('reads only configured credit metadata and marks aged values and inferred reset', async t => {
  const home = await fixture(t);
  await write(home, '.config/streamdock-ai/credits.json', { sources: { flow: { enabled: true, source: 'agentdeck-cache' }, higgsfield: { enabled: true, source: 'snapshot' } } });
  await write(home, '.cache/d200/flow.json', { checked: new Date(NOW - 1000).toISOString(), credits: 0, total: 100, reset: '2026-11-10T00:00:00Z', tier: 'SECRET-TOKEN', email: 'PRIVATE', token: 'SECRET' });
  await write(home, '.cache/streamdock-ai/credits/higgsfield.json', { checkedAt: new Date(NOW - 4 * 3600000).toISOString(), balance: 22, total: 50 });
  const r = await readCredits({ home, now: NOW });
  assert.equal(r.services[0].status, 'ok'); assert.equal(r.services[0].balance, 0); assert.equal(r.services[0].resetQuality, 'source-estimate');
  assert.equal(r.services[1].status, 'stale'); assert.equal(r.services[1].balance, 22);
  assert.ok(!JSON.stringify(r).includes('SECRET')); assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});

test('invalid, future, unconfigured source, and symlink snapshots fail closed', async t => {
  const home = await fixture(t);
  await write(home, '.config/streamdock-ai/credits.json', { sources: { flow: { enabled: true, source: 'snapshot' }, higgsfield: { enabled: true, source: 'cdp' } } });
  const dir = path.join(home, '.cache/streamdock-ai/credits'); await mkdir(dir, { recursive: true });
  const target = await write(home, 'outside.json', { checked: new Date(NOW).toISOString(), credits: 5 });
  await symlink(target, path.join(dir, 'flow.json'));
  let r = await readCredits({ home, now: NOW });
  assert.deepEqual(r.services.map(s => s.status), ['unavailable', 'unavailable']); assert.deepEqual(r.warnings.map(w => w.code), ['credits_browser_setup_required']);
  await rm(path.join(dir, 'flow.json')); await write(home, '.cache/streamdock-ai/credits/flow.json', { checked: new Date(NOW + 120000).toISOString(), credits: 2 });
  r = await readCredits({ home, now: NOW }); assert.equal(r.services[0].status, 'unavailable');
});

test('only recognized plan names are retained, including normal multiword names', async t => {
  const home = await fixture(t);
  await write(home, '.config/streamdock-ai/credits.json', { sources: { flow: { enabled: true, source: 'snapshot' }, higgsfield: { enabled: true, source: 'snapshot' } } });
  await write(home, '.cache/streamdock-ai/credits/flow.json', { checkedAt: new Date(NOW).toISOString(), balance: 10, tier: 'Pro Plan' });
  await write(home, '.cache/streamdock-ai/credits/higgsfield.json', { checkedAt: new Date(NOW).toISOString(), balance: 10, tier: 'Pro Monthly' });
  const safe = await readCredits({ home, now: NOW });
  assert.equal(safe.services[0].tier, 'Pro Plan'); assert.equal(safe.services[1].tier, 'Pro Monthly');
  await write(home, '.cache/streamdock-ai/credits/flow.json', { checkedAt: new Date(NOW).toISOString(), balance: 10, tier: 'SECRET TOKEN' });
  assert.equal((await readCredits({ home, now: NOW })).services[0].tier, '');
});

test('unsupported collection source reports a coded warning', async t => {
  const home = await fixture(t);
  await write(home, '.config/streamdock-ai/credits.json', { sources: { flow: { enabled: true, source: 'scrape' } } });
  const r = await readCredits({ home, now: NOW });
  assert.equal(r.services[0].status, 'unavailable');
  assert.deepEqual(r.warnings.map(w => w.code), ['credits_source_unsupported']);
  assert.match(r.warnings[0].message, /지원하지 않는 수집 방식/);
});
