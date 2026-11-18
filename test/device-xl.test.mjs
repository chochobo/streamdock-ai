import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import { createDevice, imagePackets, keyEventFromReport } from '../src/device.mjs';
import { PROFILES } from '../src/device-profiles.mjs';
import { summaryKeySvgs, renderSummaryKeyImages, summarySvgs, buildSummary } from '../src/summary.mjs';

const XL = { vendorId: 0x5548, productId: 0x1028, usagePage: 0xff00, usage: 1, path: 'mock-xl' };
const S293 = { vendorId: 0x6603, productId: 0x1014, usagePage: 0xff00, usage: 1, path: 'mock-293' };
const report = (code, pressed) => Buffer.from([0x41, 0x43, 0x4b, 0, 0, 0x4f, 0x4b, 0, 0, code, pressed ? 1 : 0]);
const batIds = writes => writes.filter(w => Buffer.from(w.slice(6, 9)).toString('ascii') === 'BAT').map(w => w[13]);

// Collects every BAT image as { id, jpeg }.
function images(writes) {
  const out = [];
  for (let i = 0; i < writes.length; i++) {
    const header = Buffer.from(writes[i]);
    if (header.subarray(6, 9).toString('ascii') !== 'BAT') continue;
    const size = header.readUInt32BE(9);
    const chunks = [];
    for (let remaining = size, j = i + 1; remaining > 0; remaining -= 1024, j++) chunks.push(Buffer.from(writes[j]).subarray(1));
    out.push({ id: header[13], jpeg: Buffer.concat(chunks).subarray(0, size) });
  }
  return out;
}

function xlDevice({ devices = [XL], onKey, onKeyEvent, dependencies = {} } = {}) {
  const writes = [];
  let handle;
  class FakeHid extends EventEmitter {
    constructor(path) { super(); this.path = path; handle = this; }
    write(data) { writes.push(data); return data.length; }
    close() {}
  }
  const hid = { HID: FakeHid, devicesAsync: async () => devices };
  const device = createDevice({ mode: 'hardware', onKey, onKeyEvent, dependencies: { skipInitialBlank: true, hid, sharp, officialAppRunning: async () => false, ...dependencies } });
  return { device, writes, handle: () => handle };
}

test('image packets accept XL slots 1..32 only', () => {
  assert.equal(imagePackets(32, Buffer.alloc(10, 1))[0][13], 32);
  assert.throws(() => imagePackets(33, Buffer.alloc(10, 1)));
  assert.throws(() => imagePackets(0, Buffer.alloc(10, 1)));
});

test('XL input codes map to row-major positions; rockers are ignored', () => {
  assert.deepEqual(keyEventFromReport(report(0x01, true), PROFILES.xl), { index: 0, phase: 'down' });
  assert.deepEqual(keyEventFromReport(report(0x20, false), PROFILES.xl), { index: 31, phase: 'up' });
  assert.equal(keyEventFromReport(report(0x21, true), PROFILES.xl), null);
  assert.equal(keyEventFromReport(report(0xff, true), PROFILES.xl), null);
});

test('detects an XL and switches the current profile', async () => {
  const { device, handle } = xlDevice();
  assert.equal(device.profile(), PROFILES['293sv3']);
  await device.start();
  assert.equal(device.status().connected, true);
  assert.equal(device.profile(), PROFILES.xl);
  assert.equal(device.status().model, 'Stream Dock XL (5548:1028)');
  assert.equal(handle().path, 'mock-xl');
  await device.stop();
  const intl = xlDevice({ devices: [{ ...XL, productId: 0x1031 }] });
  await intl.device.start();
  assert.equal(intl.device.status().model, 'Stream Dock XL (5548:1031)');
  await intl.device.stop();
});

test('293S detection keeps its profile and model name', async () => {
  const { device } = xlDevice({ devices: [S293] });
  await device.start();
  assert.equal(device.profile(), PROFILES['293sv3']);
  assert.equal(device.status().model, 'Stream Dock 293S V3 (6603:1014)');
  await device.stop();
});

