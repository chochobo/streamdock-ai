import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, profileById, profileForUsb, layoutFor, publicLayout } from '../src/device-profiles.mjs';

test('293S V3 keeps its existing slot table and layout', () => {
  const p = PROFILES['293sv3'];
  assert.deepEqual(Array.from({ length: 15 }, (_, i) => p.slotOf(i)), [13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3]);
  assert.equal(p.indexOfCode(13), 0);
  assert.equal(p.indexOfCode(16), -1);
  const l = layoutFor(p);
  assert.deepEqual(l.controls, { modes: 11, usage: 12, back: 12, prev: 13, next: 14 });
  assert.deepEqual(l.summaryKeys, []);
  assert.deepEqual(l.homeContent, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(l.pageContent, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(l.legacy.keys, Array.from({ length: 15 }, (_, i) => i));
  assert.deepEqual(l.legacy.sides, []);
});

test('XL maps top-left input code 0x01 to index 0 and image slot 25', () => {
  const p = PROFILES.xl;
  assert.equal(p.indexOfCode(0x01), 0);
  assert.equal(p.slotOf(0), 25);
  assert.equal(p.slotOf(7), 32);
  assert.equal(p.slotOf(24), 1); // bottom-left
  assert.equal(p.slotOf(31), 8); // bottom-right
  assert.equal(p.indexOfCode(0x20), 31);
  for (const code of [0x00, 0x21, 0x26, 0xff]) assert.equal(p.indexOfCode(code), -1);
  const slots = new Set(Array.from({ length: 32 }, (_, i) => p.slotOf(i)));
  assert.equal(slots.size, 32);
  assert.ok([...slots].every(s => s >= 1 && s <= 32));
});

test('XL layout reserves summary keys on the right and controls on the bottom right', () => {
  const l = layoutFor(PROFILES.xl);
  assert.deepEqual(l.summaryKeys, [7, 15, 23]);
  assert.deepEqual(l.controls, { modes: 28, usage: 29, back: 29, prev: 30, next: 31 });
  assert.equal(l.homeContent.length, 25);
  assert.equal(l.pageContent.length, 26);
  assert.ok(!l.pageContent.some(i => l.summaryKeys.includes(i)));
  assert.deepEqual(l.legacy.keys.slice(0, 6), [0, 1, 2, 3, 4, 8]);
  assert.equal(l.legacy.keys[14], 20);
  assert.deepEqual(l.legacy.sides, [5, 13, 21]);
});

test('USB lookup and public layout', () => {
  assert.equal(profileForUsb(0x5548, 0x1028).id, 'xl');
  assert.equal(profileForUsb(0x5548, 0x1031).id, 'xl');
  assert.equal(profileForUsb(0x6603, 0x1014).id, '293sv3');
  assert.equal(profileForUsb(0x5548, 0x9999), null);
  assert.throws(() => profileById('nope'));
  assert.equal(profileById('XL').id, 'xl');
  const json = publicLayout(layoutFor(PROFILES.xl));
  assert.deepEqual(Object.keys(json).sort(), ['cols', 'controls', 'keyCount', 'model', 'name', 'rows', 'sideSlots', 'summaryKeys']);
  assert.doesNotThrow(() => JSON.stringify(json));
});
