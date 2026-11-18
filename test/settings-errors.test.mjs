import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettings, SettingsError, validateSettingsPatch } from '../src/settings.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamdock-settings-errors-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'config', 'settings.json') };
}

function thrown(fn) {
  try { fn(); } catch (error) { return error; }
  assert.fail('expected an error');
}

const noLeak = (error, ...secrets) => {
  assert.doesNotMatch(error.message, /\/(?:Users|tmp|var|home|private)\b|settings\.json|[A-Za-z]:\\/);
  for (const secret of secrets) assert.ok(!error.message.includes(secret));
  assert.match(error.message, /[가-힣]/);
};

test('malformed JSON reports settings_invalid_json without path or content', async t => {
  const { dir, file } = await fixture(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{"token":"sk-secret-123",');
  const error = await createSettings({ file }).load().catch(e => e);
  assert.ok(error instanceof SettingsError && error instanceof TypeError);
  assert.equal(error.code, 'settings_invalid_json');
  assert.equal(error.field, null);
  noLeak(error, dir, 'sk-secret-123');
  assert.equal(await fs.readFile(file, 'utf8'), '{"token":"sk-secret-123",');
});

test('unknown fields name the field and list the allowed ones', () => {
  const top = thrown(() => validateSettingsPatch({ 'sk-secret-key': true }));
  assert.equal(top.code, 'settings_unknown_field');
  assert.equal(top.field, 'sk-secret-key');
  assert.deepEqual(top.allowed, ['version', 'language', 'sound', 'brightness', 'screensaver']);
  const nested = thrown(() => validateSettingsPatch({ screensaver: { color: 'red' } }));
  assert.equal(nested.code, 'settings_unknown_field');
  assert.equal(nested.field, 'screensaver.color');
  assert.deepEqual(nested.allowed, ['enabled', 'idleMinutes', 'scene']);
  noLeak(nested);
});

test('out-of-range values report the field and allowed range', () => {
  const cases = [
    [{ brightness: 101 }, 'brightness', { type: 'integer', min: 0, max: 100, nullable: true }],
    [{ brightness: 50.5 }, 'brightness', { type: 'integer', min: 0, max: 100, nullable: true }],
    [{ screensaver: { idleMinutes: 1441 } }, 'screensaver.idleMinutes', { type: 'integer', min: 1, max: 1440 }],
    [{ screensaver: { idleMinutes: 0 } }, 'screensaver.idleMinutes', { type: 'integer', min: 1, max: 1440 }],
    [{ screensaver: { scene: 'nope' } }, 'screensaver.scene', ['aquarium', 'fire', 'rain', 'beach']],
    [{ language: 'fr' }, 'language', ['ko', 'en']],
  ];
  for (const [patch, field, allowed] of cases) {
    const error = thrown(() => validateSettingsPatch(patch));
    assert.equal(error.code, 'settings_invalid_value');
    assert.equal(error.field, field);
    assert.deepEqual(error.allowed, allowed);
    assert.ok(error.message.includes(field));
    noLeak(error);
  }
});

test('wrong types report the field and expected type', () => {
  const cases = [
    [{ sound: { enabled: 'yes' } }, 'sound.enabled', [true, false]],
    [{ screensaver: { enabled: 1 } }, 'screensaver.enabled', [true, false]],
    [{ sound: 'loud' }, 'sound', 'object'],
    [{ screensaver: null }, 'screensaver', 'object'],
    [{ brightness: '50' }, 'brightness', { type: 'integer', min: 0, max: 100, nullable: true }],
  ];
  for (const [patch, field, allowed] of cases) {
    const error = thrown(() => validateSettingsPatch(patch));
    assert.equal(error.code, 'settings_invalid_value');
    assert.equal(error.field, field);
    assert.deepEqual(error.allowed, allowed);
    noLeak(error, 'loud');
  }
  assert.equal(thrown(() => validateSettingsPatch('x')).field, 'settings');
});

test('version change and bad stored version are specific', async t => {
  assert.equal(thrown(() => validateSettingsPatch({ version: 1 })).code, 'settings_readonly_field');
  const { file } = await fixture(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 2, sound: { enabled: false }, brightness: null, screensaver: { enabled: false, idleMinutes: 15, scene: 'fire' } }));
  const error = await createSettings({ file }).load().catch(e => e);
  assert.equal(error.code, 'settings_invalid_value');
  assert.equal(error.field, 'version');
  assert.deepEqual(error.allowed, [1]);
});

test('update surfaces the same coded error and leaves the file unchanged', async t => {
  const { file } = await fixture(t);
  const settings = createSettings({ file });
  await settings.update({ brightness: 40 });
  const before = await fs.readFile(file);
  const error = await settings.update({ brightness: 500 }).catch(e => e);
  assert.equal(error.code, 'settings_invalid_value');
  assert.equal(error.field, 'brightness');
  assert.deepEqual(await fs.readFile(file), before);
});
