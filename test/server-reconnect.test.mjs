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
  throw new Error(`Timed out: ${JSON.stringify(value)}`);
}
async function status(base) { return (await fetch(`${base}/api/status`)).json(); }
async function press(base, findKey) {
  const before = await status(base);
  const key = findKey(before.deck.keys);
  assert.ok(key, 'expected key exists');
  const response = await fetch(`${base}/api/press`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ index: key.index, revision: before.deck.revision }) });
  assert.equal(response.status, 200, await response.text());
}

test('USB reconnect restores project, game, and scene frames', { timeout: 50000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-reconnect-'));
  const control = path.join(home, 'connected'), log = path.join(home, 'device.log');
  const deviceFile = path.join(home, 'device.mjs'), agentsFile = path.join(home, 'agents.mjs');
  const gameFile = path.join(home, 'game.mjs'), sceneFile = path.join(home, 'scene.mjs'), loader = path.join(home, 'loader.mjs');
  await writeFile(control, 'up');
  await writeFile(deviceFile, `import {appendFileSync,readFileSync} from 'node:fs';
const log = value => appendFileSync(process.env.RECONNECT_LOG, JSON.stringify(value)+'\\n');
export function keyTileSvg(){return '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"/>'};
export function createDevice(){let connected=false; const available=()=>readFileSync(process.env.RECONNECT_FLAG,'utf8')==='up';
return {async start(){connected=available();log({op:'start',connected});},status(){if(!available())connected=false;return {connected,mode:'hardware',model:'fake',error:connected?null:'disconnected'};},
async render(keys){if(!this.status().connected)return false;log({op:'render',count:keys.length});return true;},
async renderSummary(){if(!this.status().connected)return false;log({op:'summary',slots:[16,17,18]});return true;},
async renderImages({keys=[],sides=[]}){if(!this.status().connected)return false;log({op:'images',keys:keys.length,slots:sides.map(x=>x.slot)});return true;},
async setBrightness(){return true;},async stop(){connected=false;log({op:'stop'});}}}`);
  await writeFile(agentsFile, `export async function readAgents(){return {agents:[],targets:new Map(),warnings:[]}}`);
  // Decoding happens inside the real worker, not in the mock HID renderer.
  const frame = `const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');`;
  await writeFile(gameFile, `${frame}\nconst f=()=>({mode:'mole',sounds:[],hud:{phaseLabel:'게임',primary:'0',secondary:''},tiles:Array.from({length:10},(_,index)=>({index,png}))});export function createGameBridge(){return {async start(){return f()},async tick(){return f()},async press(){return f()},async menu(){return f()},async close(){}}}`);
  await writeFile(sceneFile, `${frame}\nconst f=()=>({tiles:Array.from({length:15},(_,index)=>({index,png})),sideTiles:[16,17,18].map(slot=>({slot,png}))});export function createSceneBridge(){return {async start(){return f()},async tick(){return f()},async press(){return f()},async stop(){},async close(){}}}`);
  const replacements = Object.fromEntries([['./device.mjs',deviceFile],['./agents.mjs',agentsFile],['./game-bridge.mjs',gameFile],['./scene-bridge.mjs',sceneFile]].map(([key,value]) => [key,pathToFileURL(value).href]));
  await writeFile(loader, `const replacements=${JSON.stringify(replacements)};export async function resolve(s,c,n){if(c.parentURL?.endsWith('/src/server.mjs')&&replacements[s])return {url:replacements[s],shortCircuit:true};return n(s,c)}`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = {...process.env, HOME:home, PORT:String(port), RECONNECT_LOG:log, RECONNECT_FLAG:control, STREAMDOCK_USAGE_DISABLED:'1', STREAMDOCK_PRESENCE_DISABLED:'1', STREAMDOCK_DESKTOP_USAGE_DISABLED:'1', STREAMDOCK_FEATURE_NETWORK_DISABLED:'1'};
  delete env.STREAMDOCK_SWIFT_HID_PATH;
  const child = spawn(process.execPath, ['--no-warnings','--experimental-loader',loader,'src/server.mjs','--device'], {cwd:root,env,stdio:'ignore'});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit').catch(()=>{});child.kill('SIGTERM');await Promise.race([exited,delay(3000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}await rm(home,{recursive:true,force:true});});
  const records = async() => (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  await until(()=>status(base),s=>s.device?.connected && s.deck?.view==='projects');
  async function reconnect(expectImages) {
    await writeFile(control,'down');
    await until(()=>status(base),s=>!s.device?.connected);
    const old = (await records()).length;
    await writeFile(control,'up');
    await until(()=>status(base),s=>s.device?.connected);
    const after = await until(records, rows=>{
      const tail=rows.slice(old), start=tail.findIndex(r=>r.op==='start'&&r.connected);
      return start>=0 && tail.slice(start).some(r=>r.op==='render'&&r.count===15) && tail.slice(start).some(r=>expectImages ? r.op==='images'&&r.keys===expectImages&&r.slots.join(',')==='16,17,18' : r.op==='summary'&&r.slots.join(',')==='16,17,18');
    });
    assert.ok(after.slice(old).some(r=>r.op==='start'&&r.connected));
  }
  await reconnect(0);
  await press(base, keys=>keys.find(k=>k.action==='modes'));
  await press(base, keys=>keys.find(k=>k.label==='게임'&&k.action==='open_mode'));
  await press(base, keys=>keys.find(k=>k.label==='두더지'&&k.action==='feature_action'));
  await until(()=>status(base),s=>s.deck?.mode==='games'&&s.deck.frames?.length===10);
  await reconnect(10);
  await press(base, keys=>keys.find(k=>k.label==='게임 메뉴'));
  await press(base, keys=>keys.find(k=>k.label==='뒤로'&&k.action==='back'));
  await press(base, keys=>keys.find(k=>k.label==='장면'&&k.action==='open_mode'));
  await press(base, keys=>keys.find(k=>k.label==='수족관'&&k.action==='feature_action'));
  await until(()=>status(base),s=>s.deck?.mode==='scenes'&&s.deck.frames?.length===15);
  await reconnect(15);
});
