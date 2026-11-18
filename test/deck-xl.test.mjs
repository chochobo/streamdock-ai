import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck } from '../src/deck.mjs';
import { PROFILES, layoutFor } from '../src/device-profiles.mjs';

const xl = layoutFor(PROFILES.xl);
const summaryKeys = [7, 15, 23];
const live = (count, sessions = 1) => Array.from({ length: count }, (_, p) => Array.from({ length: sessions }, (_, s) => ({
  id: `s-${p}-${s}`, projectId: `p-${p}`, project: `project-${p}`, status: 'idle', presence: 'live',
}))).flat();
const unbound = (state, indexes) => indexes.every(index => state.keys[index].kind === 'empty' && state.keys[index].action === 'none');

test('XL home fills 25 content keys around the summary keys and keeps controls on 28-31', () => {
  const deck = createDeck();
  const state = deck.commit(deck.plan(live(30), {}, xl));
  assert.equal(state.keys.length, 32);
  assert.equal(state.pages, 2);
  const projects = state.keys.filter(key => key.kind === 'project').map(key => key.index);
  assert.deepEqual(projects, xl.homeContent);
  assert.equal(projects.length, 25);
  assert.ok(unbound(state, summaryKeys));
  assert.deepEqual([28, 29, 30, 31].map(index => state.keys[index].action), ['modes', 'usage', 'prev', 'next']);
  assert.ok(state.keys[30].disabled, 'prev is disabled on the first page');
  for (const index of summaryKeys) assert.deepEqual(deck.press(index, state.revision), { type: 'none' });
  assert.deepEqual(deck.press(31, state.revision), { type: 'navigate' });
  const second = deck.commit(deck.plan(live(30), {}, xl));
  assert.equal(second.page, 2);
  assert.equal(second.keys.filter(key => key.kind === 'project').length, 5);
  assert.equal(second.keys[31].action, 'next');
  assert.ok(second.keys[31].disabled);
  assert.deepEqual(deck.press(31, second.revision), { type: 'none' }, 'a disabled arrow stays unbound');
  assert.deepEqual(deck.press(32, second.revision), { type: 'none' });
});

test('XL sessions use 26 page positions and back on 29', () => {
  const deck = createDeck();
  let state = deck.commit(deck.plan(live(1, 27), {}, xl));
  assert.deepEqual(deck.press(0, state.revision), { type: 'navigate' });
  state = deck.commit(deck.plan(live(1, 27), {}, xl));
  assert.equal(state.view, 'sessions');
  assert.equal(state.pages, 2);
  assert.deepEqual(state.keys.filter(key => key.kind === 'session').map(key => key.index), xl.pageContent);
  assert.equal(xl.pageContent.length, 26);
  assert.ok(unbound(state, summaryKeys));
  assert.equal(state.keys[28].kind, 'session');
  assert.equal(state.keys[29].action, 'back');
  assert.deepEqual(deck.press(29, state.revision), { type: 'navigate' });
  assert.equal(deck.commit(deck.plan(live(1, 27), {}, xl)).view, 'projects');
});

test('XL usage keeps every usage/reset pair on one row and never on a summary key', () => {
  const deck = createDeck();
  const window = { id: '5h', label: '5시간', usedPercent: 10, resetsAt: null };
  const usage = { accounts: Array.from({ length: 13 }, (_, i) => ({ id: `a-${String(i).padStart(2, '0')}`, provider: 'codex', label: `계정${i}`, status: 'ok', windows: [window] })) };
  let state = deck.commit(deck.plan([], usage, xl));
  deck.press(29, state.revision);
  state = deck.commit(deck.plan([], usage, xl));
  assert.equal(state.view, 'usage');
  const quota = state.keys.filter(key => key.kind === 'quota');
  assert.equal(quota.length, 11, 'three pairs on each of rows 0-2 and two on row 3');
  for (const key of quota) {
    const reset = state.keys[key.index + 1];
    assert.equal(reset.kind, 'quota-reset');
    assert.equal(Math.floor(key.index / 8), Math.floor(reset.index / 8));
  }
  assert.ok(summaryKeys.every(index => state.keys[index].kind === 'empty'));
  assert.equal(state.pages, 2);
  assert.equal(state.keys[29].action, 'back');
  deck.press(31, state.revision);
  const second = deck.commit(deck.plan([], usage, xl));
  assert.equal(second.keys.filter(key => key.kind === 'quota').length, 2);
});

test('XL plans commit with 32 bindings and a 293S plan still commits after a layout change', () => {
  const deck = createDeck();
  const xlState = deck.commit(deck.plan(live(2), {}, xl));
  const small = deck.plan(live(2));
  assert.equal(small.keys.length, 15);
  assert.notEqual(small.revision, xlState.revision);
  assert.equal(deck.commit(small).keys[11].action, 'modes');
  assert.throws(() => deck.commit({ ...small, bindings: small.bindings.slice(0, 14) }), /Invalid deck plan/);
});
