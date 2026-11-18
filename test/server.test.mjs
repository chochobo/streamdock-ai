import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function ready(base, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}`);
    try { const response = await fetch(`${base}/api/status`); if (response.ok) return await response.json(); } catch { /* Starting */ }
    await delay(50);
  }
  throw new Error('Test server did not start');
}
async function post(base, payload, origin = base) {
  for (let i = 0; i < 30; i++) {
    const response = await fetch(`${base}/api/press`, { method:'POST', headers:{ origin, 'content-type':'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (data.code !== 'busy') return { status:response.status, data };
    await delay(50);
  }
  throw new Error('Test server remained busy');
}

test('isolated simulator navigates projects, rejects stale input, and keeps targets private', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-server-test-'));
  const targetPath = path.join(home, 'private-project-dir');
  const hooks = path.join(home, '.cache', 'streamdock-ai', 'agents');
  await mkdir(targetPath, {recursive:true});
  await mkdir(hooks, {recursive:true});
  const privateSession = 'private-session-id-293s-integration';
  const privateTty = '/dev/ttys987';
  await writeFile(path.join(hooks,'fixture.json'), JSON.stringify({
    id:'safe-opaque-fixture', agent:'claude-code', status:'blocked', project:'fixture-project', cwd:targetPath,
    session:privateSession, tty:privateTty, pid:987654, processStart:'PRIVATE-PROCESS-START',
    bundle:'test.unsupported.bundle', updated:Date.now()/1000,
  }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.mjs'], {cwd:root, env:{...process.env, HOME:home, PORT:String(port), STREAMDOCK_USAGE_DISABLED:'1', STREAMDOCK_PRESENCE_DISABLED:'1', STREAMDOCK_FEATURE_NETWORK_DISABLED:'1'}, stdio:'ignore'});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {});
      child.kill('SIGTERM');
      let timeout;
      await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(resolve, 2000); })]);
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(home,{recursive:true,force:true});
  });

  let state = await ready(base,child);
  assert.equal(state.device.mode,'simulator');
  assert.equal(state.deck.view,'projects');
  assert.equal(state.agents.length,1);
  assert.equal(state.deck.scope,'live');
  assert.notEqual(state.deck.keys[0].label,'fixture-project');
  const homeRevision = state.deck.revision;
  const hub = await post(base,{index:11,revision:homeRevision});
  assert.equal(hub.status,200);
  state = await (await fetch(`${base}/api/status`)).json();
  assert.equal(state.deck.view,'hub');
  assert.notEqual(state.deck.revision, homeRevision);
  const oldHubPress = await post(base,{index:2,revision:homeRevision});
  assert.equal(oldHubPress.status,409);
  assert.equal(oldHubPress.data.code,'stale');
  const timerKey = state.deck.keys.find(key => key.label === '타이머' && key.action === 'open_mode');
  assert.ok(timerKey);
  assert.equal((await post(base,{index:timerKey.index,revision:state.deck.revision})).status,200);
  state = await (await fetch(`${base}/api/status`)).json();
  assert.equal(state.deck.mode,'pomodoro');
  const startTimer = state.deck.keys.find(key => key.label === '5분' && key.action === 'feature_action');
  assert.ok(startTimer);
  assert.equal((await post(base,{index:startTimer.index,revision:state.deck.revision})).status,200);
  state = await (await fetch(`${base}/api/status`)).json();
  assert.equal(state.deck.keys.find(key => key.label === '남은 시간')?.state,'working');
  assert.equal((await post(base,{index:12,revision:state.deck.revision})).status,200);
  state = await (await fetch(`${base}/api/status`)).json();
  assert.equal(state.deck.view,'hub');
  const historyKey = state.deck.keys.find(key => key.label === '기록' && key.action === 'open_mode');
  assert.ok(historyKey);
  const history = await post(base,{index:historyKey.index,revision:state.deck.revision});
  assert.equal(history.status,200);
  state = await (await fetch(`${base}/api/status`)).json();
  assert.equal(state.deck.scope,'history');
  assert.equal(state.deck.keys[0].label,'fixture-project');
  const publicText = JSON.stringify(state);
  for (const secret of [privateSession,privateTty,targetPath,'PRIVATE-PROCESS-START','test.unsupported.bundle']) assert.equal(publicText.includes(secret),false,`public API leaked ${secret}`);
  assert.equal(Object.hasOwn(state,'targets'),false);
  // An isolated test must never connect to a real account or start Codex app-server.
  assert.equal(state.usage.updatedAt, null);
  assert.ok(state.usage.accounts.every(account => account.status === 'unavailable'));
  const quotaDenied = await fetch(`${base}/api/usage/refresh`, { method:'POST', headers:{origin:'http://evil.invalid'} });
  assert.equal(quotaDenied.status, 403);
  const quota = await fetch(`${base}/api/usage/refresh`, { method:'POST', headers:{origin:base} });
  assert.equal(quota.status, 200);
  const quotaResult = await quota.json();
  assert.equal(quotaResult.ok, true);
  assert.equal(quotaResult.usage.updatedAt, null);
  assert.ok(quotaResult.usage.accounts.every(account => account.status === 'unavailable'));
  assert.equal(JSON.stringify(quotaResult).includes(privateSession), false);

  const denied = await post(base,{index:0,revision:state.deck.revision},'http://evil.invalid');
  assert.equal(denied.status,403);
  const oldRevision = state.deck.revision;
  const open = await post(base,{index:0,revision:oldRevision});
  assert.equal(open.status,200);
  assert.equal(open.data.code,'navigated');
  state = await (await fetch(`${base}/api/status`)).json();
  assert.equal(state.deck.view,'sessions');
  assert.equal(state.deck.project.name,'fixture-project');
  assert.notEqual(state.deck.revision,oldRevision);

  const stale = await post(base,{index:0,revision:oldRevision});
  assert.equal(stale.status,409);
  assert.equal(stale.data.code,'stale');
  const focus = await post(base,{index:0,revision:state.deck.revision});
  assert.equal(focus.status,409);
  assert.equal(focus.data.ok,false);
  assert.equal(focus.data.code,process.platform === 'darwin' ? 'unsupported_origin' : 'unsupported_platform');
  state = await (await fetch(`${base}/api/status`)).json();
  assert.equal(state.deck.view,'sessions');
  assert.ok(state.deck.message);
  const back = await post(base,{index:12,revision:state.deck.revision});
  assert.equal(back.status,200);
  assert.equal(back.data.code,'navigated');
  state = await (await fetch(`${base}/api/status`)).json();
  assert.equal(state.deck.view,'projects');
  assert.equal(state.deck.scope,'history');
  const historyRevision = state.deck.revision;
  assert.equal((await post(base,{index:11,revision:historyRevision})).status,200);
  state = await (await fetch(`${base}/api/status`)).json();
  assert.equal(state.deck.scope,'live');
  const liveRevision = state.deck.revision;
  assert.equal((await post(base,{index:11,revision:liveRevision})).status,200);
  state = await (await fetch(`${base}/api/status`)).json();
  assert.equal(state.deck.view,'hub');
  assert.notEqual(state.deck.revision,liveRevision);
  assert.equal((await post(base,{index:12,revision:state.deck.revision})).status,200);
  state = await (await fetch(`${base}/api/status`)).json();
  assert.equal(state.deck.view,'projects');
  assert.equal(state.deck.scope,'live');
  assert.equal((await post(base,{index:11,revision:historyRevision})).data.code,'stale');
});

test('manual quota refresh is throttled and uses only the fixture provider', { skip: process.platform === 'win32' }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-usage-server-'));
  const bin = path.join(home, 'bin');
  const counter = path.join(home, 'provider-starts');
  await mkdir(bin, { recursive: true });
  const fake = path.join(bin, 'codex');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(process.env.STREAMDOCK_FAKE_COUNTER, 'start\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  let result;
  if (msg.id === 0) result = {};
  if (msg.id === 1) result = { account: { type: 'chatgpt' } };
  if (msg.id === 2) result = { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 2000000000 } } };
  if (result) process.stdout.write(JSON.stringify({ id: msg.id, result }) + '\\n');
});
`;
  await writeFile(fake, script, { mode: 0o700 });
  await chmod(fake, 0o700);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root,
    env: { ...process.env, HOME: home, PORT: String(port), STREAMDOCK_USAGE_DISABLED: '0', STREAMDOCK_PRESENCE_DISABLED: '1', STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1',
      STREAMDOCK_FAKE_COUNTER: counter, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {});
      child.kill('SIGTERM');
      let timeout;
      await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(resolve, 2000); })]);
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(home, { recursive: true, force: true });
  });
  let state = await ready(base, child);
  for (let i = 0; i < 100 && !state.usage?.updatedAt; i++) {
    await delay(30);
    state = await (await fetch(`${base}/api/status`)).json();
  }
  assert.ok(state.usage.updatedAt, 'fixture provider was not collected');
  assert.equal(state.usage.accounts.find(account => account.provider === 'codex')?.status, 'ok');
  const before = state.usage.updatedAt;
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${base}/api/usage/refresh`, { method:'POST', headers:{origin:base} });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).usage.updatedAt, before);
  }
  assert.equal((await readFile(counter, 'utf8')).trim().split('\\n').length, 1, 'manual refresh should reuse the recent provider result');
});
