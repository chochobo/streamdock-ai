import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonEnv } from './python-env.mjs';

const workerPath = fileURLToPath(new URL('./game-worker.py', import.meta.url));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MODES = new Set(['mole', 'simon', 'pairs', 'slot', 'bj', 'poker', 'race']);

function image(value) {
  if (typeof value !== 'string' || value.length > 670_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid game image');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < PNG.length || !bytes.subarray(0, PNG.length).equals(PNG)) throw new Error('Invalid game image');
  return bytes;
}
function safeHud(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = (v, limit = 64) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, limit) : null;
  const result = {
    title: text(value.title), phase: text(value.phase, 32), phaseLabel: text(value.phaseLabel, 32),
    primary: text(value.primary), secondary: text(value.secondary), action: text(value.action, 32),
  };
  for (const key of ['remainingSeconds','elapsedSeconds','round','position','best','matchedPairs','attempts','payout','playerTotal','dealerVisibleTotal','bet','payoutDelta']) {
    if (value[key] === null) result[key] = null;
    else if (typeof value[key] === 'number' && Number.isFinite(value[key])) result[key] = value[key];
  }
  for (const key of ['spinning','dealerHidden']) if (typeof value[key] === 'boolean') result[key] = value[key];
  for (const key of ['outcome','ownRank']) if (value[key] === null || typeof value[key] === 'string') result[key] = text(value[key], 32);
  if (Array.isArray(value.selected)) result.selected = value.selected.filter(n => Number.isInteger(n) && n >= 1 && n <= 5).slice(0, 3);
  return result;
}
function frame(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tiles) || raw.tiles.length > 15 || typeof raw.mode !== 'string' || (raw.mode !== 'menu' && !MODES.has(raw.mode))) throw new Error('Invalid game frame');
  const seen = new Set();
  const tiles = raw.tiles.map(tile => {
    if (!Number.isInteger(tile?.index) || tile.index < 0 || tile.index > 14 || seen.has(tile.index)) throw new Error('Invalid game tile');
    seen.add(tile.index);
    return { index: tile.index, png: image(tile.png) };
  });
  return { mode: raw.mode, phase: typeof raw.phase === 'string' ? raw.phase.slice(0, 30) : '',
    active: raw.active === true, fullscreen: raw.fullscreen === true,
    score: Number.isFinite(raw.score) ? raw.score : 0, coins: Number.isFinite(raw.coins) ? raw.coins : 0,
    hud: safeHud(raw.hud), tiles, wide: image(raw.wide), sounds: Array.isArray(raw.sounds) ? raw.sounds.filter(x => typeof x === 'string').slice(0, 64) : [] };
}

/** Starts a local, isolated AgentDeck game engine on first use. No device/network access. */
export function createGameBridge({ python = 'python3', stateDir, timeoutMs = 10_000, spawnProcess = spawn } = {}) {
  let child;
  let sequence = 0;
  let buffer = '';
  let closed = false;
  const pending = new Map();
  function fail(error) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  }
  function start() {
    if (closed) throw new Error('Game engine is closed');
    if (child) return;
    const env = pythonEnv();
    if (stateDir) env.STREAMDOCK_GAME_STATE_DIR = stateDir;
    const proc = spawnProcess(python, ['-u', workerPath], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    child = proc;
    buffer = '';
    proc.stdin.on('error', () => {});
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 12_000_000) { fail(new Error('Game response exceeded limit')); proc.kill('SIGTERM'); return; }
      let split;
      while ((split = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, split);
        buffer = buffer.slice(split + 1);
        let result;
        try { result = JSON.parse(line); } catch { fail(new Error('Invalid game response')); proc.kill('SIGTERM'); return; }
        const item = pending.get(result.id);
        if (!item) continue;
        clearTimeout(item.timer);
        pending.delete(result.id);
        if (!result.ok) { item.reject(new Error('Game request failed')); continue; }
        try { item.resolve(frame(result.state)); } catch (error) { item.reject(error); }
      }
    });
    proc.on('error', () => { if (child !== proc) return; child = undefined; fail(new Error('Game engine could not start')); });
    proc.on('exit', () => { if (child !== proc) return; child = undefined; fail(new Error('Game engine stopped')); });
  }
  function request(op, extra = {}) {
    try { start(); } catch (error) { return Promise.reject(error); }
    if (pending.size >= 8) return Promise.reject(new Error('Game engine is busy'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const proc = child;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Game engine timed out'));
        proc?.kill('SIGTERM');
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ id, op, ...extra })}\n`, error => {
        if (error && pending.has(id)) { clearTimeout(timer); pending.delete(id); reject(new Error('Game engine input failed')); }
      });
    });
  }
  return {
    render: () => request('render'),
    tick: () => request('tick'),
    menu: () => request('menu'),
    start: mode => MODES.has(mode) ? request('start', { mode }) : Promise.reject(new Error('Invalid game mode')),
    press: index => Number.isInteger(index) && ((index >= 0 && index < 10) || index === 13) ? request('press', { index }) : Promise.reject(new Error('Invalid game key')),
    async close() {
      if (closed) return;
      closed = true;
      const proc = child;
      if (!proc) return;
      fail(new Error('Game engine closed'));
      await new Promise(resolve => {
        const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(); }, 1500);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
        proc.stdin.end();
      });
      if (child === proc) child = undefined;
    },
  };
}
