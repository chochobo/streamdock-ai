import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const pause = ms => new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('explicit Swift HID helper owns the simulated device without loading node-hid', {timeout:15000}, async t=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'streamdock-hid-integration-'));
  const helper=path.join(home,'helper.cjs'),childModule=path.join(home,'child.mjs'),badHid=path.join(home,'hid.mjs'),loader=path.join(home,'loader.mjs');
  await writeFile(helper,`#!/usr/bin/env node\nconst readline=require('node:readline'); const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');out({event:'ready',simulated:false,vendorId:0x6603,productId:0x1014});readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);out({id:x.id,ok:true})});\n`,{mode:0o700});await chmod(helper,0o700);
  await writeFile(childModule,`export * from 'node:child_process';export function execFile(file,args,options,callback){const cb=typeof options==='function'?options:callback;const error=Object.assign(new Error('not running'),{code:1});process.nextTick(()=>cb(error,'',''));return {kill(){}}}`);
  await writeFile(badHid,`export async function devicesAsync(){throw Error('node-hid must not load')};export class HID{constructor(){throw Error('node-hid must not open')}}`);
  await writeFile(loader,`const child=${JSON.stringify(pathToFileURL(childModule).href)},hid=${JSON.stringify(pathToFileURL(badHid).href)};export async function resolve(s,c,n){if(s==='node:child_process'&&c.parentURL?.endsWith('/src/device.mjs'))return {url:child,shortCircuit:true};if(s==='node-hid')return {url:hid,shortCircuit:true};return n(s,c)}`);
  const port=await freePort(),base=`http://127.0.0.1:${port}`;
  const env={...process.env,HOME:home,PORT:String(port),STREAMDOCK_SWIFT_HID_PATH:helper,STREAMDOCK_USAGE_DISABLED:'1',STREAMDOCK_PRESENCE_DISABLED:'1',STREAMDOCK_DESKTOP_USAGE_DISABLED:'1',STREAMDOCK_FEATURE_NETWORK_DISABLED:'1'};
  const child=spawn(process.execPath,['--no-warnings','--experimental-loader',loader,'src/server.mjs','--device'],{cwd:process.cwd(),env,stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.on('data',x=>{if(errors.length<10000)errors+=x.toString()});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit').catch(()=>{});child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}await rm(home,{recursive:true,force:true})});
  let state;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(`server stopped: ${errors}`);try{const r=await fetch(`${base}/api/status`);state=await r.json();if(state.device?.connected&&state.deck?.view==='projects')break}catch{}await pause(80)}
  assert.equal(state?.device?.connected,true,errors);assert.equal(state.device.mode,'hardware');assert.equal(state.deck.view,'projects');
});
