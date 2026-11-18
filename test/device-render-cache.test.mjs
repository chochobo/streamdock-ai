import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDevice } from '../src/device.mjs';

const MODELS = {
  '293S': { vendorId: 0x6603, productId: 0x1014, path: 'mock-293' },
  XL: { vendorId: 0x5548, productId: 0x1028, path: 'mock-xl' },
};

async function setup(model) {
  const writes = [];
  class FakeHid extends EventEmitter { write(data) { writes.push(data); return data.length; } close() {} }
  const hid = { HID: FakeHid, devicesAsync: async () => [{ ...MODELS[model], usagePage: 0xff00, usage: 1 }] };
  const sharp = () => ({ resize() { return this; }, rotate() { return this; }, jpeg() { return this; }, async toBuffer() { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); } });
  const device = createDevice({ mode: 'hardware', dependencies: { skipInitialBlank: true, hid, sharp, officialAppRunning: async () => false } });
  await device.start();
  // BAT headers sent so far, as key slot ids.
  const slots = () => writes.filter(w => Buffer.from(w.slice(6, 9)).toString('ascii') === 'BAT').map(w => w[13]);
  return { device, slots };
}

const base = { index: 0, label: 'Codex', state: 'working', bar: { value: 40, direction: 'used' } };
const visual = [
  ['label', { label: 'Claude' }],
  ['state', { state: 'waiting' }],
  ['caption', { kind: 'project', caption: '다른 문구' }],
  ['bar value', { bar: { value: 41, direction: 'used' } }],
  ['language', { language: 'en' }],
  ['alertPulse', { kind: 'project', state: 'done', alertPulse: true }],
  ['usedPercent (quota)', { kind: 'quota', usedPercent: 10 }],
];

for (const model of Object.keys(MODELS)) {
  test(`${model}: unchanged keys are not re-sent`, async () => {
    const { device, slots } = await setup(model);
    await device.render([base]);
    const first = slots().length;
    assert.ok(first > 0);
    await device.render([{ ...base }]);
    assert.equal(slots().length, first);
  });

  test(`${model}: changing one drawn field re-sends exactly that key`, async () => {
    for (const [name, change] of visual) {
      const { device, slots } = await setup(model);
      const withQuota = name.includes('quota') ? { ...base, kind: 'quota', usedPercent: 5 } : base;
      await device.render([withQuota, { ...base, index: 1, label: 'Other' }]);
      const before = slots().length;
      await device.render([{ ...withQuota, ...change }, { ...base, index: 1, label: 'Other' }]);
      assert.equal(slots().length, before + 1, `${name} should re-send one key`);
    }
  });

  test(`${model}: fields the tile does not draw cause no write`, async () => {
    const { device, slots } = await setup(model);
    await device.render([base]);
    const before = slots().length;
    await device.render([{ ...base, id: 'some-id', action: 'open', unknownField: 1 }]);
    assert.equal(slots().length, before);
  });

  test(`${model}: renderImages overwrite makes render re-send the key`, async () => {
    const { device, slots } = await setup(model);
    await device.render([base]);
    const before = slots().length;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    await device.renderImages({ keys: [{ index: 0, image: png }] });
    const afterImages = slots().length;
    assert.equal(afterImages, before + 1);
    await device.render([base]);
    assert.equal(slots().length, afterImages + 1);
  });
}
