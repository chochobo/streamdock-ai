import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readShortcutsConfig, SYSTEM_SHORTCUTS } from '../src/shortcuts-config.mjs';

async function fixture(t, content, mode = 0o600) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'streamdock-shortcuts-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'shortcuts.json');
  if (content !== undefined) {
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
    await chmod(file, mode);
  }
  return { home, file };
}

test('a missing file gives only the built-in system keys', async t => {
  const { file } = await fixture(t);
  const config = await readShortcutsConfig({ file });
  assert.equal(config.status, 'unconfigured');
  assert.deepEqual(config.items.map(item => item.type), SYSTEM_SHORTCUTS.map(() => 'system'));
  assert.equal(config.skipped, 0);
});

test('every item type is read and normalized', async t => {
  const { file } = await fixture(t, { version: 1, items: [
    { label: '터미널', type: 'app', app: 'Terminal' },
    { label: 'GitHub', caption: '저장소', type: 'url', url: 'https://github.com/' },
    { label: '계속', type: 'text', text: '계속 진행해 주세요.', submit: true },
    { label: '빌드', type: 'command', command: ['/usr/bin/make', '-C', '/tmp', 'build'] },
    { label: '볼륨 +', type: 'system', system: 'volume-up' },
  ] });
  const config = await readShortcutsConfig({ file });
  assert.equal(config.status, 'ok');
  const user = config.items.filter(item => !item.builtin);
  assert.deepEqual(user.map(item => [item.label, item.type]), [['터미널', 'app'], ['GitHub', 'url'], ['계속', 'text'], ['빌드', 'command'], ['볼륨 +', 'system']]);
  assert.equal(user[1].caption, '저장소');
  assert.equal(user[2].submit, true);
  assert.deepEqual(user[3].command, ['/usr/bin/make', '-C', '/tmp', 'build']);
  assert.equal(user[3].hold, true, 'commands must be held to run');
  assert.ok(user.every(item => /^sc-\d+-[0-9a-f]{8}$/.test(item.id)));
});

test('built-in keys can be turned off and come after the user items otherwise', async t => {
  const { file } = await fixture(t, { version: 1, builtins: false, items: [{ label: 'A', type: 'app', app: 'Notes' }] });
  const config = await readShortcutsConfig({ file });
  assert.deepEqual(config.items.map(item => item.label), ['A']);
  const withBuiltins = await readShortcutsConfig({ file: (await fixture(t, { version: 1, items: [{ label: 'A', type: 'app', app: 'Notes' }] })).file });
  assert.equal(withBuiltins.items[0].label, 'A');
  assert.equal(withBuiltins.items.at(-1).builtin, true);
});

test('invalid items are skipped and counted, valid ones survive', async t => {
  const { file } = await fixture(t, { version: 1, items: [
    { label: 'ok', type: 'app', app: 'Notes' },
    { label: '', type: 'app', app: 'Notes' },
    { label: 'no type', app: 'Notes' },
    { label: 'dash app', type: 'app', app: '-a evil' },
    { label: 'file url', type: 'url', url: 'file:///etc/passwd' },
    { label: 'js url', type: 'url', url: 'javascript:alert(1)' },
    { label: 'relative cmd', type: 'command', command: ['ls'] },
    { label: 'string cmd', type: 'command', command: '/bin/ls' },
    { label: 'empty cmd', type: 'command', command: [] },
    { label: 'nul', type: 'command', command: ['/bin/echo', 'a\u0000b'] },
    { label: 'bad system', type: 'system', system: 'rm-rf' },
    { label: 'empty text', type: 'text', text: '' },
    { label: 'ctl text', type: 'text', text: 'a\u0007b' },
    { label: 'x'.repeat(200), type: 'app', app: 'Notes' },
    null,
    'string',
  ] });
  const config = await readShortcutsConfig({ file });
  const user = config.items.filter(item => !item.builtin);
  assert.deepEqual(user.map(item => item.label), ['ok']);
  assert.equal(config.skipped, 15);
  assert.equal(config.status, 'ok');
});

