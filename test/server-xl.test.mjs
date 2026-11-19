import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(get, predicate, timeout = 12000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    try { value = await get(); if (predicate(value)) return value; } catch { /* Wait for server. */ }
    await delay(50);
  }
  throw new Error(`Timed out: ${JSON.stringify(value)?.slice(0, 2000)}`);
}
const status = async (base, headers = {}) => (await fetch(`${base}/api/status`, { headers })).json();
async function press(base, findKey) {
  const before = await status(base);
  const key = findKey(before.deck.keys);
  assert.ok(key, 'expected key exists');
  const response = await fetch(`${base}/api/press`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ index: key.index, revision: before.deck.revision }) });
  assert.equal(response.status, 200, await response.text());
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').catch(() => {});
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
const baseEnv = home => {
  const env = { ...process.env, HOME: home, STREAMDOCK_USAGE_DISABLED: '1', STREAMDOCK_PRESENCE_DISABLED: '1', STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1' };
  delete env.STREAMDOCK_SWIFT_HID_PATH;
  delete env.STREAMDOCK_MODEL;
  delete env.STREAMDOCK_NATIVE_TOKEN;
  return env;
};

test('XL device gets a 32-key layout, legacy scene frames, and a re-plan after a model switch', { timeout: 60000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-xl-'));
  const flag = path.join(home, 'connected'), modelFile = path.join(home, 'model'), log = path.join(home, 'device.log'), sceneLog = path.join(home, 'scene.log');
  const deviceFile = path.join(home, 'device.mjs'), agentsFile = path.join(home, 'agents.mjs'), sceneFile = path.join(home, 'scene.mjs'), loader = path.join(home, 'loader.mjs');
  await writeFile(flag, 'up');
  await writeFile(modelFile, '293sv3');
  await writeFile(log, '');
  await writeFile(sceneLog, '');
  const profiles = pathToFileURL(path.join(root, 'src', 'device-profiles.mjs')).href;
  // The fake reports the model named in a file at each start(), like the real
  // driver detecting whichever supported device is plugged in.
  await writeFile(deviceFile, `import {appendFileSync,readFileSync} from 'node:fs';import readline from 'node:readline';import {PROFILES} from ${JSON.stringify(profiles)};
const log=value=>appendFileSync(process.env.XL_LOG,JSON.stringify(value)+'\\n');
const tag=image=>image[0]===0x89?'blank':image.toString();
export function keyTileSvg(){return '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"/>'};
export function createDevice({profile:initial,onKeyEvent}){let connected=false,profile=initial;const available=()=>readFileSync(process.env.XL_FLAG,'utf8')==='up';
log({op:'create',model:initial.id});
readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);onKeyEvent(x.index,x.phase,x.heldMs||0)});
return {profile(){return profile},async start(){connected=available();if(connected)profile=PROFILES[readFileSync(process.env.XL_MODEL,'utf8')];log({op:'start',connected,model:profile.id});},
status(){if(!available())connected=false;return {connected,mode:'hardware',model:profile.name,error:connected?null:'disconnected'};},
async render(keys){if(!this.status().connected)return false;log({op:'render',count:keys.length,model:profile.id});return true;},
async renderSummary(){if(!this.status().connected)return false;log({op:'summary',model:profile.id});return true;},
async renderImages({keys=[],sides=[]}){if(!this.status().connected)return false;if(sides.length&&!profile.sideSlots.length)throw Error('sides on XL');log({op:'images',model:profile.id,keys:keys.map(k=>[k.index,tag(k.image)]),slots:sides.map(x=>x.slot)});return true;},
async setBrightness(){return true;},async stop(){connected=false;}}}`);
  await writeFile(agentsFile, `export async function readAgents(){return {agents:Array.from({length:30},(_,i)=>({id:'s-'+i,projectId:'p-'+String(i).padStart(2,'0'),project:'project-'+String(i).padStart(2,'0'),provider:'codex',status:'idle',presence:'live',updatedAt:'2026-11-19T00:00:00.000Z'})),targets:new Map(),warnings:[]}}`);
  await writeFile(sceneFile, `import {appendFileSync} from 'node:fs';
const f=()=>({tiles:Array.from({length:15},(_,index)=>({index,png:Buffer.from('tile-'+index)})),sideTiles:[16,17,18].map(slot=>({slot,png:Buffer.from('side-'+slot)}))});
export function createSceneBridge(){return {async start(){return f()},async tick(){return f()},async press(index){appendFileSync(process.env.XL_SCENE_LOG,'press:'+index+'\\n');return f()},async stop(){appendFileSync(process.env.XL_SCENE_LOG,'stop\\n')},async close(){}}}`);
  const replacements = Object.fromEntries([['./device.mjs', deviceFile], ['./agents.mjs', agentsFile], ['./scene-bridge.mjs', sceneFile]].map(([key, value]) => [key, pathToFileURL(value).href]));
  await writeFile(loader, `const replacements=${JSON.stringify(replacements)};export async function resolve(s,c,n){if(c.parentURL?.endsWith('/src/server.mjs')&&replacements[s])return {url:replacements[s],shortCircuit:true};return n(s,c)}`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...baseEnv(home), PORT: String(port), XL_LOG: log, XL_FLAG: flag, XL_MODEL: modelFile, XL_SCENE_LOG: sceneLog };
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, 'src/server.mjs', '--device'], { cwd: root, env, stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(async () => { await stopChild(child); await rm(home, { recursive: true, force: true }); });
  const records = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const key = (index, phase, heldMs) => child.stdin.write(JSON.stringify({ index, phase, heldMs }) + '\n');

  // 293S first: unchanged 15-key layout.
  let state = await until(() => status(base), s => s.device?.connected && s.deck?.view === 'projects');
  assert.equal((await records())[0].model, '293sv3', 'the default profile is passed to the device factory');
  assert.equal(state.deck.layout.model, '293sv3');
  assert.equal(state.deck.keys.length, 15);
  assert.deepEqual(state.deck.layout.sideSlots, [16, 17, 18]);

  // Reconnect as an XL: the server adopts device.profile() and re-plans.
  await writeFile(flag, 'down');
  await until(() => status(base), s => !s.device?.connected);
  await writeFile(modelFile, 'xl');
  await writeFile(flag, 'up');
  state = await until(() => status(base), s => s.device?.connected && s.deck?.layout?.model === 'xl');
  await until(records, rows => rows.some(r => r.op === 'render' && r.model === 'xl' && r.count === 32));
  assert.deepEqual(state.deck.layout, { model: 'xl', name: 'Stream Dock XL', cols: 8, rows: 4, keyCount: 32, sideSlots: [], summaryKeys: [7, 15, 23], controls: { modes: 28, usage: 29, back: 29, prev: 30, next: 31 } });
  assert.equal(state.deck.keys.length, 32);
  assert.ok([7, 15, 23].every(index => state.deck.keys[index].kind === 'empty'));
  assert.equal(state.deck.keys.filter(k => k.kind === 'project').length, 25);
  assert.equal(state.deck.keys[31].action, 'next');

  // Key 31 is next; summary keys and out-of-range indexes do nothing.
  await press(base, keys => keys[31]);
  state = await until(() => status(base), s => s.deck?.page === 2);
  assert.equal(state.deck.keys.filter(k => k.kind === 'project').length, 5);
  const summaryPress = await fetch(`${base}/api/press`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 7, revision: state.deck.revision }) });
  assert.equal(summaryPress.status, 409);
  const outside = await fetch(`${base}/api/press`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 32, revision: state.deck.revision }) });
  assert.equal((await outside.json()).code, 'invalid');

  // Physical key 28 opens the feature hub on an XL.
  key(28, 'down'); key(28, 'up', 50);
  await until(() => status(base), s => s.deck?.view === 'hub' && s.deck.keys.length === 32);
  await press(base, keys => keys.find(k => k.label === '장면' && k.action === 'open_mode'));
  const before = (await records()).length;
  await press(base, keys => keys.find(k => k.label === '수족관' && k.action === 'feature_action'));
  state = await until(() => status(base), s => s.deck?.mode === 'scenes' && s.deck.frames?.length === 21);
  const images = (await until(records, rows => rows.slice(before).some(r => r.op === 'images'))).slice(before).find(r => r.op === 'images');
  const drawn = Object.fromEntries(images.keys);
  assert.deepEqual(images.slots, []);
  assert.equal(drawn[20], 'tile-14');
  assert.equal(drawn[0], 'tile-0');
  assert.equal(drawn[8], 'tile-5');
  assert.deepEqual([drawn[5], drawn[13], drawn[21]], ['side-16', 'side-17', 'side-18']);
  assert.deepEqual([drawn[7], drawn[15], drawn[23]], ['blank', 'blank', 'blank']);
  const frames = Object.fromEntries(state.deck.frames.map(frame => [frame.index, Buffer.from(frame.url.split(',')[1], 'base64').toString()]));
  assert.equal(frames[20], 'tile-14');
  assert.equal(frames[13], 'side-17');
  assert.equal(state.deck.keys.find(k => k.id === 'scene-key-11').index, 17, 'scene keys sit on the legacy area');

  // Physical presses map back through the legacy area.
  key(8, 'down'); key(8, 'up', 30);
  await until(() => readFile(sceneLog, 'utf8'), text => text.includes('press:5\n'));
  key(6, 'down'); key(6, 'up', 30);
  key(23, 'down'); key(23, 'up', 30);
  await delay(300);
  assert.equal((await readFile(sceneLog, 'utf8')).match(/press:/g).length, 1, 'keys outside the legacy area are ignored');
  const beforeExit = (await records()).length;
  key(20, 'down'); key(20, 'up', 1500);
  await until(() => readFile(sceneLog, 'utf8'), text => text.includes('stop\n'));
  await until(() => status(base), s => s.deck?.view === 'hub');
  // The summary keys are repainted once the scene is gone.
  await until(records, rows => rows.slice(beforeExit).some(r => r.op === 'summary'));
});

test('native preview on an XL shows summary key frames and no side frames', { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-xl-native-'));
  const token = 'b'.repeat(64), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...baseEnv(home), PORT: String(port), STREAMDOCK_NATIVE_TOKEN: token, STREAMDOCK_MODEL: 'xl' };
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env, stdio: 'ignore' });
  t.after(async () => { await stopChild(child); await rm(home, { recursive: true, force: true }); });
  const headers = { 'X-StreamDock-Native-Token': token };
  const state = await until(() => status(base, headers), s => s.deck?.keyFrames?.length === 32);
  assert.equal(state.deck.layout.model, 'xl');
  assert.deepEqual(state.deck.sideFrames, []);
  assert.deepEqual(state.deck.keyFrames.map(frame => frame.index), Array.from({ length: 32 }, (_, i) => i));
  const empty = state.deck.keyFrames[6].url;
  const summary = [7, 15, 23].map(index => state.deck.keyFrames[index].url);
  assert.ok(summary.every(url => url.startsWith('data:image/png;base64,') && url !== empty));
  assert.equal(new Set(summary).size, 3);
  const publicState = await status(base);
  assert.equal(publicState.deck.layout.model, 'xl');
  assert.equal(publicState.deck.keyFrames, undefined);
});
