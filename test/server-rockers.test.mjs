import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

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
    await delay(30);
  }
  throw new Error(`Timed out: ${JSON.stringify(value)?.slice(0, 2000)}`);
}
const status = async base => (await fetch(`${base}/api/status`)).json();
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

test('XL rockers page, go back, step brightness, and do nothing in scenes and games', { timeout: 90000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-rockers-'));
  const log = path.join(home, 'device.log'), sceneLog = path.join(home, 'scene.log'), gameLog = path.join(home, 'game.log');
  const deviceFile = path.join(home, 'device.mjs'), agentsFile = path.join(home, 'agents.mjs'), sceneFile = path.join(home, 'scene.mjs'), gameFile = path.join(home, 'game.mjs'), loader = path.join(home, 'loader.mjs');
  await Promise.all([log, sceneLog, gameLog].map(file => writeFile(file, '')));
  const profiles = pathToFileURL(path.join(root, 'src', 'device-profiles.mjs')).href;
  // Stdin lines drive the device callbacks: {index, phase} for keys, {control, action} for rockers.
  await writeFile(deviceFile, `import {appendFileSync} from 'node:fs';import readline from 'node:readline';import {PROFILES} from ${JSON.stringify(profiles)};
const log=value=>appendFileSync(process.env.ROCKER_LOG,JSON.stringify(value)+'\\n');
export function keyTileSvg(){return '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"/>'};
export function createDevice({onKeyEvent,onControl}){let connected=false,requestedBrightness;const profile=PROFILES.xl;
readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);if(x.control)onControl({control:x.control,action:x.action,phase:'down'});else onKeyEvent(x.index,x.phase,x.heldMs||0)});
return {profile(){return profile},async start(){connected=true},
status(){return {connected,mode:'hardware',model:profile.name,error:null,requestedBrightness}},
async render(){return connected},async renderSummary(){return connected},async renderImages(){return connected},
async setBrightness(value){log({op:'brightness',value});requestedBrightness=value;return true},async stop(){connected=false}}}`);
  await writeFile(agentsFile, `export async function readAgents(){return {agents:Array.from({length:30},(_,i)=>({id:'s-'+i,projectId:'p-'+String(i).padStart(2,'0'),project:'project-'+String(i).padStart(2,'0'),provider:'codex',status:'idle',presence:'live',updatedAt:'2026-11-19T00:00:00.000Z'})),targets:new Map(),warnings:[]}}`);
  await writeFile(sceneFile, `import {appendFileSync} from 'node:fs';
const f=()=>({tiles:Array.from({length:15},(_,index)=>({index,png:Buffer.from('tile-'+index)})),sideTiles:[16,17,18].map(slot=>({slot,png:Buffer.from('side-'+slot)}))});
export function createSceneBridge(){return {async start(){return f()},async tick(){return f()},async press(index){appendFileSync(process.env.ROCKER_SCENE_LOG,'press:'+index+'\\n');return f()},async stop(){appendFileSync(process.env.ROCKER_SCENE_LOG,'stop\\n')},async close(){}}}`);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#345678' } }).png().toBuffer();
  await writeFile(gameFile, `import {appendFileSync} from 'node:fs';
const png=Buffer.from(${JSON.stringify(png.toString('base64'))},'base64');
const log=line=>appendFileSync(process.env.ROCKER_GAME_LOG,line+'\\n');
const frame=()=>({mode:'mole',score:0,coins:20,sounds:[],hud:{phaseLabel:'게임',primary:'0',secondary:''},tiles:Array.from({length:10},(_,index)=>({index,png})),wide:png});
export function createGameBridge(){return {async start(mode){log('start:'+mode);return frame()},async tick(){return frame()},async press(index){log('press:'+index);return frame()},async menu(){log('menu');return frame()},async close(){}}}`);
  const replacements = Object.fromEntries([['./device.mjs', deviceFile], ['./agents.mjs', agentsFile], ['./scene-bridge.mjs', sceneFile], ['./game-bridge.mjs', gameFile]].map(([key, value]) => [key, pathToFileURL(value).href]));
  await writeFile(loader, `const replacements=${JSON.stringify(replacements)};export async function resolve(s,c,n){if(c.parentURL?.endsWith('/src/server.mjs')&&replacements[s])return {url:replacements[s],shortCircuit:true};return n(s,c)}`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOME: home, PORT: String(port), ROCKER_LOG: log, ROCKER_SCENE_LOG: sceneLog, ROCKER_GAME_LOG: gameLog,
    STREAMDOCK_USAGE_DISABLED: '1', STREAMDOCK_PRESENCE_DISABLED: '1', STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1' };
  for (const name of ['STREAMDOCK_SWIFT_HID_PATH', 'STREAMDOCK_MODEL', 'STREAMDOCK_NATIVE_TOKEN']) delete env[name];
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, 'src/server.mjs', '--device'], { cwd: root, env, stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(async () => { await stopChild(child); await rm(home, { recursive: true, force: true }); });
  const brightnessCalls = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(r => r.op === 'brightness').map(r => r.value);
  const key = (index, phase, heldMs) => child.stdin.write(JSON.stringify({ index, phase, heldMs }) + '\n');
  // Sends one rocker press and waits for its recorded outcome.
  async function rocker(control, action) {
    const before = (await status(base)).lastInput?.at;
    child.stdin.write(JSON.stringify({ control, action }) + '\n');
    const state = await until(() => status(base), s => s.lastInput?.at && s.lastInput.at !== before && s.lastInput.control === control);
    assert.equal(state.lastInput.action, action);
    return state.lastInput.code;
  }

  let state = await until(() => status(base), s => s.device?.connected && s.deck?.view === 'projects' && s.deck.layout?.model === 'xl');
  assert.equal(state.deck.page, 1);

  // Left rocker down/up = next/prev page; prev on the first page does nothing.
  assert.equal(await rocker('left', 'down'), 'navigated');
  state = await until(() => status(base), s => s.deck?.page === 2);
  assert.equal(await rocker('left', 'down'), 'empty', 'next is disabled on the last page');
  assert.equal(await rocker('left', 'up'), 'navigated');
  state = await until(() => status(base), s => s.deck?.page === 1);
  assert.equal(await rocker('left', 'up'), 'empty');
  // Left push on the home page does nothing (its back position is the usage key).
  assert.equal(await rocker('left', 'push'), 'empty');
  state = await status(base);
  assert.equal(state.deck.view, 'projects');

  // Left push = back from a project's sessions.
  await press(base, keys => keys.find(k => k.kind === 'project'));
  state = await until(() => status(base), s => s.deck?.view === 'sessions');
  assert.equal(await rocker('left', 'push'), 'navigated');
  await until(() => status(base), s => s.deck?.view === 'projects');

  // Right rocker steps brightness by 10 within 10..100 and persists it.
  // Unknown brightness steps from the middle (50) so neither direction jumps to an extreme.
  assert.equal((await status(base)).settings.brightness, null);
  assert.equal(await rocker('right', 'up'), 'updated');
  assert.equal((await status(base)).settings.brightness, 60, 'unknown brightness steps from 50');
  for (let step = 0; step < 4; step++) assert.equal(await rocker('right', 'up'), 'updated');
  assert.equal(await rocker('right', 'up'), 'unchanged');
  assert.equal(await rocker('right', 'down'), 'updated');
  assert.equal((await status(base)).settings.brightness, 90);
  for (let step = 0; step < 8; step++) assert.equal(await rocker('right', 'down'), 'updated');
  assert.equal(await rocker('right', 'down'), 'unchanged', 'the rocker never turns the screen off');
  assert.deepEqual(await brightnessCalls(), [60, 70, 80, 90, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10]);
  const saved = JSON.parse(await readFile(path.join(home, '.config', 'streamdock-ai', 'settings.json'), 'utf8'));
  assert.equal(saved.brightness, 10);
  assert.equal((await status(base)).settings.brightness, 10);
  // Right push is reserved.
  assert.equal(await rocker('right', 'push'), 'empty');

  // Scenes ignore every rocker input.
  key(28, 'down'); key(28, 'up', 50);
  await until(() => status(base), s => s.deck?.view === 'hub');
  await press(base, keys => keys.find(k => k.label === '장면' && k.action === 'open_mode'));
  await press(base, keys => keys.find(k => k.label === '수족관' && k.action === 'feature_action'));
  await until(() => status(base), s => s.deck?.mode === 'scenes' && s.deck.frames?.length);
  for (const [control, action] of [['left', 'up'], ['left', 'down'], ['left', 'push'], ['right', 'up'], ['right', 'down'], ['right', 'push']]) {
    assert.equal(await rocker(control, action), 'ignored');
  }
  state = await status(base);
  assert.equal(state.deck.mode, 'scenes');
  assert.equal(await readFile(sceneLog, 'utf8'), '', 'no scene press or stop');
  assert.equal((await brightnessCalls()).length, 14);
  key(20, 'down'); key(20, 'up', 1500);
  await until(() => status(base), s => s.deck?.view === 'hub');

  // Games ignore every rocker input too.
  await press(base, keys => keys.find(k => k.label === '게임' && k.action === 'open_mode'));
  await press(base, keys => keys.find(k => k.label === '두더지' && k.action === 'feature_action'));
  await until(() => status(base), s => s.deck?.mode === 'games' && s.deck.frames?.length);
  for (const [control, action] of [['left', 'up'], ['left', 'down'], ['left', 'push'], ['right', 'up'], ['right', 'down']]) {
    assert.equal(await rocker(control, action), 'ignored');
  }
  state = await status(base);
  assert.equal(state.deck.mode, 'games');
  assert.equal(await readFile(gameLog, 'utf8'), 'start:mole\n', 'no game press or menu');
  assert.equal((await brightnessCalls()).length, 14);
});
