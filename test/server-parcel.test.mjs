import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const listener=net.createServer();
  await new Promise((resolve,reject)=>listener.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;
  await new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
  return port;
}
async function stateUntil(base, child, predicate, timeout = 15000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    if(child.exitCode!==null||child.signalCode!==null) throw Error('isolated server stopped');
    try { const response=await fetch(`${base}/api/status`); if(response.ok) {const state=await response.json();if(predicate(state))return state;} } catch { /* starting */ }
    await delay(60);
  }
  throw Error('isolated server state not reached');
}
async function press(base,index,revision,heldMs) {
  for(let i=0;i<60;i++) {
    const response=await fetch(`${base}/api/press`,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({index,revision,...(heldMs===undefined?{}:{heldMs})})});
    const data=await response.json(); if(data.code!=='busy')return {status:response.status,data}; await delay(60);
  }
  throw Error('isolated server remained busy');
}
async function review(base,body,origin=base) {
  const headers={'content-type':'application/json'};if(origin!==null)headers.origin=origin;
  for(let i=0;i<60;i++) {
    const response=await fetch(`${base}/api/review`,{method:'POST',headers,body:JSON.stringify(body)});
    const data=await response.json();
    if(response.status!==409||!String(data.message||'').includes('갱신 중'))return {status:response.status,data};
    const current=await(await fetch(`${base}/api/status`)).json();
    if(current.deck?.revision!==body.revision)return {status:response.status,data};
    await delay(60);
  }
  throw Error('review remained busy');
}

