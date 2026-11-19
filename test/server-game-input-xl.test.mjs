import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function readText(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function status(base) {
  const response = await fetch(`${base}/api/status`, {signal:AbortSignal.timeout(5000)});
  assert.equal(response.status, 200);
  return response.json();
}
async function until(read, predicate, { timeout = 15_000 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await read(); if (predicate(last)) return last; } catch { /* startup or transient read */ }
    await delay(30);
  }
  throw new Error(`Timed out waiting for test event; last=${typeof last === 'string' ? last.slice(-500) : JSON.stringify({view:last?.deck?.view, mode:last?.deck?.mode})}`);
}
async function click(base, choose) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const before = await status(base);
    const key = choose(before.deck);
    if (!key) { await delay(30); continue; }
    const response = await fetch(`${base}/api/press`, {method:'POST',headers:{Origin:base,'Content-Type':'application/json'},
      body:JSON.stringify({index:key.index,revision:before.deck.revision}),signal:AbortSignal.timeout(10_000)});
    const result = await response.json();
    if (result.code === 'busy' || result.code === 'stale') { await delay(30); continue; }
    assert.equal(result.ok,true,result.message || result.code);
    return await status(base);
  }
  throw new Error('Expected button remained unavailable');
}

test('XL physical presses reach the game through the legacy 5x3 area only', {timeout:45_000}, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-game-input-xl-'));
  const fakeHid = path.join(home,'hid.mjs'), fakeChild = path.join(home,'child.mjs'), fakeGame = path.join(home,'game.mjs');
  const loader = path.join(home,'loader.mjs'), guard = path.join(home,'guard.mjs');
  const gameLog = path.join(home,'game.log'), hidLog = path.join(home,'hid.log'), networkLog = path.join(home,'network.log');
  const png = await sharp({create:{width:2,height:2,channels:3,background:'#345678'}}).png().toBuffer();
  // XL input code = physical index + 1 (0x01 is top-left).
  await writeFile(fakeHid, `import {EventEmitter} from 'node:events';import {appendFileSync} from 'node:fs';let handle;let buffer='';
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))>=0){let line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const x=JSON.parse(line);const d=Buffer.alloc(11);d[0]=0x41;d[1]=0x43;d[2]=0x4b;d[5]=0x4f;d[6]=0x4b;d[9]=x.index+1;d[10]=x.phase==='down'?1:0;const delivered=!!handle?.emit('data',d);appendFileSync(process.env.FAKE_HID_LOG,x.phase+':'+x.index+':'+delivered+'\\n');}catch{}}});
export async function devicesAsync(){return [{vendorId:0x5548,productId:0x1028,usagePage:65440,usage:1,path:'mock-xl'}]};
export class HID extends EventEmitter{constructor(){super();handle=this}write(a){return a.length}close(){handle=undefined}}`);
  await writeFile(fakeChild, `export function execFile(file,args,options,callback){const cb=typeof options==='function'?options:callback;const error=Object.assign(new Error('no official app'),{code:1});process.nextTick(()=>cb(error,'',''));return {kill(){}}}`);
  await writeFile(fakeGame, `import {appendFileSync} from 'node:fs';
const png=Buffer.from(${JSON.stringify(png.toString('base64'))},'base64');let score=0;
const log=line=>appendFileSync(process.env.FAKE_GAME_LOG,line+'\\n');
const frame=()=>({mode:'mole',score,coins:20,sounds:[],hud:{phaseLabel:'게임',primary:String(score),secondary:''},tiles:Array.from({length:10},(_,index)=>({index,png})),wide:png});
export function createGameBridge(){return {async start(mode){log('start:'+mode);return frame()},async tick(){return frame()},async press(index){score++;log('press:'+index);return frame()},async menu(){log('menu');return frame()},async close(){log('close')}}}`);
  await writeFile(loader, `const hid=${JSON.stringify(pathToFileURL(fakeHid).href)},child=${JSON.stringify(pathToFileURL(fakeChild).href)},game=${JSON.stringify(pathToFileURL(fakeGame).href)};
export async function resolve(s,c,n){if(s==='node-hid')return {url:hid,shortCircuit:true};if(s==='node:child_process'&&c.parentURL?.endsWith('/src/device.mjs'))return {url:child,shortCircuit:true};if(s==='./game-bridge.mjs'&&c.parentURL?.endsWith('/src/server.mjs'))return {url:game,shortCircuit:true};return n(s,c)}`);
  await writeFile(guard, `import {appendFileSync} from 'node:fs';globalThis.fetch=async()=>{appendFileSync(process.env.FAKE_NETWORK_LOG,'unexpected\\n');throw Error('network disabled in test')}`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = {...process.env,HOME:home,PORT:String(port),FAKE_HID_LOG:hidLog,FAKE_GAME_LOG:gameLog,FAKE_NETWORK_LOG:networkLog,
    STREAMDOCK_USAGE_DISABLED:'1',STREAMDOCK_PRESENCE_DISABLED:'1',STREAMDOCK_DESKTOP_USAGE_DISABLED:'1',STREAMDOCK_FEATURE_NETWORK_DISABLED:'1'};
  const child = spawn(process.execPath,['--no-warnings','--experimental-loader',loader,'--import',guard,'src/server.mjs','--device'],{cwd:root,env,stdio:['pipe','ignore','ignore']});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit').catch(()=>{});child.kill('SIGTERM');let timer;await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,3000)})]);clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
    await rm(home,{recursive:true,force:true});
  });
  const ready = await until(()=>status(base),s=>s.device?.connected && s.deck?.view==='projects' && s.deck?.layout?.model==='xl');
  assert.equal(ready.deck.keys.length, 32);
  await click(base,deck=>deck.keys.find(k=>k.action==='modes'));
  await click(base,deck=>deck.keys.find(k=>k.label==='게임'&&k.action==='open_mode'));
  await click(base,deck=>deck.keys.find(k=>k.label==='두더지'&&k.action==='feature_action'));
  await until(()=>status(base),s=>s.deck?.mode==='games'&&(s.deck.frames?.length||0)>=10);
  // Physical XL index -> 293S game index: 8 (row 1, col 0) -> 5; 0 -> 0.
  // 6 is outside the 5x3 area and 7 is a summary key: both must be ignored.
  for(const index of [6,7,8,0]) {
    child.stdin.write(JSON.stringify({index,phase:'down'})+'\n');
    child.stdin.write(JSON.stringify({index,phase:'up'})+'\n');
  }
  const log = await until(()=>readText(gameLog),value=>value.includes('press:5\n')&&value.includes('press:0\n'));
  await delay(300);
  const presses = (await readText(gameLog)).split('\n').filter(line=>/^press:/.test(line));
  assert.deepEqual(presses,['press:5','press:0'], log);
  const hid = await readText(hidLog);
  for(const index of [6,7,8,0])assert.match(hid,new RegExp(`down:${index}:true`));
  assert.equal(await readText(networkLog),'');
});
