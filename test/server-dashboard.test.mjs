import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
async function until(get, predicate, timeout = 20000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    try { value = await get(); if (predicate(value)) return value; } catch { /* Wait for server. */ }
    await delay(40);
  }
  throw new Error(`Timed out: ${JSON.stringify(value)?.slice(0, 1200)}`);
}
const status = async base => (await fetch(`${base}/api/status`)).json();
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').catch(() => {});
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function start(t, model) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-dashboard-'));
  const deviceFile = path.join(home, 'device.mjs'), agentsFile = path.join(home, 'agents.mjs'), machinesFile = path.join(home, 'machines.mjs'), loader = path.join(home, 'loader.mjs');
  const profiles = pathToFileURL(path.join(root, 'src', 'device-profiles.mjs')).href;
  await writeFile(deviceFile, `import readline from 'node:readline';import {PROFILES} from ${JSON.stringify(profiles)};
export function keyTileSvg(){return '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"/>'};
export function createDevice({onKeyEvent}){let connected=false;const profile=PROFILES[process.env.DASH_MODEL];
readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);onKeyEvent(x.index,x.phase,x.heldMs||0)});
return {profile(){return profile},async start(){connected=true},
status(){return {connected,mode:'hardware',model:profile.name,error:null}},
async render(){return connected},async renderSummary(){return connected},async renderImages(){return connected},
async setBrightness(){return true},async stop(){connected=false}}}`);
  const session = (id, state) => ({ id, projectId: `p-${id}`, project: id, provider: 'codex', status: state, presence: 'live', updatedAt: '2026-11-19T00:00:00.000Z' });
  await writeFile(agentsFile, `export async function readAgents(){return {agents:${JSON.stringify([session('a', 'working'), session('b', 'working'), session('c', 'blocked'), session('d', 'idle')])},targets:new Map(),warnings:[]}}`);
  // Every read returns the next CPU value, so the graph history is predictable.
  await writeFile(machinesFile, `let n=0;export function createMachineMonitor(){return {async read(){n++;return {cpuPercent:10+n,memoryUsedPercent:50,metricStatus:{}}},invalidate(){n=0},async close(){}}}`);
  const replacements = Object.fromEntries([['./device.mjs', deviceFile], ['./agents.mjs', agentsFile], ['./machines.mjs', machinesFile]].map(([key, value]) => [key, pathToFileURL(value).href]));
  await writeFile(loader, `const replacements=${JSON.stringify(replacements)};export async function resolve(s,c,n){if(c.parentURL?.endsWith('/src/server.mjs')&&replacements[s])return {url:replacements[s],shortCircuit:true};return n(s,c)}`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOME: home, PORT: String(port), DASH_MODEL: model,
    STREAMDOCK_USAGE_DISABLED: '1', STREAMDOCK_PRESENCE_DISABLED: '1', STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1' };
  for (const name of ['STREAMDOCK_SWIFT_HID_PATH', 'STREAMDOCK_MODEL', 'STREAMDOCK_NATIVE_TOKEN']) delete env[name];
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, 'src/server.mjs', '--device'], { cwd: root, env, stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(async () => { await stopChild(child); await rm(home, { recursive: true, force: true }); });
  const release = (index, heldMs = 50) => child.stdin.write(JSON.stringify({ index, phase: 'up', heldMs }) + '\n');
  return { base, release };
}

test('the XL dashboard shows widgets, collects samples only while open, and starts fresh on re-entry', { timeout: 120000 }, async t => {
  const { base, release } = await start(t, 'xl');
  await until(() => status(base), s => s.device?.connected && s.deck?.layout?.model === 'xl');
  release(28);
  let state = await until(() => status(base), s => s.deck?.view === 'hub');
  const entry = state.deck.keys.find(k => k.label === '대시보드');
  assert.ok(entry && entry.disabled !== true, 'the dashboard is offered on an XL');
  release(entry.index);
  state = await until(() => status(base), s => s.deck?.mode === 'dashboard');
  assert.equal(state.deck.keys[0].wide.type, 'usage');
  assert.equal(state.deck.keys[8].wide.type, 'graph');
  assert.equal(state.deck.keys[16].wide.type, 'stack');
  assert.deepEqual(state.deck.keys[16].wide.counts, { working: 2, blocked: 1, error: 0, done: 0, idle: 1 });

  // About one sample a second while the page is open; every key of the row carries the whole series.
  state = await until(() => status(base), s => s.deck?.keys?.[8]?.wide?.cpu?.length >= 3);
  const cpu = state.deck.keys[8].wide.cpu;
  assert.deepEqual(cpu, cpu.map((_, i) => 11 + i), 'samples are in order');
  assert.deepEqual(state.deck.keys[14].wide.cpu, cpu, 'all seven keys of the row draw the same series');
  assert.deepEqual(state.deck.keys[8].wide.mem.slice(0, 3), [50, 50, 50]);

  // Leaving stops collecting; coming back starts a new history instead of a gap.
  release(29); // back
  await until(() => status(base), s => s.deck?.view === 'hub');
  await delay(2500);
  release((await status(base)).deck.keys.find(k => k.label === '대시보드').index);
  state = await until(() => status(base), s => s.deck?.mode === 'dashboard' && s.deck.keys[8].wide.cpu.length >= 1);
  assert.ok(state.deck.keys[8].wide.cpu.length <= 3, 'a fresh history, not the old one plus a gap');
  assert.equal(state.deck.keys[8].wide.cpu[0], 11, 'the monitor was restarted');
});

test('a 293S never sees the dashboard', { timeout: 90000 }, async t => {
  const { base, release } = await start(t, '293sv3');
  await until(() => status(base), s => s.device?.connected && s.deck?.layout?.model === '293sv3');
  release(11); // the feature key is the fourth from the end on a 293S
  const state = await until(() => status(base), s => s.deck?.view === 'hub');
  assert.ok(!state.deck.keys.some(k => k.label === '대시보드'));
  assert.ok(state.deck.keys.some(k => k.label === '타이머'), 'the rest of the first page is still there');
  assert.equal(state.deck.pages, 2, 'sixteen modes minus the hidden one still fill two pages');
});
