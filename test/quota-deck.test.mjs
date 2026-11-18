import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createDeck } from '../src/deck.mjs';
import { keyTileSvg } from '../src/device.mjs';

const account = (status = 'ok') => ({ id: 'one', provider: 'codex', label: 'Codex', status,
  windows: [{ id: '5h', label: '5시간', usedPercent: 37, resetsAt: '2026-11-09T06:30:00.000Z' },
    { id: '7d', label: '7일', usedPercent: 89, resetsAt: null }] });

test('quota view shows measured usage and reset separately and returns to projects', () => {
  const deck = createDeck();
  let state = deck.commit(deck.plan([], { accounts: [account()] }));
  assert.equal(state.keys[12].action, 'usage');
  assert.deepEqual(deck.press(12, state.revision), { type: 'navigate' });
  state = deck.commit(deck.plan([], { accounts: [account()] }));
  assert.equal(state.view, 'usage');
  assert.equal(state.keys[0].kind, 'quota');
  assert.equal(state.keys[0].usedPercent, 37);
  assert.equal(state.keys[0].windowLabel, '5시간');
  assert.equal(state.keys[1].kind, 'quota-reset');
  assert.match(state.keys[1].resetDate, /^\d{2}\/\d{2}$/);
  assert.match(state.keys[1].resetTime, /^\d{2}:\d{2}$/);
  assert.equal(state.keys[3].resetTime, null);
  assert.equal(state.keys[12].action, 'back');
  assert.deepEqual(deck.press(12, state.revision), { type: 'navigate' });
  assert.equal(deck.commit(deck.plan([], { accounts: [account()] })).view, 'projects');
});

test('quota view does not fabricate missing or invalid values and distinguishes stale data', () => {
  const deck = createDeck();
  let state = deck.commit(deck.plan([]));
  deck.press(12, state.revision);
  state = deck.commit(deck.plan([], { accounts: [{ id: 'bad', label: 'Claude', provider: 'claude', status: 'ok', windows: [
    { id: 'bad', label: '5시간', usedPercent: 200, resetsAt: 'not a date' },
  ] }, account('stale'), { id: 'none', label: 'Codex', provider: 'codex', status: 'unavailable', windows: [] }] }));
  const invalid = state.keys.find(k => k.kind === 'quota' && k.provider === 'claude');
  const invalidReset = state.keys.find(k => k.kind === 'quota-reset' && k.provider === 'claude');
  const stale = state.keys.find(k => k.kind === 'quota' && k.usageStatus === 'stale');
  const unavailable = state.keys.find(k => k.kind === 'quota' && k.usageStatus === 'unavailable');
  assert.equal(invalid.usedPercent, null);
  assert.equal(invalidReset.resetTime, null);
  assert.equal(stale.usedPercent, 37);
  assert.equal(unavailable.usedPercent, null);
  const staleSvg = keyTileSvg(stale);
  assert.match(staleSvg, /37%/);
  assert.match(staleSvg, /이전|오래됨/);
  const missingSvg = keyTileSvg(invalid);
  assert.match(missingSvg, /미확인/);
  assert.doesNotMatch(missingSvg, /200%/);
});

test('quota windows paginate without separating usage and reset keys', async () => {
  const deck = createDeck();
  const quota = { accounts: Array.from({ length: 7 }, (_, i) => ({ ...account(), id: `account-${i}`, label: `계정${i}`, windows: [account().windows[0]] })) };
  let state = deck.commit(deck.plan([], quota));
  deck.press(12, state.revision);
  state = deck.commit(deck.plan([], quota));
  assert.equal(state.pages, 2);
  assert.equal(state.keys.filter(k => k.kind === 'quota').length, 6);
  assert.equal(state.keys[14].action, 'next');
  assert.equal(state.keys[11].kind, 'quota-reset');
  assert.deepEqual(deck.press(14, state.revision), { type: 'navigate' });
  const second = deck.commit(deck.plan([], quota));
  assert.equal(second.page, 2);
  assert.equal(second.keys[0].label, 'Codex 7');
  assert.equal(second.keys[0].accountLabel, '계정6');
  assert.equal(second.keys[1].kind, 'quota-reset');
  assert.equal(deck.press(13, state.revision).type, 'stale');
  for (const key of [second.keys[0], second.keys[1]]) {
    const jpeg = await sharp(Buffer.from(keyTileSvg(key))).rotate(-90).jpeg({ quality: 85 }).toBuffer();
    assert.ok(jpeg.length > 0 && jpeg.length <= 10240);
  }
});

test('home reserves features and usage keys after 11 live projects and orders account labels stably', () => {
  const deck = createDeck();
  const projects = Array.from({ length: 13 }, (_, i) => ({ id: `session-${i}`, projectId: `project-${i}`, project: `project-${i}`, status: 'unknown', presence: 'live' }));
  let state = deck.commit(deck.plan(projects));
  assert.equal(state.pages, 2);
  assert.equal(state.keys.slice(0, 11).filter(k => k.kind === 'project').length, 11);
  assert.equal(state.keys[11].action, 'modes');
  assert.equal(state.keys[12].action, 'usage');
  assert.equal(state.keys[14].action, 'next');
  deck.press(12, state.revision);
  const accounts = [{ ...account(), id: 'b', label: 'Second', windows: [account().windows[0]] }, { ...account(), id: 'a', label: 'First', windows: [account().windows[0]] }];
  state = deck.commit(deck.plan(projects, { accounts }));
  assert.equal(state.keys[0].label, 'Codex 1');
  assert.equal(state.keys[0].accountLabel, 'First');
  assert.equal(state.keys[2].label, 'Codex 2');
  assert.equal(state.keys[2].accountLabel, 'Second');
  const reordered = deck.commit(deck.plan(projects, { accounts: accounts.reverse() }));
  assert.equal(reordered.keys[0].accountLabel, 'First');
  assert.equal(reordered.keys[2].accountLabel, 'Second');
});

