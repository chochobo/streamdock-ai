import test from 'node:test';
import assert from 'node:assert/strict';
import { createModeRouter, isModeHubShortcut, MODE_CATALOG, PAGE_CAPACITY } from '../src/modes.mjs';
import { layoutFor, PROFILES } from '../src/device-profiles.mjs';

const enabled = Object.fromEntries(MODE_CATALOG.map(mode => [mode.id, true]));
const publish = (router, options) => router.commit(router.planPage(options));

test('machine memory bytes survive navigation only with a matching usage bar', () => {
  const router = createModeRouter();
  router.openMode('machines');
  const GiB = 1024 ** 3;
  const bar = { value: 25, direction: 'used', stale: true };
  const memory = { usedBytes: 8 * GiB, totalBytes: 32 * GiB, estimated: true };
  const items = [{ id: 'machine-memory', label: '메모리', bar, memory }];
  const plan = router.planPage({ items });
  assert.deepEqual(plan.keys[0].memory, memory);
  assert.equal(plan.keys[0].bar.stale, true);
  const rev = router.commit(plan).revision;
  const later = router.planPage({ items: [{ ...items[0], memory: { ...memory, usedBytes: 8 * GiB + 1024 } }] });
  assert.equal(later.revision, rev);
  assert.notEqual(later.keys[0].memory.usedBytes, memory.usedBytes);
  for (const invalid of [
    { ...memory, usedBytes: -1 }, { ...memory, totalBytes: 0 },
    { ...memory, usedBytes: 9 * GiB }, { ...memory, estimated: false },
    { ...memory, totalBytes: Infinity },
  ]) assert.equal(router.planPage({ items: [{ ...items[0], memory: invalid }] }).keys[0].memory, undefined);
  assert.equal(router.planPage({ items: [{ ...items[0], bar: null }] }).keys[0].memory, undefined);
  assert.equal(router.planPage({ items: [{ ...items[0], id: 'fake-memory' }] }).keys[0].memory, undefined);
});

test('the feature key opens the hub only on the live project home', () => {
  assert.equal(isModeHubShortcut({ view: 'projects', scope: 'live', index: 11 }), true);
  assert.equal(isModeHubShortcut({ view: 'projects', scope: 'history', index: 11 }), false);
  assert.equal(isModeHubShortcut({ view: 'sessions', scope: 'live', index: 11 }), false);
  assert.equal(isModeHubShortcut({ view: 'projects', scope: 'live', index: 12 }), false);
});

test('hub lists all modes over pages, while unavailable modes cannot be selected', () => {
  const router = createModeRouter();
  router.openHub();
  const first = publish(router);
  assert.equal(first.view, 'hub');
  assert.equal(first.pages, 2);
  assert.equal(first.keys[0].disabled, true); // summary has no adapter yet
  assert.equal(router.press(0, { revision: first.revision }).type, 'none');
  assert.equal(first.keys[1].label, '에이전트');
  assert.equal(first.keys[2].label, '기록');
  assert.equal(first.keys[3].label, '사용량');
  assert.equal(first.keys[12].action, 'back');
  assert.equal(first.keys[14].action, 'next');
  assert.equal(router.press(14, { revision: first.revision }).type, 'navigate');
  assert.equal(router.press(14, { revision: first.revision }).type, 'busy');
  const second = publish(router, { availability: enabled });
  assert.equal(second.keys[0].label, '원격');
  assert.equal(second.keys[1].label, '대시보드');
  assert.equal(second.keys[2].label, '바로가기');
  assert.equal(second.keys[3].label, '설정');
  assert.notEqual(second.revision, first.revision);
  assert.equal(router.press(3, { revision: first.revision }).type, 'stale');
  assert.deepEqual(router.press(3, { revision: second.revision }), { type: 'open', mode: 'settings' });
  assert.equal(router.current(), 'settings');
});

test('feature pages keep item identity stable and emit actions without executing them', () => {
  const router = createModeRouter();
  router.openMode('machines');
  const items = Array.from({ length: PAGE_CAPACITY + 1 }, (_, index) => ({ id: `device-${index}`, label: `기기 ${index}`, action: 'show_detail' }));
  const first = publish(router, { items });
  assert.equal(first.pages, 2);
  assert.deepEqual(router.press(0, { revision: first.revision, heldMs: 801 }), { type: 'action', mode: 'machines', id: 'device-0', action: 'show_detail', longPress: true });
  const reordered = publish(router, { items: [...items].reverse() });
  assert.equal(reordered.keys[0].label, '기기 0');
  assert.equal(reordered.revision, first.revision);
  assert.equal(router.press(14, { revision: reordered.revision }).type, 'navigate');
  const second = publish(router, { items });
  assert.equal(second.keys[0].label, '기기 12');
  assert.equal(router.press(0, { revision: reordered.revision }).type, 'stale');
  assert.deepEqual(router.press(12, { revision: second.revision }), { type: 'open', mode: 'hub' });
});

test('old plans cannot be committed after navigation and duplicate ids fail closed', () => {
  const router = createModeRouter();
  router.openMode('games');
  const plan = router.planPage({ items: [{ id: 'mole', label: '두더지' }] });
  router.openHub();
  assert.throws(() => router.commit(plan), /Stale or invalid/);
  router.openMode('games');
  assert.throws(() => router.planPage({ items: [{ id: 'same' }, { id: 'same' }] }), /unique/);
  assert.throws(() => router.openMode('not-a-mode'), /Unknown mode/);
});

test('a mode whose availability is null is not offered at all, unlike a disabled one (#36)', () => {
  const router = createModeRouter();
  router.openHub();
  const labels = plan => plan.keys.filter(k => k.kind === 'control' && k.action === 'open_mode').map(k => k.label);
  const shown = router.planPage({ availability: enabled, layout: layoutFor(PROFILES.xl) });
  assert.ok(labels(shown).includes('대시보드'));
  const hidden = router.planPage({ availability: { ...enabled, dashboard: null }, layout: layoutFor(PROFILES.xl) });
  assert.ok(!labels(hidden).includes('대시보드'));
  const disabled = router.planPage({ availability: { ...enabled, dashboard: false }, layout: layoutFor(PROFILES.xl) });
  const key = disabled.keys.find(k => k.label === '대시보드');
  assert.ok(key && key.disabled === true, 'false keeps a grey key; null removes it');
  assert.equal(labels(hidden).length, labels(shown).length - 1);
});

test('a wide key carries only the data the renderer reads', () => {
  const router = createModeRouter();
  router.openMode('dashboard');
  const items = [{ id: 'dash-graph-1', label: '', caption: '', state: 'idle', kind: 'wide', enabled: false,
    wide: { type: 'graph', part: 1, parts: 7, cpu: [1, 2, 'x', 300], mem: [5, 6], secret: 'token', extra: { a: 1 } } },
    { id: 'dash-bad', label: '', caption: '', state: 'idle', kind: 'wide', enabled: false, wide: { type: 'nope' } }];
  const plan = router.planPage({ items, availability: { dashboard: true }, layout: layoutFor(PROFILES.xl) });
  const graph = plan.keys.find(k => k.id === 'dash-graph-1');
  assert.deepEqual(graph.wide, { type: 'graph', parts: 7, part: 1, cpu: [1, 2, 100], mem: [5, 6] });
  assert.equal(JSON.stringify(plan).includes('token'), false);
  assert.equal(plan.keys.find(k => k.id === 'dash-bad').wide, undefined, 'an unknown widget type is dropped');
});
