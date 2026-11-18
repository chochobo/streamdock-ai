import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { createNativeProviderSettings } from '../src/native-provider-settings.mjs';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'native-provider-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, directory: path.join(home, '.config', 'streamdock-ai'), service: createNativeProviderSettings({ home }) };
}

test('provider settings do not contact network and safely create configuration', async t => {
  const { service, directory } = await fixture(t);
  const oldFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw Error('unexpected'); };
  t.after(() => { globalThis.fetch = oldFetch; });
  const before = await service.read('market');
  assert.equal(before.status, 'unconfigured'); assert.deepEqual(before.config.portfolio, []);
  const saved = await service.update('market', { revision: before.revision, patch: { portfolio: ['005930'], favoriteSectors: ['반도체'] } });
  assert.equal(saved.ok, true); assert.deepEqual(saved.config.portfolio, ['005930']);
  assert.equal((await stat(path.join(directory, 'market.json'))).mode & 0o777, 0o600);
  assert.equal(requests, 0);
});

test('editing preserves unrelated properties and rejects stale versions', async t => {
  const { service, directory } = await fixture(t); await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'parcels.json');
  await writeFile(file, JSON.stringify({ trackingOptIn: false, keep: { value: 7 }, parcels: [{ tracking: 'ABC12345', title: '택배', status: '배송 중', extra: 42 }] }));
  const first = await service.read('parcels');
  assert.equal(first.config.parcels[0].tracking, 'ABC12345'); assert.equal(first.config.parcels[0].title, '택배');
  assert.match(first.config.parcels[0].rowId, /^[a-f0-9]{32}$/);
  const saved = await service.update('parcels', { revision: first.revision, patch: { trackingOptIn: true, parcels: [{ ...first.config.parcels[0], title: '이름 수정' }] } });
  assert.equal(saved.ok, true);
  const disk = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(disk.keep, { value: 7 }); assert.equal(disk.parcels[0].extra, 42); assert.equal(disk.parcels[0].status, '배송 중');
  assert.deepEqual(await service.update('parcels', { revision: first.revision, patch: { trackingOptIn: false } }), { ok: false, code: 'changed' });
});

test('rejects unsafe targets and invalid credits configuration without modifying files', async t => {
  const { service } = await fixture(t);
  const remote = await service.read('remote');
  for (const host of ['-bad', 'a..b', 'example.com;touch']) {
    assert.equal((await service.update('remote', { revision: remote.revision, patch: { enabled: true, hosts: [{ label: 'test', ssh: host, port: 22, operations: ['machine'] }] } })).ok, false);
  }
  const credits = await service.read('credits');
  assert.equal((await service.update('credits', { revision: credits.revision, patch: { sources: { flow: { enabled: true, source: 'cdp' } } } })).ok, false);
  const enabled = await service.update('credits', { revision: credits.revision, patch: { sources: { flow: { enabled: true, source: 'cdp', dedicatedProfile: true, port: 9223 } } } });
  assert.equal(enabled.ok, true); assert.equal(enabled.config.sources.flow.port, 9223);
});

test('invalid or symlinked existing files are never overwritten', async t => {
  const { service, directory, home } = await fixture(t); await mkdir(directory, { recursive: true });
  const outside = path.join(home, 'outside'); await writeFile(outside, 'sentinel');
  await symlink(outside, path.join(directory, 'market.json'));
  const result = await service.read('market'); assert.equal(result.status, 'unavailable');
  assert.deepEqual(await service.update('market', { revision: 'a'.repeat(64), patch: { portfolio: [] } }), { ok: false, code: 'invalid' });
  assert.equal(await readFile(outside, 'utf8'), 'sentinel');
});

test('rejects symlinked config directories without creating outside files', async t => {
  const { service, home } = await fixture(t);
  const target = path.join(home, 'target'); await mkdir(target);
  await symlink(target, path.join(home, '.config'));
  const result = await service.read('market');
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(await service.update('market', { revision: 'a'.repeat(64), patch: { portfolio: [] } }), { ok: false, code: 'invalid' });
  await assert.rejects(stat(path.join(target, 'streamdock-ai')), { code: 'ENOENT' });
});

test('recognizes existing normalized parcel data without exposing unknown fields', async t => {
  const { service, directory } = await fixture(t); await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'parcels.json');
  await writeFile(file, JSON.stringify({ trackingOptIn: false, secret: 'PRIVATE-SENTINEL', parcels: [{ tracking: 'ab c12345', extra: 'private' }] }));
  const first = await service.read('parcels');
  assert.equal(first.config.parcels[0].tracking, 'ABC12345'); assert.equal(first.config.parcels[0].title, '택배');
  assert.match(first.config.parcels[0].rowId, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE-SENTINEL|private/);
  const saved = await service.update('parcels', { revision: first.revision, patch: { parcels: [{ ...first.config.parcels[0], title: '소포' }] } });
  assert.equal(saved.ok, true);
  const disk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(disk.secret, 'PRIVATE-SENTINEL'); assert.equal(disk.parcels[0].extra, 'private');
});

test('preserves hidden remote fields on rename and blocks unsafe endpoint changes', async t => {
  const { service, directory } = await fixture(t); await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'remote.json');
  await writeFile(file, JSON.stringify({ enabled: true, hosts: [{ label: '원본', ssh: 'user@example.invalid', port: 22, operations: ['machine'], extra: { keep: true } }] }));
  const first = await service.read('remote'); const host = first.config.hosts[0];
  assert.match(host.rowId, /^[a-f0-9]{32}$/); assert.equal(host.extra, undefined);
  const rejected = await service.update('remote', { revision: first.revision, patch: { hosts: [{ ...host, ssh: 'other@example.invalid' }] } });
  assert.deepEqual(rejected, { ok: false, code: 'identity_changed' });
  const renamed = await service.update('remote', { revision: first.revision, patch: { hosts: [{ ...host, label: '변경' }] } });
  assert.equal(renamed.ok, true);
  const disk = JSON.parse(await readFile(file, 'utf8')); assert.deepEqual(disk.hosts[0].extra, { keep: true });
  assert.notEqual(renamed.config.hosts[0].rowId, host.rowId);
});

test('requires explicit deletion and blocks reuse of hidden parcel status for a different tracking number', async t => {
  const { service, directory } = await fixture(t); await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'parcels.json');
  await writeFile(file, JSON.stringify({ trackingOptIn: false, parcels: [{ tracking: 'ABC12345', title: '택배', status: '배송 중' }] }));
  const first = await service.read('parcels'); const row = first.config.parcels[0];
  assert.deepEqual(await service.update('parcels', { revision: first.revision, patch: { parcels: [{ ...row, tracking: 'NEW12345' }] } }), { ok: false, code: 'identity_changed' });
  assert.deepEqual(await service.update('parcels', { revision: first.revision, patch: { parcels: [{ tracking: 'NEW12345', title: '새 택배' }] } }), { ok: false, code: 'rows_changed' });
  const saved = await service.update('parcels', { revision: first.revision, patch: { parcels: [{ tracking: 'NEW12345', title: '새 택배' }], deletedRowIds: [row.rowId] } });
  assert.equal(saved.ok, true);
  const disk = JSON.parse(await readFile(file, 'utf8')); assert.equal(disk.parcels[0].tracking, 'NEW12345'); assert.equal(disk.parcels[0].status, undefined);
  assert.equal(disk.parcels[0].rowId, undefined);
});
