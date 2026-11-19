import test from 'node:test';
import assert from 'node:assert/strict';
import { featureItems } from '../src/feature-pages.mjs';
import { MODE_CATALOG, createModeRouter } from '../src/modes.mjs';
import { layoutFor, PROFILES } from '../src/device-profiles.mjs';
import { translateKeys } from '../src/i18n.mjs';

const user = (id, extra) => ({ id, label: 'L', type: 'app', app: 'Notes', ...extra });

test('the shortcuts page is in the feature list, before settings', () => {
  const ids = MODE_CATALOG.map(mode => mode.id);
  assert.ok(ids.includes('shortcuts'));
  assert.equal(ids.at(-1), 'settings');
  assert.equal(ids.indexOf('shortcuts'), ids.length - 2);
});

test('each shortcut becomes one key bound to its id; commands look cautionary', () => {
  const items = featureItems('shortcuts', { shortcuts: { status: 'ok', skipped: 0, items: [
    user('sc-0-aaaaaaaa', { label: '터미널' }),
    user('sc-1-bbbbbbbb', { label: '빌드', type: 'command', command: ['/usr/bin/make'], hold: true }),
    user('sc-2-cccccccc', { label: '계속', type: 'text', text: '계속', submit: true, caption: '프롬프트' }),
    { id: 'scb-mute', label: '음소거', caption: '전환', type: 'system', system: 'mute', builtin: true },
  ] } });
  assert.deepEqual(items.map(i => i.action), ['shortcut:sc-0-aaaaaaaa', 'shortcut:sc-1-bbbbbbbb', 'shortcut:sc-2-cccccccc', 'shortcut:scb-mute']);
  assert.equal(items[0].caption, '앱 열기');
  assert.equal(items[1].caption, '길게');
  assert.equal(items[1].state, 'blocked');
  assert.equal(items[2].caption, '프롬프트');
  assert.ok(items.every(i => i.enabled === true && i.kind === 'feature'));
});

test('an unconfigured or unreadable file and skipped items are named on the page', () => {
  const none = featureItems('shortcuts', { shortcuts: { status: 'unconfigured', skipped: 0, items: [] } });
  assert.deepEqual(none.map(i => i.id), ['shortcuts-setup']);
  assert.equal(none[0].enabled, false);
  const broken = featureItems('shortcuts', { shortcuts: { status: 'unavailable', skipped: 0, items: [] } });
  assert.deepEqual(broken.map(i => i.id), ['shortcuts-unavailable']);
  const skipped = featureItems('shortcuts', { shortcuts: { status: 'ok', skipped: 3, items: [user('sc-0-aaaaaaaa')] } });
  assert.deepEqual(skipped.map(i => i.id), ['sc-0-aaaaaaaa', 'shortcuts-skipped']);
  assert.equal(skipped[1].caption, '3개');
  assert.deepEqual(featureItems('shortcuts', {}).map(i => i.id), []);
});

test('XL fits 26 shortcuts on a page and 293S 12; extra ones page forward', () => {
  const items = Array.from({ length: 30 }, (_, i) => featureItems('shortcuts', { shortcuts: { status: 'ok', skipped: 0, items: [user(`sc-${i}-aaaaaaaa`, { label: `K${i}` })] } })[0]);
  for (const [model, capacity] of [['xl', 26], ['293sv3', 12]]) {
    const router = createModeRouter();
    router.openMode('shortcuts');
    const plan = router.planPage({ items, availability: { shortcuts: true }, layout: layoutFor(PROFILES[model]) });
    assert.equal(plan.keys.filter(k => k.kind === 'feature').length, capacity);
    assert.ok(plan.pages > 1);
  }
});

test('English mode translates built-in keys but never the user labels', () => {
  const keys = [
    { index: 0, kind: 'feature', id: 'scb-mute', label: '음소거', caption: '전환' },
    { index: 1, kind: 'feature', id: 'sc-0-aaaaaaaa', label: '음소거', caption: '전환' },
  ];
  const [builtin, mine] = translateKeys(keys, 'en');
  assert.deepEqual([builtin.label, builtin.caption], ['Mute', 'Toggle']);
  assert.deepEqual([mine.label, mine.caption], ['음소거', '전환']);
});
