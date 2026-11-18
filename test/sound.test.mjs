import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSoundController } from '../src/sound.mjs';

const exec = promisify(execFileCb);
const wave = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)]);
function fakePlayer(events) {
  return (program, args) => {
    const p = new EventEmitter();
    p.kill = signal => { events.push(['kill', signal]); queueMicrotask(() => p.emit('exit', null)); return true; };
    events.push(['play', program, args]);
    return p;
  };
}

test('audio is disabled by default and only explicit enabled actions start playback', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'streamdock-sound-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const events = [];
  const s = createSoundController({ cacheDir: dir, platform: 'darwin', spawnPlayer: fakePlayer(events), generate: (_name, file) => writeFile(file, wave) });
  assert.equal((await s.play('tap')).code, 'disabled');
  assert.equal((await s.startAmbient('aqua')).code, 'disabled');
  assert.deepEqual(events, []);
  s.setEnabled(true);
  assert.deepEqual(events, [], 'enabling never auto-starts audio');
  assert.equal((await s.play('tap')).ok, true);
  assert.equal((await s.startAmbient('rain')).ok, true);
  assert.equal(s.status().ambient, 'amb_rain');
  s.setEnabled(false);
  assert.equal(s.status().ambient, null);
  assert.ok(events.some(x => x[0] === 'kill'));
  s.close();
});

test('invalid cues and unavailable platforms never play audio', async () => {
  const events = [];
  const s = createSoundController({ enabled: true, platform: 'linux', spawnPlayer: fakePlayer(events) });
  assert.equal((await s.play('../escape')).code, 'unknown_sound');
  assert.equal((await s.play('tap')).code, 'unsupported');
  assert.equal((await s.startAmbient('beach')).code, 'unsupported');
  assert.deepEqual(events, []);
  s.close();
});

test('vendored sound synthesis renders deterministic private WAV without playing it', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'streamdock-sound-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, STREAMDOCK_SOUND_DIR: dir };
  await exec('python3', ['src/sound-render.py', 'tap'], { env, timeout: 5000 });
  const file = path.join(dir, 'tap.wav');
  const first = await readFile(file);
  assert.equal(first.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(first.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await exec('python3', ['src/sound-render.py', 'tap'], { env, timeout: 5000 });
  assert.deepEqual(await readFile(file), first);
  await assert.rejects(exec('python3', ['src/sound-render.py', '../escape'], { env, timeout: 5000 }));
});
