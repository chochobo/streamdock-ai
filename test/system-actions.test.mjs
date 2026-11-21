import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemActions } from '../src/system-actions.mjs';

function harness({ volume = 50, fail = null, copyFail = false } = {}) {
  const calls = [];
  const copied = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    if (typeof fail === 'function') { const error = fail(file, args); if (error) throw error; }
    if (file === '/usr/bin/osascript' && String(args[1]).startsWith('output volume of')) return { stdout: `${volume}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const copy = async value => { if (copyFail) throw new Error('no pbcopy'); copied.push(value); };
  return { actions: createSystemActions({ run, copy, platform: 'darwin' }), calls, copied };
}
const osa = (calls, index) => calls[index].args.at(-1);

test('apps and links open through /usr/bin/open without a shell', async () => {
  const { actions, calls } = harness();
  assert.equal((await actions.execute({ type: 'app', label: '터미널', app: 'Terminal' })).ok, true);
  assert.deepEqual(calls[0], { file: '/usr/bin/open', args: ['-a', 'Terminal'], options: calls[0].options });
  assert.equal((await actions.execute({ type: 'url', label: 'g', url: 'https://example.com/' })).ok, true);
  assert.deepEqual(calls[1].args, ['https://example.com/']);
});

test('a failing open reports an error without leaking the command output', async () => {
  const { actions } = harness({ fail: () => Object.assign(new Error('boom /Users/x/secret'), { code: 1, stderr: 'secret path' }) });
  const result = await actions.execute({ type: 'app', label: 'x', app: 'Nope' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'open_failed');
  assert.doesNotMatch(JSON.stringify(result), /secret|Users/);
});

test('volume steps by 6 within 0..100 and reports the new level', async () => {
  const { actions, calls } = harness({ volume: 50 });
  let result = await actions.execute({ type: 'system', system: 'volume-up' });
  assert.equal(result.ok, true);
  assert.equal(osa(calls, 1), 'set volume output volume 56');
  assert.match(result.message, /56/);
  const low = harness({ volume: 3 });
  await low.actions.execute({ type: 'system', system: 'volume-down' });
  assert.equal(osa(low.calls, 1), 'set volume output volume 0');
  const high = harness({ volume: 98 });
  await high.actions.execute({ type: 'system', system: 'volume-up' });
  assert.equal(osa(high.calls, 1), 'set volume output volume 100');
});

test('adjustVolume is reusable for the rocker with any step', async () => {
  const { actions, calls } = harness({ volume: 40 });
  const result = await actions.adjustVolume(-10);
  assert.equal(result.ok, true);
  assert.equal(result.volume, 30);
  assert.equal(osa(calls, 1), 'set volume output volume 30');
});

test('an output without a software volume is reported, not guessed', async () => {
  const calls = [];
  const actions = createSystemActions({ run: async (file, args) => { calls.push(args); return { stdout: 'missing value\n', stderr: '' }; }, copy: async () => {}, platform: 'darwin' });
  const result = await actions.execute({ type: 'system', system: 'volume-up' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'volume_unavailable');
  assert.equal(calls.length, 1, 'no set command is sent');
});

test('mute toggles and the other system keys use fixed commands', async () => {
  const { actions, calls } = harness();
  await actions.execute({ type: 'system', system: 'mute' });
  assert.match(osa(calls, 0), /set volume output muted \(not \(output muted of \(get volume settings\)\)\)/);
  await actions.execute({ type: 'system', system: 'display-sleep' });
  assert.deepEqual([calls[1].file, calls[1].args], ['/usr/bin/pmset', ['displaysleepnow']]);
  await actions.execute({ type: 'system', system: 'screensaver' });
  assert.deepEqual([calls[2].file, calls[2].args], ['/usr/bin/open', ['-a', 'ScreenSaverEngine']]);
  assert.equal((await actions.toggleMute()).ok, true);
});

test('text is copied as UTF-8 and pasted; submit adds Return', async () => {
  const { actions, calls, copied } = harness();
  const result = await actions.execute({ type: 'text', label: 'c', text: '계속 진행해 주세요.', submit: true });
  assert.equal(result.ok, true);
  assert.deepEqual(copied, ['계속 진행해 주세요.']);
  assert.equal(osa(calls, 0), 'tell application "System Events" to keystroke "v" using command down');
  assert.equal(osa(calls, 1), 'tell application "System Events" to key code 36');
  const plain = harness();
  await plain.actions.execute({ type: 'text', label: 'c', text: 'x', submit: false });
  assert.equal(plain.calls.length, 1, 'no Return without submit');
});

test('without Accessibility permission the text stays on the clipboard and the key says so', async () => {
  const { actions, copied } = harness({ fail: (file, args) => /keystroke/.test(args.at(-1) || '') ? Object.assign(new Error('x'), { stderr: 'osascript is not allowed to send keystrokes. (1002)' }) : null });
  const result = await actions.execute({ type: 'text', label: 'c', text: 'hello', submit: false });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'permission_required');
  assert.deepEqual(copied, ['hello']);
  assert.match(result.message, /손쉬운 사용/);
});

test('a clipboard failure is reported before any paste is tried', async () => {
  const { actions, calls } = harness({ copyFail: true });
  const result = await actions.execute({ type: 'text', label: 'c', text: 'x', submit: false });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'copy_failed');
  assert.equal(calls.length, 0);
});

test('commands run directly with their arguments, a timeout and no shell', async () => {
  const { actions, calls } = harness();
  const result = await actions.execute({ type: 'command', label: 'b', command: ['/usr/bin/make', '-C', '/tmp/x y', 'build'], hold: true });
  assert.equal(result.ok, true);
  assert.equal(calls[0].file, '/usr/bin/make');
  assert.deepEqual(calls[0].args, ['-C', '/tmp/x y', 'build']);
  assert.ok(calls[0].options.timeout > 0 && calls[0].options.timeout <= 30_000);
  assert.equal(calls[0].options.shell, undefined);
});

test('a command does not inherit the native app token', async () => {
  process.env.STREAMDOCK_NATIVE_TOKEN = 'a'.repeat(64);
  try {
    const { actions, calls } = harness();
    await actions.execute({ type: 'command', label: 'b', command: ['/usr/bin/true'], hold: true });
    assert.equal(calls[0].options.env.STREAMDOCK_NATIVE_TOKEN, undefined);
    assert.ok(calls[0].options.env.PATH, 'the rest of the environment is kept');
  } finally { delete process.env.STREAMDOCK_NATIVE_TOKEN; }
});

test('a failing or hanging command reports a short message without output', async () => {
  const failed = harness({ fail: () => Object.assign(new Error('Command failed'), { code: 2, stdout: 'TOKEN=abc', stderr: 'secret' }) });
  let result = await failed.actions.execute({ type: 'command', label: 'b', command: ['/bin/false'], hold: true });
  assert.deepEqual([result.ok, result.code], [false, 'command_failed']);
  assert.doesNotMatch(JSON.stringify(result), /TOKEN|secret/);
  const slow = harness({ fail: () => Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }) });
  result = await slow.actions.execute({ type: 'command', label: 'b', command: ['/bin/sleep', '99'], hold: true });
  assert.equal(result.code, 'command_timeout');
});

test('unknown kinds and other platforms do nothing', async () => {
  const { actions, calls } = harness();
  assert.equal((await actions.execute({ type: 'nope' })).code, 'unsupported');
  assert.equal((await actions.execute({ type: 'system', system: 'rm' })).code, 'unsupported');
  const linux = createSystemActions({ run: async () => { throw new Error('should not run'); }, copy: async () => {}, platform: 'linux' });
  assert.equal((await linux.execute({ type: 'app', app: 'X' })).code, 'unsupported_platform');
  assert.equal(calls.length, 0);
});
