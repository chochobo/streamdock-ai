import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePace, buildUsagePace } from '../src/usage-pace.mjs';

const now = Date.parse('2026-11-09T00:00:00Z');
const account = (id, extra = {}) => ({ id, label: id, provider: 'codex', status: 'ok', identityVerified: true, updatedAt: new Date(now).toISOString(), ...extra });
const window = (usedPercent, extra = {}) => ({ id: 'week', label: '7일', usedPercent, resetsAt: new Date(now + 3.5 * 86_400_000).toISOString(), durationMinutes: 10_080, ...extra });

test('calculates percent-point pace from the reported elapsed portion', () => {
  assert.deepEqual(calculatePace(account('a'),window(70),{now}), {elapsedPercent:50,deltaPercentPoints:20,classification:'fast'});
  assert.deepEqual(calculatePace(account('a'),window(30),{now}), {elapsedPercent:50,deltaPercentPoints:-20,classification:'relaxed'});
  assert.equal(calculatePace(account('a'),window(60),{now}).classification,'on_track');
  assert.equal(calculatePace(account('a'),window(40),{now}).classification,'on_track');
  assert.equal(calculatePace(account('a'),window(0),{now}).deltaPercentPoints,-50);
});

test('refuses stale, inferred, missing and invalid observations', () => {
  for (const [a,w] of [
    [account('a',{status:'stale'}), window(10)],
    [account('a'), window(10,{status:'stale'})],
    [account('a'), window(10,{status:'unavailable'})],
    [account('a',{estimated:true}), window(10)],
    [account('a',{confidence:'inferred'}), window(10)],
    [account('a',{updatedAt:new Date(now-16*60_000).toISOString()}), window(10)],
    [account('a',{updatedAt:null}), window(10)],
    [account('a'), window(10,{resetIsEstimate:true})],
    [account('a'), window(10,{resetsAt:null,resetLabel:'금 03:00'})],
    [account('a'), window(10,{durationMinutes:null})],
    [account('a'), window(10,{resetsAt:new Date(now).toISOString()})],
    [account('a'), window(10,{resetsAt:new Date(now+8*86_400_000).toISOString()})],
    [account('a'), window(101)],
  ]) assert.equal(calculatePace(a,w,{now}),null);
});

test('recommends only among two distinct accounts with matching real windows', () => {
  const a={...account('a'),windows:[window(70)]};
  const b={...account('b'),windows:[window(20)]};
  const c={...account('c',{status:'stale'}),windows:[window(1)]};
  const result=buildUsagePace({accounts:[a,b,c]},{now});
  assert.deepEqual(result.recommendation,{id:'b',label:'b',remainingPercent:80,durationMinutes:10080});
  assert.equal(result.accounts[2].windows[0].pace,null);
  assert.equal(buildUsagePace({accounts:[a,{...b,windows:[window(20,{durationMinutes:300,resetsAt:new Date(now+60_000).toISOString()})]}]},{now}).recommendation,null);
  assert.equal(buildUsagePace({accounts:[a,{...b,id:'a'}]},{now}).recommendation,null);
  assert.equal(buildUsagePace({accounts:[a,{...b,windows:[window(70)]}]},{now}).recommendation,null);
});

test('never compares anonymous status-line snapshots as distinct accounts', () => {
  const codex={...account('codex-local-account',{identityVerified:false}),windows:[window(60)]};
  const anonymous={...account('claude-statusline',{provider:'claude',identityVerified:false,label:'Claude 계정 미확인'}),windows:[window(20)]};
  const result=buildUsagePace({accounts:[codex,anonymous]},{now});
  assert.ok(result.accounts[1].windows[0].pace);
  assert.equal(result.recommendation,null);
});

test('chooses the longest shared horizon and honors the tightest bucket per account', () => {
  const short=(used)=>window(used,{id:'short',durationMinutes:300,resetsAt:new Date(now+60*60_000).toISOString()});
  const a={...account('a'),windows:[window(10),window(90,{id:'extra'}),short(5)]};
  const b={...account('b'),windows:[window(30),short(70)]};
  assert.deepEqual(buildUsagePace({accounts:[a,b]},{now}).recommendation,{id:'b',label:'b',remainingPercent:70,durationMinutes:10080});
});