test('parcel review exposes only approved local details and never sends tracking in network-disabled mode', {timeout:45000}, async t => {
  const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'streamdock-parcel-e2e-')));
  const config=path.join(home,'.config','streamdock-ai','parcels.json');await mkdir(path.dirname(config),{recursive:true});
  const tracking='TEST123456789', title='격리된 테스트 택배';
  await writeFile(config,JSON.stringify({trackingOptIn:true,parcels:[{title,tracking}]}),{mode:0o600});
  const marker=path.join(home,'unexpected-fetch.txt'), hidLog=path.join(home,'fake-hid.log');
  const fakeHid=path.join(home,'fake-hid.mjs'), fakeChild=path.join(home,'fake-child.mjs'), fakeMachine=path.join(home,'fake-machine.mjs'), loader=path.join(home,'loader.mjs'), guard=path.join(home,'guard.mjs');
  await writeFile(fakeHid, `import {EventEmitter} from 'node:events';import {appendFileSync} from 'node:fs';
const ids=[13,10,7,4,1,14,11,8,5,2,15,12,9,6,3];let handle;let buffer='';
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))>=0){let line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{let x=JSON.parse(line);let d=Buffer.alloc(11);d[0]=0x41;d[1]=0x43;d[2]=0x4b;d[5]=0x4f;d[6]=0x4b;d[9]=ids[x.index];d[10]=x.phase==='down'?1:0;const delivered=!!handle?.emit('data',d);appendFileSync(process.env.FAKE_HID_LOG, x.phase+':'+delivered+'\\n');}catch{}}});
export async function devicesAsync(){return [{vendorId:0x6603,productId:0x1014,usagePage:65440,usage:1,path:'mock-device'}]};
export class HID extends EventEmitter{constructor(){super();handle=this}write(a){return a.length}close(){handle=undefined}}`);
  await writeFile(fakeChild, `export function execFile(file,args,options,callback){const cb=typeof options==='function'?options:callback;const error=Object.assign(new Error('no official app'),{code:1});process.nextTick(()=>cb(error,'',''));return {kill(){}}}`);
  await writeFile(fakeMachine, `export function createMachineMonitor(){return {async read(){return {name:'test',status:'ok',cpuPercent:1,memoryFreePercent:50,disk:{usedPercent:10},battery:{present:false,percent:null},networkHasAddress:false,thermalC:null,healthScore:null}},invalidate(){},async close(){}}}`);
  await writeFile(loader, `const hid=${JSON.stringify(pathToFileURL(fakeHid).href)},child=${JSON.stringify(pathToFileURL(fakeChild).href)},machine=${JSON.stringify(pathToFileURL(fakeMachine).href)};
export async function resolve(s,c,n){if(s==='node-hid')return {url:hid,shortCircuit:true};if(s==='node:child_process'&&c.parentURL?.endsWith('/src/device.mjs'))return {url:child,shortCircuit:true};if(s==='./machines.mjs'&&c.parentURL?.endsWith('/src/server.mjs'))return {url:machine,shortCircuit:true};return n(s,c)}`);
  await writeFile(guard, `import {appendFileSync} from 'node:fs';globalThis.fetch=async()=>{appendFileSync(process.env.FAKE_NETWORK_LOG,'unexpected-fetch\\n');throw Error('network disabled in isolated test')}`);
  const port=await freePort(),base=`http://127.0.0.1:${port}`;
  const env={...process.env,HOME:home,PORT:String(port),FAKE_NETWORK_LOG:marker,FAKE_HID_LOG:hidLog,STREAMDOCK_USAGE_DISABLED:'1',STREAMDOCK_PRESENCE_DISABLED:'1',STREAMDOCK_DESKTOP_USAGE_DISABLED:'1',STREAMDOCK_FEATURE_NETWORK_DISABLED:'1'};
  const child=spawn(process.execPath,['--no-warnings','--experimental-loader',loader,'--import',guard,'src/server.mjs','--device'],{cwd:root,env,stdio:['pipe','ignore','ignore']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit').catch(()=>{});child.kill('SIGTERM');let timer;await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,3000)})]);clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}await rm(home,{recursive:true,force:true});});
  let s=await stateUntil(base,child,x=>x.device?.connected&&x.deck?.view==='projects');
  let key=s.deck.keys.find(x=>x.action==='modes');assert.ok(key);assert.equal((await press(base,key.index,s.deck.revision)).status,200);
  s=await stateUntil(base,child,x=>x.deck?.view==='hub');key=s.deck.keys.find(x=>x.action==='open_mode'&&x.label==='택배');assert.ok(key);assert.equal((await press(base,key.index,s.deck.revision)).status,200);
  s=await stateUntil(base,child,x=>x.deck?.mode==='parcels'&&x.deck.keys.some(k=>k.label==='배송 조회'));
  key=s.deck.keys.find(k=>k.label==='배송 조회'&&k.action==='feature_action');assert.ok(key);assert.equal((await press(base,key.index,s.deck.revision)).status,200);
  s=await stateUntil(base,child,x=>x.parcelReview?.stage==='review');
  assert.ok(!JSON.stringify(s).includes(tracking),'status leaked full tracking number');
  assert.ok(!/"token"\s*:/.test(JSON.stringify(s.parcelReview)),'status leaked private confirmation token');
  assert.equal(s.parcelReview.plan.destination,'Cainiao');assert.equal(s.parcelReview.plan.count,1);
  const reviewId=s.parcelReview.reviewId,revision=s.deck.revision;assert.match(reviewId,/^[a-f0-9]{48}$/);
  assert.equal((await review(base,{kind:'parcel',revision,reviewId})).status,409,'must read full list before acknowledgement');
  assert.equal((await review(base,{kind:'parcel',revision,reviewId},null)).status,403);
  assert.equal((await review(base,{kind:'parcel',revision:revision+1,reviewId})).status,409);
  assert.equal((await review(base,{kind:'parcel',revision,reviewId:'a'.repeat(48)})).status,409);
  const query=`${base}/api/parcel-review?reviewId=${reviewId}`;
  assert.equal((await fetch(query)).status,403);
  assert.equal((await fetch(`${base}/api/parcel-review?reviewId=${'b'.repeat(48)}`,{headers:{'X-StreamDock-Review':'1'}})).status,404);
  const details=await(await fetch(query,{headers:{'X-StreamDock-Review':'1'}})).json();
  assert.equal(details.destination,'Cainiao');assert.equal(details.count,1);assert.deepEqual(details.targets.map(x=>({title:x.title,tracking:x.tracking})),[{title,tracking}]);
  assert.ok(!/"token"\s*:/.test(JSON.stringify(details)));
  assert.equal((await review(base,{kind:'parcel',revision,reviewId})).status,200);
  s=await stateUntil(base,child,x=>x.parcelReview?.reviewed===true&&x.deck?.keys.some(k=>k.caption==='번호 전송'));
  assert.ok(!JSON.stringify(s).includes(tracking));
  const confirm=s.deck.keys.find(k=>k.caption==='번호 전송'&&k.action==='feature_action');assert.ok(confirm);
  const fakeWeb=await press(base,confirm.index,s.deck.revision,5000);assert.equal(fakeWeb.status,409);assert.equal(fakeWeb.data.code,'unavailable');
  await delay(200);
  child.stdin.write(JSON.stringify({index:confirm.index,phase:'down'})+'\n');await delay(1400);
  child.stdin.write(JSON.stringify({index:confirm.index,phase:'up'})+'\n');await delay(400);
  const events=await readFile(hidLog,'utf8');assert.match(events,/down:true/);assert.match(events,/up:true/);
  const last=await(await fetch(`${base}/api/status`)).json();assert.equal(last.parcelReview?.stage,'review');assert.equal(last.parcelReview?.reviewed,true);
  await assert.rejects(readFile(marker,'utf8'),{code:'ENOENT'});
});
