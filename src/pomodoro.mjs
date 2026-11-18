import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const POMODORO_PRESETS = Object.freeze([5, 10, 15, 20, 25, 30, 45, 50, 60, 90]);
const initial = () => ({ version: 1, state: 'setup', durationSeconds: 0, endAt: null, remainingSeconds: 0 });
const states = new Set(['setup', 'running', 'paused', 'done']);
function valid(value) {
  if (!value || value.version !== 1 || !states.has(value.state) || !Number.isFinite(value.durationSeconds) || value.durationSeconds < 0 || value.durationSeconds > 10800 || !Number.isFinite(value.remainingSeconds) || value.remainingSeconds < 0 || value.remainingSeconds > 10800) return false;
  if (value.state === 'setup') return value.durationSeconds === 0 && value.remainingSeconds === 0 && value.endAt === null;
  if (value.durationSeconds <= 0 || value.remainingSeconds > value.durationSeconds) return false;
  if (value.state === 'running') return typeof value.endAt === 'number' && Number.isFinite(value.endAt) && value.endAt >= 0 && value.endAt <= 8.64e15;
  if (value.endAt !== null) return false;
  return value.state !== 'done' || value.remainingSeconds === 0;
}

async function defaultNotify() {
  if (process.platform !== 'darwin') return;
  try {
    await execFileAsync('/usr/bin/osascript', ['-e', 'display notification "설정한 집중 시간이 끝났습니다." with title "StreamDock AI" sound name "Glass"'], { timeout: 5_000 });
  } catch { /* A disabled notification must not stop the timer. */ }
}

/** Persistent single timer. Use tick() from the app's existing update loop. */
export async function createPomodoro({ home = os.homedir(), statePath = path.join(home, '.cache', 'streamdock-ai', 'pomodoro.json'), now = Date.now, notify = defaultNotify } = {}) {
  let state = initial();
  let operations = Promise.resolve();
  let closed = false;
  try {
    const stat = await fs.lstat(statePath);
    if (stat.isFile() && stat.size <= 8192) {
      const stored = JSON.parse(await fs.readFile(statePath, 'utf8'));
      if (valid(stored)) state = stored;
    }
  } catch { /* First run or invalid state. */ }

  async function save() {
    const dir = path.dirname(statePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `.pomodoro-${process.pid}-${randomBytes(6).toString('hex')}`);
    try {
      await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, statePath);
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  function serialize(operation) {
    const next = operations.then(async () => { if (closed) throw new Error('Timer is stopped'); return operation(); });
    operations = next.catch(() => {});
    return next;
  }
  function snapshot() {
    const remaining = state.state === 'running' ? Math.max(0, Math.ceil((state.endAt - now()) / 1000)) : Math.ceil(state.remainingSeconds);
    return { state: state.state, durationSeconds: state.durationSeconds, remainingSeconds: remaining,
      endAt: state.endAt === null ? null : new Date(state.endAt).toISOString(), presets: [...POMODORO_PRESETS] };
  }
  // A timer that ended while the app was not running is displayed as done;
  // don't play a delayed sound or repeat a previously delivered notification.
  if (state.state === 'running' && state.endAt <= now()) {
    state = { ...state, state: 'done', endAt: null, remainingSeconds: 0 };
    await save();
  }
  return {
    snapshot,
    start(minutes) {
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return Promise.reject(new RangeError('Minutes must be an integer from 1 to 180'));
      return serialize(async () => {
        const durationSeconds = minutes * 60;
        const next = { version: 1, state: 'running', durationSeconds, endAt: now() + durationSeconds * 1000, remainingSeconds: durationSeconds };
        const previous = state; state = next;
        try { await save(); } catch (error) { state = previous; throw error; }
        return snapshot();
      });
    },
    pause() {
      return serialize(async () => {
        if (state.state !== 'running') return snapshot();
        const remainingSeconds = Math.max(0, Math.ceil((state.endAt - now()) / 1000));
        const previous = state;
        state = remainingSeconds ? { ...state, state: 'paused', endAt: null, remainingSeconds } : { ...state, state: 'done', endAt: null, remainingSeconds: 0 };
        try { await save(); } catch (error) { state = previous; throw error; }
        if (!remainingSeconds) await Promise.resolve().then(notify).catch(() => {});
        return snapshot();
      });
    },
    resume() {
      return serialize(async () => {
        if (state.state !== 'paused' || state.remainingSeconds <= 0) return snapshot();
        const previous = state; state = { ...state, state: 'running', endAt: now() + state.remainingSeconds * 1000 };
        try { await save(); } catch (error) { state = previous; throw error; }
        return snapshot();
      });
    },
    reset() {
      return serialize(async () => {
        const previous = state; state = initial();
        try { await save(); } catch (error) { state = previous; throw error; }
        return snapshot();
      });
    },
    tick() {
      return serialize(async () => {
        if (state.state !== 'running' || state.endAt > now()) return snapshot();
        const previous = state; state = { ...state, state: 'done', endAt: null, remainingSeconds: 0 };
        try { await save(); } catch (error) { state = previous; throw error; }
        await Promise.resolve().then(notify).catch(() => {});
        return snapshot();
      });
    },
    async stop() { await operations; closed = true; },
  };
}
