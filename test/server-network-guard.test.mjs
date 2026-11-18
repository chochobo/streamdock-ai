import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function availablePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function status(base) {
  const r = await fetch(`${base}/api/status`, {signal: AbortSignal.timeout(4000)});
  assert.equal(r.status, 200);
  return r.json();
}
async function waitFor(base, predicate, child) {
  let last;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('Isolated server exited');
    try { last = await status(base); if (predicate(last)) return last; } catch { /* startup */ }
    await delay(40);
  }
  throw new Error(`Timed out waiting for the requested screen: ${JSON.stringify({mode:last?.deck?.mode,keys:last?.deck?.keys?.map(k=>({label:k.label,action:k.action})),warnings:last?.warnings})}`);
}
async function press(base, choose, { expected = 200, code, heldMs } = {}) {
  for (let i = 0; i < 40; i++) {
    const s = await status(base);
    const key = choose(s.deck);
    if (!key) { await delay(40); continue; }
    const response = await fetch(`${base}/api/press`, {method:'POST', headers:{Origin:base,'Content-Type':'application/json'},
      body:JSON.stringify({index:key.index,revision:s.deck.revision,...(heldMs === undefined ? {} : {heldMs})}), signal:AbortSignal.timeout(4000)});
    const result = await response.json();
    if (result.code === 'busy' || result.code === 'stale') { await delay(40); continue; }
    assert.equal(response.status, expected, `${result.message || result.code}; mode=${s.deck?.mode}; key=${key.label}; warnings=${JSON.stringify(s.warnings)}`);
    if (code) assert.equal(result.code, code);
    return result;
  }
  throw new Error('Expected key was not available');
}

