import { test } from 'node:test';
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(get, match, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await get(); if (match(value)) return value; } catch { /* Server may be starting. */ }
    await delay(25);
  }
  throw new Error('Timed out waiting for test state');
}

test('status refresh waits for an in-flight alert repaint', { timeout: 15000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-alert-race-'));
  const agentFile = path.join(home, 'agent.json');
  const logFile = path.join(home, 'render.log');
  const releaseFile = path.join(home, 'release-blink');
  const agent = status => ({ id: 'a', project: 'Demo', projectId: 'p', status, presence: 'live', confidence: 'observed', source: 'streamdock-hook', updatedAt: new Date().toISOString() });
  await writeFile(agentFile, JSON.stringify(agent('done')));
  const fakeAgents = path.join(home, 'agents.mjs');
  const fakeDevice = path.join(home, 'device.mjs');
  const loader = path.join(home, 'loader.mjs');
  const observer = path.join(home, 'observer.mjs');
  await writeFile(fakeAgents, `import {readFile} from 'node:fs/promises'; export async function readAgents(){return {agents:[JSON.parse(await readFile(process.env.FAKE_AGENT_FILE,'utf8'))],warnings:[],targets:new Map()}}`);
  await writeFile(fakeDevice, `import {appendFileSync,existsSync} from 'node:fs';export function keyTileSvg(){return '<svg/>'}let renders=0;const log=x=>appendFileSync(process.env.FAKE_RENDER_LOG,x+'\\n');export function createDevice(){return {async start(){},status(){return {connected:true,mode:'hardware',model:'fake'}},async render(keys){const state=keys[0]?.state;const pulse=keys[0]?.alertPulse;if(++renders>1&&state==='done'){log('blink-start');while(!existsSync(process.env.FAKE_BLINK_RELEASE))await new Promise(r=>setTimeout(r,10));log('blink-end')}log('render:'+state+':'+pulse);return true},async renderSummary(){return true},async renderImages(){return true},async stop(){}}}`);
  await writeFile(loader, `const agent=${JSON.stringify(pathToFileURL(fakeAgents).href)},device=${JSON.stringify(pathToFileURL(fakeDevice).href)};export async function resolve(s,c,n){if(c.parentURL?.endsWith('/src/server.mjs')&&s==='./agents.mjs')return {url:agent,shortCircuit:true};if(c.parentURL?.endsWith('/src/server.mjs')&&s==='./device.mjs')return {url:device,shortCircuit:true};return n(s,c)}`);
  // A test-only observer reports when the refresh handler has started. Stop
  // the regular 2-second polling timer here so the held repaint is the alert
  // timer's repaint even when the event loop is heavily delayed.
  await writeFile(observer, `import http from 'node:http';import {appendFileSync} from 'node:fs';
const schedule=globalThis.setInterval;globalThis.setInterval=(fn,ms,...args)=>ms===2000?schedule(()=>{},ms,...args):schedule(fn,ms,...args);
const create=http.createServer;http.createServer=handler=>create((req,res)=>{const result=handler(req,res);if(req.method==='POST'&&req.url==='/api/refresh')appendFileSync(process.env.FAKE_RENDER_LOG,'refresh-received\\n');return result})`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOME: home, PORT: String(port), FAKE_AGENT_FILE: agentFile, FAKE_RENDER_LOG: logFile, FAKE_BLINK_RELEASE: releaseFile,
    STREAMDOCK_USAGE_DISABLED: '1', STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1' };
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--import', observer, 'src/server.mjs', '--device'], { cwd: root, env, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {});
      child.kill('SIGTERM');
      await Promise.race([exited, delay(2500)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(home, { recursive: true, force: true });
  });
  const status = async () => (await fetch(`${base}/api/status`)).json();
  await until(status, value => value.deck?.keys[0]?.state === 'done');
  await until(() => readFile(logFile, 'utf8'), value => value.includes('blink-start') && !value.includes('blink-end'));
  await writeFile(agentFile, JSON.stringify(agent('working')));
  // Keep the blink in flight until after the new agent state is written and
  // the refresh has been requested; wall-clock sleeps race under CI load.
  const request = fetch(`${base}/api/refresh`, { method: 'POST', headers: { Origin: base } });
  await until(() => readFile(logFile, 'utf8'), value => value.includes('refresh-received') && !value.includes('blink-end'));
  await writeFile(releaseFile, 'release');
  const response = await request;
  assert.equal(response.status, 200);
  const refreshed = await response.json();
  assert.equal(refreshed.deck.keys[0].state, 'working');
  const lines = (await readFile(logFile, 'utf8')).trim().split('\n');
  assert.ok(lines.indexOf('blink-start') < lines.indexOf('refresh-received'));
  assert.ok(lines.indexOf('refresh-received') < lines.indexOf('blink-end'));
  assert.ok(lines.indexOf('blink-end') < lines.findIndex(line => line.startsWith('render:working:')));
  assert.equal((await status()).deck.keys[0].state, 'working');
});
