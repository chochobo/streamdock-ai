import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeDesktopUsageProvider, queryClaudeDesktopUsage } from '../src/usage-claude-desktop.mjs';

const label = '사용량: 주간 · 모든 모델: 7% (금) 오전 3:00에 초기화';
const date = Date.parse('2026-11-08T18:00:00Z');

test('reads only confirmed weekly badge and marks reset as UI label', async () => {
  const provider = createClaudeDesktopUsageProvider({ query: async () => ({ status: 'ok', badges: [label] }) });
  const result = await provider.read({ now: date });
  assert.equal(result.accounts.length, 1);
  const account = result.accounts[0];
  assert.equal(account.status, 'ok');
  assert.equal(account.source, 'claude-desktop-ax');
  assert.equal(account.windows[0].usedPercent, 7);
  assert.equal(account.windows[0].resetLabel, '금 03:00');
  assert.equal(account.windows[0].resetsAt, null);
  assert.ok(!JSON.stringify(result).includes(label));
});

test('does not choose between conflicting UI badges', async () => {
  const provider = createClaudeDesktopUsageProvider({ query: async () => ({status:'ok',badges:[label,label.replace('7%', '8%')]}) });
  const result = await provider.read({ now: date });
  assert.equal(result.accounts.length, 0);
  assert.match(result.warnings[0], /다른 사용량/);
});

test('unreadable UI never presents old value as current and expires it', async () => {
  let ok = true;
  const provider = createClaudeDesktopUsageProvider({ query: async () => ok ? {status:'ok',badges:[label]} : {status:'not_found',badges:[]}, maxStaleMs: 60_000 });
  await provider.read({now:date}); ok = false;
  const stale = await provider.read({now:date+30_000});
  assert.equal(stale.accounts[0].status,'stale');
  assert.equal(stale.accounts[0].updatedAt,new Date(date).toISOString());
  const expired = await provider.read({now:date+60_001});
  assert.deepEqual(expired.accounts,[]);
});

test('permission and unsupported platform do not launch or prompt', async () => {
  let executed = false;
  const unsupported = await queryClaudeDesktopUsage({platform:'linux',execute:async()=>{executed=true;}});
  assert.equal(unsupported.status,'unsupported');
  assert.equal(executed,false);
  const provider = createClaudeDesktopUsageProvider({query:async()=>({status:'permission_required',badges:[]})});
  const result = await provider.read({now:date});
  assert.deepEqual(result.accounts,[]);
  assert.match(result.warnings[0], /권한/);
  assert.deepEqual(result.issues, [{ provider: 'claude-desktop', code: 'permission_required' }]);
});

test('keeps the permission issue when a prior usage observation is stale', async () => {
  let available = true;
  const provider = createClaudeDesktopUsageProvider({query:async()=>available ? {status:'ok',badges:[label]} : {status:'permission_required',badges:[]}});
  await provider.read({now:date});
  available = false;
  const result = await provider.read({now:date+1000});
  assert.equal(result.accounts[0].status,'stale');
  assert.deepEqual(result.issues, [{provider:'claude-desktop',code:'permission_required'}]);
});

test('does not silently discard conflicting excess native badges', async () => {
  const result = await queryClaudeDesktopUsage({ platform: 'darwin', execute: async () => ({stdout: JSON.stringify({status:'ok',badges:Array(9).fill(label)})}) });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.badges, []);
});