test('network-disabled fake HID blocks parcel, credits, and SSH confirmation before any network action', {timeout:30_000}, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-network-guard-'));
  const config = path.join(home, '.config', 'streamdock-ai');
  await mkdir(config, {recursive:true, mode:0o700});
  let connections = 0;
  const trap = net.createServer(socket => { connections++; socket.destroy(); });
  const trapPort = await listen(trap);
  const tracking = 'TEST293S12345';
  await writeFile(path.join(config, 'parcels.json'), JSON.stringify({trackingOptIn:true, parcels:[{tracking,title:'시험 택배'}]}), {mode:0o600});
  await writeFile(path.join(config, 'remote.json'), JSON.stringify({enabled:true,hosts:[{ssh:'127.0.0.1',port:trapPort,label:'시험 호스트',operations:['machine']}]}), {mode:0o600});
  await writeFile(path.join(config, 'credits.json'), JSON.stringify({sources:{flow:{enabled:true,source:'cdp',dedicatedProfile:true,port:trapPort}}}), {mode:0o600});
  const marker = path.join(home, 'fetch-attempted');
  const preload = path.join(home, 'block-network.mjs');
  await writeFile(preload, "import { appendFileSync } from 'node:fs'; globalThis.fetch = async () => { appendFileSync(process.env.STREAMDOCK_TEST_FETCH_MARKER, 'x'); throw new Error('test network disabled'); };\n", {mode:0o600});
  const fakeHid=path.join(home,'fake-hid.mjs'), fakeChild=path.join(home,'fake-child.mjs'), loader=path.join(home,'loader.mjs'), hidLog=path.join(home,'hid.log');
  await writeFile(fakeHid, `import {EventEmitter} from 'node:events';import {appendFileSync} from 'node:fs';
const ids=[13,10,7,4,1,14,11,8,5,2,15,12,9,6,3];let handle;let buffer='';
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))>=0){let line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const x=JSON.parse(line);const d=Buffer.alloc(11);d[0]=0x41;d[1]=0x43;d[2]=0x4b;d[5]=0x4f;d[6]=0x4b;d[9]=ids[x.index];d[10]=x.phase==='down'?1:0;const delivered=!!handle?.emit('data',d);appendFileSync(process.env.FAKE_HID_LOG,x.phase+':'+delivered+'\\n');}catch{}}});
export async function devicesAsync(){return [{vendorId:0x6603,productId:0x1014,usagePage:65440,usage:1,path:'mock-device'}]};
export class HID extends EventEmitter{constructor(){super();handle=this}write(a){return a.length}close(){handle=undefined}}`);
  await writeFile(fakeChild, `export function execFile(file,args,options,callback){const cb=typeof options==='function'?options:callback;const error=Object.assign(new Error('no official app'),{code:1});process.nextTick(()=>cb(error,'',''));return {kill(){}}}`);
  await writeFile(loader, `const hid=${JSON.stringify(pathToFileURL(fakeHid).href)},child=${JSON.stringify(pathToFileURL(fakeChild).href)};
export async function resolve(s,c,n){if(s==='node-hid')return {url:hid,shortCircuit:true};if(s==='node:child_process'&&c.parentURL?.endsWith('/src/device.mjs'))return {url:child,shortCircuit:true};return n(s,c)}`);
  const port = await availablePort(), base = `http://127.0.0.1:${port}`;
  const env = {...process.env, HOME:home, PORT:String(port), STREAMDOCK_USAGE_DISABLED:'1', STREAMDOCK_PRESENCE_DISABLED:'1',
    STREAMDOCK_DESKTOP_USAGE_DISABLED:'1', STREAMDOCK_FEATURE_NETWORK_DISABLED:'1', STREAMDOCK_TEST_FETCH_MARKER:marker,
    FAKE_HID_LOG:hidLog, NODE_OPTIONS:`--import=${pathToFileURL(preload).href}`};
  const child = spawn(process.execPath, ['--no-warnings','--experimental-loader',loader,'src/server.mjs','--device'], {cwd:root,env,stdio:['pipe','ignore','ignore']});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {}); child.kill('SIGTERM');
      let timer; await Promise.race([exited, new Promise(resolve => { timer=setTimeout(resolve,3000); })]); clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await new Promise(resolve => trap.close(resolve));
    await rm(home,{recursive:true,force:true});
  });
  await waitFor(base, s=>s.device?.connected && s.deck?.view==='projects', child);
  await press(base, deck=>deck.keys.find(k=>k.action==='modes'));
  await press(base, deck=>deck.keys.find(k=>k.label==='택배' && k.action==='open_mode'));
  await waitFor(base, s=>s.deck?.mode==='parcels' && s.deck.keys.some(k=>k.label==='배송 조회' && k.action==='feature_action'), child);
  await press(base, deck=>deck.keys.find(k=>k.label==='배송 조회' && k.action==='feature_action'));
  let state = await waitFor(base,s=>s.parcelReview?.stage==='review' && s.parcelReview.reviewId,child);
  const reviewId=state.parcelReview.reviewId;
  let viewed = await fetch(`${base}/api/parcel-review?reviewId=${reviewId}`, {headers:{'x-streamdock-review':'1'}, signal:AbortSignal.timeout(4000)});
  assert.equal(viewed.status,200);
  const review = await viewed.json();
  assert.equal(review.targets[0].tracking,tracking);
  for (let i=0;i<40;i++) {
    state=await status(base);
    const ack=await fetch(`${base}/api/review`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},
      body:JSON.stringify({kind:'parcel',reviewId,revision:state.deck.revision}),signal:AbortSignal.timeout(4000)});
    if (ack.status===200) break;
    assert.equal(ack.status,409);
    if(i===39) assert.fail('Parcel review could not be acknowledged');
    await delay(40);
  }
  await waitFor(base,s=>s.deck.keys.some(k=>k.label==='Cainiao' && k.caption==='번호 전송' && k.action==='feature_action'),child);
  await press(base,deck=>deck.keys.find(k=>k.label==='Cainiao' && k.caption==='번호 전송' && k.action==='feature_action'),{expected:409,code:'unavailable',heldMs:2000});
  await press(base,deck=>deck.keys.find(k=>k.label==='취소' && k.action==='feature_action'));
  await press(base,deck=>deck.keys.find(k=>k.action==='back'));

  // Credit collection is also disabled, even with an opted-in dedicated port.
  await press(base,deck=>deck.keys.find(k=>k.label==='크레딧' && k.action==='open_mode'));
  state=await waitFor(base,s=>s.deck?.mode==='credits',child);
  await delay(200);
  state=await status(base);
  assert.ok(state.deck.keys.some(k=>k.label==='크레딧'));
  assert.ok(!state.deck.keys.some(k=>['Google Flow','Higgsfield'].includes(k.label)),'disabled mode must not read configured credit sources');
  await press(base,deck=>deck.keys.find(k=>k.action==='back'));

  // Remote host is local loopback; if SSH is accidentally spawned the trap
  // records a connection and never forwards traffic outside this test.
  state=await status(base);
  await press(base,deck=>deck.keys.find(k=>k.action==='next'));
  await press(base,deck=>deck.keys.find(k=>k.label==='원격' && k.action==='open_mode'));
  await waitFor(base,s=>s.deck?.mode==='remote' && s.deck.keys.some(k=>k.label==='시험 호스트' && k.action==='feature_action'),child);
  await press(base,deck=>deck.keys.find(k=>k.label==='시험 호스트' && k.action==='feature_action'));
  state=await waitFor(base,s=>s.remoteReview?.stage==='review' && s.remoteReview.reviewId,child);
  const remoteReviewId=state.remoteReview.reviewId;
  const reviewBody={kind:'remote',reviewId:remoteReviewId,revision:state.deck.revision};
  const acknowledge=async body=>fetch(`${base}/api/review`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(4000)});
  assert.equal((await acknowledge(reviewBody)).status,409,'remote detail must be viewed before acknowledgement');
  const remoteUrl=`${base}/api/remote-review?reviewId=${remoteReviewId}`;
  assert.equal((await fetch(remoteUrl)).status,403);
  const remoteDetail=await (await fetch(remoteUrl,{headers:{'X-StreamDock-Review':'1'}})).json();
  assert.equal(remoteDetail.host,'127.0.0.1'); assert.equal(remoteDetail.port,trapPort); assert.equal(remoteDetail.operation,'machine');
  for(let i=0;i<40;i++){
    state=await status(base);
    const ack=await acknowledge({...reviewBody,revision:state.deck.revision});
    if(ack.status===200)break;
    assert.equal(ack.status,409);
    if(i===39)assert.fail('Remote review could not be acknowledged');
    await delay(40);
  }
  state=await waitFor(base,s=>s.remoteReview?.reviewed===true && s.deck.keys.some(k=>k.label==='연결 실행' && k.action==='feature_action'),child);
  const confirm=state.deck.keys.find(k=>k.label==='연결 실행' && k.action==='feature_action');
  await press(base,deck=>deck.keys.find(k=>k.label==='연결 실행' && k.action==='feature_action'),{expected:409,code:'unavailable'});
  // A real 293S button uses an unversioned physical down/up event. Verify
  // this exact path reached the guard, rather than merely observing no SSH.
  const lastAt=state.lastInput?.at || null;
  child.stdin.write(JSON.stringify({index:confirm.index,phase:'down'})+'\n');
  await delay(1400);
  child.stdin.write(JSON.stringify({index:confirm.index,phase:'up'})+'\n');
  const physical=await waitFor(base,s=>s.lastInput?.index===confirm.index && s.lastInput?.at!==lastAt,child);
  assert.equal(physical.lastInput.code,'unavailable');
  const hidEvents=await readFile(hidLog,'utf8'); assert.match(hidEvents,/down:true/); assert.match(hidEvents,/up:true/);
  await delay(250);
  assert.equal(connections,0,'network-disabled mode must not connect even to loopback fixture');
  assert.equal(await readFile(marker,'utf8').catch(error=>error.code==='ENOENT'?'':Promise.reject(error)),'','outbound fetch was attempted');
});
