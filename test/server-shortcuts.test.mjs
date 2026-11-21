import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
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

test('shortcut keys run user items, hold-only commands need a long press, edited files cannot run stale keys', { timeout: 90000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-shortcuts-srv-'));
  const log = path.join(home, 'actions.log');
  const configDir = path.join(home, '.config', 'streamdock-ai');
  const configFile = path.join(configDir, 'shortcuts.json');
  const writeConfig = async value => { await writeFile(configFile, JSON.stringify(value)); await chmod(configFile, 0o600); };
  await mkdir(configDir, { recursive: true });
  await writeFile(log, '');
  await writeConfig({ version: 1, items: [
    { label: '터미널', type: 'app', app: 'Terminal' },
    { label: '빌드', type: 'command', command: ['/usr/bin/make', 'build'] },
    { label: '계속', type: 'text', text: '계속 진행해 주세요.', submit: true },
  ] });
  const deviceFile = path.join(home, 'device.mjs'), agentsFile = path.join(home, 'agents.mjs'), actionsFile = path.join(home, 'system-actions.mjs'), loader = path.join(home, 'loader.mjs');
  const profiles = pathToFileURL(path.join(root, 'src', 'device-profiles.mjs')).href;
  await writeFile(deviceFile, `import readline from 'node:readline';import {PROFILES} from ${JSON.stringify(profiles)};
export function keyTileSvg(){return '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"/>'};
export function createDevice({onKeyEvent}){let connected=false;const profile=PROFILES.xl;
readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);onKeyEvent(x.index,x.phase,x.heldMs||0)});
return {profile(){return profile},async start(){connected=true},
status(){return {connected,mode:'hardware',model:profile.name,error:null}},
async render(){return connected},async renderSummary(){return connected},async renderImages(){return connected},
async setBrightness(){return true},async stop(){connected=false}}}`);
  await writeFile(agentsFile, `export async function readAgents(){return {agents:[{id:'s-a',projectId:'p-a',project:'alpha',provider:'codex',status:'idle',presence:'live',updatedAt:'2026-11-19T00:00:00.000Z'}],targets:new Map(),warnings:[]}}`);
  // Nothing real may run in this test: the executor only records what it was asked to do.
  await writeFile(actionsFile, `import {appendFileSync} from 'node:fs';
export function createSystemActions(){return {async execute(item){appendFileSync(process.env.SHORTCUT_LOG,JSON.stringify({type:item.type,label:item.label,system:item.system})+'\\n');return {ok:true,code:'ran',message:'실행했습니다.'}},async adjustVolume(){return {ok:true,code:'volume',message:'v'}},async toggleMute(){return {ok:true,code:'mute',message:'m'}}}}`);
  const replacements = Object.fromEntries([['./device.mjs', deviceFile], ['./agents.mjs', agentsFile], ['./system-actions.mjs', actionsFile]].map(([key, value]) => [key, pathToFileURL(value).href]));
  await writeFile(loader, `const replacements=${JSON.stringify(replacements)};export async function resolve(s,c,n){if(c.parentURL?.endsWith('/src/server.mjs')&&replacements[s])return {url:replacements[s],shortCircuit:true};return n(s,c)}`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOME: home, PORT: String(port), SHORTCUT_LOG: log,
    STREAMDOCK_USAGE_DISABLED: '1', STREAMDOCK_PRESENCE_DISABLED: '1', STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1' };
  for (const name of ['STREAMDOCK_SWIFT_HID_PATH', 'STREAMDOCK_MODEL', 'STREAMDOCK_NATIVE_TOKEN']) delete env[name];
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, 'src/server.mjs', '--device'], { cwd: root, env, stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(async () => { await stopChild(child); await rm(home, { recursive: true, force: true }); });
  const ran = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  // A physical key release with the given hold time; resolves with the recorded outcome.
  async function release(label, heldMs = 50) {
    const state = await status(base);
    const key = state.deck.keys.find(k => k.label === label && k.action !== 'none');
    assert.ok(key, `key ${label} is shown`);
    const before = state.lastInput?.at ?? null;
    child.stdin.write(JSON.stringify({ index: key.index, phase: 'up', heldMs }) + '\n');
    const after = await until(() => status(base), s => s.lastInput?.at && s.lastInput.at !== before && s.lastInput.index === key.index);
    return after.lastInput.code;
  }

  await until(() => status(base), s => s.device?.connected && s.deck?.view === 'projects' && s.deck.layout?.model === 'xl');
  child.stdin.write(JSON.stringify({ index: 28, phase: 'up', heldMs: 50 }) + '\n');
  await until(() => status(base), s => s.deck?.view === 'hub');
  assert.equal(await release('바로가기'), 'navigated');
  let state = await until(() => status(base), s => s.deck?.mode === 'shortcuts');
  const labels = state.deck.keys.filter(k => k.kind === 'feature').map(k => k.label);
  assert.deepEqual(labels.slice(0, 3), ['터미널', '빌드', '계속']);
  assert.ok(labels.includes('음소거'), 'built-in keys follow the user keys');

  // A tap opens the app; a text key reaches the executor with its Return flag.
  assert.equal(await release('터미널'), 'ran');
  assert.equal(await release('계속'), 'ran');
  assert.deepEqual((await ran()).map(r => r.label), ['터미널', '계속']);

  // A command key ignores a tap and runs on a long press.
  assert.equal(await release('빌드', 60), 'hold_required');
  assert.equal((await ran()).length, 2);
  assert.equal(await release('빌드', 1000), 'ran');
  assert.deepEqual((await ran()).at(-1), { type: 'command', label: '빌드' });

  // Built-in keys work without any file entry.
  assert.equal(await release('음소거'), 'ran');
  assert.deepEqual((await ran()).at(-1), { type: 'system', label: '음소거', system: 'mute' });

  // The HTTP press API (any local process) never runs commands or pastes text, even with a faked hold time.
  async function apiPress(label, heldMs) {
    const state = await status(base);
    const key = state.deck.keys.find(k => k.label === label && k.action !== 'none');
    const response = await fetch(`${base}/api/press`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ index: key.index, revision: state.deck.revision, heldMs }) });
    return { status: response.status, body: await response.json() };
  }
  const beforeApi = (await ran()).length;
  for (const label of ['빌드', '계속']) {
    const denied = await apiPress(label, 60_000);
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, 'device_required');
  }
  assert.equal((await ran()).length, beforeApi, 'no command or paste through the API');
  assert.equal((await apiPress('터미널', 0)).status, 200, 'opening an app from the app preview still works');
  assert.equal((await ran()).length, beforeApi + 1);

  // The file changes while the old keys are still on screen: stale keys do not run.
  await writeConfig({ version: 1, items: [{ label: '터미널', type: 'app', app: 'Notes' }] });
  const before = (await ran()).length;
  assert.equal(await release('터미널'), 'stale');
  assert.equal((await ran()).length, before, 'a key whose item changed never runs');
});
