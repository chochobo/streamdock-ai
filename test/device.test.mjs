import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { commandPacket, createDevice, imagePackets, keyEventFromReport, keyIndexFromReport, keyTileSvg } from '../src/device.mjs';
import sharp from 'sharp';

test('memory tile shows matching estimated GB and percent without clipping', async () => {
  const gib = 1024 ** 3;
  const make = (used, total, value, extra = {}) => ({ id: 'machine-memory', kind: 'feature', state: 'idle', label: '메모리 사용', caption: `약 ${value}%`, bar: { value, direction: 'used', ...extra }, memory: { usedBytes: Math.round(used * gib), totalBytes: total * gib, estimated: true } });
  const normal = keyTileSvg(make(51.8, 64, 81));
  assert.match(normal, />메모리 사용<\/text>/);
  assert.match(normal, />약 51\.8GB<\/text>/);
  assert.match(normal, />약 81%<\/text>/);
  assert.match(normal, /data-bar-direction="used" data-bar-value="81"/);
  const stale = keyTileSvg(make(51.8, 64, 81, { stale: true }));
  assert.match(stale, />메모리 이전<\/text>/);
  assert.match(stale, />약 51\.8GB<\/text>/);
  const english = keyTileSvg({ ...make(51.8, 64, 81), language: 'en' });
  assert.match(english, />Memory Used<\/text>/);
  assert.match(english, />~51\.8GB<\/text>/);
  for (const [used, total, value] of [[0,64,0],[64,64,100],[512,1024,50],[1024,2048,50],[65536,131072,50]]) {
    const key = make(used, total, value);
    const svg = keyTileSvg(key);
    assert.match(svg, new RegExp(`>${value === 100 ? '약 100%' : `약 ${value}%`}<\\/text>`));
    const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
    for (let y = 5; y < 78; y++) for (let x = 92; x < 96; x++) {
      const p = (y * info.width + x) * info.channels;
      assert.ok(data[p] < 150 && data[p + 1] < 150 && data[p + 2] < 150, `text clipped at ${x},${y} for ${used}GB`);
    }
  }
  const bad = keyTileSvg({ ...make(51.8,64,81), memory: { usedBytes: 99*gib, totalBytes:64*gib,estimated:true } });
  assert.doesNotMatch(bad, /99\.0GB/);
  const mismatch = keyTileSvg({ ...make(51.8,64,81), bar: { value: 50, direction: 'used' } });
  assert.doesNotMatch(mismatch, /51\.8GB/);
});

test('memory tile cache redraws when displayed tenths of GB change', async () => {
  const writes = [];
  class FakeHid extends EventEmitter { write(data) { writes.push(data); return data.length; } close() {} }
  const hid = { HID: FakeHid, devicesAsync: async () => [{ vendorId: 0x6603, productId: 0x1014, usagePage: 0xff00, usage: 1, path: 'mock' }] };
  const sharpMock = () => ({ rotate() { return this; }, jpeg() { return this; }, async toBuffer() { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); } });
  const device = createDevice({ mode: 'hardware', dependencies: { skipInitialBlank: true, hid, sharp: sharpMock, officialAppRunning: async () => false } });
  await device.start();
  const gib = 1024 ** 3, memory = used => ({ usedBytes: Math.round(used * gib), totalBytes: 64 * gib, estimated: true });
  const key = { index: 0, id: 'machine-memory', kind: 'feature', label: '메모리 사용', caption: '약 78%', state: 'idle', bar: { value: 78, direction: 'used' }, memory: memory(50.01) };
  await device.render([key]);
  const count = writes.length;
  await device.render([{ ...key, memory: memory(50.04) }]);
  assert.equal(writes.length, count, 'unchanged displayed GB must not redraw');
  await device.render([{ ...key, memory: memory(50.11) }]);
  assert.equal(writes.length, count + 3, 'changed displayed GB must redraw');
  await device.stop();
});

test('percent bars preserve value, direction, thresholds, stale and unavailable state', () => {
  const quota = value => keyTileSvg({ kind: 'quota', label: 'Codex', windowLabel: '7일', usedPercent: value, usageStatus: 'ok' });
  const tile = bar => keyTileSvg({ kind: 'feature', label: '메모리', caption: `${bar.value}%`, state: 'idle', bar });
  assert.match(quota(0), /data-bar-direction="used" data-bar-value="0"/);
  assert.doesNotMatch(quota(null), /data-bar-direction/);
  assert.doesNotMatch(quota(-1), /data-bar-direction/);
  assert.match(quota(59), /width="47.2" height="7" rx="3.5" fill="#59d2ae"/);
  assert.match(quota(60), /width="48" height="7" rx="3.5" fill="#ffc66d"/);
  assert.match(quota(65), /height="4" fill="#ffc66d"/);
  assert.match(quota(65), /fill="#ffc66d"[^>]*>65%<\/text>/);
  assert.match(quota(85), /width="68" height="7" rx="3.5" fill="#fb7185"/);
  assert.match(quota(87), /height="4" fill="#fb7185"/);
  assert.match(quota(87), /fill="#fb7185"[^>]*>87%<\/text>/);
  assert.match(quota(100), /width="80" height="7" rx="3.5" fill="#fb7185"/);
  assert.match(quota(59.6), /data-bar-value="60"/);
  assert.match(keyTileSvg({ kind: 'quota', usedPercent: 50, usageStatus: 'stale' }), /fill="#8c99a8"/);
  assert.match(keyTileSvg({ kind: 'quota', usedPercent: 50, usageStatus: 'stale' }), />이전</);
  assert.match(tile({ value: 25, direction: 'free', warningAt: 75, criticalAt: 90 }), /fill="#ffc66d"/);
  assert.match(tile({ value: 10, direction: 'free', warningAt: 75, criticalAt: 90 }), /fill="#fb7185"/);
  assert.match(tile({ value: 75, direction: 'free', warningAt: 75, criticalAt: 90 }), /fill="#59d2ae"/);
  assert.match(tile({ value: 20, direction: 'charge' }), /fill="#ffc66d"/);
  assert.match(tile({ value: 8, direction: 'score' }), /fill="#fb7185"/);
  assert.doesNotMatch(tile({ value: null, direction: 'used' }), /data-bar-direction/);
  assert.match(tile({ value: 0, direction: 'used' }), /data-bar-value="0"/);
  assert.match(tile({ value: 50, direction: 'used', stale: true }), /fill="#8c99a8"/);
});

