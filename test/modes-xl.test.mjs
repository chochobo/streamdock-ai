import test from 'node:test';
import assert from 'node:assert/strict';
import { createModeRouter, isModeHubShortcut, MODE_CATALOG } from '../src/modes.mjs';
import { PROFILES, layoutFor } from '../src/device-profiles.mjs';

const xl = layoutFor(PROFILES.xl);

test('XL feature hub fits the whole catalog on one page away from summary keys', () => {
  const router = createModeRouter();
  router.openHub();
  const state = router.commit(router.planPage({ availability: { summary: true, games: true }, layout: xl }));
  assert.equal(state.keys.length, 32);
  assert.equal(state.pages, 1);
  assert.deepEqual(state.keys.filter(key => key.id).map(key => key.index), xl.pageContent.slice(0, MODE_CATALOG.length));
  assert.ok([7, 15, 23].every(index => state.keys[index].kind === 'empty' && state.keys[index].disabled));
  assert.equal(state.keys[29].action, 'back');
  assert.equal(state.keys[30].action, 'prev');
  assert.equal(state.keys[31].action, 'next');
  assert.ok(state.keys[30].disabled && state.keys[31].disabled);
  assert.deepEqual(router.press(31, { revision: state.revision }), { type: 'none' });
  assert.deepEqual(router.press(7, { revision: state.revision }), { type: 'none' });
  const games = state.keys.find(key => key.id === 'games');
  assert.deepEqual(router.press(games.index, { revision: state.revision }), { type: 'open', mode: 'games' });
});

test('XL feature pages paginate by 26 and the shortcut is on key 28', () => {
  const router = createModeRouter();
  router.openMode('machines');
  const items = Array.from({ length: 27 }, (_, index) => ({ id: `item-${index}`, label: `항목 ${index}` }));
  const state = router.commit(router.planPage({ items, layout: xl }));
  assert.equal(state.pages, 2);
  assert.equal(state.keys.filter(key => key.kind === 'feature').length, 26);
  assert.deepEqual(router.press(31, { revision: state.revision }), { type: 'navigate', mode: 'machines' });
  const second = router.commit(router.planPage({ items, layout: xl }));
  assert.equal(second.keys[0].id, 'item-26');
  assert.equal(isModeHubShortcut({ view: 'projects', scope: 'live', index: 28, layout: xl }), true);
  assert.equal(isModeHubShortcut({ view: 'projects', scope: 'live', index: 11, layout: xl }), false);
  assert.equal(isModeHubShortcut({ view: 'projects', scope: 'live', index: 11 }), true);
});
