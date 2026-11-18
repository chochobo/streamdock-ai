import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexUsageProvider, normalizeCodexUsage } from '../src/usage-codex.mjs';

const sample = { accountType:'chatgpt', rateLimits:{ rateLimits:{ primary:{usedPercent:25,windowDurationMins:300,resetsAt:1794168000},secondary:{usedPercent:80,windowDurationMins:10080,resetsAt:1794500000} } } };

test('normalizes official used percentages and reset seconds without invented windows',()=>{
  const account=normalizeCodexUsage(sample, 1794160000000);
  assert.equal(account.status,'ok');
  assert.deepEqual(account.windows.map(x=>[x.id,x.label,x.usedPercent]),[['codex:primary','5시간',25],['codex:secondary','7일',80]]);
  assert.equal(account.windows[0].resetsAt,new Date(1794168000*1000).toISOString());
  assert.equal(normalizeCodexUsage({...sample, accountType:'apiKey'}),null);
  assert.equal(normalizeCodexUsage({accountType:'chatgpt',rateLimits:{rateLimits:{primary:null}}}),null);
});

test('separate model limit buckets remain separate and invalid values are omitted',()=>{
  const a=normalizeCodexUsage({accountType:'chatgpt',rateLimits:{rateLimitsByLimitId:{codex:{primary:{usedPercent:19,windowDurationMins:300,resetsAt:null}},other:{primary:{usedPercent:42,windowDurationMins:60,resetsAt:1794168000},secondary:{usedPercent:101}}}}});
  assert.deepEqual(a.windows.map(x=>x.id),['codex:primary','other:primary']);
  assert.equal(a.windows[0].resetsAt,null);
});

test('failed reads preserve original timestamp, expire, and never report stale as current',async()=>{
  let fail=false; const p=createCodexUsageProvider({query:async()=>{if(fail)throw new Error('secret should not leak');return sample},maxStaleMs:1000});
  let r=await p.read({now:1794160000000}); assert.equal(r.accounts[0].status,'ok');
  fail=true; r=await p.read({now:1794160000500}); assert.equal(r.accounts[0].status,'stale');assert.match(r.accounts[0].label,/계정 미확인/);assert.equal(r.accounts[0].updatedAt,new Date(1794160000000).toISOString());assert.equal(JSON.stringify(r).includes('secret'),false);
  r=await p.read({now:1794160002000}); assert.equal(r.accounts[0].status,'unavailable');assert.deepEqual(r.accounts[0].windows,[]);
});


test('marks only an expired limit window as stale and preserves the other window', () => {
  const now = 1794168000000;
  const account = normalizeCodexUsage(sample, now);
  assert.equal(account.status, 'ok');
  assert.equal(account.windows[0].status, 'stale');
  assert.equal(account.windows[0].usedPercent, 25);
  assert.notEqual(account.windows[1].status, 'stale');
  assert.equal(account.windows[1].usedPercent, 80);
  const missingReset = { accountType: 'chatgpt', rateLimits: { rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300 } } } };
  assert.notEqual(normalizeCodexUsage(missingReset, now).windows[0].status, 'stale');
});
