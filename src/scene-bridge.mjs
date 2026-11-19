import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonEnv } from './python-env.mjs';

const workerPath = fileURLToPath(new URL('./scene-worker.py', import.meta.url));
const MODES = new Set(['aquarium', 'fire', 'rain', 'beach']);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function image(value) {
  if (typeof value !== 'string' || value.length > 350_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid scene image');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG)) throw new Error('Invalid scene PNG');
  return bytes;
}
function frame(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.mode !== 'string' || (raw.mode !== '' && !MODES.has(raw.mode)) || !Array.isArray(raw.tiles) || !Array.isArray(raw.sideTiles) || !Number.isSafeInteger(raw.frame) || raw.frame < 0) throw new Error('Invalid scene frame');
  const active = raw.active === true;
  if ((active && (!MODES.has(raw.mode) || raw.tiles.length !== 15 || raw.sideTiles.length !== 3)) || (!active && (raw.mode !== '' || raw.tiles.length || raw.sideTiles.length))) throw new Error('Incomplete scene frame');
  const seen = new Set();
  const tiles = raw.tiles.map(tile => {
    if (!Number.isInteger(tile?.index) || tile.index < 0 || tile.index > 14 || seen.has(tile.index)) throw new Error('Invalid scene tile');
    seen.add(tile.index);
    return { index: tile.index, png: image(tile.png) };
  });
  const sides = new Set();
  const sideTiles = raw.sideTiles.map(tile => {
    if (!Number.isInteger(tile?.slot) || tile.slot < 16 || tile.slot > 18 || sides.has(tile.slot)) throw new Error('Invalid scene side tile');
    sides.add(tile.slot);
    return { slot: tile.slot, png: image(tile.png) };
  });
  return { mode: raw.mode, active, paused: raw.paused === true, frame: raw.frame, tiles, sideTiles };
}

/** A single bounded background Python worker; it never opens USB or plays audio. */
export function createSceneBridge({ python = 'python3', timeoutMs = 10_000, spawnProcess = spawn } = {}) {
  let child, sequence = 0, buffer = '', closed = false;
  const pending = new Map();
  function fail(error) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  }
  function ensureProcess() {
    if (closed) throw new Error('Scene engine is closed');
    if (child) return;
    const proc = spawnProcess(python, ['-u', workerPath], { env: pythonEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    child = proc; buffer = '';
    proc.stdin.on('error', () => {});
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8_000_000) { fail(new Error('Scene response exceeded limit')); proc.kill('SIGTERM'); return; }
      let split;
      while ((split = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        let result;
        try { result = JSON.parse(line); } catch { fail(new Error('Invalid scene response')); proc.kill('SIGTERM'); return; }
        const item = pending.get(result.id);
        if (!item) continue;
        clearTimeout(item.timer); pending.delete(result.id);
        if (!result.ok) { item.reject(new Error('Scene request failed')); continue; }
        try { item.resolve(frame(result.state)); } catch (error) { item.reject(error); }
      }
    });
    proc.on('error', () => { if (child !== proc) return; child = undefined; fail(new Error('Scene engine could not start')); });
    proc.on('exit', () => { if (child !== proc) return; child = undefined; fail(new Error('Scene engine stopped')); });
  }
  function request(op, extra = {}) {
    try { ensureProcess(); } catch (error) { return Promise.reject(error); }
    if (pending.size >= 4) return Promise.reject(new Error('Scene engine is busy'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const proc = child;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Scene engine timed out')); proc?.kill('SIGTERM'); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ id, op, ...extra })}\n`, error => {
        if (error && pending.has(id)) { clearTimeout(timer); pending.delete(id); reject(new Error('Scene engine input failed')); }
      });
    });
  }
  return {
    start: mode => MODES.has(mode) ? request('start', { mode }) : Promise.reject(new Error('Invalid scene mode')),
    render: () => request('render'),
    tick: () => request('tick'),
    press: index => Number.isInteger(index) && index >= 0 && index < 15 ? request('press', { index }) : Promise.reject(new Error('Invalid scene key')),
    pause: paused => typeof paused === 'boolean' ? request('pause', { paused }) : Promise.reject(new Error('Invalid pause state')),
    stop: () => request('stop'),
    async close() {
      if (closed) return;
      closed = true;
      const proc = child;
      if (!proc) return;
      fail(new Error('Scene engine closed'));
      await new Promise(resolve => {
        const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(); }, 1500);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
        proc.stdin.end();
      });
      if (child === proc) child = undefined;
    },
  };
}
