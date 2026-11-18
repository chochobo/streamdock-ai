import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(fn, condition, ms = 6000) {
  const deadline = Date.now() + ms;
  let value;
  while (Date.now() < deadline) {
    try { value = await fn(); if (condition(value)) return value; } catch { /* startup */ }
    await delay(50);
  }
  throw new Error('Timed out waiting for machine screen');
}

test('fast machine sampling only runs on the machine screen and reuses agent observations', { timeout: 18000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-machine-timer-'));
  const monitor = path.join(home, 'monitor.mjs');
  const agents = path.join(home, 'agents.mjs');
  const device = path.join(home, 'device.mjs');
  const loader = path.join(home, 'loader.mjs');
  const machineLog = path.join(home, 'machine.log');
  const agentLog = path.join(home, 'agent.log');
  const trigger = path.join(home, 'press-on-render');
  await writeFile(monitor, `import {appendFileSync} from 'node:fs';let n=0;export function createMachineMonitor(){return {async read(){const current=++n;appendFileSync(process.env.MACHINE_LOG,current+'\\n');await new Promise(r=>setTimeout(r,350));return {cpuPercent:current}},invalidate(){},async close(){}}}`);
  await writeFile(agents, `import {appendFileSync} from 'node:fs';export async function readAgents(){appendFileSync(process.env.AGENT_LOG,'read\\n');return {agents:[],warnings:[],targets:new Map()}}`);
  await writeFile(device, `import {existsSync,unlinkSync} from 'node:fs';export function keyTileSvg(){return '<svg/>'}export function createDevice({onKeyEvent}){return {async start(){},status(){return {connected:true,mode:'hardware',model:'fake'}},async render(keys){if(keys.some(k=>k.id==='machine-cpu')&&existsSync(process.env.TRIGGER)){unlinkSync(process.env.TRIGGER);onKeyEvent(12,'up',0);await new Promise(r=>setTimeout(r,250))}return true},async renderSummary(){return true},async renderImages(){return true},async stop(){}}}`);
  await writeFile(loader, `const replacements=${JSON.stringify(Object.fromEntries([['./agents.mjs',agents],['./machines.mjs',monitor],['./device.mjs',device]].map(([key,value])=>[key,pathToFileURL(value).href])))};export async function resolve(s,c,n){if(c.parentURL?.endsWith('/src/server.mjs')&&replacements[s])return {url:replacements[s],shortCircuit:true};return n(s,c)}`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOME: home, PORT: String(port), MACHINE_LOG: machineLog, AGENT_LOG: agentLog, TRIGGER: trigger,
    STREAMDOCK_USAGE_DISABLED: '1', STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1' };
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, 'src/server.mjs', '--device'], { cwd: root, env, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {});
      child.kill('SIGTERM');
      await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(home, { recursive: true, force: true });
  });
  const status = async () => (await fetch(`${base}/api/status`)).json();
  const count = async file => (await readFile(file, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))).trim().split('\n').filter(Boolean).length;
  const press = async key => {
    const state = await status();
    const selected = state.deck.keys.find(key);
    assert.ok(selected, 'Expected navigation key');
    const res = await fetch(`${base}/api/press`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ index: selected.index, revision: state.deck.revision }) });
    assert.equal(res.status, 200);
  };
  await until(status, value => value.deck?.view === 'projects');
  await press(key => key.action === 'modes');
  await press(key => key.id === 'machines');
  await until(status, value => value.deck?.keys.some(key => key.id === 'machine-cpu' && key.caption === '1%'));
  const baselineAgents = await count(agentLog);
  await until(() => count(machineLog), n => n >= 3, 3500);
  const observedAgents = (await count(agentLog)) - baselineAgents;
  assert.ok(observedAgents <= 2, `Unexpected repeated agent scans: ${observedAgents}`);
  await until(status, value => value.deck?.keys.some(key => key.id === 'machine-cpu' && Number.parseInt(key.caption, 10) >= 2));
  await writeFile(trigger, 'press during repaint');
  await until(status, value => value.deck?.view === 'hub' && value.lastInput?.index === 12 && value.lastInput?.code === 'navigated', 3000);
  const stoppedReads = await count(machineLog);
  await delay(1500);
  assert.equal(await count(machineLog), stoppedReads, 'Machine reads continued after leaving');
  await press(key => key.id === 'machines');
  await until(() => count(machineLog), n => n > stoppedReads, 700);
});
