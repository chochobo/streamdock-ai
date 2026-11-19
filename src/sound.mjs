import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pythonEnv } from './python-env.mjs';

const exec = promisify(execFile);
const renderer = fileURLToPath(new URL('./sound-render.py', import.meta.url));
const EFFECTS = new Set(['tap', 'tick', 'flip', 'hit', 'coin', 'bad', 'boom', 'win', 'jackpot', 'lose', 'card', 'bell', 'gallop', 'whoosh', 'cheer', 'shutter', 'slash', 'fire', 'roar', 'levelup', 'heal', 'dead', 'crackle', 'intro', 'thunder', ...Array.from({length: 10}, (_, i) => `note${i}`)]);
const AMBIENT = Object.freeze({ aqua: 'amb_water', aquarium: 'amb_water', fire: 'amb_fire', rain: 'amb_rain', beach: 'amb_waves', sea: 'amb_waves' });

async function validWave(file) {
  let handle;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 44 || stat.size > 15_000_000) return false;
    handle = await fs.open(file, 'r');
    const head = Buffer.alloc(12);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE';
  } catch { return false; }
  finally { await handle?.close(); }
}

/** Sound is disabled by default and plays only after an explicit caller action. */
export function createSoundController({ enabled = false, volume = 0.6,
  cacheDir = path.join(os.homedir(), '.cache', 'streamdock-ai', 'sfx', 'v6'),
  python = 'python3', platform = process.platform, run = exec, spawnPlayer = spawn,
  generate } = {}) {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new RangeError('Invalid sound volume');
  let isEnabled = enabled === true;
  let level = volume;
  let closed = false;
  let ambientGeneration = 0;
  let ambientPlayer;
  let ambientName = null;
  const effects = new Set();
  const pending = new Map();
  const lastPlayed = new Map();

  async function waveFor(name) {
    if (!EFFECTS.has(name) && !Object.values(AMBIENT).includes(name)) throw new Error('Unknown sound');
    const file = path.join(cacheDir, `${name}.wav`);
    if (await validWave(file)) return file;
    if (pending.has(name)) return pending.get(name);
    const promise = (async () => {
      await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
      if (generate) await generate(name, file);
      else await run(python, [renderer, name], { env: { ...pythonEnv(), STREAMDOCK_SOUND_DIR: cacheDir }, timeout: 60_000, maxBuffer: 8192 });
      if (!(await validWave(file))) throw new Error('Sound could not be generated');
      return file;
    })().finally(() => pending.delete(name));
    pending.set(name, promise);
    return promise;
  }
  function stopAmbient() {
    ambientGeneration++;
    ambientName = null;
    if (ambientPlayer) { try { ambientPlayer.kill('SIGTERM'); } catch {} ambientPlayer = undefined; }
  }
  function player(file, gain) {
    const proc = spawnPlayer('/usr/bin/afplay', ['-v', String(Math.max(0, Math.min(1, gain))), file], { stdio: 'ignore' });
    proc.on('error', () => {});
    return proc;
  }
  return {
    status: () => ({ enabled: isEnabled, volume: level, ambient: ambientName, supported: platform === 'darwin' }),
    setEnabled(value) {
      if (typeof value !== 'boolean') throw new TypeError('Sound enabled must be boolean');
      isEnabled = value;
      if (!value) { stopAmbient(); for (const proc of effects) { try { proc.kill('SIGTERM'); } catch {} } effects.clear(); }
    },
    setVolume(value) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Invalid sound volume');
      level = value;
    },
    async play(name) {
      if (!EFFECTS.has(name)) return { ok: false, code: 'unknown_sound' };
      if (closed || !isEnabled) return { ok: false, code: 'disabled' };
      if (platform !== 'darwin') return { ok: false, code: 'unsupported' };
      const now = Date.now();
      if (now - (lastPlayed.get(name) || 0) < 50) return { ok: false, code: 'throttled' };
      lastPlayed.set(name, now);
      try {
        const file = await waveFor(name);
        if (closed || !isEnabled) return { ok: false, code: 'disabled' };
        const proc = player(file, level);
        effects.add(proc);
        proc.once('exit', () => effects.delete(proc));
        proc.once('error', () => effects.delete(proc));
        return { ok: true, code: 'started' };
      } catch { return { ok: false, code: 'unavailable' }; }
    },
    async startAmbient(scene) {
      const name = AMBIENT[scene];
      if (!name) return { ok: false, code: 'unknown_scene' };
      if (closed || !isEnabled) return { ok: false, code: 'disabled' };
      if (platform !== 'darwin') return { ok: false, code: 'unsupported' };
      if (ambientName === name && ambientPlayer) return { ok: true, code: 'already_playing' };
      stopAmbient();
      const token = ambientGeneration;
      try {
        const file = await waveFor(name);
        if (closed || !isEnabled || token !== ambientGeneration) return { ok: false, code: 'cancelled' };
        ambientName = name;
        const loop = () => {
          if (closed || !isEnabled || token !== ambientGeneration) return;
          let proc;
          try { proc = player(file, level * 0.45); } catch { ambientName = null; return; }
          ambientPlayer = proc;
          proc.once('error', () => { if (ambientPlayer === proc) { ambientPlayer = undefined; ambientName = null; } });
          proc.once('exit', code => {
            if (ambientPlayer === proc) ambientPlayer = undefined;
            if (code === 0 && token === ambientGeneration && isEnabled && !closed) loop();
            else if (token === ambientGeneration) ambientName = null;
          });
        };
        loop();
        return ambientPlayer ? { ok: true, code: 'started' } : { ok: false, code: 'unavailable' };
      } catch { return { ok: false, code: 'unavailable' }; }
    },
    stopAmbient,
    close() {
      closed = true;
      stopAmbient();
      for (const proc of effects) { try { proc.kill('SIGTERM'); } catch {} }
      effects.clear();
    },
  };
}
