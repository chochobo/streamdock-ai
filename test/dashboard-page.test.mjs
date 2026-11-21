import test from 'node:test';
import assert from 'node:assert/strict';
import { featureItems } from '../src/feature-pages.mjs';
import { createModeRouter } from '../src/modes.mjs';
import { layoutFor, PROFILES } from '../src/device-profiles.mjs';
import { wideRuns } from '../src/dashboard-widgets.mjs';
import { translateKeys } from '../src/i18n.mjs';

const XL = layoutFor(PROFILES.xl);
const S293 = layoutFor(PROFILES['293sv3']);
const usage = { accounts: [
  { id: 'x', provider: 'codex', label: 'Codex', status: 'ok', windows: [{ label: '5h', usedPercent: 42, resetLabel: '월 09:00' }] },
  { id: 'c', provider: 'claude', label: 'Claude', status: 'ok', windows: [{ label: '5h', usedPercent: 91 }] },
] };
const agent = (status, extra = {}) => ({ id: `${status}-${Math.random()}`, status, presence: 'live', ...extra });
const agents = [agent('working'), agent('working'), agent('blocked'), agent('done'), agent('idle'), agent('weird'),
  agent('error', { isSubagent: true }), agent('blocked', { presence: 'history' })];
const history = Array.from({ length: 5 }, (_, i) => ({ cpu: 10 + i, mem: 50 + i }));
const items = featureItems('dashboard', { layout: XL, usage, agents, machineHistory: history });

test('rows of seven keys exist on the XL and nowhere on the 293S', () => {
  assert.deepEqual(wideRuns(XL).map(run => run.length), [7, 7, 7]);
  assert.deepEqual(wideRuns(XL).map(run => run[0]), [0, 8, 16], 'the right column belongs to the summary keys');
  assert.deepEqual(wideRuns(S293), []);
});

test('items follow the page content order: usage on row 1, graph on row 2, agents on row 3, the rest blank', () => {
  assert.equal(items.length, XL.pageContent.length);
  const kinds = items.map(item => item.id.replace(/-\d+$/, ''));
  assert.deepEqual(kinds.slice(0, 7), Array(7).fill('dash-usage'));
  assert.deepEqual(kinds.slice(7, 14), Array(7).fill('dash-graph'));
  assert.deepEqual(kinds.slice(14, 21), Array(7).fill('dash-stack'));
  assert.ok(items.slice(21).every(item => item.state === 'empty' && item.enabled === false));
  assert.deepEqual(items.slice(0, 7).map(item => item.wide.part), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(items.slice(0, 21).every(item => item.kind === 'wide' && item.enabled === false && item.wide.parts === 7));
  assert.equal(new Set(items.map(item => item.id)).size, items.length, 'ids are unique');
});

test('widgets carry real data: usage rows, history samples, and live-session counts', () => {
  assert.deepEqual(items[0].wide.rows.map(row => [row.label, row.used, row.reset]), [['Codex 5h', 42, '월 09:00'], ['Claude 5h', 91, null]]);
  assert.deepEqual(items[7].wide.cpu, [10, 11, 12, 13, 14]);
  assert.deepEqual(items[7].wide.mem, [50, 51, 52, 53, 54]);
  // History sessions and subagents are not counted; a state the app does not know is kept apart.
  assert.deepEqual(items[14].wide.counts, { working: 2, blocked: 1, error: 0, done: 1, idle: 1 });
  assert.equal(items[14].wide.unknown, 1);
});

test('a router page places each widget on its keys and keeps the summary column free', () => {
  const router = createModeRouter();
  router.openMode('dashboard');
  const plan = router.planPage({ items, availability: { dashboard: true }, layout: XL });
  assert.equal(plan.keys[0].wide.type, 'usage');
  assert.equal(plan.keys[6].wide.part, 7);
  assert.equal(plan.keys[7].kind, 'empty', 'key 7 is a summary key');
  assert.equal(plan.keys[8].wide.type, 'graph');
  assert.equal(plan.keys[16].wide.type, 'stack');
  assert.equal(plan.keys[22].wide.part, 7);
  assert.equal(plan.keys[23].kind, 'empty');
  assert.ok([24, 25, 26, 27, 28].every(index => plan.keys[index].state === 'empty'));
  assert.equal(plan.keys[29].action, 'back');
  assert.ok(plan.keys.filter(key => key.kind === 'wide').every(key => key.action === 'none' && key.disabled === true), 'widget keys are not buttons');
  assert.equal(plan.pages, 1);
});

test('without live data the widgets say so instead of inventing values', () => {
  const empty = featureItems('dashboard', { layout: XL });
  assert.deepEqual(empty[0].wide.rows, []);
  assert.deepEqual(empty[7].wide.cpu, []);
  assert.deepEqual(empty[14].wide.counts, { working: 0, blocked: 0, error: 0, done: 0, idle: 0 });
});

test('a 293S gets an explanation and no widgets', () => {
  const none = featureItems('dashboard', { layout: S293 });
  assert.deepEqual(none.map(item => item.id), ['dashboard-unavailable']);
  assert.equal(none[0].enabled, false);
  assert.deepEqual(featureItems('dashboard', {}).map(item => item.id), ['dashboard-unavailable']);
});

test('English mode keeps the widget data and tells the renderer the language', () => {
  const router = createModeRouter();
  router.openMode('dashboard');
  const plan = router.planPage({ items, availability: { dashboard: true }, layout: XL });
  const keys = translateKeys(plan.keys, 'en').map(key => ({ ...key, language: 'en' }));
  assert.equal(keys[0].wide.type, 'usage');
  assert.equal(keys[0].language, 'en');
});

test('widget and blank keys carry no name, so the app never shows an internal id', () => {
  const router = createModeRouter();
  router.openMode('dashboard');
  const plan = router.planPage({ items, availability: { dashboard: true }, layout: XL });
  for (const index of [0, 6, 8, 16, 22, 24, 28]) assert.equal(plan.keys[index].label, '', `key ${index}`);
  assert.doesNotMatch(JSON.stringify(plan.keys), /"label":"dash-/);
  assert.equal(plan.keys[29].label, '뒤로', 'real controls keep their names');
});
