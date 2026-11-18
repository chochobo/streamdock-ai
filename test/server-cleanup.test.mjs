import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}
async function status(base, predicate, child, timeout = 12000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Test server exited early');
    try { const response = await fetch(`${base}/api/status`); if (response.ok) { const state = await response.json(); if (predicate(state)) return state; } } catch { /* Starting or updating. */ }
    await delay(60);
  }
  throw new Error('Expected isolated test state not observed');
}
async function press(base, index, revision) {
  for (let i = 0; i < 100; i++) {
    const response = await fetch(`${base}/api/press`, {method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({index,revision})});
    const result = await response.json();
    if (result.code !== 'busy') return { status:response.status, result };
    await delay(60);
  }
  throw new Error('Test server remained busy');
}
async function review(base, body, origin) {
  const headers = { 'content-type':'application/json' };
  if (origin !== null) headers.origin = origin;
  const response = await fetch(`${base}/api/review`, {method:'POST',headers,body:JSON.stringify(body)});
  return {status:response.status,result:await response.json()};
}

test('isolated cleanup review cannot delete, approve a forged plan, or expose confirmation tokens', {timeout:30000}, async t => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('Cleanup rejects root-owned runtime; test must run as a regular user.');
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(),'streamdock-cleanup-e2e-')));
  const trash = path.join(home,'.Trash'); await mkdir(trash,{mode:0o700});
  const target = path.join(trash,'disposable-target.txt');
  const unrelated = path.join(home,'unrelated.txt');
  await writeFile(target,'disposable trash only'); await writeFile(unrelated,'must remain');
  const bin = path.join(home, 'bin'); await mkdir(bin);
  const fakeMole = path.join(bin, 'mo'); await writeFile(fakeMole, '#!/bin/sh\nprintf \'{"health_score":80,"thermal":{}}\\n\'\n'); await chmod(fakeMole, 0o700);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOME:home, PATH:`${bin}${path.delimiter}${process.env.PATH || ''}`, PORT:String(port), STREAMDOCK_USAGE_DISABLED:'1', STREAMDOCK_PRESENCE_DISABLED:'1', STREAMDOCK_DESKTOP_USAGE_DISABLED:'1', STREAMDOCK_FEATURE_NETWORK_DISABLED:'1' };
  const child = spawn(process.execPath,['src/server.mjs'],{cwd:root,env,stdio:'ignore'});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child,'exit').catch(() => {}); child.kill('SIGTERM');
      let timer; await Promise.race([exited,new Promise(resolve => {timer=setTimeout(resolve,3000);})]); clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(home,{recursive:true,force:true});
  });
  let state = await status(base,s=>s.deck?.view==='projects',child);
  const hub = state.deck.keys.find(k=>k.action==='modes'); assert.ok(hub,'feature hub must be reachable');
  assert.equal((await press(base,hub.index,state.deck.revision)).status,200);
  state = await status(base,s=>s.deck?.view==='hub',child);
  const machine = state.deck.keys.find(k=>k.action==='open_mode'&&k.label==='머신'); assert.ok(machine);
  assert.equal((await press(base,machine.index,state.deck.revision)).status,200);
  state = await status(base,s=>s.deck?.view==='feature'&&s.deck?.mode==='machines',child);
  let trashKey = state.deck.keys.find(k=>k.action==='feature_action'&&k.label==='휴지통');
  if (!trashKey) {
    state = await status(base,s=>s.deck?.mode==='machines'&&s.deck.keys.some(k=>k.action==='feature_action'&&k.label==='휴지통'),child);
    trashKey = state.deck.keys.find(k=>k.action==='feature_action'&&k.label==='휴지통');
  }
  assert.ok(trashKey);
  const started = await press(base,trashKey.index,state.deck.revision); assert.equal(started.status,200);
  state = await status(base,s=>s.cleanup && s.cleanup.stage!=='loading',child);
  assert.equal(state.cleanup.stage,'review');
  assert.ok(state.cleanup.plan);
  assert.equal(state.cleanup.plan.executable,false);
  assert.equal(state.cleanup.reviewed,false);
  assert.equal(state.cleanup.plan.count,1);
  assert.equal(state.cleanup.plan.complete,true);
  assert.deepEqual(state.cleanup.plan.targets.map(x=>x.path),[target]);
  assert.ok(Array.isArray(state.cleanup.plan.reasons) && state.cleanup.plan.reasons.length);
  assert.ok(!/"token"\s*:/.test(JSON.stringify(state.cleanup)));
  assert.ok(!state.deck.keys.some(k=>k.action==='feature_action'&&['검토 확인','영구 삭제'].includes(k.label)),'confirm must not be exposed');
  const revision = state.deck.revision;
  const body = {kind:'cleanup',revision,reviewId:'a'.repeat(48)};
  assert.equal((await review(base,body,null)).status,403);
  assert.equal((await review(base,{...body,revision:revision+1},base)).status,409);
  assert.equal((await review(base,body,base)).status,409);
  assert.equal(await readFile(target,'utf8'),'disposable trash only');
  assert.equal(await readFile(unrelated,'utf8'),'must remain');
});
