import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { pythonEnv } from '../src/python-env.mjs';
import { createGameBridge } from '../src/game-bridge.mjs';
import { createSceneBridge } from '../src/scene-bridge.mjs';
import { createSoundController } from '../src/sound.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('Python bytecode goes to a user cache, never next to the (signed) sources (#43)', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-pyenv-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = pythonEnv({ PATH: '/usr/bin', KEEP: '1' }, home);
  assert.equal(env.PYTHONPYCACHEPREFIX, path.join(home, '.cache', 'streamdock-ai', 'pycache'));
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.KEEP, '1');
  assert.equal(pythonEnv({ PYTHONPYCACHEPREFIX: '/custom' }, home).PYTHONPYCACHEPREFIX, '/custom', 'an explicit choice is kept');
  const base = { A: '1' };
  pythonEnv(base, home);
  assert.deepEqual(base, { A: '1' }, 'the input is not modified');
  assert.equal(pythonEnv(undefined, home).PYTHONPYCACHEPREFIX, path.join(home, '.cache', 'streamdock-ai', 'pycache'));
});

test('the cache directory is created private to the user', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-pyenv-mode-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previous = process.umask(0);
  try {
    const { PYTHONPYCACHEPREFIX } = pythonEnv({}, home);
    assert.equal((await stat(PYTHONPYCACHEPREFIX)).mode & 0o777, 0o700, 'not group- or world-accessible even with umask 0');
  } finally { process.umask(previous); }
  // An unwritable location does not make the environment fail; Python then decides for itself.
  assert.doesNotThrow(() => pythonEnv({}, '/dev/null/not-a-directory'));
});

async function capture(factory) {
  const calls = [];
  const spawnProcess = (command, args, options) => { calls.push({ command, args, options }); throw new Error('stop here'); };
  await factory(spawnProcess);
  return calls;
}

test('the game and scene workers start with the bytecode cache outside the bundle', async () => {
  const games = await capture(async spawnProcess => {
    const bridge = createGameBridge({ spawnProcess });
    await assert.rejects(bridge.render());
    await bridge.close().catch(() => {});
  });
  assert.equal(games.length, 1);
  assert.match(games[0].options.env.PYTHONPYCACHEPREFIX, /\.cache\/streamdock-ai\/pycache$/);
  const scenes = await capture(async spawnProcess => {
    const bridge = createSceneBridge({ spawnProcess });
    await assert.rejects(bridge.start('aquarium'));
    await bridge.close().catch(() => {});
  });
  assert.equal(scenes.length, 1);
  assert.match(scenes[0].options.env.PYTHONPYCACHEPREFIX, /\.cache\/streamdock-ai\/pycache$/);
});

test('the sound renderer starts with the same cache location', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'streamdock-pyenv-sound-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const sound = createSoundController({ enabled: true, cacheDir: dir, platform: 'darwin', run: async (command, args, options) => { calls.push(options); throw new Error('stop here'); }, spawnPlayer: () => { throw new Error('no player'); } });
  await sound.play('tap');
  assert.ok(calls.length >= 1, 'the renderer was started');
  assert.match(calls[0].env.PYTHONPYCACHEPREFIX, /\.cache\/streamdock-ai\/pycache$/);
  assert.equal(calls[0].env.STREAMDOCK_SOUND_DIR, dir, 'the existing environment is kept');
  sound.close();
});

test('a real worker run writes no bytecode into the source tree it imports from', async t => {
  // Copy the vendored sources and the scene worker to a scratch "bundle" and run the real worker from there.
  const bundle = await mkdtemp(path.join(os.tmpdir(), 'streamdock-pyenv-bundle-'));
  const cache = await mkdtemp(path.join(os.tmpdir(), 'streamdock-pyenv-cache-'));
  t.after(() => Promise.all([rm(bundle, { recursive: true, force: true }), rm(cache, { recursive: true, force: true })]));
  const src = path.join(bundle, 'src');
  await mkdir(path.join(src, 'vendor'), { recursive: true });
  spawnSync('/bin/cp', ['-R', path.join(root, 'src', 'vendor', 'agentdeck'), path.join(src, 'vendor', 'agentdeck')]);
  spawnSync('/bin/rm', ['-rf', path.join(src, 'vendor', 'agentdeck', '__pycache__')]);
  const probe = path.join(src, 'probe.py');
  await writeFile(probe, "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), 'vendor', 'agentdeck'))\nimport clock\nprint('ok')\n");
  const env = pythonEnv({ ...process.env, PYTHONDONTWRITEBYTECODE: '' }, os.homedir());
  env.PYTHONPYCACHEPREFIX = cache;
  const run = spawnSync('python3', ['-u', probe], { env, encoding: 'utf8' });
  assert.equal(run.stdout.trim(), 'ok', run.stderr);
  const left = spawnSync('/usr/bin/find', [bundle, '-name', '__pycache__'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(left, '', 'nothing was written inside the bundle');
  assert.ok((await readdir(cache)).length > 0, 'the bytecode went to the cache directory instead');
});
