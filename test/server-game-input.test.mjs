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

test('fake physical game presses during animation and redraw are queued exactly once', {timeout:45_000}, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-game-input-'));
  const fakeHid = path.join(home,'hid.mjs'), fakeChild = path.join(home,'child.mjs'), fakeGame = path.join(home,'game.mjs'), fakeSharp = path.join(home,'sharp.mjs');
  const loader = path.join(home,'loader.mjs'), guard = path.join(home,'guard.mjs');
  const gameLog = path.join(home,'game.log'), hidLog = path.join(home,'hid.log'), networkLog = path.join(home,'network.log'), renderLog = path.join(home,'render.log');
  const png = await sharp({create:{width:2,height:2,channels:3,background:'#345678'}}).png().toBuffer();
  const jpeg = await sharp({create:{width:2,height:2,channels:3,background:'#345678'}}).jpeg().toBuffer();
  await writeFile(fakeHid, `import {EventEmitter} from 'node:events';import {appendFileSync} from 'node:fs';
const ids=[13,10,7,4,1,14,11,8,5,2,15,12,9,6,3];let handle;let buffer='';
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))>=0){let line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const x=JSON.parse(line);const d=Buffer.alloc(11);d[0]=0x41;d[1]=0x43;d[2]=0x4b;d[5]=0x4f;d[6]=0x4b;d[9]=ids[x.index];d[10]=x.phase==='down'?1:0;const delivered=!!handle?.emit('data',d);appendFileSync(process.env.FAKE_HID_LOG,x.phase+':'+x.index+':'+delivered+'\\n');}catch{}}});
export async function devicesAsync(){return [{vendorId:0x6603,productId:0x1014,usagePage:65440,usage:1,path:'mock-device'}]};
export class HID extends EventEmitter{constructor(){super();handle=this}write(a){return a.length}close(){handle=undefined}}`);
  await writeFile(fakeChild, `export function execFile(file,args,options,callback){const cb=typeof options==='function'?options:callback;const error=Object.assign(new Error('no official app'),{code:1});process.nextTick(()=>cb(error,'',''));return {kill(){}}}`);
  await writeFile(fakeGame, `import {appendFileSync} from 'node:fs';
const png=Buffer.from(${JSON.stringify(png.toString('base64'))},'base64');let score=0;
const log=line=>appendFileSync(process.env.FAKE_GAME_LOG,line+'\\n');
const frame=()=>({mode:'mole',score,coins:20,sounds:[],hud:{phaseLabel:'게임',primary:String(score),secondary:''},tiles:Array.from({length:10},(_,index)=>({index,png})),wide:png});
export function createGameBridge(){return {async start(mode){log('start:'+mode);return frame()},async tick(){log('tick-start');await new Promise(r=>setTimeout(r,900));log('tick-end');return frame()},async press(index){score++;log('press:'+index);return frame()},async menu(){log('menu');return frame()},async close(){log('close')}}}`);
  await writeFile(fakeSharp, `import {appendFileSync} from 'node:fs';
const png=Buffer.from(${JSON.stringify(png.toString('base64'))},'base64'),jpeg=Buffer.from(${JSON.stringify(jpeg.toString('base64'))},'base64');
export default function sharp(input){const frame=Buffer.isBuffer(input)&&input[0]===0x89;let format='jpeg';const api={resize(){return api},rotate(){return api},jpeg(){format='jpeg';return api},png(){format='png';return api},async toBuffer(){if(frame){appendFileSync(process.env.FAKE_RENDER_LOG,'render-start\\n');await new Promise(r=>setTimeout(r,900));appendFileSync(process.env.FAKE_RENDER_LOG,'render-end\\n')}return format==='png'?png:jpeg}};return api}`);
  await writeFile(loader, `const hid=${JSON.stringify(pathToFileURL(fakeHid).href)},child=${JSON.stringify(pathToFileURL(fakeChild).href)},game=${JSON.stringify(pathToFileURL(fakeGame).href)},sharp=${JSON.stringify(pathToFileURL(fakeSharp).href)};
export async function resolve(s,c,n){if(s==='node-hid')return {url:hid,shortCircuit:true};if(s==='sharp'&&(c.parentURL?.endsWith('/src/device.mjs')||c.parentURL?.endsWith('/src/server.mjs')))return {url:sharp,shortCircuit:true};if(s==='node:child_process'&&c.parentURL?.endsWith('/src/device.mjs'))return {url:child,shortCircuit:true};if(s==='./game-bridge.mjs'&&c.parentURL?.endsWith('/src/server.mjs'))return {url:game,shortCircuit:true};return n(s,c)}`);
  await writeFile(guard, `import {appendFileSync} from 'node:fs';globalThis.fetch=async()=>{appendFileSync(process.env.FAKE_NETWORK_LOG,'unexpected\\n');throw Error('network disabled in test')}`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = {...process.env,HOME:home,PORT:String(port),FAKE_HID_LOG:hidLog,FAKE_GAME_LOG:gameLog,FAKE_NETWORK_LOG:networkLog,FAKE_RENDER_LOG:renderLog,
    STREAMDOCK_USAGE_DISABLED:'1',STREAMDOCK_PRESENCE_DISABLED:'1',STREAMDOCK_DESKTOP_USAGE_DISABLED:'1',STREAMDOCK_FEATURE_NETWORK_DISABLED:'1'};
  const child = spawn(process.execPath,['--no-warnings','--experimental-loader',loader,'--import',guard,'src/server.mjs','--device'],{cwd:root,env,stdio:['pipe','ignore','ignore']});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit').catch(()=>{});child.kill('SIGTERM');let timer;await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,3000)})]);clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
    await rm(home,{recursive:true,force:true});
  });
  await until(()=>status(base),s=>s.device?.connected && s.deck?.view==='projects');
  await click(base,deck=>deck.keys.find(k=>k.action==='modes'));
  await click(base,deck=>deck.keys.find(k=>k.label==='게임'&&k.action==='open_mode'));
  await click(base,deck=>deck.keys.find(k=>k.label==='두더지'&&k.action==='feature_action'));
  await until(()=>status(base),s=>s.deck?.mode==='games'&&s.deck.frames?.length===10);
  await until(()=>readText(gameLog),log=>log.includes('tick-start\n') && !log.includes('tick-end\n'));
  for(const index of [0,1,2]) {
    child.stdin.write(JSON.stringify({index,phase:'down'})+'\n');
    child.stdin.write(JSON.stringify({index,phase:'up'})+'\n');
  }
  const log = await until(()=>readText(gameLog),value=>[0,1,2].every(index=>value.includes(`press:${index}\n`)));
  const order = log.split('\n').filter(line=>/^press:/.test(line));
  assert.deepEqual(order.slice(0,3),['press:0','press:1','press:2']);
  for(const index of [0,1,2])assert.equal(order.filter(line=>line===`press:${index}`).length,1,`key ${index} handled exactly once`);
  // Let the first batch commit. Then wait for a new physical-frame conversion
  // to be in flight, rather than just the animation tick itself.
  await until(()=>status(base),s=>s.lastInput?.index===2 && s.lastInput?.code==='updated');
  const startCount = text => (text.match(/render-start/g)||[]).length;
  const endCount = text => (text.match(/render-end/g)||[]).length;
  const initialStarts = startCount(await readText(renderLog));
  await until(()=>readText(renderLog),text=>startCount(text)>initialStarts && startCount(text)>endCount(text));
  for(const index of [3,4]) {
    child.stdin.write(JSON.stringify({index,phase:'down'})+'\n');
    child.stdin.write(JSON.stringify({index,phase:'up'})+'\n');
  }
  const afterRedraw = await until(()=>readText(gameLog),value=>[3,4].every(index=>value.includes(`press:${index}\n`)));
  const allPresses = afterRedraw.split('\n').filter(line=>/^press:/.test(line));
  assert.deepEqual(allPresses.slice(0,5),['press:0','press:1','press:2','press:3','press:4']);
  for(const index of [3,4])assert.equal(allPresses.filter(line=>line===`press:${index}`).length,1,`redraw key ${index} handled exactly once`);
  const hid = await readText(hidLog);
  for(const index of [0,1,2]){assert.match(hid,new RegExp(`down:${index}:true`));assert.match(hid,new RegExp(`up:${index}:true`));}
  assert.equal(await readText(networkLog),'');
});