test('both models connected, or none, refuse to open', async () => {
  const both = xlDevice({ devices: [S293, XL] });
  await both.device.start();
  assert.equal(both.device.status().connected, false);
  assert.match(both.device.status().error, /여러 개/);
  assert.equal(both.handle(), undefined);
  const none = xlDevice({ devices: [{ ...XL, usage: 6 }, { vendorId: 0x1234, productId: 0x1028, usagePage: 0xff00, usage: 1, path: 'x' }] });
  await none.device.start();
  assert.equal(none.device.status().connected, false);
  assert.match(none.device.status().error, /293S V3, XL/);
});

test('simulator keeps the configured profile and model', () => {
  const device = createDevice({ mode: 'simulator', profile: PROFILES.xl });
  assert.equal(device.profile(), PROFILES.xl);
  assert.equal(device.status().model, 'Simulator');
  assert.throws(() => createDevice({ profile: { ...PROFILES.xl } }), TypeError);
});

test('XL key presses dispatch row-major positions; rocker codes are ignored', async () => {
  const presses = [], events = [];
  const { device, handle } = xlDevice({ onKey: i => presses.push(i), onKeyEvent: (i, phase) => events.push([i, phase]) });
  await device.start();
  handle().emit('data', report(0x01, true));
  handle().emit('data', report(0x01, false));
  handle().emit('data', report(0x21, true));
  handle().emit('data', report(0x20, true));
  assert.deepEqual(presses, [0, 31]);
  assert.deepEqual(events, [[0, 'down'], [0, 'up'], [31, 'down']]);
  await device.stop();
});

test('XL render draws 80 px rotated tiles to mapped slots and skips summary keys', async () => {
  const { device, writes } = xlDevice();
  await device.start();
  assert.equal(await device.render([{ index: 0, label: 'Codex', state: 'working' }]), true);
  const drawn = images(writes);
  assert.equal(drawn.length, 32 - 3);
  assert.equal(drawn[0].id, 25, 'index 0 (top-left) is slot 25');
  for (const skipped of [32, 24, 16]) assert.ok(!drawn.some(image => image.id === skipped), `summary slot ${skipped} is not drawn by render`);
  assert.deepEqual(new Set(drawn.map(image => image.id)).size, 29);
  const meta = await sharp(drawn[0].jpeg).metadata();
  assert.equal(meta.width, 80); assert.equal(meta.height, 80);
  for (const { jpeg } of drawn) assert.ok(jpeg.length <= 10240);
  // Rotation 180: the status strip at the top of the upright tile ends up at the bottom.
  const { data, info } = await sharp(drawn[0].jpeg).raw().toBuffer({ resolveWithObject: true });
  const pixel = y => data[(y * info.width + 40) * info.channels + 1];
  assert.ok(pixel(79) > 150, 'green status strip at the bottom after rotation');
  assert.ok(pixel(0) < 80, 'top edge is background after rotation');
  const before = writes.length;
  await device.render([{ index: 0, label: 'Codex', state: 'working' }]);
  assert.equal(writes.length, before, 'unchanged tiles are cached');
  await device.stop();
});

test('XL summary is drawn to keys 7, 15, 23 top-to-bottom and cached', async () => {
  const calls = [];
  const renderSummaryKeyImages = async (summary, _sharp, options) => { calls.push(options); return [1, 2, 3].map(n => Buffer.from([0xff, 0xd8, n, summary.value || 0, 0xff, 0xd9])); };
  const { device, writes } = xlDevice({ dependencies: { renderSummaryKeyImages, renderSummaryTiles: async () => { throw new Error('side tiles must not be used'); } } });
  await device.start();
  assert.equal(await device.renderSummary({ value: 1 }), true);
  assert.deepEqual(calls, [{ size: 80, rotate: 180 }]);
  assert.deepEqual(images(writes).map(({ id, jpeg }) => [id, jpeg[2]]), [[32, 1], [24, 2], [16, 3]]);
  const count = writes.length;
  await device.renderSummary({ value: 1 });
  assert.equal(writes.length, count);
  await device.renderSummary({ value: 2 });
  assert.deepEqual(batIds(writes.slice(count)), [32, 24, 16]);
  await device.stop();
});

test('XL summary with the real renderer produces 80 px JPEGs', async () => {
  const { device, writes } = xlDevice();
  await device.start();
  assert.equal(await device.renderSummary(buildSummary([{ status: 'working' }])), true);
  const drawn = images(writes);
  assert.deepEqual(drawn.map(image => image.id), [32, 24, 16]);
  for (const { jpeg } of drawn) {
    const meta = await sharp(jpeg).metadata();
    assert.equal(meta.width, 80); assert.equal(meta.height, 80);
  }
  await device.stop();
});

