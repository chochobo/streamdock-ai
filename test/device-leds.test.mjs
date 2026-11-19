import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import { createDevice, commandPacket, ledPackets, LED_COMMANDS } from '../src/device.mjs';
import { PROFILES } from '../src/device-profiles.mjs';

const XL = { vendorId: 0x5548, productId: 0x1028, usagePage: 0xff00, usage: 1, path: 'mock-xl' };
const S293 = { vendorId: 0x6603, productId: 0x1014, usagePage: 0xff00, usage: 1, path: 'mock-293' };

function mockDevice(usb = XL) {
  const writes = [];
  class FakeHid extends EventEmitter { write(data) { writes.push(Buffer.from(data)); return data.length; } close() {} }
  const hid = { HID: FakeHid, devicesAsync: async () => [usb] };
  const device = createDevice({ mode: 'hardware', dependencies: { skipInitialBlank: true, hid, sharp, officialAppRunning: async () => false } });
  return { device, writes };
}
// The text of a command and its parameter bytes, as the device sees them (report id removed).
const command = (packet, length = 5) => ({ name: packet.subarray(6, 6 + length).toString('ascii'), param: [...packet.subarray(11)] });

test('only XL has LEDs: six of them', () => {
  assert.equal(PROFILES.xl.ledCount, 6);
  assert.equal(PROFILES['293sv3'].ledCount, 0);
});

test('LED command bytes follow the documented layout: name at offset 5, parameters at offset 10', () => {
  assert.deepEqual(LED_COMMANDS, { brightness: 'LBLIG', color: 'SETLB', reset: 'DELED' });
  const [brightness] = ledPackets.brightness(30);
  assert.equal(brightness.length, 1025, 'a full report with the leading report id');
  assert.deepEqual([...brightness.subarray(1, 6)], [0x43, 0x52, 0x54, 0, 0], 'CRT 00 00 prefix');
  assert.equal(brightness.subarray(6, 11).toString('ascii'), 'LBLIG');
  assert.equal(brightness[11], 30);
  assert.equal(brightness[12], 0, 'zero padded');

  const [color] = ledPackets.color([255, 170, 0], 6);
  assert.equal(color.subarray(6, 11).toString('ascii'), 'SETLB');
  assert.deepEqual([...color.subarray(11, 11 + 18)], [255, 170, 0, 255, 170, 0, 255, 170, 0, 255, 170, 0, 255, 170, 0, 255, 170, 0]);
  assert.equal(color[11 + 18], 0);

  const [reset] = ledPackets.reset();
  assert.equal(reset.subarray(6, 11).toString('ascii'), 'DELED');
  assert.equal(reset[11], 0);
  assert.deepEqual(ledPackets.brightness(30)[0], commandPacket([...Buffer.from('LBLIG'), 30]));
});

test('bad LED values are rejected before anything is built', () => {
  assert.throws(() => ledPackets.brightness(-1), RangeError);
  assert.throws(() => ledPackets.brightness(101), RangeError);
  assert.throws(() => ledPackets.brightness(1.5), RangeError);
  assert.throws(() => ledPackets.color([256, 0, 0], 6), RangeError);
  assert.throws(() => ledPackets.color([0, 0], 6), RangeError);
  assert.throws(() => ledPackets.color([0, 0, 0], 0), RangeError);
});

test('a color is sent before the brightness, so the old color never flashes', async () => {
  const { device, writes } = mockDevice();
  await device.start();
  writes.length = 0;
  assert.equal(await device.setLeds({ rgb: [0, 210, 110], brightness: 40 }), true);
  assert.deepEqual(writes.map(w => w.subarray(6, 11).toString('ascii')), ['SETLB', 'LBLIG']);
  assert.deepEqual([...writes[0].subarray(11, 17)], [0, 210, 110, 0, 210, 110]);
  assert.equal(writes[1][11], 40);
});

test('off is brightness 0 only; an all-zero color is never sent', async () => {
  const { device, writes } = mockDevice();
  await device.start();
  writes.length = 0;
  assert.equal(await device.setLeds({ rgb: null, brightness: 0 }), true);
  assert.deepEqual(writes.map(w => w.subarray(6, 11).toString('ascii')), ['LBLIG']);
  assert.equal(writes[0][11], 0);
  await assert.rejects(device.setLeds({ rgb: [0, 0, 0], brightness: 30 }), RangeError);
});

test('reset sends DELED to restore the device effect', async () => {
  const { device, writes } = mockDevice();
  await device.start();
  writes.length = 0;
  assert.equal(await device.resetLeds(), true);
  assert.deepEqual(writes.map(w => w.subarray(6, 11).toString('ascii')), ['DELED']);
});

test('a 293S, a simulator and a stopped device send nothing and say so', async () => {
  const s293 = mockDevice(S293);
  await s293.device.start();
  s293.writes.length = 0;
  assert.equal(await s293.device.setLeds({ rgb: [1, 2, 3], brightness: 30 }), false);
  assert.equal(await s293.device.resetLeds(), false);
  assert.equal(s293.writes.length, 0);
  const sim = createDevice({ mode: 'simulator' });
  assert.equal(await sim.setLeds({ rgb: [1, 2, 3], brightness: 30 }), false);
  const stopped = mockDevice();
  assert.equal(await stopped.device.setLeds({ rgb: [1, 2, 3], brightness: 30 }), false);
});