test('machine bar captions keep their percent and fit without overlapping the stale label', async () => {
  const rasterBounds = async element => {
    const svg = `<svg width="96" height="96" xmlns="http://www.w3.org/2000/svg">${element}</svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const xs = [], ys = [];
    for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
      if (data[(y * 96 + x) * info.channels + 3]) { xs.push(x); ys.push(y); }
    }
    assert.ok(xs.length > 0);
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  };
  for (const caption of ['사용 73%', '사용 100%', '여유 20%', '충전 100%', '약 0%', '약 83%', '약 100%', '~100%']) {
    const memoryCaption = caption.startsWith('약 ') || caption.startsWith('~');
    const svg = keyTileSvg({ kind: 'feature', id: memoryCaption ? 'machine-memory' : undefined,
      label: memoryCaption ? (caption.startsWith('~') ? 'Memory Used' : '메모리 사용') : '가나다라마바사',
      language: caption.startsWith('~') ? 'en' : 'ko', caption, state: 'unknown',
      bar: { value: 20, direction: 'used', stale: true } });
    const text = [...svg.matchAll(new RegExp('<text[^>]*>[^<]*</text>', 'g'))].map(match => match[0]);
    const value = text.find(part => part.includes(`>${caption}</text>`));
    const old = text.find(part => part.includes(caption.startsWith('~') ? '>Old</text>' : '>이전</text>'));
    assert.ok(value, `Missing full caption ${caption}`);
    assert.ok(old, 'Missing stale label');
    if (memoryCaption) {
      const titleWords = caption.startsWith('~') ? ['Memory', 'Used'] : ['메모리', '사용'];
      for (const word of titleWords) assert.ok(text.some(part => part.includes(`>${word}</text>`)), `Missing memory label ${word}`);
    }
    const a = await rasterBounds(value);
    const b = await rasterBounds(old);
    assert.ok(a.left >= 6 && a.right <= 89, `Caption exceeds tile padding: ${caption}`);
    for (const label of text.filter(part => part !== value && part !== old)) {
      const bounds = await rasterBounds(label);
      assert.ok(bounds.bottom < a.top, `Title overlaps value: ${caption}`);
    }
    assert.ok(a.bottom < b.top, `Caption overlaps stale label: ${caption}`);
    assert.ok(b.bottom < 83, 'Stale label overlaps bar');
  }
});

test('draws semantic icons without reducing project, session, or data text', async () => {
  const samples = [
    [{kind:'project', label:'streamdock-ai', state:'working', caption:'작업 1?'}, 'folder'],
    [{kind:'session', label:'Codex', provider:'codex', state:'working'}, 'codex'],
    [{kind:'session', label:'Claude', provider:'claude', state:'done'}, 'claude'],
    [{kind:'control', label:'기능', action:'modes'}, 'menu'],
    [{kind:'control', label:'머신', id:'machines', action:'open_mode'}, 'machine'],
    [{kind:'control', label:'타이머', id:'pomodoro', action:'open_mode'}, 'timer'],
    [{kind:'control', label:'뒤로', action:'back'}, 'back'],
    [{kind:'control', label:'Next', action:'none', index:14, disabled:true, language:'en'}, 'next'],
    [{kind:'feature', label:'CPU', id:'machine-cpu', state:'idle', caption:'59%'}, 'cpu'],
  ];
  for (const [key, expected] of samples) {
    const svg = keyTileSvg(key);
    assert.match(svg, new RegExp(`data-icon="${expected}"`));
    assert.ok(svg.includes(`>${key.caption || key.label}</text>`));
    assert.match(svg, /font-size="(?:18|19|20)"/);
    const jpeg = await sharp(Buffer.from(svg)).rotate(-90).jpeg({quality: 85}).toBuffer();
    assert.ok(jpeg.length > 0 && jpeg.length <= 10240);
  }
  const userSuppliedId = keyTileSvg({kind:'feature', id:'__proto__', label:'Text', state:'idle'});
  assert.doesNotMatch(userSuppliedId, /data-icon=/);
});


test('renders attention pulses only for project and session keys', () => {
  const done = keyTileSvg({kind: 'session', state: 'done', label: 'Codex', alertPulse: true});
  assert.match(done, /fill="#59d2ae"/);
  assert.match(done, /fill="#101923"[^>]*>Codex/);
  const waiting = keyTileSvg({kind: 'project', state: 'blocked', label: 'Project', alertPulse: true});
  assert.match(waiting, /fill="#ffc66d"/);
  assert.doesNotMatch(keyTileSvg({kind: 'feature', state: 'done', label: 'Feature', alertPulse: true}), /fill="#59d2ae"/);
  assert.doesNotMatch(keyTileSvg({kind: 'session', state: 'error', label: 'Error', alertPulse: true}), /fill="#ffc66d"/);
});

test('localizes quota and state text on device tiles', () => {
  const quota = keyTileSvg({kind: 'quota', label: 'Codex', windowLabel: '7 days', language: 'en', usageStatus: 'stale'});
  assert.match(quota, /7 days Used/);
  assert.match(quota, />Unknown</);
  assert.match(quota, />Old</);
  assert.doesNotMatch(quota, /미확인|오래됨|사용/);
  const reset = keyTileSvg({kind: 'quota-reset', label: 'Codex', windowLabel: '7 days', resetDate: 'Fri', resetTime: '03:00', language: 'en'});
  assert.match(reset, /7 days Reset/);
  assert.match(reset, />Fri</);
  assert.match(keyTileSvg({kind: 'session', label: 'Codex', state: 'working', language: 'en'}), />Working</);
  assert.match(keyTileSvg({kind: 'session', label: 'Codex', state: 'unexpected', language: 'en'}), />Unknown</);
});

test('renders project, session, and navigation keys distinctly', async () => {
  const control = keyTileSvg({kind: 'control', state: 'control', label: '뒤로'});
  assert.match(control, /뒤로/);
  assert.match(control, /text-anchor="middle"/);
  assert.doesNotMatch(control, /미확인/);
  const disabled = keyTileSvg({kind: 'control', state: 'control', label: '다음', disabled: true});
  assert.match(disabled, /#697584/);
  const project = keyTileSvg({kind: 'project', state: 'working', label: 'homenet', caption: '작업 2'});
  assert.match(project, /작업 2/);
  const session = keyTileSvg({kind: 'session', state: 'done', label: '안전 <test>', provider: 'claude', estimated: true});
  assert.match(session, /완료\?/);
  assert.match(session, />CL<\/text>/);
  assert.doesNotMatch(session, /<test>/);
  assert.match(keyTileSvg({kind: 'session', state: 'done', label: 'test', provider: 'codex'}), />CX<\/text>/);
  for (const svg of [control, disabled, project, session]) {
    const jpeg = await sharp(Buffer.from(svg)).rotate(-90).jpeg({quality: 85}).toBuffer();
    assert.ok(jpeg.length > 0 && jpeg.length <= 10240);
  }
});


test('fits four Korean characters on one line without clipping', async () => {
  const samples = [
    { kind: 'control', label: '에이전트', id: 'summary', action: 'open_mode' },
    { kind: 'project', label: '에이전트', state: 'working', caption: '작업 1' },
    { kind: 'session', label: '에이전트', state: 'working', provider: 'codex' },
    { kind: 'feature', label: 'CPU', state: 'idle', caption: '에이전트' },
    { kind: 'quota', label: '에이전트', state: 'idle', windowLabel: '주간', usedPercent: 20 },
  ];
  for (const key of samples) {
    const svg = keyTileSvg(key);
    const text = svg.match(/<text\b[^>]*>에이전트<\/text>/u)?.[0];
    assert.ok(text, `${key.kind} must keep the four characters on one line`);
    const textOnly = `<svg width="96" height="96" xmlns="http://www.w3.org/2000/svg">${text}</svg>`;
    const { data, info } = await sharp(Buffer.from(textOnly)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let left = info.width, right = -1;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 20) { left = Math.min(left, x); right = Math.max(right, x); }
    }
    assert.ok(left >= 7 && right <= 88, `${key.kind} text must stay inside the tile: ${left}-${right}`);
  }
  assert.match(keyTileSvg({ kind: 'project', label: '한글AB', state: 'working' }), />한글AB<\/text>/);
  assert.doesNotMatch(keyTileSvg({ kind: 'project', label: '가나다라마', state: 'working' }), />가나다라마<\/text>/);
});

test('renders readable, bounded key tiles for Korean, long names, and estimated states', async () => {
  for (const label of ['가나다라마바사아자차', 'streamdock-ai-super-long-name', 'A<&👩‍💻X']) {
    const svg = keyTileSvg({ label, state: 'blocked', estimated: true });
    assert.match(svg, /font-size="18"/);
    assert.match(svg, /font-size="19"/);
    assert.match(svg, /확인\?/);
    assert.ok((svg.match(/<text /g) || []).length <= 3);
    assert.doesNotMatch(svg, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    const jpeg = await sharp(Buffer.from(svg)).rotate(-90).jpeg({ quality: 85 }).toBuffer();
    const meta = await sharp(jpeg).metadata();
    assert.equal(meta.width, 96);
    assert.equal(meta.height, 96);
    assert.ok(jpeg.length < 10240);
  }
  // Measured in the bold sans-serif font: 'homenet' occupies 74 px.
  assert.match(keyTileSvg({ label: 'homenet', state: 'working' }), />homenet<\/text>/);
  // Wide glyphs still wrap instead of drawing outside the tile.
  assert.doesNotMatch(keyTileSvg({ label: 'WWWWWW', state: 'working' }), />WWWWWW<\/text>/);
  assert.doesNotMatch(keyTileSvg({}), /<text /);
  assert.match(keyTileSvg({ label: '<test&', state: 'done' }), /&lt;test&amp;/);
});

test('packs 293sV3 commands and splits image reports', () => {
  assert.deepEqual([...commandPacket([0x53, 0x54, 0x50]).subarray(0, 9)], [0, 0x43, 0x52, 0x54, 0, 0, 0x53, 0x54, 0x50]);
  const packets = imagePackets(13, Buffer.alloc(1025, 7));
  assert.equal(packets.length, 4);
  assert.equal(packets[0].readUInt32BE(9), 1025);
  assert.equal(packets[0][13], 13);
  assert.equal(packets[1].length, 1025);
  assert.equal(packets[2][1], 7);
  assert.equal(packets[2][2], 0);
  assert.throws(() => imagePackets(1, Buffer.alloc(10241)));
});

test('decodes only key presses into row-major positions', () => {
  const report = Buffer.alloc(11);
  report.set(Buffer.from('ACK'), 0); report.set(Buffer.from('OK'), 5);
  report[9] = 13; report[10] = 1;
  assert.equal(keyIndexFromReport(report), 0);
  for (const offset of [0, 1, 2, 5, 6]) {
    const invalid = Buffer.from(report); invalid[offset] ^= 0xff;
    assert.equal(keyIndexFromReport(invalid), null);
  }
  assert.equal(keyIndexFromReport(report.subarray(0, 10)), null);
  report[9] = 3;
  assert.equal(keyIndexFromReport(report), 14);
  report[10] = 0;
  assert.equal(keyIndexFromReport(report), null);
});

test('refuses to open when official application is running', async () => {
  let enumerated = false;
  const device = createDevice({ mode: 'hardware', dependencies: { officialAppRunning: async () => true, hid: { devicesAsync: async () => { enumerated = true; return []; } } } });
  await device.start();
  assert.equal(enumerated, false);
  assert.equal(device.status().connected, false);
  assert.match(device.status().error, /StreamDock/);
});

test('hardware sends only changed tiles and reports button events', async () => {
  const writes = [];
  let fakeHandle;
  class FakeHid extends EventEmitter {
    constructor() { super(); fakeHandle = this; }
    write(data) { writes.push(data); return data.length; }
    close() {}
  }
  const hid = { HID: FakeHid, devicesAsync: async () => [{ vendorId: 0x6603, productId: 0x1014, usagePage: 0xff00, usage: 1, path: 'mock' }] };
  const images = [];
  const sharp = svg => { images.push(svg.toString()); return { rotate() { return this; }, jpeg() { return this; }, async toBuffer() { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); } }; };
  const presses = [];
  const device = createDevice({ mode: 'hardware', onKey: key => presses.push(key), dependencies: { skipInitialBlank: true, hid, sharp, officialAppRunning: async () => false } });
  await device.start();
  assert.equal(device.status().connected, true);
  await device.render([{ index: 0, label: 'Codex', state: 'working' }]);
  assert.equal(writes.length, 2 + 15 * 3);
  await device.render([{ index: 0, label: 'Codex', state: 'working' }]);
  assert.equal(writes.length, 2 + 15 * 3);
  await device.render([{ index: 0, label: 'Codex', state: 'waiting' }]);
  assert.equal(writes.length, 2 + 16 * 3);
  await device.render([{ index: 0, label: 'Codex', state: 'waiting', estimated: true }]);
  assert.equal(writes.length, 2 + 17 * 3);
  assert.match(images.at(-1), /확인\?/);
  await device.render([{ index: 0, label: 'Codex', state: 'waiting', estimated: false }]);
  assert.equal(writes.length, 2 + 18 * 3);
  assert.doesNotMatch(images.at(-1), /확인\?/);
  await device.render([{ index: 0, label: 'Codex', state: 'waiting', kind: 'project', caption: '확인 1' }]);
  assert.equal(writes.length, 2 + 19 * 3);
  await device.render([{ index: 0, label: 'Codex', state: 'waiting', kind: 'project', caption: '확인 2' }]);
  assert.equal(writes.length, 2 + 20 * 3);
  assert.match(images.at(-1), /확인 2/);
  await device.render([{ index: 0, label: 'Codex', state: 'waiting', kind: 'session', provider: 'codex' }]);
  assert.equal(writes.length, 2 + 21 * 3);
  await device.render([{ index: 0, label: 'Codex', state: 'waiting', kind: 'session', provider: 'claude' }]);
  assert.equal(writes.length, 2 + 22 * 3);
  assert.match(images.at(-1), />CL<\/text>/);
  await device.render([{ index: 0, label: '다음', state: 'control', kind: 'control', disabled: false }]);
  assert.equal(writes.length, 2 + 23 * 3);
  await device.render([{ index: 0, label: '다음', state: 'control', kind: 'control', disabled: true }]);
  assert.equal(writes.length, 2 + 24 * 3);
  assert.match(images.at(-1), /#697584/);
  await device.render([{ index: 0, label: 'Codex', state: 'waiting', kind: 'session', language: 'ko' }]);
  const writesBeforeLanguageChange = writes.length;
  await device.render([{ index: 0, label: 'Codex', state: 'waiting', kind: 'session', language: 'en' }]);
  assert.equal(writes.length, writesBeforeLanguageChange + 3);
  assert.match(images.at(-1), />Review</);
  const writesBeforePulse = writes.length;
  await device.render([{ index: 0, label: 'Codex', state: 'waiting', kind: 'session', language: 'en', alertPulse: true }]);
  assert.equal(writes.length, writesBeforePulse + 3);
  assert.match(images.at(-1), /fill="#ffc66d"/);
  await device.render([{ index: 0, label: '메뉴', state: 'control', kind: 'control', id: 'machines', action: 'open_mode' }]);
  const writesBeforeIconChange = writes.length;
  await device.render([{ index: 0, label: '메뉴', state: 'control', kind: 'control', id: 'games', action: 'open_mode' }]);
  assert.equal(writes.length, writesBeforeIconChange + 3);
  assert.match(images.at(-1), /data-icon="game"/);
  await device.render([{ index: 0, label: '메뉴', state: 'control', kind: 'control', action: 'modes' }]);
  const writesBeforeActionChange = writes.length;
  await device.render([{ index: 0, label: '메뉴', state: 'control', kind: 'control', action: 'usage' }]);
  assert.equal(writes.length, writesBeforeActionChange + 3);
  assert.match(images.at(-1), /data-icon="gauge"/);
  const input = Buffer.alloc(11); input.set(Buffer.from('ACK'), 0); input.set(Buffer.from('OK'), 5); input[9] = 13; input[10] = 1;
  fakeHandle.emit('data', input);
  assert.deepEqual(presses, [0]);
  await device.stop();
  assert.equal(device.status().connected, false);
});

test('bar value, direction, age and thresholds trigger device repaint', async () => {
  const writes = [];
  class FakeHid extends EventEmitter { write(data) { writes.push(data); return data.length; } close() {} }
  const hid = { HID: FakeHid, devicesAsync: async () => [{ vendorId: 0x6603, productId: 0x1014, usagePage: 0xff00, usage: 1, path: 'mock' }] };
  const sharpMock = () => ({ rotate() { return this; }, jpeg() { return this; }, async toBuffer() { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); } });
  const device = createDevice({ mode: 'hardware', dependencies: { skipInitialBlank: true, hid, sharp: sharpMock, officialAppRunning: async () => false } });
  await device.start();
  const key = { index: 0, kind: 'feature', label: 'CPU', caption: '20%', state: 'idle', bar: { value: 20, direction: 'used' } };
  await device.render([key]);
  let count = writes.length;
  await device.render([key]);
  assert.equal(writes.length, count);
  for (const bar of [ { value: 21, direction: 'used' }, { value: 21, direction: 'free' }, { value: 21, direction: 'free', stale: true }, { value: 21, direction: 'free', warningAt: 80, criticalAt: 90 } ]) {
    await device.render([{ ...key, bar }]);
    assert.equal(writes.length, count + 3);
    count = writes.length;
  }
  await device.stop();
});

test('summary writes three display slots, caches unchanged tiles, and shares the device queue', async () => {
  const writes = [];
  class FakeHid extends EventEmitter {
    write(data) { writes.push(data); return data.length; }
    close() {}
  }
  const hid = { HID: FakeHid, devicesAsync: async () => [{ vendorId: 0x6603, productId: 0x1014, usagePage: 0xff00, usage: 1, path: 'mock' }] };
  const sharp = () => ({ rotate() { return this; }, jpeg() { return this; }, async toBuffer() { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); } });
  const renderSummaryTiles = async summary => [16, 17, 18].map(slot => ({ slot, jpeg: Buffer.from([0xff, 0xd8, slot, slot === 17 ? summary.value : 0, 0xff, 0xd9]) }));
  const device = createDevice({ mode: 'hardware', dependencies: { skipInitialBlank: true, hid, sharp, renderSummaryTiles, officialAppRunning: async () => false } });
  await device.start();
  await Promise.all([device.render([{ index: 0, label: 'Codex', state: 'working' }]), device.renderSummary({ value: 1 })]);
  const ids = writes.filter(w => String.fromCharCode(...w.slice(6, 9)) === 'BAT').map(w => w[13]);
  assert.equal(ids.length, 18);
  assert.deepEqual(ids.slice(-3), [16, 17, 18]);
  const count = writes.length;
  await device.renderSummary({ value: 1 });
  assert.equal(writes.length, count);
  await device.renderSummary({ value: 2 });
  assert.equal(writes.length, count + 3);
  assert.equal(writes[count][13], 17);
  await device.stop();
});

test('summary clears its cache after an incomplete write', async () => {
  const writes = [];
  let shouldFail = true;
  class FakeHid extends EventEmitter {
    write(data) {
      writes.push(data);
      if (shouldFail && String.fromCharCode(...data.slice(6, 9)) === 'BAT' && data[13] === 17) throw new Error('test write failure');
      return data.length;
    }
    close() {}
  }
  const hid = { HID: FakeHid, devicesAsync: async () => [{ vendorId: 0x6603, productId: 0x1014, usagePage: 0xff00, usage: 1, path: 'mock' }] };
  const renderSummaryTiles = async () => [16, 17, 18].map(slot => ({ slot, jpeg: Buffer.from([0xff, 0xd8, slot, 0xff, 0xd9]) }));
  const device = createDevice({ mode: 'hardware', dependencies: { skipInitialBlank: true, hid, sharp: () => {}, renderSummaryTiles, officialAppRunning: async () => false } });
  await device.start();
  assert.equal(await device.renderSummary({}), false);
  assert.match(device.status().error, /test write failure/);
  shouldFail = false;
  await device.start();
  const before = writes.length;
  assert.equal(await device.renderSummary({}), true);
  const ids = writes.slice(before).filter(w => String.fromCharCode(...w.slice(6, 9)) === 'BAT').map(w => w[13]);
  assert.deepEqual(ids, [16, 17, 18]);
  await device.stop();
  assert.equal(await createDevice({ mode: 'simulator' }).renderSummary({}), false);
});

test('brightness uses SDK LIG framing only after an explicit validated request', async () => {
  const writes = [];
  class FakeHid extends EventEmitter {
    write(data) { writes.push(data); return data.length; }
    close() {}
  }
  const hid = { HID: FakeHid, devicesAsync: async () => [{ vendorId: 0x6603, productId: 0x1014, usagePage: 0xff00, usage: 1, path: 'mock' }] };
  const device = createDevice({ mode: 'hardware', dependencies: { skipInitialBlank: true, hid, sharp: () => {}, officialAppRunning: async () => false } });
  await device.start();
  const initial = writes.length;
  assert.equal(device.status().requestedBrightness, undefined);
  assert.equal(await device.setBrightness(42), true);
  assert.deepEqual(writes.at(-1).slice(0, 12), [0, 0x43, 0x52, 0x54, 0, 0, 0x4c, 0x49, 0x47, 0, 0, 42]);
  assert.equal(writes.at(-1).length, 1025);
  assert.equal(device.status().requestedBrightness, 42);
  for (const value of [-1, 101, 50.5, '50', null, NaN]) await assert.rejects(device.setBrightness(value), RangeError);
  assert.equal(writes.length, initial + 1);
  await device.setBrightness(0);
  await device.setBrightness(100);
  assert.deepEqual(writes.slice(-2).map(packet => packet[11]), [0, 100]);
  await device.stop();
  assert.equal(await device.setBrightness(50), false);
  const simulated = createDevice({ mode: 'simulator' });
  assert.equal(await simulated.setBrightness(25), true);
  assert.equal(simulated.status().requestedBrightness, 25);
});

test('decodes press and release safely and rejects malformed reports', () => {
  const input = Buffer.alloc(11);
  input.set(Buffer.from('ACK'), 0); input.set(Buffer.from('OK'), 5);
  input[9] = 13; input[10] = 1;
  assert.deepEqual(keyEventFromReport(input), { index: 0, phase: 'down' });
  input[10] = 0;
  assert.deepEqual(keyEventFromReport(input), { index: 0, phase: 'up' });
  assert.equal(keyIndexFromReport(input), null);
  input[10] = 2;
  assert.equal(keyEventFromReport(input), null);
  input[10] = 1; input[9] = 16;
  assert.equal(keyEventFromReport(input), null);
  assert.equal(keyEventFromReport(null), null);
});

test('emits down and release duration once, and cancels on disconnect', async () => {
  let handle;
  class FakeHid extends EventEmitter {
    constructor() { super(); handle = this; }
    write(data) { return data.length; }
    close() {}
  }
  const hid = { HID: FakeHid, devicesAsync: async () => [{ vendorId: 0x6603, productId: 0x1014, usagePage: 0xff00, usage: 1, path: 'mock' }] };
  let now = 100;
  const events = [], legacy = [];
  const device = createDevice({ mode: 'hardware', onKey: i => legacy.push(i),
    onKeyEvent: (i, phase, heldMs) => events.push({ i, phase, heldMs }),
    dependencies: { skipInitialBlank: true, hid, sharp: () => {}, now: () => now, officialAppRunning: async () => false } });
  await device.start();
  const report = Buffer.alloc(11); report.set(Buffer.from('ACK'), 0); report.set(Buffer.from('OK'), 5); report[9] = 13; report[10] = 1;
  handle.emit('data', report);
  handle.emit('data', report); // repeated press is not a second action
  now = 1700; report[10] = 0; handle.emit('data', report);
  handle.emit('data', report); // release without a press is ignored
  assert.deepEqual(legacy, [0]);
  assert.deepEqual(events, [{ i: 0, phase: 'down', heldMs: 0 }, { i: 0, phase: 'up', heldMs: 1600 }]);
  report[10] = 1; handle.emit('data', report);
  now = 1900; handle.emit('error', new Error('disconnected'));
  assert.deepEqual(events.at(-1), { i: 0, phase: 'cancel', heldMs: 200 });
  assert.equal(device.status().connected, false);
  await device.stop();
});

test('expired holds cancel and cannot become an action until released', async () => {
  let handle;
  class FakeHid extends EventEmitter {
    constructor() { super(); handle = this; }
    write(data) { return data.length; }
    close() {}
  }
  const hid = { HID: FakeHid, devicesAsync: async () => [{ vendorId: 0x6603, productId: 0x1014, usagePage: 0xff00, usage: 1, path: 'mock' }] };
  const phases = [], legacy = [];
  const device = createDevice({ mode: 'hardware', maxHoldMs: 25, onKey: i => legacy.push(i),
    onKeyEvent: (i, phase) => phases.push(phase), dependencies: { skipInitialBlank: true, hid, sharp: () => {}, officialAppRunning: async () => false } });
  await device.start();
  const input = Buffer.alloc(11); input.set(Buffer.from('ACK'), 0); input.set(Buffer.from('OK'), 5); input[9] = 13; input[10] = 1;
  handle.emit('data', input);
  await new Promise(resolve => setTimeout(resolve, 40));
  handle.emit('data', input);
  input[10] = 0; handle.emit('data', input);
  input[10] = 1; handle.emit('data', input);
  assert.deepEqual(legacy, [0, 0]);
  assert.deepEqual(phases, ['down', 'cancel', 'down']);
  await device.stop();
  assert.deepEqual(phases, ['down', 'cancel', 'down', 'cancel']);
});

test('image frames validate, convert, cache, and share key and side display paths', async () => {
  const writes = [];
  class FakeHid extends EventEmitter {
    write(data) { writes.push(data); return data.length; }
    close() {}
  }
  const hid = { HID: FakeHid, devicesAsync: async () => [{ vendorId: 0x6603, productId: 0x1014, usagePage: 0xff00, usage: 1, path: 'mock' }] };
  const device = createDevice({ mode: 'hardware', dependencies: { skipInitialBlank: true, hid, sharp, officialAppRunning: async () => false } });
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#117744' } }).png().toBuffer();
  const pngCorrupt = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(20)]);
  await device.start();
  const frame = { keys: [{ index: 0, image }, { index: 14, image }], sides: [{ slot: 16, image }, { slot: 18, image }] };
  assert.equal(await device.renderImages(frame), true);
  const packets = () => writes.filter(w => String.fromCharCode(...w.slice(6, 9)) === 'BAT').map(w => w[13]);
  assert.deepEqual(packets(), [13, 3, 16, 18]);
  const before = writes.length;
  assert.equal(await device.renderImages(frame), true);
  assert.equal(writes.length, before);
  await assert.rejects(device.renderImages({ keys: [{ index: 0, image }, { index: 0, image }] }), /Invalid/);
  await assert.rejects(device.renderImages({ sides: [{ slot: 15, image }] }), /Invalid/);
  await assert.rejects(device.renderImages({ keys: [{ index: 1, image: pngCorrupt }] }), /decode/);
  assert.equal(writes.length, before);
  assert.equal(device.status().connected, true);
  await device.stop();
});
test('startup replaces all key and side slots with opaque black before reporting connected', async () => {
  const writes = [], states = []; let device, instance; const phases=[];
  class FakeHid extends EventEmitter {
    constructor(){super();instance=this}
    write(value){writes.push(Buffer.from(value));states.push(device.status().connected);if(writes.length===4){const input=Buffer.from([0x41,0x43,0x4b,0,0,0x4f,0x4b,0,0,13,1]);this.emit('data',input)}return value.length}
    close(){}
  }
  const hid={HID:FakeHid,devicesAsync:async()=>[{vendorId:0x6603,productId:0x1014,usagePage:0xff00,usage:1,path:'mock'}]};
  device=createDevice({mode:'hardware',onKeyEvent:(i,p)=>phases.push([i,p]),dependencies:{hid,sharp,officialAppRunning:async()=>false}});
  await device.start();assert.equal(device.status().connected,true);assert.ok(states.every(value=>value===false));assert.deepEqual(phases,[],'startup input cannot target a stale screen');
  assert.deepEqual([...writes[0].subarray(6,9)], [0x44,0x49,0x53], 'wake first');
  assert.equal(writes[1].subarray(6,13).toString('ascii'), 'CONNECT');
  assert.deepEqual([...writes[2].subarray(6,13)], [0x43,0x4c,0x45,0,0,0,0xff], 'clear transient key overlays');
  assert.equal(writes[3].subarray(6,9).toString('ascii'), 'STP', 'refresh clear before images');
  const commands=writes.filter(p=>p.subarray(1,4).toString('ascii')==='CRT').map(p=>p.subarray(6,9).toString('ascii'));
  assert.ok(!commands.includes('LOG'),'never send a persistent boot-logo command');
  assert.ok(!commands.includes('LIG'),'never alter brightness during startup');
  const ids=[], jpgs=[];let i=4;
  while(i<writes.length){const header=writes[i++];assert.equal(header.subarray(6,9).toString('ascii'),'BAT');const size=header.readUInt32BE(9);ids.push(header[13]);const chunks=[];for(let remaining=size;remaining>0;remaining-=1024)chunks.push(writes[i++].subarray(1));jpgs.push(Buffer.concat(chunks).subarray(0,size));assert.equal(writes[i++].subarray(6,9).toString('ascii'),'STP')}
  assert.deepEqual(ids,[13,10,7,4,1,14,11,8,5,2,15,12,9,6,3,16,17,18]);
  const {data,info}=await sharp(jpgs[0]).raw().toBuffer({resolveWithObject:true});assert.equal(info.width,96);assert.equal(info.height,96);assert.ok(data.every(x=>x===0),'startup key must be opaque black');
  const before=writes.length;assert.equal(await device.render([{index:0,label:'Test',state:'working'}]),true);assert.ok(writes.length>before,'black startup must not pollute normal frame cache');
  const down=Buffer.from([0x41,0x43,0x4b,0,0,0x4f,0x4b,0,0,13,1]);instance.emit('data',down);assert.deepEqual(phases,[[0,'down']]);await device.stop();
});
test('startup image error disconnects and clears caches before a successful retry',async()=>{
  let failAt=8, closed=0;const writes=[];
  class FakeHid extends EventEmitter{write(value){writes.push(Buffer.from(value));if(failAt && writes.length===failAt)throw Error('initial image failure');return value.length}close(){closed++}}
  const hid={HID:FakeHid,devicesAsync:async()=>[{vendorId:0x6603,productId:0x1014,usagePage:0xff00,usage:1,path:'mock'}]};
  const device=createDevice({mode:'hardware',dependencies:{hid,sharp,officialAppRunning:async()=>false}});
  await device.start();assert.equal(device.status().connected,false);assert.match(device.status().error,/initial image failure/);assert.equal(closed,1);
  failAt=0;const before=writes.length;await device.start();assert.equal(device.status().connected,true);assert.ok(writes.length-before>=58,'retry must clear and repaint all 18 slots');
  const renderStart=writes.length;assert.equal(await device.render([{index:0,label:'Test',state:'working'}]),true);assert.ok(writes.length>renderStart);await device.stop();
});
test('device response timestamp is not carried over into a new connection',async()=>{
  let handle;class FakeHid extends EventEmitter{constructor(){super();handle=this}write(a){return a.length}close(){}}
  const hid={HID:FakeHid,devicesAsync:async()=>[{vendorId:0x6603,productId:0x1014,usagePage:0xff00,usage:1,path:'mock'}]};
  const device=createDevice({mode:'hardware',dependencies:{skipInitialBlank:true,hid,sharp,officialAppRunning:async()=>false}});
  await device.start();handle.emit('data',Buffer.from([0,0,0,0,0,0,0,0,0,0xff]));assert.ok(Number.isFinite(Date.parse(device.status().lastDeviceAcknowledgementAt)));assert.ok(Number.isFinite(Date.parse(device.status().lastTransportHeartbeatAt)));
  await device.stop();assert.equal(device.status().lastDeviceAcknowledgementAt,null);await device.start();assert.equal(device.status().lastDeviceAcknowledgementAt,null);await device.stop();
});
test('late events from a previous HID handle cannot affect a reconnected device',async()=>{
  const handles=[],phases=[];class FakeHid extends EventEmitter{constructor(){super();handles.push(this)}write(a){return a.length}close(){}}
  const hid={HID:FakeHid,devicesAsync:async()=>[{vendorId:0x6603,productId:0x1014,usagePage:0xff00,usage:1,path:'mock'}]};
  const device=createDevice({mode:'hardware',onKeyEvent:(i,p)=>phases.push([i,p]),dependencies:{skipInitialBlank:true,hid,sharp,officialAppRunning:async()=>false}});
  await device.start();const old=handles[0];await device.stop();await device.start();const current=handles[1];
  const down=Buffer.from([0x41,0x43,0x4b,0,0,0x4f,0x4b,0,0,13,1]);old.emit('data',down);old.emit('deviceAck');old.emit('error',new Error('late error'));
  assert.deepEqual(phases,[]);assert.equal(device.status().lastDeviceAcknowledgementAt,null);assert.equal(device.status().connected,true);
  current.emit('data',down);assert.deepEqual(phases,[[0,'down']]);await device.stop();
});
test('clear failure never reports connected and retry clears before repaint',async()=>{
  const writes=[];let failClear=true,closed=0;
  class FakeHid extends EventEmitter{write(value){const packet=Buffer.from(value);writes.push(packet);if(failClear&&packet.subarray(6,9).toString('ascii')==='CLE')throw Error('clear failure');return value.length}close(){closed++}}
  const hid={HID:FakeHid,devicesAsync:async()=>[{vendorId:0x6603,productId:0x1014,usagePage:0xff00,usage:1,path:'mock'}]};
  const device=createDevice({mode:'hardware',dependencies:{hid,sharp,officialAppRunning:async()=>false}});
  await device.start();assert.equal(device.status().connected,false);assert.match(device.status().error,/clear failure/);assert.equal(closed,1);
  assert.equal(writes.length,3);assert.equal(writes[2].subarray(6,9).toString('ascii'),'CLE');
  failClear=false;const before=writes.length;await device.start();assert.equal(device.status().connected,true);
  const retry=writes.slice(before);assert.equal(retry[2].subarray(6,9).toString('ascii'),'CLE');assert.equal(retry[3].subarray(6,9).toString('ascii'),'STP');assert.equal(retry[4].subarray(6,9).toString('ascii'),'BAT');
  const afterInitial=writes.length;assert.equal(await device.render([{index:0,label:'프로젝트',state:'working'}]),true);assert.ok(writes.length>afterInitial,'application frame must be repainted');await device.stop();
});
