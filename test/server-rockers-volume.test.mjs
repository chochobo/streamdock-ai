import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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
    await delay(30);
  }
  throw new Error(`Timed out: ${JSON.stringify(value)?.slice(0, 1500)}`);
}
const status = async base => (await fetch(`${base}/api/status`)).json();
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').catch(() => {});
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function start(t, rockers) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-rocker-volume-'));
  const log = path.join(home, 'calls.log'), failFlag = path.join(home, 'fail');
  const configDir = path.join(home, '.config', 'streamdock-ai');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ version: 1, language: 'ko', sound: { enabled: false }, brightness: null,
    screensaver: { enabled: false, idleMinutes: 15, scene: 'aquarium' }, ...(rockers ? { rockers } : {}) }), { mode: 0o600 });
  await writeFile(log, '');
  const deviceFile = path.join(home, 'device.mjs'), agentsFile = path.join(home, 'agents.mjs'), actionsFile = path.join(home, 'system-actions.mjs'), loader = path.join(home, 'loader.mjs');
  const profiles = pathToFileURL(path.join(root, 'src', 'device-profiles.mjs')).href;
  await writeFile(deviceFile, `import {appendFileSync} from 'node:fs';import readline from 'node:readline';import {PROFILES} from ${JSON.stringify(profiles)};
export function keyTileSvg(){return '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"/>'};
export function createDevice({onKeyEvent,onControl}){let connected=false,requestedBrightness;const profile=PROFILES.xl;
readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);onControl({control:x.control,action:x.action,phase:'down'})});
return {profile(){return profile},async start(){connected=true},
status(){return {connected,mode:'hardware',model:profile.name,error:null,requestedBrightness}},
async render(){return connected},async renderSummary(){return connected},async renderImages(){return connected},
async setBrightness(value){appendFileSync(process.env.ROCKER_LOG,JSON.stringify({op:'brightness',value})+'\\n');requestedBrightness=value;return true},async stop(){connected=false}}}`);
  await writeFile(agentsFile, `export async function readAgents(){return {agents:[{id:'s-a',projectId:'p-a',project:'alpha',provider:'codex',status:'idle',presence:'live',updatedAt:'2026-11-19T00:00:00.000Z'}],targets:new Map(),warnings:[]}}`);
  await writeFile(actionsFile, `import {appendFileSync,existsSync} from 'node:fs';
const log=value=>appendFileSync(process.env.ROCKER_LOG,JSON.stringify(value)+'\\n');
const fail=()=>existsSync(process.env.ROCKER_FAIL);
export function createSystemActions(){return {async execute(){return {ok:true,code:'ran',message:'x'}},
async adjustVolume(delta){log({op:'volume',delta});return fail()?{ok:false,code:'volume_unavailable',message:'이 출력 장치는 볼륨을 조절할 수 없습니다.'}:{ok:true,code:'volume',message:'볼륨 '+(50+delta)+'%',volume:50+delta}},
async toggleMute(){log({op:'mute'});return {ok:true,code:'mute',message:'음소거를 전환했습니다.'}}}}`);
  const replacements = Object.fromEntries([['./device.mjs', deviceFile], ['./agents.mjs', agentsFile], ['./system-actions.mjs', actionsFile]].map(([key, value]) => [key, pathToFileURL(value).href]));
  await writeFile(loader, `const replacements=${JSON.stringify(replacements)};export async function resolve(s,c,n){if(c.parentURL?.endsWith('/src/server.mjs')&&replacements[s])return {url:replacements[s],shortCircuit:true};return n(s,c)}`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOME: home, PORT: String(port), ROCKER_LOG: log, ROCKER_FAIL: failFlag,
    STREAMDOCK_USAGE_DISABLED: '1', STREAMDOCK_PRESENCE_DISABLED: '1', STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1' };
  for (const name of ['STREAMDOCK_SWIFT_HID_PATH', 'STREAMDOCK_MODEL', 'STREAMDOCK_NATIVE_TOKEN']) delete env[name];
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, 'src/server.mjs', '--device'], { cwd: root, env, stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(async () => { await stopChild(child); await rm(home, { recursive: true, force: true }); });
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  async function rocker(control, action) {
    const before = (await status(base)).lastInput?.at ?? null;
    child.stdin.write(JSON.stringify({ control, action }) + '\n');
    const state = await until(() => status(base), s => s.lastInput?.at && s.lastInput.at !== before && s.lastInput.control === control);
    return state.lastInput.code;
  }
  await until(() => status(base), s => s.device?.connected && s.deck?.layout?.model === 'xl');
  return { base, calls, rocker, failFlag };
}

test('with rockers.right = volume the right rocker steps the volume and push toggles mute', { timeout: 90000 }, async t => {
  const { base, calls, rocker, failFlag } = await start(t, { right: 'volume' });
  assert.equal((await status(base)).settings.rockers.right, 'volume');
  assert.equal(await rocker('right', 'up'), 'updated');
  assert.equal(await rocker('right', 'up'), 'updated');
  assert.equal(await rocker('right', 'down'), 'updated');
  assert.equal(await rocker('right', 'push'), 'updated');
  assert.deepEqual(await calls(), [{ op: 'volume', delta: 6 }, { op: 'volume', delta: 6 }, { op: 'volume', delta: -6 }, { op: 'mute' }]);
  // The brightness steps are not used and nothing is saved.
  assert.equal((await status(base)).settings.brightness, null);
  assert.ok(!(await calls()).some(call => call.op === 'brightness'));

  // A device without a software volume reports the failure instead of pretending.
  await writeFile(failFlag, '');
  assert.equal(await rocker('right', 'up'), 'volume_unavailable');
  const state = await status(base);
  assert.equal(state.lastInput.code, 'volume_unavailable');

  // The left rocker still pages and goes back.
  await rm(failFlag);
  assert.equal(await rocker('left', 'down'), 'empty', 'a single home page has nothing to page to');
});

test('by default the right rocker keeps stepping brightness and never touches the volume', { timeout: 90000 }, async t => {
  const { base, calls, rocker } = await start(t, undefined);
  assert.equal((await status(base)).settings.rockers.right, 'brightness');
  assert.equal(await rocker('right', 'up'), 'updated');
  assert.equal(await rocker('right', 'push'), 'empty');
  const recorded = await calls();
  assert.deepEqual(recorded, [{ op: 'brightness', value: 60 }]);
});
