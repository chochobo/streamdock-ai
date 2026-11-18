import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSwiftHID, createNativeDevice } from '../src/native-hid.mjs';
import { commandPacket } from '../src/device.mjs';
const fixture = path.resolve('native/HID/Tests/fixtures/hid-mock.cjs');
const make = (mode, timeoutMs=5000) => createSwiftHID({executable:process.execPath,args:[fixture,mode],timeoutMs});
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function open(mode, timeout) { const hid=make(mode,timeout);const entries=await hid.devicesAsync();const handle=new hid.HID(entries[0].path);handle.on('error',()=>{});return handle; }

test('Swift bridge awaits physical write acknowledgement and rejects malformed packets', async () => {
  const handle=await open('delay');try {
    let complete=false;const write=handle.writePacket(commandPacket([1])).then(()=>{complete=true});
    await pause(20);assert.equal(complete,false,'write completed before ACK');await write;assert.equal(complete,true);
    await assert.rejects(handle.writePacket(Buffer.alloc(1024)),/Invalid/);
  } finally { handle.close(); }
});
test('Swift bridge translates input events and preserves press/release order',async()=>{
  const handle=await open('key');try {const received=[];handle.on('data',x=>received.push([x[9],x[10]]));await handle.writePacket(commandPacket([1]));assert.deepEqual(received,[[13,1],[13,0]]);} finally {handle.close()}
});
test('Swift bridge rejects write errors, wrong acknowledgements, timeouts, and helper exit',async t=>{
  // A real helper process can take more than 150 ms to start under load. Use
  // the production timeout for startup rather than racing the scheduler.
  for (const [mode,pattern] of [['error',/failure|failed/i],['wrong-id',/acknowledgement/i],['exit',/exited/i]]) {
    const handle=await open(mode,5000);try {await assert.rejects(handle.writePacket(commandPacket([1])),pattern);} finally {handle.close()}
  }
  // Advance the parent timer only after the real silent helper is ready. This
  // checks the actual write-timeout path without coupling it to process startup.
  const handle=await open('timeout',5000);
  try {
    t.mock.timers.enable({apis:['setTimeout']});
    const rejected=assert.rejects(handle.writePacket(commandPacket([1])),/timed out/i);
    t.mock.timers.tick(5000);
    await rejected;
  } finally {
    t.mock.timers.reset();
    handle.close();
  }
});
test('closing Swift bridge rejects an in-flight write without reporting success',async()=>{
  const handle=await open('timeout',5000);const pending=handle.writePacket(commandPacket([1]));handle.close();await assert.rejects(pending,/closed/);
});
test('device start waits for helper ACK and fails closed on helper errors',async()=>{
  const device=createNativeDevice({mode:'hardware',helperPath:process.execPath,helperArgs:[fixture,'error'],helperTimeoutMs:5000,dependencies:{skipInitialBlank:true,officialAppRunning:async()=>false}});
  await device.start();assert.equal(device.status().connected,false);assert.match(device.status().error,/failure|failed/i);await device.stop();
});
test('device waits for all image acknowledgements before committing and serializes brightness',async()=>{
  const device=createNativeDevice({mode:'hardware',helperPath:process.execPath,helperArgs:[fixture,'delay'],helperTimeoutMs:5000,dependencies:{skipInitialBlank:true,officialAppRunning:async()=>false,renderSummaryTiles:async()=>[16,17,18].map(slot=>({slot,jpeg:Buffer.from([1,2,3])}))}});
  await device.start();assert.equal(device.status().connected,true);let rendered=false,changed=false;
  const frame=device.renderSummary({}).then(value=>{rendered=value});
  const brightness=device.setBrightness(50).then(value=>{changed=value});
  await pause(50);assert.equal(rendered,false);assert.equal(changed,false);
  await frame;assert.equal(rendered,true);await brightness;assert.equal(changed,true);await device.stop();
});
test('image write failure cannot report a successful frame',async()=>{
  const device=createNativeDevice({mode:'hardware',helperPath:process.execPath,helperArgs:[fixture,'after-two-error'],helperTimeoutMs:5000,dependencies:{skipInitialBlank:true,officialAppRunning:async()=>false,renderSummaryTiles:async()=>[16,17,18].map(slot=>({slot,jpeg:Buffer.from([1,2,3])}))}});
  await device.start();assert.equal(device.status().connected,true);assert.equal(await device.renderSummary({}),false);assert.equal(device.status().connected,false);await device.stop();
});
test('helper key bursts during rendering deliver only one down/up per physical press',async()=>{
  const events=[];
  const device=createNativeDevice({mode:'hardware',helperPath:process.execPath,helperArgs:[fixture,'keyburst'],helperTimeoutMs:5000,onKeyEvent:(index,phase)=>events.push([index,phase]),dependencies:{skipInitialBlank:true,officialAppRunning:async()=>false,renderSummaryTiles:async()=>[16,17,18].map(slot=>({slot,jpeg:Buffer.from([1,2,3])}))}});
  await device.start();events.length=0;assert.equal(await device.renderSummary({}),true);
  assert.equal(events.length,18);for(let i=0;i<events.length;i+=2)assert.deepEqual(events.slice(i,i+2),[[0,'down'],[0,'up']]);await device.stop();
});
test('late helper input after close is ignored',async()=>{
  const handle=await open('delayed-key',5000), events=[];handle.on('data',data=>events.push(data));const pending=handle.writePacket(commandPacket([1]));handle.close();await assert.rejects(pending,/closed/);await pause(120);assert.deepEqual(events,[]);
});
test('simulator cannot claim a hardware connection without explicit test-only opt in',async()=>{
  const hid=make('simulate');await assert.rejects(hid.devicesAsync(),/simulator/i);
  const simulated=createSwiftHID({executable:process.execPath,args:[fixture,'simulate'],timeoutMs:500,allowSimulation:true});
  const entries=await simulated.devicesAsync();const handle=new simulated.HID(entries[0].path);handle.on('error',()=>{});await handle.writePacket(commandPacket([1]));handle.close();
});
test('device acknowledgement is recorded separately from transport write success',async()=>{
  const device=createNativeDevice({mode:'hardware',helperPath:process.execPath,helperArgs:[fixture,'ack'],helperTimeoutMs:5000,dependencies:{skipInitialBlank:true,officialAppRunning:async()=>false}});
  await device.start();assert.equal(device.status().connected,true);assert.ok(Number.isFinite(Date.parse(device.status().lastDeviceAcknowledgementAt)));await device.stop();
});
test('native device starts once under concurrent calls and can reconnect after stop',async()=>{
  const device=createNativeDevice({mode:'hardware',helperPath:process.execPath,helperArgs:[fixture,'success'],helperTimeoutMs:5000,dependencies:{skipInitialBlank:true,officialAppRunning:async()=>false}});
  await Promise.all([device.start(),device.start(),device.start()]);assert.equal(device.status().connected,true);
  await device.stop();assert.equal(device.status().connected,false);
  await device.start();assert.equal(device.status().connected,true);await device.stop();
});
test('native device starts a new helper after an unexpected exit',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const os=await import('node:os');const home=await mkdtemp(path.join(os.tmpdir(),'streamdock-hid-reconnect-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const device=createNativeDevice({mode:'hardware',helperPath:process.execPath,helperArgs:[fixture,'restart',path.join(home,'marker')],helperTimeoutMs:5000,dependencies:{skipInitialBlank:true,officialAppRunning:async()=>false}});
  await device.start();assert.equal(device.status().connected,false);
  await device.start();assert.equal(device.status().connected,true);await device.stop();
});
test('reconnect after failed render starts a new helper and repaints frames',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const os=await import('node:os');const home=await mkdtemp(path.join(os.tmpdir(),'streamdock-hid-render-reconnect-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const device=createNativeDevice({mode:'hardware',helperPath:process.execPath,helperArgs:[fixture,'after-two-restart',path.join(home,'marker')],helperTimeoutMs:5000,dependencies:{skipInitialBlank:true,officialAppRunning:async()=>false,renderSummaryTiles:async()=>[16,17,18].map(slot=>({slot,jpeg:Buffer.from([1,2,3])}))}});
  await device.start();assert.equal(device.status().connected,true);assert.equal(await device.renderSummary({}),false);assert.equal(device.status().connected,false);
  await device.start();assert.equal(device.status().connected,true);assert.equal(await device.renderSummary({}),true);await device.stop();
});
test('Swift clear acknowledgement failure prevents connection and a new helper can retry',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const os=await import('node:os');const home=await mkdtemp(path.join(os.tmpdir(),'streamdock-hid-clear-reconnect-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const device=createNativeDevice({mode:'hardware',helperPath:process.execPath,helperArgs:[fixture,'after-two-restart',path.join(home,'marker')],helperTimeoutMs:5000,dependencies:{officialAppRunning:async()=>false,renderSummaryTiles:async()=>[16,17,18].map(slot=>({slot,jpeg:Buffer.from([1,2,3])}))}});
  await device.start();assert.equal(device.status().connected,false);assert.match(device.status().error,/failure|failed/i);
  await device.start();assert.equal(device.status().connected,true);assert.equal(await device.renderSummary({}),true);await device.stop();
});
