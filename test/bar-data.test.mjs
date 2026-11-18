import test from 'node:test';
import assert from 'node:assert/strict';
import { featureItems } from '../src/feature-pages.mjs';
import { createModeRouter } from '../src/modes.mjs';

test('machine bars match displayed numbers and preserve metric direction', () => {
  const items = featureItems('machines', { machine: {
    cpuPercent: 71.8, memoryUsedPercent: 25, memoryUsedBytes: 8 * 1024 ** 3, memoryTotalBytes: 32 * 1024 ** 3,
    disk: { usedPercent: 90 }, battery: { percent: 0 }, healthScore: 100,
    externalDrives: { status: 'ok', items: [{ name: 'Disk', usedPercent: 32.6 }] },
  } });
  const byId = id => items.find(item => item.id === id);
  assert.equal(byId('machine-cpu').caption, '72%');
  assert.deepEqual(byId('machine-cpu').bar, { value: 72, direction: 'used', warningAt: 70, criticalAt: 90 });
  assert.equal(byId('machine-memory').label, '메모리 사용');
  assert.equal(byId('machine-memory').caption, '약 25%');
  assert.equal(byId('machine-memory').detail, 'macOS 물리 메모리 사용량 추정 8.0 / 32.0 GB');
  assert.deepEqual(byId('machine-memory').bar, { value: 25, direction: 'used', warningAt: 75, criticalAt: 90 });
  assert.deepEqual(byId('machine-disk').bar, { value: 90, direction: 'used', warningAt: 80, criticalAt: 90 });
  assert.equal(byId('machine-battery').bar.value, 0);
  assert.equal(byId('machine-battery').bar.direction, 'charge');
  assert.equal(byId('machine-health').bar.value, 100);
  assert.equal(byId('machine-health').bar.direction, 'score');
  assert.equal(byId('machine-drive-0').caption, '사용 33%');
  assert.equal(byId('machine-drive-0').bar.value, 33);
});

test('memory used percentage remains explicit and matches the bar at bounds', () => {
  for (const value of [0, 83, 100]) {
    const tile = featureItems('machines', { machine: { memoryUsedPercent: value } }).find(item => item.id === 'machine-memory');
    assert.equal(tile.label, '메모리 사용');
    assert.equal(tile.caption, `약 ${value}%`);
    assert.equal(tile.bar.value, value);
    assert.equal(tile.bar.direction, 'used');
  }
});

test('machine bars never infer unavailable or invalid measurements', () => {
  const items = featureItems('machines', { machine: {
    cpuPercent: NaN, memoryUsedPercent: null, memoryFreePercent: 87, disk: { usedPercent: 101 },
    battery: { percent: -1 }, externalDrives: { status: 'ok', items: [{ name: 'Disk', usedPercent: null }] },
  } });
  for (const id of ['machine-cpu', 'machine-memory', 'machine-disk', 'machine-battery', 'machine-drive-0']) {
    const tile = items.find(item => item.id === id);
    assert.equal(tile.caption, '미확인');
    assert.equal(tile.bar, undefined);
  }
});

test('summary bars match used percent, distinguish stale and unavailable windows', () => {
  const usage = { accounts: [
    { provider: 'codex', status: 'ok', windows: [{ usedPercent: 17.4 }, { usedPercent: 0, status: 'stale' }] },
    { provider: 'claude', status: 'unavailable', windows: [{ usedPercent: 82 }] },
    { provider: 'other', status: 'stale', windows: [{ usedPercent: 100 }] },
  ] };
  const items = featureItems('summary', { usage });
  const byId = id => items.find(item => item.id === id);
  assert.equal(byId('summary-usage-0-0').caption, '17%');
  assert.deepEqual(byId('summary-usage-0-0').bar, { value: 17, direction: 'used', warningAt: 60, criticalAt: 85 });
  assert.equal(byId('summary-usage-0-1').bar.value, 0);
  assert.equal(byId('summary-usage-0-1').bar.stale, true);
  assert.match(byId('summary-usage-0-1').detail, /이전 값/);
  assert.equal(byId('summary-usage-1-0').caption, '미확인');
  assert.equal(byId('summary-usage-1-0').bar, undefined);
  assert.equal(byId('summary-usage-2-0').bar.value, 100);
  assert.equal(byId('summary-usage-2-0').bar.stale, true);
});

test('mode router carries validated bars without changing navigation revision', () => {
  const router = createModeRouter();
  router.openMode('machines');
  const bar = { value: 0, direction: 'free', warningAt: 75, criticalAt: 90, stale: true, extra: 'ignored' };
  const first = router.planPage({ items: [{ id: 'mem', label: 'Memory', action: 'inspect', bar }] });
  assert.deepEqual(first.keys[0].bar, { value: 0, direction: 'free', warningAt: 75, criticalAt: 90, stale: true });
  router.commit(first);
  const second = router.planPage({ items: [{ id: 'mem', label: 'Memory', action: 'inspect', bar: { ...bar, value: 100 } }] });
  assert.equal(second.keys[0].bar.value, 100);
  assert.equal(second.revision, first.revision);
  for (const invalid of [
    { value: null, direction: 'used' }, { value: NaN, direction: 'used' },
    { value: -1, direction: 'used' }, { value: 101, direction: 'used' },
    { value: 10, direction: 'unknown' }, { value: 10, direction: 'used', warningAt: 90, criticalAt: 70 },
    { value: 10, direction: 'used', warningAt: 70, criticalAt: 101 },
  ]) {
    const plan = router.planPage({ items: [{ id: 'mem', label: 'Memory', action: 'inspect', bar: invalid }] });
    assert.equal(plan.keys[0].bar, undefined);
  }
});
