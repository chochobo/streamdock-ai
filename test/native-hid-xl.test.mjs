import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSwiftHID, createNativeDevice } from '../src/native-hid.mjs';
import { commandPacket } from '../src/device.mjs';
import { PROFILES } from '../src/device-profiles.mjs';

const fixture = path.resolve('native/HID/Tests/fixtures/hid-mock.cjs');
const make = mode => createSwiftHID({ executable: process.execPath, args: [fixture, mode], timeoutMs: 5000 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Swift bridge reports the USB IDs from the helper ready event', async () => {
  for (const [mode, ids] of [['success', [0x6603, 0x1014]], ['xl', [0x5548, 0x1028]]]) {
    const hid = make(mode);
    const entries = await hid.devicesAsync();
    assert.deepEqual(entries, [{ vendorId: ids[0], productId: ids[1], usagePage: 0xff00, usage: 1, path: 'swift-hid' }]);
    assert.throws(() => new hid.HID('swift-293sv3'), /unavailable/);
    const handle = new hid.HID(entries[0].path); handle.on('error', () => {}); handle.close();
  }
});

test('Swift bridge rejects unsupported or missing USB IDs', async () => {
  await assert.rejects(make('unsupported').devicesAsync(), /unsupported/);
  await assert.rejects(make('missing-ids').devicesAsync(), /unsupported/);
});

test('Swift bridge re-emits raw input codes and rejects codes outside 0x01..0x26', async () => {
  const hid = make('xl-key');
  const entries = await hid.devicesAsync();
  const handle = new hid.HID(entries[0].path); handle.on('error', () => {});
  try {
    const received = [];
    handle.on('data', data => received.push([...data]));
    await handle.writePacket(commandPacket([1]));
    assert.deepEqual(received.map(r => [r[9], r[10]]), [[0x01, 1], [0x01, 0], [0x21, 1]]);
    assert.deepEqual(received[0], [0x41, 0x43, 0x4b, 0, 0, 0x4f, 0x4b, 0, 0, 0x01, 1]);
  } finally { handle.close(); }
  const bad = make('bad-code');
  const badHandle = new bad.HID((await bad.devicesAsync())[0].path);
  const errors = []; badHandle.on('error', error => errors.push(error.message));
  await assert.rejects(badHandle.writePacket(commandPacket([1])));
  assert.match(errors[0], /key event/);
  badHandle.close();
});

test('native device detects an XL through the helper and maps its keys', async () => {
  const presses = [], events = [];
  const device = createNativeDevice({ mode: 'hardware', helperPath: process.execPath, helperArgs: [fixture, 'xl-key'], helperTimeoutMs: 5000,
    onKey: i => presses.push(i), onKeyEvent: (i, phase) => events.push([i, phase]),
    dependencies: { skipInitialBlank: true, officialAppRunning: async () => false, renderSummaryKeyImages: async () => [1, 2, 3].map(n => Buffer.from([0xff, 0xd8, n, 0xff, 0xd9])) } });
  await device.start();
  assert.equal(device.status().connected, true);
  assert.equal(device.profile(), PROFILES.xl);
  assert.equal(device.status().model, 'Stream Dock XL (5548:1028)');
  assert.equal(await device.renderSummary({}), true);
  await pause(20);
  assert.deepEqual(presses.slice(0, 1), [0]);
  assert.ok(presses.every(i => i === 0), 'rocker code 0x21 is not a key');
  assert.deepEqual(events.slice(0, 2), [[0, 'down'], [0, 'up']]);
  await device.stop();
});
