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
async function until(get, predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    try { value = await get(); if (predicate(value)) return value; } catch { /* Wait for server. */ }
    await delay(40);
  }
  throw new Error(`Timed out: ${JSON.stringify(value)?.slice(0, 1500)}`);
}
const status = async base => (await fetch(`${base}/api/status`)).json();
const session = (id, state) => ({ id, projectId: `p-${id}`, project: id, provider: 'codex', status: state, presence: 'live', updatedAt: '2026-11-19T00:00:00.000Z' });

async function start(t, led) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-led-'));
  const log = path.join(home, 'leds.log'), agentsJson = path.join(home, 'agents.json');
  const configDir = path.join(home, '.config', 'streamdock-ai');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ version: 1, language: 'ko', sound: { enabled: false }, brightness: null,
    screensaver: { enabled: false, idleMinutes: 15, scene: 'aquarium' }, ...(led ? { led } : {}) }), { mode: 0o600 });
  await writeFile(log, '');
  const setAgents = list => writeFile(agentsJson, JSON.stringify(list));
  await setAgents([session('a', 'idle')]);
  const deviceFile = path.join(home, 'device.mjs'), agentsFile = path.join(home, 'agents.mjs'), loader = path.join(home, 'loader.mjs');
  const profiles = pathToFileURL(path.join(root, 'src', 'device-profiles.mjs')).href;
  await writeFile(deviceFile, `import {appendFileSync} from 'node:fs';import {PROFILES} from ${JSON.stringify(profiles)};
const log=value=>appendFileSync(process.env.LED_LOG,JSON.stringify(value)+'\\n');
export function keyTileSvg(){return '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"/>'};
export function createDevice(){let connected=false;const profile=PROFILES.xl;
return {profile(){return profile},async start(){connected=true},
status(){return {connected,mode:'hardware',model:profile.name,error:null}},
async render(){return connected},async renderSummary(){return connected},async renderImages(){return connected},
async setBrightness(){return true},async setLeds(v){log({op:'set',rgb:v.rgb,brightness:v.brightness});return true},async resetLeds(){log({op:'reset'});return true},async stop(){connected=false}}}`);
  await writeFile(agentsFile, `import {readFileSync} from 'node:fs';
export async function readAgents(){return {agents:JSON.parse(readFileSync(process.env.LED_AGENTS,'utf8')),targets:new Map(),warnings:[]}}`);
  const replacements = Object.fromEntries([['./device.mjs', deviceFile], ['./agents.mjs', agentsFile]].map(([key, value]) => [key, pathToFileURL(value).href]));
  await writeFile(loader, `const replacements=${JSON.stringify(replacements)};export async function resolve(s,c,n){if(c.parentURL?.endsWith('/src/server.mjs')&&replacements[s])return {url:replacements[s],shortCircuit:true};return n(s,c)}`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOME: home, PORT: String(port), LED_LOG: log, LED_AGENTS: agentsJson,
    STREAMDOCK_USAGE_DISABLED: '1', STREAMDOCK_PRESENCE_DISABLED: '1', STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1' };
  for (const name of ['STREAMDOCK_SWIFT_HID_PATH', 'STREAMDOCK_MODEL', 'STREAMDOCK_NATIVE_TOKEN']) delete env[name];
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, 'src/server.mjs', '--device'], { cwd: root, env, stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}); }
    await rm(home, { recursive: true, force: true });
  });
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  await until(() => status(base), s => s.device?.connected && s.deck?.layout?.model === 'xl');
  return { base, child, calls, setAgents };
}

test('with the LEDs on they follow the agents, resend only on change, and restore the device effect at exit', { timeout: 120000 }, async t => {
  const { base, child, calls, setAgents } = await start(t, { enabled: true, brightness: 40 });
  // Nothing is working: the LEDs are explicitly turned off.
  await until(calls, rows => rows.length >= 1);
  assert.deepEqual((await calls())[0], { op: 'set', rgb: null, brightness: 0 });

  await setAgents([session('a', 'idle'), session('b', 'blocked')]);
  await until(calls, rows => rows.some(r => r.op === 'set' && r.rgb?.join() === '255,170,0'));
  assert.equal((await calls()).at(-1).brightness, 40);

  // Several refreshes later the same state has not been sent again.
  const count = (await calls()).length;
  await delay(4500);
  assert.equal((await calls()).length, count, 'an unchanged state is not resent');

  await setAgents([session('a', 'error')]);
  await until(calls, rows => rows.some(r => r.op === 'set' && r.rgb?.join() === '255,30,30'));
  await setAgents([session('a', 'working')]);
  await until(calls, rows => rows.some(r => r.op === 'set' && r.rgb?.join() === '0,210,110'));

  // The device status API is unchanged by LEDs.
  assert.equal((await status(base)).settings.led.enabled, true);

  child.kill('SIGTERM');
  await once(child, 'exit');
  assert.deepEqual((await calls()).at(-1), { op: 'reset' }, 'the device effect comes back at exit');
});

test('by default the LEDs are never touched', { timeout: 90000 }, async t => {
  const { calls, setAgents } = await start(t, undefined);
  await setAgents([session('a', 'blocked')]);
  await delay(5000);
  assert.deepEqual(await calls(), []);
});
