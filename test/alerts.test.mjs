import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertTracker } from '../src/alerts.mjs';

const stamp = '2026-01-01T00:00:00.000Z';
const now = Date.parse(stamp);
const agent = (id, status, overrides = {}) => ({ id, projectId: 'p', status, presence: 'live', source: 'streamdock-hook', confidence: 'observed', updatedAt: stamp, ...overrides });
const plan = {
  keys: [{ kind: 'project', index: 0, state: 'working', caption: '작업 1' }, { kind: 'session', index: 1, state: 'done' }],
  bindings: [{ projectId: 'p' }, { sessionId: 'b' }],
  projects: [{ id: 'p', counts: { blocked: 0, working: 1, done: 1 } }],
};

test('unread completion pulses on its session and project until acknowledged', () => {
  const alerts = createAlertTracker();
  alerts.update([agent('a', 'working'), agent('b', 'done')], now);
  const lit = alerts.decorate(plan, now);
  assert.equal(lit.keys[0].state, 'done');
  assert.equal(lit.keys[0].caption, '완료 1');
  assert.equal(lit.keys[0].alertPulse, true);
  assert.equal(lit.keys[1].alertPulse, true);
  assert.equal(alerts.decorate(plan, now + 1000).keys[1].alertPulse, false);
  assert.equal(alerts.acknowledge('b'), true);
  alerts.update([agent('a', 'working'), agent('b', 'done')], now + 2000);
  assert.equal(alerts.decorate(plan, now + 2000).keys[0].state, 'working');
  assert.equal(alerts.decorate(plan, now + 2000).keys[1].alertPulse, undefined);
});

test('a fresh explicit new event re-arms but ordinary index timestamps do not', () => {
  const alerts = createAlertTracker();
  alerts.update([agent('b', 'done')], now);
  alerts.acknowledge('b');
  alerts.update([agent('b', 'done', { source: 'codex-index', updatedAt: new Date(now + 1000).toISOString() })], now + 1000);
  assert.equal(alerts.decorate(plan, now + 1000).keys[1].alertPulse, undefined);
  alerts.update([agent('b', 'done', { updatedAt: new Date(now + 2000).toISOString() })], now + 2000);
  assert.equal(alerts.decorate(plan, now + 2000).keys[1].alertPulse, true);
});

test('unavailable, ended, stale and old sessions do not flash or invent state', () => {
  const alerts = createAlertTracker();
  for (const overrides of [{ presence: 'ended' }, { presence: 'unknown' }, { stale: true }, { isSubagent: true }]) {
    alerts.update([agent('b', 'done', overrides)], now);
    assert.equal(alerts.decorate(plan, now).keys[1].alertPulse, undefined);
  }
  alerts.update([agent('b', 'done')], now + 301000);
  assert.equal(alerts.decorate(plan, now + 301000).keys[1].alertPulse, undefined);
});

test('blocked takes priority and inferred state remains marked uncertain', () => {
  const alerts = createAlertTracker();
  alerts.update([agent('a', 'blocked', { confidence: 'inferred' }), agent('b', 'done')], now);
  const decorated = alerts.decorate({ ...plan, projects: [{ id: 'p', counts: { blocked: 1, done: 1 } }] }, now);
  assert.equal(decorated.keys[0].state, 'blocked');
  assert.equal(decorated.keys[0].caption, '확인 1?');
  assert.equal(decorated.keys[0].estimated, true);
  alerts.update([agent('a', 'working'), agent('b', 'done')], now + 1000);
  assert.equal(alerts.decorate(plan, now + 1000).keys[0].state, 'done');
});
