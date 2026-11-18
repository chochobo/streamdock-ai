import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettings } from '../src/settings.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamdock-settings-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'config', 'settings.json') };
}

test('defaults are inert, isolated copies, and do not create a file', async t => {
  const { file } = await fixture(t);
  const settings = createSettings({ file });
  const initial = await settings.load();
  assert.deepEqual(initial, { version: 1, language: 'ko', sound: { enabled: false }, brightness: null,
    screensaver: { enabled: false, idleMinutes: 15, scene: 'aquarium' } });
  initial.sound.enabled = true;
  initial.screensaver.enabled = true;
  assert.equal(settings.get().sound.enabled, false);
  assert.equal(settings.get().screensaver.enabled, false);
  await assert.rejects(fs.stat(file), error => error.code === 'ENOENT');
});

test('valid updates persist atomically and never enable a feature implicitly', async t => {
  const { file } = await fixture(t);
  const settings = createSettings({ file });
  await settings.load();
  const [first, second] = await Promise.all([
    settings.update({ brightness: 42 }),
    settings.update({ screensaver: { scene: 'rain', idleMinutes: 25 } }),
  ]);
  assert.equal(first.brightness, 42);
  assert.equal(second.screensaver.enabled, false);
  assert.deepEqual(second.screensaver, { enabled: false, idleMinutes: 25, scene: 'rain' });
  assert.equal(second.sound.enabled, false);
  const reloaded = await createSettings({ file }).load();
  assert.deepEqual(reloaded, second);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await settings.update({ sound: { enabled: true }, screensaver: { enabled: true } })).sound.enabled, true);
  assert.equal(settings.get().screensaver.enabled, true);
});

test('language defaults for old settings and persists only supported values', async t => {
  const { file } = await fixture(t);
  const settings = createSettings({ file });
  await settings.update({ brightness: 50 });
  const old = JSON.parse(await fs.readFile(file, 'utf8'));
  delete old.language;
  await fs.writeFile(file, JSON.stringify(old), { mode: 0o600 });
  assert.equal((await settings.load()).language, 'ko');
  assert.equal((await settings.update({ language: 'en' })).language, 'en');
  assert.equal((await createSettings({ file }).load()).language, 'en');
  const before = await fs.readFile(file, 'utf8');
  for (const invalid of ['fr', '', null, 1]) {
    await assert.rejects(settings.update({ language: invalid }));
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
  assert.equal((await settings.update({ language: 'ko' })).language, 'ko');
});

test('invalid fields and values leave the prior file unchanged', async t => {
  const { file } = await fixture(t);
  const settings = createSettings({ file });
  await settings.update({ brightness: 55 });
  const before = await fs.readFile(file);
  for (const patch of [
    { brightness: -1 }, { brightness: 101 }, { brightness: 50.5 }, { sound: { enabled: 'yes' } },
    { screensaver: { idleMinutes: 0 } }, { screensaver: { idleMinutes: 1441 } },
    { screensaver: { scene: 'unsupported' } }, { screensaver: { enabled: 1 } },
    { unexpected: true }, JSON.parse('{"__proto__":{"polluted":true}}'),
  ]) await assert.rejects(settings.update(patch));
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal(settings.get().brightness, 55);
});

test('does not overwrite malformed, oversized, or symbolic-link settings', async t => {
  const { dir, file } = await fixture(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{broken');
  const settings = createSettings({ file });
  await assert.rejects(settings.load(), /Invalid settings JSON/);
  await assert.rejects(settings.update({ brightness: 20 }), /Invalid settings JSON/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  await fs.writeFile(file, 'x'.repeat(17_000));
  await assert.rejects(settings.load(), /Unsafe settings file/);
  await fs.unlink(file);
  const other = path.join(dir, 'keep');
  await fs.writeFile(other, 'keep');
  await fs.symlink(other, file);
  await assert.rejects(settings.update({ sound: { enabled: true } }));
  assert.equal(await fs.readFile(other, 'utf8'), 'keep');
});

test('reads recent external changes before a partial update', async t => {
  const { file } = await fixture(t);
  const first = createSettings({ file });
  const second = createSettings({ file });
  await first.update({ brightness: 25 });
  await second.load();
  await first.update({ brightness: 80 });
  const result = await second.update({ sound: { enabled: true } });
  assert.equal(result.brightness, 80);
  assert.equal(result.sound.enabled, true);
  assert.equal(result.screensaver.enabled, false);
});
