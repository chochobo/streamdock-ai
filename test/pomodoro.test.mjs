import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPomodoro } from '../src/pomodoro.mjs';

test('timer persists pause, resume and notifies once on completion', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-pomo-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let clock = 1_000_000; let notices = 0;
  const statePath = path.join(home, '.cache', 'streamdock-ai', 'pomodoro.json');
  const options = { home, now: () => clock, notify: async () => { notices++; } };
  let timer = await createPomodoro(options);
  assert.equal(timer.snapshot().state, 'setup');
  await timer.start(5); assert.equal(timer.snapshot().remainingSeconds, 300);
  clock += 125_000; await timer.pause(); assert.equal(timer.snapshot().remainingSeconds, 175);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  await timer.stop(); clock += 50_000;
  timer = await createPomodoro(options); assert.equal(timer.snapshot().state, 'paused'); assert.equal(timer.snapshot().remainingSeconds, 175);
  await timer.resume(); clock += 174_000; await timer.tick(); assert.equal(notices, 0);
  clock += 1000; await Promise.all([timer.tick(), timer.tick()]); assert.equal(notices, 1); assert.equal(timer.snapshot().state, 'done');
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).state, 'done');
  await timer.reset(); assert.equal(timer.snapshot().state, 'setup');
  await timer.stop();
});

test('timer completed while stopped restores as done without a delayed duplicate notification', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-pomo-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let clock = 10_000; let notices = 0;
  const options = { home, now: () => clock, notify: async () => { notices++; } };
  const timer = await createPomodoro(options); await timer.start(1); await timer.stop();
  clock += 61_000;
  const restored = await createPomodoro(options);
  assert.equal(restored.snapshot().state, 'done'); await restored.tick(); assert.equal(notices, 0);
  await restored.stop();
});

test('invalid duration and corrupted state do not produce a false running timer', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-pomo-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const statePath = path.join(home, 'broken.json'); await writeFile(statePath, '{invalid');
  const timer = await createPomodoro({ home, statePath, now: () => 10_000, notify: async () => {} });
  assert.equal(timer.snapshot().state, 'setup');
  for (const invalid of [0, -1, 181, 1.5, NaN, '25']) await assert.rejects(timer.start(invalid), RangeError);
  assert.equal(await readFile(statePath, 'utf8'), '{invalid');
  await timer.stop();
});