test('newlines and tabs are allowed in text, other control characters are not', async t => {
  const { file } = await fixture(t, { version: 1, items: [{ label: 'multi', type: 'text', text: 'line one\nline two\tend' }] });
  const config = await readShortcutsConfig({ file });
  assert.equal(config.items.find(item => item.label === 'multi').text, 'line one\nline two\tend');
});

test('http, https and mailto links are allowed', async t => {
  const { file } = await fixture(t, { version: 1, items: [
    { label: 'a', type: 'url', url: 'http://localhost:3000/' },
    { label: 'b', type: 'url', url: 'https://example.com/a?b=1#c' },
    { label: 'c', type: 'url', url: 'mailto:me@example.com' },
  ] });
  const config = await readShortcutsConfig({ file });
  assert.deepEqual(config.items.filter(item => !item.builtin).map(item => item.label), ['a', 'b', 'c']);
});

test('an unsafe file is refused: group/world writable, symlink, other owner is not testable, too large, not JSON', async t => {
  const writable = await fixture(t, { version: 1, items: [] }, 0o666);
  assert.equal((await readShortcutsConfig({ file: writable.file })).status, 'unavailable');

  const real = await fixture(t, { version: 1, items: [] });
  const link = path.join(real.home, 'link.json');
  await symlink(real.file, link);
  assert.equal((await readShortcutsConfig({ file: link })).status, 'unavailable');

  const big = await fixture(t, JSON.stringify({ version: 1, items: [], pad: 'x'.repeat(70_000) }));
  assert.equal((await readShortcutsConfig({ file: big.file })).status, 'unavailable');

  const broken = await fixture(t, '{ not json');
  assert.equal((await readShortcutsConfig({ file: broken.file })).status, 'unavailable');

  const wrongVersion = await fixture(t, { version: 2, items: [] });
  assert.equal((await readShortcutsConfig({ file: wrongVersion.file })).status, 'unavailable');
});

test('a FIFO in place of the file is refused without hanging', async t => {
  const { execFileSync } = await import('node:child_process');
  const { home } = await fixture(t);
  const fifo = path.join(home, 'fifo.json');
  execFileSync('/usr/bin/mkfifo', [fifo]);
  const result = await Promise.race([readShortcutsConfig({ file: fifo }), new Promise(resolve => setTimeout(() => resolve('hung'), 3000))]);
  assert.notEqual(result, 'hung');
  assert.equal(result.status, 'unavailable');
});

test('an unavailable file still offers the built-in keys', async t => {
  const broken = await fixture(t, '{ not json');
  const config = await readShortcutsConfig({ file: broken.file });
  assert.equal(config.status, 'unavailable');
  assert.deepEqual(config.items.map(item => item.type), SYSTEM_SHORTCUTS.map(() => 'system'));
});

test('ids follow the content so a changed item cannot reuse a displayed id', async t => {
  const a = await readShortcutsConfig({ file: (await fixture(t, { version: 1, items: [{ label: 'X', type: 'app', app: 'Notes' }] })).file });
  const b = await readShortcutsConfig({ file: (await fixture(t, { version: 1, items: [{ label: 'X', type: 'app', app: 'Terminal' }] })).file });
  assert.notEqual(a.items[0].id, b.items[0].id);
  const again = await readShortcutsConfig({ file: (await fixture(t, { version: 1, items: [{ label: 'X', type: 'app', app: 'Notes' }] })).file });
  assert.equal(a.items[0].id, again.items[0].id);
});

test('at most 100 items are read', async t => {
  const items = Array.from({ length: 130 }, (_, i) => ({ label: `i${i}`, type: 'app', app: 'Notes' }));
  const { file } = await fixture(t, { version: 1, builtins: false, items });
  const config = await readShortcutsConfig({ file });
  assert.equal(config.items.length, 100);
  assert.equal(config.skipped, 30);
});

test('the shipped example file is valid, so it cannot drift from the validator', async t => {
  const { readFile } = await import('node:fs/promises');
  const example = JSON.parse(await readFile(new URL('../examples/shortcuts.example.json', import.meta.url), 'utf8'));
  const { file } = await fixture(t, example);
  const config = await readShortcutsConfig({ file });
  assert.equal(config.status, 'ok');
  assert.equal(config.skipped, 0);
  assert.equal(config.items.filter(item => !item.builtin).length, example.items.length);
});
