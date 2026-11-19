import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import { createDevice, controlEventFromReport, keyEventFromReport } from '../src/device.mjs';
import { PROFILES } from '../src/device-profiles.mjs';

const XL = { vendorId: 0x5548, productId: 0x1028, usagePage: 0xff00, usage: 1, path: 'mock-xl' };
const S293 = { vendorId: 0x6603, productId: 0x1014, usagePage: 0xff00, usage: 1, path: 'mock-293' };
const report = (code, pressed) => Buffer.from([0x41, 0x43, 0x4b, 0, 0, 0x4f, 0x4b, 0, 0, code, pressed ? 1 : 0]);
const ROCKER_CODES = {
  0x21: ['left', 'up'], 0x22: ['left', 'push'], 0x23: ['left', 'down'],
  0x24: ['right', 'up'], 0x25: ['right', 'push'], 0x26: ['right', 'down'],
};

function mockDevice(usb) {
  const keys = [], controls = [];
  let handle;
  class FakeHid extends EventEmitter {
    constructor(path) { super(); handle = this; }
    write(data) { return data.length; }
    close() {}
  }
  const device = createDevice({ mode: 'hardware', onKey: i => keys.push(i), onControl: event => controls.push(event),
    dependencies: { skipInitialBlank: true, hid: { HID: FakeHid, devicesAsync: async () => [usb] }, sharp, officialAppRunning: async () => false } });
  return { device, keys, controls, emit: (code, pressed) => handle.emit('data', report(code, pressed)) };
}

test('XL rocker codes decode to control events and never to keys', () => {
  for (const [code, [control, action]] of Object.entries(ROCKER_CODES)) {
    assert.deepEqual(controlEventFromReport(report(Number(code), true), PROFILES.xl), { code: Number(code), control, action, phase: 'down' });
    assert.equal(controlEventFromReport(report(Number(code), false), PROFILES.xl).phase, 'up');
    assert.equal(keyEventFromReport(report(Number(code), true), PROFILES.xl), null);
  }
  assert.equal(controlEventFromReport(report(0x01, true), PROFILES.xl), null);
  assert.equal(controlEventFromReport(report(0x20, true), PROFILES.xl), null);
  assert.equal(controlEventFromReport(report(0x27, true), PROFILES.xl), null);
  const bad = report(0x21, true); bad[5] = 0;
  assert.equal(controlEventFromReport(bad, PROFILES.xl), null);
});

test('293S has no rockers: codes from 0x10 up are neither keys nor controls', () => {
  for (let code = 0x10; code <= 0x26; code++) {
    assert.equal(controlEventFromReport(report(code, true), PROFILES['293sv3']), null);
    assert.equal(keyEventFromReport(report(code, true), PROFILES['293sv3']), null);
  }
});

test('XL device emits each rocker press once, until released, without key callbacks', async () => {
  const { device, keys, controls, emit } = mockDevice(XL);
  await device.start();
  for (const code of Object.keys(ROCKER_CODES).map(Number)) { emit(code, true); emit(code, false); }
  assert.deepEqual(controls, Object.values(ROCKER_CODES).map(([control, action]) => ({ control, action, phase: 'down' })));
  assert.deepEqual(keys, []);
  // A held rocker (repeated press reports, no release) fires once.
  controls.length = 0;
  emit(0x21, true); emit(0x21, true); emit(0x21, true);
  assert.equal(controls.length, 1);
  emit(0x21, false); emit(0x21, true);
  assert.equal(controls.length, 2);
  // Keys still work alongside rockers.
  emit(0x01, true);
  assert.deepEqual(keys, [0]);
  await device.stop();
});

test('293S device never emits control events', async () => {
  const { device, keys, controls, emit } = mockDevice(S293);
  await device.start();
  for (let code = 0x10; code <= 0x26; code++) { emit(code, true); emit(code, false); }
  assert.deepEqual(controls, []);
  assert.deepEqual(keys, []);
  await device.stop();
});

test('onControl must be a function', () => {
  assert.throws(() => createDevice({ onControl: 'nope' }), TypeError);
});
