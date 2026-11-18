import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function status(base) {
  const response = await fetch(`${base}/api/status`, { headers: { 'X-StreamDock-Native-Token': 'a'.repeat(64) }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
}

async function ready(base, child) {
  for (let index = 0; index < 120; index++) {
    if (child.exitCode !== null) throw new Error('Test server exited during startup');
    try { return await status(base); } catch { await delay(50); }
  }
  throw new Error('Test server did not start');
}

async function press(base, findKey) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const before = await status(base);
    const key = findKey(before.deck);
    assert.ok(key, 'expected key is not displayed');
    const response = await fetch(`${base}/api/press`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: key.index, revision: before.deck.revision }), signal: AbortSignal.timeout(15000) });
    const value = await response.json();
    if (value.code === 'busy' || value.code === 'stale') { await delay(60); continue; }
    assert.equal(value.ok, true, value.message || value.code);
    return { before, value, after: await status(base) };
  }
  throw new Error('Feature input remained busy');
}

function requirePillow(t) {
  const check = spawnSync('python3', ['-c', 'import PIL; print(PIL.__file__)'], { encoding: 'utf8', timeout: 5000 });
  if (check.error?.code === 'ENOENT' || /No module named ['"]PIL['"]/.test(check.stderr || '')) {
    t.skip('Python 3 or Pillow is not installed');
    return null;
  }
  if (check.error || check.status !== 0) throw check.error || new Error('Pillow availability check failed');
  return path.dirname(path.dirname(check.stdout.trim()));
}

function liveChildren(pid) {
  const check = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 3000 });
  if (check.error) throw check.error;
  if (check.status !== 0 && check.status !== 1) throw new Error('Could not inspect test worker processes');
  return (check.stdout || '').trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger);
}

