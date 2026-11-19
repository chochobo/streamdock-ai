import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROFILES } from '../src/device-profiles.mjs';
import { KEY_TEST_EXIT_HOLD_MS, keyTestExitIndex, keyTestFrame, keyTestKeySvg, keyTestMessage } from '../src/key-test.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const texts = svg => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(match => match[1]);

for (const profile of Object.values(PROFILES)) {
  test(`${profile.id}: every key shows its own index, row/col and device slot`, () => {
    const frame = keyTestFrame(profile);
    assert.equal(frame.keys.length, profile.keyCount);
    const slots = new Set();
    for (const { index, svg } of frame.keys) {
      const [label, position, slot] = texts(svg);
      assert.equal(label, String(index));
      assert.equal(position, `r${Math.floor(index / profile.cols)} c${index % profile.cols}`);
      assert.equal(slot, `slot ${profile.slotOf(index)}`);
      slots.add(profile.slotOf(index));
    }
    // Slots are a permutation of the device's key slots.
    assert.equal(slots.size, profile.keyCount);
    assert.deepEqual(frame.sides.map(side => side.slot), [...profile.sideSlots]);
    for (const side of frame.sides) assert.equal(texts(side.svg)[0], `slot ${side.slot}`);
  });

  test(`${profile.id}: the pressed key is inverted and shows its raw input code; only the last key is labelled exit`, () => {
    const exit = keyTestExitIndex(profile);
    assert.equal(exit, profile.keyCount - 1);
    const pressed = keyTestKeySvg(profile, 3, { last: { index: 3, code: 0x0d } });
    assert.match(pressed, /fill="#ffd84d"/);
    assert.ok(texts(pressed).includes('입력 0x0D'));
    assert.doesNotMatch(keyTestKeySvg(profile, 4, { last: { index: 3, code: 0x0d } }), /#ffd84d/);
    const exitLabels = keyTestFrame(profile).keys.filter(key => texts(key.svg).includes('길게: 나가기')).map(key => key.index);
    assert.deepEqual(exitLabels, [exit]);
    assert.ok(texts(keyTestKeySvg(profile, exit, { language: 'en' })).includes('Hold: exit'));
    assert.match(keyTestMessage(profile, { last: { index: 3, code: 0x0d } }), /3번 키 \(입력 코드 0x0D\).*\d+번 키를 길게/);
  });
}

test('293S side screens show their slot, the last key and its input code', () => {
  const profile = PROFILES['293sv3'];
  const sides = keyTestFrame(profile, { last: { index: 0, code: 13 }, count: 2 }).sides.map(side => texts(side.svg));
  assert.deepEqual(sides.map(lines => lines[0]), ['slot 16', 'slot 17', 'slot 18']);
  assert.equal(sides[0][2], '0');
  assert.equal(sides[1][2], '0x0D');
  assert.equal(sides[2][1], '14번 길게');
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function readText(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function status(base) {
  const response = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
}
async function until(read, predicate, { timeout = 15_000 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await read(); if (predicate(last)) return last; } catch { /* startup or transient read */ }
    await delay(30);
  }
  throw new Error(`Timed out; last=${JSON.stringify({ mode: last?.deck?.mode, keyTest: last?.keyTest })}`);
}
async function click(base, choose) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const before = await status(base);
    const key = before.deck && choose(before.deck);
    if (!key) { await delay(30); continue; }
    const response = await fetch(`${base}/api/press`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: key.index, revision: before.deck.revision }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json();
    if (result.code === 'busy' || result.code === 'stale') { await delay(30); continue; }
    assert.equal(result.ok, true, result.message || result.code);
    return status(base);
  }
  throw new Error('Expected button remained unavailable');
}

const devices = {
  '293sv3': { vendorId: 0x6603, productId: 0x1014, codeOf: index => PROFILES['293sv3'].slotOf(index) },
  xl: { vendorId: 0x5548, productId: 0x1028, codeOf: index => index + 1 },
};

for (const [model, usb] of Object.entries(devices)) {
  test(`${model}: key test screen opens from settings, reports physical presses and exits only on a held exit key`, { timeout: 90_000 }, async t => {
    const profile = PROFILES[model];
    const home = await mkdtemp(path.join(os.tmpdir(), `streamdock-key-test-${model}-`));
    const fakeHid = path.join(home, 'hid.mjs'), fakeChild = path.join(home, 'child.mjs');
    const loader = path.join(home, 'loader.mjs'), guard = path.join(home, 'guard.mjs');
    const hidLog = path.join(home, 'hid.log'), networkLog = path.join(home, 'network.log');
    // stdin lines {code, phase} become raw input reports; written packets are logged.
    await writeFile(fakeHid, `import {EventEmitter} from 'node:events';import {appendFileSync} from 'node:fs';let handle;let buffer='';
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))>=0){let line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const x=JSON.parse(line);const d=Buffer.alloc(11);d[0]=0x41;d[1]=0x43;d[2]=0x4b;d[5]=0x4f;d[6]=0x4b;d[9]=x.code;d[10]=x.phase==='down'?1:0;handle?.emit('data',d);}catch{}}});
export async function devicesAsync(){return [{vendorId:${usb.vendorId},productId:${usb.productId},usagePage:65440,usage:1,path:'mock'}]};
export class HID extends EventEmitter{constructor(){super();handle=this}write(a){appendFileSync(process.env.FAKE_HID_LOG,Buffer.from(a.slice(0,16)).toString('hex')+'\\n');return a.length}close(){handle=undefined}}`);
    await writeFile(fakeChild, `export function execFile(file,args,options,callback){const cb=typeof options==='function'?options:callback;const error=Object.assign(new Error('no official app'),{code:1});process.nextTick(()=>cb(error,'',''));return {kill(){}}}`);
    await writeFile(loader, `const hid=${JSON.stringify(pathToFileURL(fakeHid).href)},child=${JSON.stringify(pathToFileURL(fakeChild).href)};
export async function resolve(s,c,n){if(s==='node-hid')return {url:hid,shortCircuit:true};if(s==='node:child_process'&&c.parentURL?.endsWith('/src/device.mjs'))return {url:child,shortCircuit:true};return n(s,c)}`);
    await writeFile(guard, `import {appendFileSync} from 'node:fs';globalThis.fetch=async()=>{appendFileSync(process.env.FAKE_NETWORK_LOG,'unexpected\\n');throw Error('network disabled in test')}`);
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, HOME: home, PORT: String(port), FAKE_HID_LOG: hidLog, FAKE_NETWORK_LOG: networkLog,
      STREAMDOCK_USAGE_DISABLED: '1', STREAMDOCK_PRESENCE_DISABLED: '1', STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1' };
    const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--import', guard, 'src/server.mjs', '--device'], { cwd: root, env, stdio: ['pipe', 'ignore', 'ignore'] });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit').catch(() => {}); child.kill('SIGTERM'); let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
      await rm(home, { recursive: true, force: true });
    });
    const send = (code, phase) => child.stdin.write(JSON.stringify({ code, phase }) + '\n');
    async function physical(index, holdMs = 0) {
      const before = (await status(base)).keyTest?.count;
      send(usb.codeOf(index), 'down');
      if (holdMs) await delay(holdMs);
      send(usb.codeOf(index), 'up');
      return until(() => status(base), s => s.keyTest === null || s.keyTest?.count !== before);
    }

    await until(() => status(base), s => s.device?.connected && s.deck?.view === 'projects' && s.deck?.layout?.model === model);
    await click(base, deck => deck.keys.find(k => k.action === 'modes'));
    // The 293S hub has 12 items per page; settings may be on the next page.
    let settingsPage;
    for (let page = 0; page < 3 && !settingsPage; page++) {
      const hub = await status(base);
      if (hub.deck.keys.some(k => k.label === '설정' && k.action === 'open_mode')) settingsPage = await click(base, deck => deck.keys.find(k => k.label === '설정' && k.action === 'open_mode'));
      else await click(base, deck => deck.keys.find(k => k.action === 'next'));
    }
    settingsPage = await until(() => status(base), s => s.deck?.mode === 'settings');
    assert.equal(settingsPage.keyTest, null);
    const opened = await click(base, deck => deck.keys.find(k => k.label === '키 시험' && k.action === 'feature_action'));
    const screen = await until(() => Promise.resolve(opened), s => s.keyTest?.active === true);
    assert.equal(screen.keyTest.exitIndex, profile.keyCount - 1);
    assert.equal(screen.keyTest.exitHoldMs, KEY_TEST_EXIT_HOLD_MS);
    assert.equal(screen.deck.keys.length, profile.keyCount);
    for (const key of screen.deck.keys) {
      assert.equal(key.label, String(key.index));
      assert.equal(key.caption, `slot ${profile.slotOf(key.index)}`);
    }
    // Preview frames cover every key, summary keys included.
    assert.deepEqual(screen.deck.frames.map(frame => frame.index).sort((a, b) => a - b), Array.from({ length: profile.keyCount }, (_, i) => i));

    // Every key, short-pressed, is reported with its raw code and never exits.
    for (let index = 0; index < profile.keyCount; index++) {
      const s = await physical(index);
      assert.equal(s.keyTest?.active, true, `key ${index} left the key test`);
      assert.deepEqual({ index: s.keyTest.last.index, code: s.keyTest.last.code, slot: s.keyTest.last.slot }, { index, code: usb.codeOf(index), slot: profile.slotOf(index) });
      assert.equal(s.deck.keys[index].state, 'working');
      assert.ok(s.deck.message.startsWith(`키 시험: ${index}번 키 `), s.deck.message);
    }
    if (model === 'xl') {
      // Rockers are recorded for direction checks and never act (no page change, no brightness).
      const brightness = (await status(base)).settings?.brightness ?? null;
      for (const [code, rocker, action] of [[0x21, 'left', 'up'], [0x25, 'right', 'push'], [0x26, 'right', 'down']]) {
        const before = (await status(base)).keyTest.count;
        send(code, 'down'); send(code, 'up');
        const r = await until(() => status(base), s => s.keyTest?.count !== before);
        assert.equal(r.keyTest?.active, true);
        assert.deepEqual({ rocker: r.keyTest.last.rocker, action: r.keyTest.last.action, code: r.keyTest.last.code, index: r.keyTest.last.index }, { rocker, action, code, index: null });
        assert.ok(r.deck.message.startsWith('키 시험: '), r.deck.message);
        assert.ok(r.deck.message.includes('로커'), r.deck.message);
      }
      assert.equal((await status(base)).settings?.brightness ?? null, brightness);
    }
    // Holding a non-exit key is still just a test press.
    const held = await physical(0, KEY_TEST_EXIT_HOLD_MS + 300);
    assert.equal(held.keyTest?.active, true);
    assert.equal(held.keyTest.last.index, 0);
    // Holding the exit key returns to the settings page.
    const exited = await physical(profile.keyCount - 1, KEY_TEST_EXIT_HOLD_MS + 300);
    assert.equal(exited.keyTest, null);
    const back = await until(() => status(base), s => s.deck?.mode === 'settings' && s.deck.keys.some(k => k.label === '키 시험'));
    assert.equal(back.keyTest, null);
    // The app has no hold gesture: an app press on the exit key leaves; on any other key it is a test press.
    await click(base, deck => deck.keys.find(k => k.label === '키 시험' && k.action === 'feature_action'));
    await until(() => status(base), s => s.keyTest?.active === true);
    const appPress = async index => {
      const before = await status(base);
      const response = await fetch(`${base}/api/press`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ index, revision: before.deck.revision }), signal: AbortSignal.timeout(10_000) });
      return response.json();
    };
    assert.equal((await appPress(0)).code, 'updated');
    assert.equal((await status(base)).keyTest?.active, true);
    assert.equal((await appPress(profile.keyCount - 1)).code, 'navigated');
    await until(() => status(base), s => s.keyTest === null && s.deck?.mode === 'settings');

    // Command packets are 00 'CRT' 00 00 <command>. Never the boot-logo (LOG) command.
    const commands = (await readText(hidLog)).split('\n').filter(line => line.startsWith('004352540000')).map(line => Buffer.from(line.slice(12, 18), 'hex').toString('latin1'));
    assert.ok(commands.includes('BAT'), 'key images were sent');
    assert.ok(!commands.includes('LOG'), 'boot-logo command sent');
    assert.equal(await readText(networkLog), '');
  });
}
