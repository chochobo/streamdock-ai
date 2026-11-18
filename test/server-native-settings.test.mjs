import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('native settings and provider APIs require the launch token and preserve reviewed state', { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-native-api-'));
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await writeFile(path.join(home, '.codex', 'hooks.json'), JSON.stringify({
    hidden: 'not-returned-as-diagnostics', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'python3 /x/codex-hook.py' }] }] },
  }));
  const token = 'a'.repeat(64), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOME: home, PORT: String(port), STREAMDOCK_NATIVE_TOKEN: token,
    STREAMDOCK_USAGE_DISABLED: '1', STREAMDOCK_PRESENCE_DISABLED: '1', STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1' };
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {}); child.kill('SIGTERM');
      let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(home, { recursive: true, force: true });
  });
  const deadline = Date.now() + 12000;
  let status;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error('isolated server stopped');
    try { const r = await fetch(`${base}/api/status`, { headers: { 'X-StreamDock-Native-Token': token } }); if (r.ok) { status = await r.json(); if (status.deck) break; } } catch { /* Starting. */ }
    await delay(50);
  }
  assert.ok(status?.deck, 'server did not become ready');
  assert.equal(status.deck.sideFrames?.length, 3);
  assert.deepEqual(status.deck.sideFrames.map(x => x.slot), [16, 17, 18]);
  assert.ok(status.deck.sideFrames.every(x => x.url.startsWith('data:image/png;base64,') && x.url.length < 180000));
  assert.ok(status.summary && !JSON.stringify(status).includes(token));
  assert.equal(status.deck.keyFrames?.length, 15);
  assert.deepEqual(status.deck.keyFrames.map(x => x.index), Array.from({ length: 15 }, (_, i) => i));
  assert.ok(status.deck.keyFrames.every(x => x.url.startsWith('data:image/png;base64,') && x.url.length < 180000));
  const publicStatus = await (await fetch(`${base}/api/status`)).json();
  assert.equal(publicStatus.summary, undefined);
  assert.equal(publicStatus.deck.sideFrames, undefined);
  assert.equal(publicStatus.deck.keyFrames, undefined);
  const publicRefresh = await (await fetch(`${base}/api/refresh`, { method: 'POST', headers: { Origin: base } })).json();
  assert.equal(publicRefresh.summary, undefined);
  assert.equal(publicRefresh.deck.keyFrames, undefined);
  const auth = { 'X-StreamDock-Native-Token': token };
  const get = route => fetch(`${base}${route}`, { headers: auth });
  const post = (route, value, headers = {}) => fetch(`${base}${route}`, { method: 'POST',
    headers: { ...auth, Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  assert.equal((await fetch(`${base}/api/native/identity`)).status, 403);
  assert.equal((await fetch(`${base}/api/native/settings`, { headers: { 'X-StreamDock-Native-Token': 'b'.repeat(64) } })).status, 403);
  assert.deepEqual(await (await get('/api/native/identity')).json(), { application: 'streamdock-ai', protocol: 1 });
  const diagnostics = await (await get('/api/native/diagnostics')).json();
  assert.equal(diagnostics.codex.registration, 'partial');
  assert.equal(diagnostics.codex.trust, 'unknown');
  assert.ok(!JSON.stringify(diagnostics).includes('not-returned-as-diagnostics'));
  assert.equal((await post('/api/native/settings', { language: 'en' }, { Origin: 'http://evil.invalid' })).status, 403);
  assert.equal(status.settingsError, null);
  const outOfRange = await post('/api/native/settings', { brightness: 101, language: 'en' });
  assert.equal(outOfRange.status, 400);
  assert.deepEqual(await outOfRange.json(), { error: 'Invalid settings', code: 'settings_invalid_value', field: 'brightness',
    allowed: { type: 'integer', min: 0, max: 100, nullable: true }, message: 'brightness 값은 null 또는 0에서 100 사이의 정수여야 합니다.' });
  const readonly = await post('/api/native/settings', { version: 1 });
  assert.equal(readonly.status, 400);
  assert.equal((await readonly.json()).code, 'settings_readonly_field');
  const unknown = await (await post('/api/native/settings', { secretValue123: 'raw-user-value' })).json();
  assert.equal(unknown.code, 'settings_unknown_field');
  assert.ok(!JSON.stringify(unknown).includes('raw-user-value'));
  const badJson = await fetch(`${base}/api/native/settings`, { method: 'POST', headers: { ...auth, Origin: base, 'Content-Type': 'application/json' }, body: '{' });
  assert.deepEqual(await badJson.json(), { error: 'Invalid settings' });
  assert.equal((await (await get('/api/native/settings')).json()).settings.language, 'ko');
  const settingsPath = path.join(home, '.config', 'streamdock-ai', 'settings.json');
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, 'invalid');
  const partial = await post('/api/native/settings', { language: 'en', brightness: 41 });
  assert.equal(partial.status, 409);
  assert.equal((await partial.json()).code, 'brightness_applied_not_saved');
  assert.equal(await readFile(settingsPath, 'utf8'), 'invalid');
  assert.equal((await (await get('/api/native/settings')).json()).settings.language, 'ko');
  await unlink(settingsPath);
  const saved = await post('/api/native/settings', { language: 'en', brightness: 42, sound: { enabled: true }, screensaver: { enabled: false, idleMinutes: 5, scene: 'rain' } });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).settings.brightness, 42);
  const onDisk = JSON.parse(await readFile(path.join(home, '.config', 'streamdock-ai', 'settings.json'), 'utf8'));
  assert.equal(onDisk.language, 'en'); assert.equal(onDisk.screensaver.scene, 'rain');
  await writeFile(settingsPath, 'invalid-again');
  const rolledBack = await post('/api/native/settings', { brightness: 43 });
  assert.equal(rolledBack.status, 409);
  const rolledBackBody = await rolledBack.json();
  assert.equal(rolledBackBody.code, 'settings_not_saved');
  assert.equal(rolledBackBody.settingsError.code, 'settings_invalid_json');
  assert.ok(!JSON.stringify(rolledBackBody).includes(home));
  assert.equal(await readFile(settingsPath, 'utf8'), 'invalid-again');
  const afterRollback = await (await fetch(`${base}/api/refresh`, { method: 'POST', headers: { Origin: base } })).json();
  assert.equal(afterRollback.device.requestedBrightness, 42);
  await writeFile(settingsPath, JSON.stringify(onDisk));
  const provider = await (await get('/api/native/providers/market')).json();
  assert.equal(provider.status, 'unconfigured');
  assert.equal((await fetch(`${base}/api/native/providers/market`)).status, 403);
  assert.equal((await post('/api/native/providers/market', { revision: provider.revision, patch: { portfolio: ['005930'] } })).status, 200);
  assert.equal((await post('/api/native/providers/market', { revision: provider.revision, patch: { portfolio: ['000660'] } })).status, 409);
});