test('simulator routes physical-style game and scene inputs without contacting real services', { timeout: 45_000 }, async t => {
  const pillow = requirePillow(t);
  if (!pillow) return;
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-features-'));
  const codexDir = path.join(home, '.codex');
  await mkdir(codexDir, { recursive: true });
  const sentinel = 'fixture-private-token-never-display-293s';
  await writeFile(path.join(codexDir, 'auth.json'), JSON.stringify({ token: sentinel }), { mode: 0o600 });
  const mockBin = path.join(home, 'bin');
  await mkdir(mockBin, { recursive: true });
  await writeFile(path.join(mockBin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const usageDir = path.join(home, '.cache', 'streamdock-ai', 'usage');
  await mkdir(usageDir, { recursive: true });
  await writeFile(path.join(usageDir, 'claude-statusline.json'), JSON.stringify({
    provider: 'claude', source: 'claude-statusline', observedAt: new Date().toISOString(),
    sevenDay: { usedPercentage: 17, resetsAt: new Date(Date.now() + 86400_000).toISOString() },
  }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOME: home, PORT: String(port),
    PATH: [mockBin, process.env.PATH].filter(Boolean).join(path.delimiter),
    STREAMDOCK_USAGE_DISABLED: '0', STREAMDOCK_PRESENCE_DISABLED: '1',
    STREAMDOCK_DESKTOP_USAGE_DISABLED: '1', STREAMDOCK_FEATURE_NETWORK_DISABLED: '1',
    STREAMDOCK_GAME_STATE_DIR: path.join(home, 'game-data'),
    STREAMDOCK_NATIVE_TOKEN: 'a'.repeat(64),
    PYTHONPATH: [pillow, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env, stdio: 'ignore' });
  let stopped = false;
  t.after(async () => {
    if (!stopped && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {});
      child.kill('SIGTERM');
      await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(home, { recursive: true, force: true });
  });
  let state = await ready(base, child);
  for (const path of ['/', '/app.js', '/style.css']) {
    const removed = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(removed.status, 404, `legacy route ${path} must not be served`);
  }
  assert.equal(state.device.mode, 'simulator');
  assert.equal(state.device.connected, false);
  assert.equal(JSON.stringify(state).includes(sentinel), false);
  const assertSideFrames = deck => {
    assert.equal(deck.sideFrames?.length, 3);
    assert.deepEqual(deck.sideFrames.map(frame => frame.slot), [16, 17, 18]);
    assert.ok(deck.sideFrames.every(frame => frame.url.startsWith('data:image/png;base64,') && frame.url.length < 180000));
    assert.equal(deck.keyFrames?.length, 15);
    assert.ok(deck.keyFrames.every(frame => frame.url.startsWith('data:image/png;base64,') && frame.url.length < 180000));
  };
  assertSideFrames(state.deck);
  const homeRevision = state.deck.revision;
  await press(base, deck => deck.keys.find(key => key.action === 'modes'));
  state = await status(base);
  assert.equal(state.deck.view, 'hub');
  const stale = await fetch(`${base}/api/press`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: 0, revision: homeRevision }), signal: AbortSignal.timeout(5000) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'stale');

  for (let retry = 0; retry < 40; retry++) {
    state = await status(base);
    if (state.usage.accounts.some(account => account.provider === 'claude' && account.windows?.some(window => window.usedPercent === 17))) break;
    await delay(50);
  }
  assert.ok(state.usage.accounts.some(account => account.provider === 'claude' && account.windows?.some(window => window.usedPercent === 17)), 'expected isolated usage fixture');
  await press(base, deck => deck.keys.find(key => key.label === '요약' && key.action === 'open_mode'));
  await press(base, deck => deck.keys.find(key => key.id?.startsWith('summary-usage-')));
  state = await status(base);
  assert.equal(state.deck.view, 'usage');
  assert.ok(state.deck.keys.some(key => key.kind === 'quota' && key.usedPercent === 17));
  await press(base, deck => deck.keys.find(key => key.index === 12 && key.action === 'back'));
  await press(base, deck => deck.keys.find(key => key.action === 'modes'));
  await press(base, deck => deck.keys.find(key => key.label === '요약' && key.action === 'open_mode'));
  await press(base, deck => deck.keys.find(key => key.id === 'summary-working'));
  state = await status(base);
  assert.equal(state.deck.view, 'projects');
  await press(base, deck => deck.keys.find(key => key.action === 'modes'));
  await press(base, deck => deck.keys.find(key => key.label === '타이머' && key.action === 'open_mode'));
  await press(base, deck => deck.keys.find(key => key.id === 'timer-start-5'));
  state = await status(base);
  assert.ok(state.deck.keys.find(key => key.id === 'timer-start-90'), 'all ten presets should fit');
  await press(base, deck => deck.keys.find(key => key.id === 'timer-current'));
  state = await status(base);
  assert.equal(state.deck.keys.find(key => key.id === 'timer-current').state, 'idle');
  await press(base, deck => deck.keys.find(key => key.id === 'timer-current'));
  state = await status(base);
  assert.equal(state.deck.keys.find(key => key.id === 'timer-current').state, 'working');
  await press(base, deck => deck.keys.find(key => key.index === 12 && key.action === 'back'));

  await press(base, deck => deck.keys.find(key => key.label === '게임' && key.action === 'open_mode'));
  await press(base, deck => deck.keys.find(key => key.label === '두더지' && key.action === 'feature_action'));
  state = await status(base);
  assert.equal(state.deck.mode, 'games');
  assert.equal(state.deck.frames?.length, 10);
  assert.ok(state.deck.frames.every(frame => frame.url.startsWith('data:image/png;base64,')));
  assertSideFrames(state.deck);
  const gameSideFrames = state.deck.sideFrames.map(frame => frame.url);
  await press(base, deck => deck.keys.find(key => key.index === 0 && key.action === 'feature_action'));
  await press(base, deck => deck.keys.find(key => key.index === 12 && key.action === 'back'));
  state = await status(base);
  assert.equal(state.deck.view, 'hub');

  await press(base, deck => deck.keys.find(key => key.label === '장면' && key.action === 'open_mode'));
  await press(base, deck => deck.keys.find(key => key.label === '수족관' && key.action === 'feature_action'));
  state = await status(base);
  assert.equal(state.deck.mode, 'scenes');
  assert.equal(state.deck.frames?.length, 15);
  assert.ok(state.deck.frames.every(frame => frame.url.startsWith('data:image/png;base64,')));
  assertSideFrames(state.deck);
  assert.notDeepEqual(state.deck.sideFrames.map(frame => frame.url), gameSideFrames);
  await delay(700);
  state = await status(base);
  assertSideFrames(state.deck);
  assert.equal(JSON.stringify(state).includes(sentinel), false);
  const soundDir = path.join(home, '.cache', 'streamdock-ai', 'sfx');
  assert.deepEqual(await readdir(soundDir).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
  const workers = liveChildren(child.pid);
  assert.ok(workers.length >= 1, 'expected isolated worker processes');
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let shutdownTimer;
  try { await Promise.race([exited, new Promise((_, reject) => { shutdownTimer = setTimeout(() => reject(new Error('Test server did not stop')), 5000); })]); }
  finally { clearTimeout(shutdownTimer); }
  stopped = true;
  for (let retry = 0; retry < 30; retry++) {
    const alive = workers.filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } });
    if (!alive.length) return;
    await delay(100);
  }
  assert.fail('A feature worker survived server shutdown');
});
