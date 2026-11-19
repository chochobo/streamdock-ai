import test from 'node:test';
import assert from 'node:assert/strict';
import { ledStateFor, ledTarget, createLedSync, LED_COLORS } from '../src/led-status.mjs';

const agent = (status, extra = {}) => ({ id: `a-${status}-${Math.random()}`, status, presence: 'live', ...extra });

test('the most urgent live session decides the state: waiting, then error, then working', () => {
  assert.equal(ledStateFor([agent('working'), agent('blocked'), agent('error')]), 'blocked');
  assert.equal(ledStateFor([agent('working'), agent('error'), agent('done')]), 'error');
  assert.equal(ledStateFor([agent('working'), agent('idle')]), 'working');
  assert.equal(ledStateFor([agent('idle'), agent('done'), agent('unknown')]), 'idle');
  assert.equal(ledStateFor([]), 'idle');
  assert.equal(ledStateFor(undefined), 'idle');
});

test('history sessions and subagents never light the LEDs', () => {
  assert.equal(ledStateFor([agent('blocked', { presence: 'history' })]), 'idle');
  assert.equal(ledStateFor([agent('blocked', { isSubagent: true })]), 'idle');
  assert.equal(ledStateFor([agent('error', { presence: undefined })]), 'idle');
  assert.equal(ledStateFor([null, 'x', 3]), 'idle');
});

test('each state has its own color and idle turns the LEDs off', () => {
  const blocked = ledTarget('blocked', 30);
  const error = ledTarget('error', 30);
  const working = ledTarget('working', 30);
  const idle = ledTarget('idle', 30);
  assert.deepEqual(blocked.rgb, LED_COLORS.blocked);
  assert.deepEqual(error.rgb, LED_COLORS.error);
  assert.deepEqual(working.rgb, LED_COLORS.working);
  assert.notDeepEqual(blocked.rgb, error.rgb);
  assert.notDeepEqual(blocked.rgb, working.rgb);
  assert.equal(idle.rgb, null);
  assert.equal(idle.brightness, 0, 'off uses brightness 0: an all-zero color is ignored by the device');
  assert.equal(blocked.brightness, 30);
  assert.equal(new Set([blocked.key, error.key, working.key, idle.key]).size, 4);
  assert.notEqual(ledTarget('blocked', 30).key, ledTarget('blocked', 60).key, 'a brightness change is a change');
});

function harness() {
  const calls = [];
  const device = { setLeds: async value => { calls.push(['set', value]); return harness.fail ? false : true; }, resetLeds: async () => { calls.push(['reset']); return true; } };
  return { calls, sync: createLedSync(device) };
}
const on = (agents, extra = {}) => ({ enabled: true, supported: true, connected: true, brightness: 30, agents, ...extra });

test('a state is sent once and again only when it changes', async () => {
  const { calls, sync } = harness();
  assert.equal(await sync.sync(on([agent('blocked')])), 'set');
  assert.equal(await sync.sync(on([agent('blocked')])), 'unchanged');
  assert.equal(await sync.sync(on([agent('working')])), 'set');
  assert.equal(await sync.sync(on([])), 'set');
  assert.deepEqual(calls.map(c => c[0]), ['set', 'set', 'set']);
  assert.equal(calls[2][1].rgb, null);
});

test('turned off, unsupported or disconnected sends nothing; turning it off restores the default effect once', async () => {
  const { calls, sync } = harness();
  assert.equal(await sync.sync(on([agent('blocked')], { enabled: false })), 'idle');
  assert.equal(await sync.sync(on([agent('blocked')], { supported: false })), 'skipped');
  assert.equal(await sync.sync(on([agent('blocked')], { connected: false })), 'skipped');
  assert.equal(calls.length, 0);
  await sync.sync(on([agent('blocked')]));
  assert.equal(await sync.sync(on([agent('blocked')], { enabled: false })), 'reset');
  assert.equal(await sync.sync(on([agent('blocked')], { enabled: false })), 'idle', 'reset only once');
  assert.deepEqual(calls.map(c => c[0]), ['set', 'reset']);
});

test('a reconnect sends the current state again', async () => {
  const { calls, sync } = harness();
  await sync.sync(on([agent('error')]));
  await sync.sync(on([agent('error')], { connected: false }));
  assert.equal(await sync.sync(on([agent('error')])), 'set');
  assert.equal(calls.length, 2);
});

test('a failed send is retried on the next refresh', async () => {
  const { calls, sync } = harness();
  harness.fail = true;
  assert.equal(await sync.sync(on([agent('error')])), 'failed');
  harness.fail = false;
  assert.equal(await sync.sync(on([agent('error')])), 'set');
  assert.equal(calls.length, 2);
});

test('shutdown restores the default effect only if the LEDs were changed', async () => {
  const unused = harness();
  await unused.sync.shutdown();
  assert.equal(unused.calls.length, 0);
  const used = harness();
  await used.sync.sync(on([agent('working')]));
  await used.sync.shutdown();
  await used.sync.shutdown();
  assert.deepEqual(used.calls.map(c => c[0]), ['set', 'reset']);
});