test('XL image frames reject side screens and map keys to slots', async () => {
  const { device, writes } = xlDevice();
  await device.start();
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#117744' } }).png().toBuffer();
  await assert.rejects(device.renderImages({ sides: [{ slot: 16, image }] }), TypeError);
  await assert.rejects(device.renderImages({ keys: [{ index: 32, image }] }), TypeError);
  assert.equal(writes.length, 2);
  assert.equal(await device.renderImages({ keys: [{ index: 0, image }, { index: 31, image }] }), true);
  const drawn = images(writes);
  assert.deepEqual(drawn.map(entry => entry.id), [25, 8]);
  const meta = await sharp(drawn[0].jpeg).metadata();
  assert.equal(meta.width, 80); assert.equal(meta.height, 80);
  await device.stop();
});

test('XL frame over a summary key forces the next summary to repaint it', async () => {
  const renderSummaryKeyImages = async () => [1, 2, 3].map(n => Buffer.from([0xff, 0xd8, n, 0xff, 0xd9]));
  const { device, writes } = xlDevice({ dependencies: { renderSummaryKeyImages } });
  await device.start();
  await device.renderSummary({});
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000000' } }).png().toBuffer();
  await device.renderImages({ keys: [{ index: 7, image }] });
  const before = writes.length;
  await device.renderSummary({});
  assert.deepEqual(batIds(writes.slice(before)), [32]);
  await device.stop();
});

test('XL startup blanks all 32 slots with 80 px black images and no boot logo', async () => {
  const { device, writes } = xlDevice({ dependencies: { skipInitialBlank: false } });
  await device.start();
  assert.equal(device.status().connected, true);
  const commands = writes.filter(p => Buffer.from(p.slice(1, 4)).toString('ascii') === 'CRT').map(p => Buffer.from(p.slice(6, 9)).toString('ascii'));
  assert.deepEqual(commands.slice(0, 4), ['DIS', 'CON', 'CLE', 'STP']);
  assert.ok(!commands.includes('LOG'));
  const drawn = images(writes);
  assert.deepEqual(drawn.map(image => image.id), [25, 26, 27, 28, 29, 30, 31, 32, 17, 18, 19, 20, 21, 22, 23, 24, 9, 10, 11, 12, 13, 14, 15, 16, 1, 2, 3, 4, 5, 6, 7, 8]);
  const meta = await sharp(drawn[0].jpeg).metadata();
  assert.equal(meta.width, 80); assert.equal(meta.height, 80);
  await device.stop();
});

test('summary key SVGs centre the 293S content and keep the side tiles unchanged', async () => {
  const summary = buildSummary([{ status: 'blocked', project: 'demo' }]);
  const side = summarySvgs(summary);
  const keys = summaryKeySvgs(summary);
  assert.equal(keys.length, 3);
  keys.forEach((svg, i) => {
    assert.match(svg, /width="96" height="96"/);
    assert.match(svg, /transform="translate\(-10 0\)"/);
    assert.equal(svg.replace(' transform="translate(-10 0)"', ''), side[i]);
  });
  const jpegs = await renderSummaryKeyImages(summary, sharp, { size: 80, rotate: 180 });
  assert.equal(jpegs.length, 3);
  for (const jpeg of jpegs) {
    const meta = await sharp(jpeg).metadata();
    assert.equal(meta.format, 'jpeg'); assert.equal(meta.width, 80); assert.equal(meta.height, 80);
    assert.ok(jpeg.length <= 10240);
  }
  // Visible content is horizontally centred: ink spans roughly equal margins.
  const { data, info } = await sharp(Buffer.from(keys[0])).raw().toBuffer({ resolveWithObject: true });
  let min = info.width, max = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const p = (y * info.width + x) * info.channels;
    if (data[p] > 100 || data[p + 1] > 100 || data[p + 2] > 100) { min = Math.min(min, x); max = Math.max(max, x); }
  }
  assert.ok(Math.abs(min - (info.width - 1 - max)) <= 6, `ink ${min}..${max} is centred`);
  await assert.rejects(renderSummaryKeyImages(summary, null), TypeError);
});
