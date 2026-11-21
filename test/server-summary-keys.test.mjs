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
    await delay(30);
  }
  throw new Error(`Timed out: ${JSON.stringify(value)?.slice(0, 2000)}`);
}
const status = async base => (await fetch(`${base}/api/status`)).json();
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').catch(() => {});
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

const session = (id, project, status, updatedAt) => ({ id, projectId: `p-${project}`, project, provider: 'codex', status, presence: 'live', updatedAt });

test('XL summary keys: overview opens agents, attention key cycles waiting sessions, time key opens usage', { timeout: 90000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-summary-keys-'));
  const log = path.join(home, 'focus.log'), agentsJson = path.join(home, 'agents.json');
  const deviceFile = path.join(home, 'device.mjs'), agentsFile = path.join(home, 'agents.mjs'), focusFile = path.join(home, 'focus.mjs'), loader = path.join(home, 'loader.mjs');
  await writeFile(log, '');
  const setAgents = list => writeFile(agentsJson, JSON.stringify(list));
  await setAgents([
    session('s-a', 'alpha', 'idle', '2026-11-19T00:00:00.000Z'),
    session('s-b', 'bravo', 'blocked', '2026-11-19T00:00:03.000Z'),
    session('s-c', 'charlie', 'blocked', '2026-11-19T00:00:02.000Z'),
    session('s-d', 'delta', 'working', '2026-11-19T00:00:01.000Z'),
  ]);
  const profiles = pathToFileURL(path.join(root, 'src', 'device-profiles.mjs')).href;
  // Stdin lines drive the device callbacks: {index, phase, heldMs} for keys.
  await writeFile(deviceFile, `import readline from 'node:readline';import {PROFILES} from ${JSON.stringify(profiles)};
export function keyTileSvg(){return '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"/>'};
export function createDevice({onKeyEvent}){let connected=false;const profile=PROFILES.xl;
readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);onKeyEvent(x.index,x.phase,x.heldMs||0)});
return {profile(){return profile},async start(){connected=true},
status(){return {connected,mode:'hardware',model:profile.name,error:null}},
async render(){return connected},async renderSummary(){return connected},async renderImages(){return connected},
async setBrightness(){return true},async stop(){connected=false}}}`);
  // Each read reloads the file so the test can change statuses between presses.
  await writeFile(agentsFile, `import {readFileSync} from 'node:fs';
export async function readAgents(){const agents=JSON.parse(readFileSync(process.env.SUMMARY_AGENTS,'utf8'));
return {agents,targets:new Map(agents.map(a=>[a.id,{provider:'codex',sessionId:a.id,id:a.id}])),warnings:[]}}`);
  await writeFile(focusFile, `import {appendFileSync} from 'node:fs';
export async function focusSession(target){appendFileSync(process.env.SUMMARY_FOCUS_LOG,(target&&target.id)+'\\n');return {ok:true,code:'dispatched',message:'열기 요청'}}`);
  const replacements = Object.fromEntries([['./device.mjs', deviceFile], ['./agents.mjs', agentsFile], ['./focus.mjs', focusFile]].map(([key, value]) => [key, pathToFileURL(value).href]));
  await writeFile(loader, `const replacements=${JSON.stringify(replacements)};export async function resolve(s,c,n){if(c.parentURL?.endsWith('/src/server.mjs')&&replacements[s])return {url:replacements[s],shortCircuit:true};return n(s,c)}`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOME: home, PORT: String(port), SUMMARY_AGENTS: agentsJson, SUMMARY_FOCUS_LOG: log,
    STREAMDOCK_USAGE_DISABLED: '1', STREAMDOCK_PRESENCE_DISABLED: '1', STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1' };
  for (const name of ['STREAMDOCK_SWIFT_HID_PATH', 'STREAMDOCK_MODEL', 'STREAMDOCK_NATIVE_TOKEN']) delete env[name];
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, 'src/server.mjs', '--device'], { cwd: root, env, stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(async () => { await stopChild(child); await rm(home, { recursive: true, force: true }); });
  const focused = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean);
  // Presses a physical key and waits for its recorded outcome.
  async function press(index) {
    const before = (await status(base)).lastInput?.at ?? null;
    child.stdin.write(JSON.stringify({ index, phase: 'up', heldMs: 50 }) + '\n');
    const state = await until(() => status(base), s => s.lastInput?.at && s.lastInput.at !== before && s.lastInput.index === index);
    return state.lastInput.code;
  }

  const state = await until(() => status(base), s => s.device?.connected && s.deck?.view === 'projects' && s.deck.layout?.model === 'xl');
  assert.deepEqual(state.deck.layout.summaryKeys, [7, 15, 23]);

  // Key 15 opens the first waiting session, then the next on each press, and wraps around.
  assert.equal(await press(15), 'dispatched');
  assert.equal(await press(15), 'dispatched');
  assert.equal(await press(15), 'dispatched');
  assert.deepEqual(await focused(), ['s-b', 's-c', 's-b']);

  // With nothing waiting but an error, key 15 opens the failed session.
  await setAgents([session('s-a', 'alpha', 'idle', '2026-11-19T00:00:00.000Z'), session('s-e', 'echo', 'error', '2026-11-19T00:00:04.000Z')]);
  await until(() => status(base), s => s.agents?.some(a => a.id === 's-e'));
  assert.equal(await press(15), 'dispatched');
  assert.deepEqual((await focused()).slice(3), ['s-e']);

  // With neither, key 15 opens the agent list and opens no session.
  await setAgents([session('s-a', 'alpha', 'idle', '2026-11-19T00:00:00.000Z')]);
  await until(() => status(base), s => s.agents?.length === 1);
  assert.equal(await press(15), 'navigated');
  assert.equal((await focused()).length, 4);

  // Key 23 opens usage; key 7 returns to the agent list.
  assert.equal(await press(23), 'navigated');
  await until(() => status(base), s => s.deck?.view === 'usage');
  assert.equal(await press(7), 'navigated');
  await until(() => status(base), s => s.deck?.view === 'projects' && s.deck.scope === 'live');

  // Key 7 also leaves a feature page.
  await press(28 /* modes key on the home screen */);
  await until(() => status(base), s => s.deck?.view === 'hub');
  assert.equal(await press(7), 'navigated');
  await until(() => status(base), s => s.deck?.view === 'projects');
});