test('usage reports a sanitized Claude Desktop accessibility issue', { timeout: 15000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-native-usage-'));
  const codex = path.join(home, 'codex.mjs');
  const claude = path.join(home, 'claude.mjs');
  const desktop = path.join(home, 'desktop.mjs');
  const loader = path.join(home, 'loader.mjs');
  await writeFile(codex, `export function createCodexUsageProvider(){return {read:async()=>({accounts:[],warnings:[]})}}`);
  await writeFile(claude, `export async function readClaudeUsage(){return {accounts:[],warnings:[]}}`);
  await writeFile(desktop, `export function createClaudeDesktopUsageProvider(){return {read:async()=>({accounts:[],warnings:['permission'],issues:[{provider:'claude-desktop',code:'permission_required',private:'must-not-leak'}]})}}`);
  const replacements = Object.fromEntries([['./usage-codex.mjs',codex],['./usage-claude.mjs',claude],['./usage-claude-desktop.mjs',desktop]].map(([key,value])=>[key,pathToFileURL(value).href]));
  await writeFile(loader, `const replacements=${JSON.stringify(replacements)};export async function resolve(s,c,n){if(c.parentURL?.endsWith('/src/server.mjs')&&replacements[s])return {url:replacements[s],shortCircuit:true};return n(s,c)}`);
  const port=await freePort(), base=`http://127.0.0.1:${port}`;
  const env={...process.env,HOME:home,PORT:String(port),STREAMDOCK_PRESENCE_DISABLED:'1',STREAMDOCK_FEATURE_NETWORK_DISABLED:'1'};
  delete env.STREAMDOCK_USAGE_DISABLED; delete env.STREAMDOCK_DESKTOP_USAGE_DISABLED;
  const child=spawn(process.execPath,['--no-warnings','--experimental-loader',loader,'src/server.mjs'],{cwd:root,env,stdio:'ignore'});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit').catch(()=>{});child.kill('SIGTERM');let timer;await Promise.race([done,new Promise(r=>{timer=setTimeout(r,3000)})]);clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}await rm(home,{recursive:true,force:true})});
  const deadline=Date.now()+12000; let status;
  while(Date.now()<deadline){if(child.exitCode!==null||child.signalCode!==null)throw Error('isolated server stopped');try{const response=await fetch(`${base}/api/status`);if(response.ok){status=await response.json();if(status.usage?.issues?.length)break}}catch{}await delay(50)}
  assert.deepEqual(status?.usage?.issues,[{provider:'claude-desktop',code:'permission_required'}]);
  assert.ok(!JSON.stringify(status).includes('must-not-leak'));
});

test('status exposes a sanitized settings error when the settings file is invalid', { timeout: 15000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-settings-error-'));
  const settingsPath = path.join(home, '.config', 'streamdock-ai', 'settings.json');
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ version: 1, language: 'ko', sound: { enabled: false }, brightness: 250, screensaver: { enabled: true, idleMinutes: 5, scene: 'rain' } }));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOME: home, PORT: String(port), STREAMDOCK_USAGE_DISABLED: '1', STREAMDOCK_PRESENCE_DISABLED: '1', STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1' };
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {}); child.kill('SIGTERM');
      let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(home, { recursive: true, force: true });
  });
  const deadline = Date.now() + 12000;
  let status;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error('isolated server stopped');
    try { const r = await fetch(`${base}/api/status`); if (r.ok) { status = await r.json(); if (status.deck) break; } } catch { /* Starting. */ }
    await delay(50);
  }
  assert.deepEqual(status?.settingsError, { code: 'settings_invalid_value', field: 'brightness',
    allowed: { type: 'integer', min: 0, max: 100, nullable: true }, message: 'brightness 값은 null 또는 0에서 100 사이의 정수여야 합니다.' });
  assert.ok(status.warnings.includes('설정을 읽지 못했습니다.'));
  assert.ok(!JSON.stringify(status.settingsError).includes(home));
  assert.ok(!JSON.stringify(status.settingsError).includes('250'));
});