test('shows only reported Codex windows and keeps other buckets separate', () => {
  const deck = createDeck();
  let state = deck.commit(deck.plan([]));
  deck.press(12, state.revision);
  state = deck.commit(deck.plan([], { accounts: [{ id: 'codex', label: 'Codex', provider: 'codex', status: 'ok', windows: [
    { id: 'codex:secondary', label: 'codex · 7일', usedPercent: 27, resetsAt: null },
    { id: 'spark:primary', label: 'spark · 5시간', usedPercent: 38, resetsAt: null },
  ] }] }));
  assert.equal(state.keys[0].windowLabel, '7일');
  assert.equal(state.keys[0].bucketId, 'codex');
  assert.equal(state.keys[0].usedPercent, 27);
  assert.equal(state.keys[1].kind, 'quota-reset');
  assert.equal(state.keys[2].windowLabel, '5시간');
  assert.equal(state.keys[2].bucketId, 'spark');
  assert.equal(state.keys[2].usedPercent, 38);
  assert.equal(state.keys[3].kind, 'quota-reset');
  assert.equal(state.keys[4].kind, 'empty');
});

test('shows a validated Desktop weekday reset without inventing a date', () => {
  const deck = createDeck();
  let state = deck.commit(deck.plan([]));
  deck.press(12, state.revision);
  const account = { id: 'claude-desktop', provider: 'claude', status: 'ok',
    windows: [{ id: 'weekly', label: '7일', usedPercent: 7, resetsAt: null, resetLabel: '금 03:00' }] };
  state = deck.commit(deck.plan([], { accounts: [account] }));
  assert.equal(state.keys[1].kind, 'quota-reset');
  assert.equal(state.keys[1].resetDate, '금');
  assert.equal(state.keys[1].resetTime, '03:00');
  for (const invalid of ['금 25:00', '금 03:60', '금요일 03:00', '금 3:00', '금 03:00 extra', '<금 03:00>']) {
    account.windows[0].resetLabel = invalid;
    state = deck.commit(deck.plan([], { accounts: [account] }));
    assert.equal(state.keys[1].resetDate, null, invalid);
    assert.equal(state.keys[1].resetTime, null, invalid);
  }
});

test('hub can open usage safely without a synthetic physical press', () => {
  const deck = createDeck();
  const agents = [{id:'a',projectId:'p',project:'project',status:'idle',presence:'live'}];
  const home = deck.commit(deck.plan(agents));
  assert.equal(deck.openUsage().type, 'navigate');
  assert.equal(deck.press(0, home.revision).type, 'busy');
  const quota = deck.commit(deck.plan(agents, {accounts:[account()]}));
  assert.equal(quota.view, 'usage');
  assert.notEqual(quota.revision, home.revision);
  assert.equal(deck.press(0, home.revision).type, 'stale');
});

test('unknown accounts occupy one tile and available windows stay paired across pages', () => {
  const deck = createDeck();
  let state = deck.commit(deck.plan([]));
  deck.press(12, state.revision);
  const accountList = [
    { id: 'unknown', provider: 'codex', label: 'Codex', status: 'unavailable', windows: [] },
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `claude-${i}`, provider: 'claude', label: `Claude ${i}`, status: 'ok',
      windows: [{ id: 'week', label: '7일', usedPercent: i * 10, resetsAt: '2026-11-10T10:00:00Z' }]
    }))
  ];
  state = deck.commit(deck.plan([], { accounts: accountList }));
  assert.equal(state.pages, 2);
  assert.equal(state.keys[0].kind, 'quota');
  assert.equal(state.keys[0].accountUnavailable, true);
  assert.equal(state.keys[0].usedPercent, null);
  assert.equal(state.keys[1].kind, 'quota');
  assert.equal(state.keys[2].kind, 'quota-reset');
  assert.equal(state.keys[11].kind, 'empty');
  deck.press(14, state.revision);
  state = deck.commit(deck.plan([], { accounts: accountList }));
  assert.equal(state.keys[0].kind, 'quota');
  assert.equal(state.keys[1].kind, 'quota-reset');
});


test('marks an expired window stale without dimming the current window on the same account', () => {
  const deck = createDeck();
  deck.openUsage();
  const source = account();
  source.windows[0].status = 'stale';
  const state = deck.commit(deck.plan([], { accounts: [source] }));
  const keys = state.keys.filter(key => key.kind === 'quota');
  assert.equal(keys[0].usedPercent, 37);
  assert.equal(keys[0].usageStatus, 'stale');
  assert.equal(keys[1].usedPercent, 89);
  assert.equal(keys[1].usageStatus, 'ok');
});
