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
async function until(get, predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    try { value = await get(); if (predicate(value)) return value; } catch { /* Wait for server. */ }
    await delay(50);
  }
  throw new Error(`Timed out: ${JSON.stringify(value)}`);
}

test('status reports reconnect state with a sanitized last error', { timeout: 40000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-connection-'));
  const control = path.join(home, 'connected');
  const deviceFile = path.join(home, 'device.mjs'), agentsFile = path.join(home, 'agents.mjs'), loader = path.join(home, 'loader.mjs');
  await writeFile(control, 'down');
  // The failure message carries a path, an email and a token-like run that must not leak.
  await writeFile(deviceFile, `import {readFileSync} from 'node:fs';
export function keyTileSvg(){return '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"/>'};
export function createDevice(){let connected=false; const available=()=>readFileSync(process.env.CONNECTION_FLAG,'utf8')==='up';
const error='open failed at /Users/someone/Library/hid.sock for me@example.com key=fixtureTokenABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
return {async start(){connected=available();},status(){if(!available())connected=false;return {connected,mode:'hardware',model:'fake',error:connected?null:error};},
async render(){return this.status().connected;},async renderSummary(){return this.status().connected;},async renderImages(){return this.status().connected;},
async setBrightness(){return true;},async stop(){connected=false;}}}`);
  await writeFile(agentsFile, `export async function readAgents(){return {agents:[],targets:new Map(),warnings:[]}}`);
  const replacements = Object.fromEntries([['./device.mjs', deviceFile], ['./agents.mjs', agentsFile]].map(([key, value]) => [key, pathToFileURL(value).href]));
  await writeFile(loader, `const replacements=${JSON.stringify(replacements)};export async function resolve(s,c,n){if(c.parentURL?.endsWith('/src/server.mjs')&&replacements[s])return {url:replacements[s],shortCircuit:true};return n(s,c)}`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOME: home, PORT: String(port), CONNECTION_FLAG: control, STREAMDOCK_USAGE_DISABLED: '1', STREAMDOCK_PRESENCE_DISABLED: '1', STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1' };
  delete env.STREAMDOCK_SWIFT_HID_PATH;
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

  const failing = await until(status, s => s.connection?.consecutiveFailures >= 2);
  assert.equal(failing.device.connected, false);
  assert.equal(typeof failing.connection.reconnecting, 'boolean');
  assert.ok(!Number.isNaN(Date.parse(failing.connection.nextAttemptAt)), 'next attempt is an ISO time');
  const lastError = failing.connection.lastError;
  assert.match(lastError, /open failed/);
  assert.match(lastError, /<path>/);
  assert.doesNotMatch(lastError, /\/Users\/|example\.com|fixtureTokenABCDEF/);

  await writeFile(control, 'up');
  const recovered = await until(status, s => s.device?.connected && s.connection?.consecutiveFailures === 0);
  assert.deepEqual(recovered.connection, { reconnecting: false, nextAttemptAt: null, consecutiveFailures: 0, lastError: null });
});
