import test from 'node:test';
import assert from 'node:assert/strict';
import { translateKeys } from '../src/i18n.mjs';

test('translates app-owned control and feature text and preserves dynamic values', () => {
  const keys = [
    {kind:'control',label:'뒤로'},
    {kind:'feature',id:'timer-start-25',label:'25분',caption:'시작'},
    {kind:'feature',id:'machine-memory',label:'메모리 사용',caption:'약 37%'},
    {kind:'feature',id:'settings-idle-5',label:'대기 5분',caption:'선택됨'},
    {kind:'quota',label:'Codex',windowLabel:'한도',resetDate:'금',resetTime:'03:00'},
  ];
  const got = translateKeys(keys,'en');
  assert.deepEqual(got.map(k=>k.label),['Back','25 min','Memory Used','Idle 5m','Codex']);
  assert.equal(got[1].caption,'Start');
  assert.equal(got[2].caption,'~37%');
  assert.equal(got[4].windowLabel,'Limit');
  assert.equal(got[4].resetDate,'Fri');
  assert.equal(keys[0].label,'뒤로');
});

test('does not translate external titles even if they match a UI word', () => {
  const keys = [
    {kind:'project',label:'게임',caption:'작업 2'},
    {kind:'session',label:'택배'},
    {kind:'feature',id:'market-quote-0',label:'에이전트',caption:'+1.2%'},
    {kind:'feature',id:'parcel-0',label:'택배',caption:'도착'},
    {kind:'feature',id:'remote-12345678901234567890-machine',label:'머신',caption:'머신'},
    {kind:'feature',id:'worktree-wt-123',label:'기록',caption:'사용 중'},
    {kind:'feature',id:'credit-service',label:'게임',caption:'123'},
    {kind:'feature',label:'게임',caption:'시작'},
  ];
  const got=translateKeys(keys,'en');
  assert.deepEqual(got.map(k=>k.label),keys.map(k=>k.label));
  assert.equal(got[3].caption,'Delivered');
  assert.equal(got[5].caption,'Active');
});

test('uses safe fallback and keeps Korean unchanged', () => {
  const keys=[{kind:'feature',id:'x',label:'사용자 고유 이름',caption:'알 수 없는 내용'}];
  assert.deepEqual(translateKeys(keys,'en'),keys);
  assert.equal(translateKeys(keys,'ko'),keys);
  assert.equal(translateKeys(keys,'fr'),keys);
  assert.equal(translateKeys(null,'en'),null);
});
