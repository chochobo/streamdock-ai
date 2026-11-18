import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeDesktopBadge } from '../src/claude-desktop-badge.mjs';

test('parses Korean weekly all-model badge without inventing a date', () => {
  assert.deepEqual(parseClaudeDesktopBadge('사용량: 주간 · 모든 모델: 7% (금) 오전 3:00에 초기화'), {
    usedPercent: 7, resetsAt: null, resetLabel: '금 03:00',
  });
});

test('parses English weekly all-model badge and 12-hour clock', () => {
  const result = parseClaudeDesktopBadge('Usage: Weekly · All models: 12.5% resets Fri 3:30 PM');
  assert.deepEqual(result, { usedPercent: 12.5, resetsAt: null, resetLabel: '금 15:30' });
});

test('handles zero values and midday/midnight correctly', () => {
  assert.deepEqual(parseClaudeDesktopBadge('사용량: 주간 · 모든 모델: 0% (금) 오전 12:00에 초기화'), {usedPercent: 0, resetsAt: null, resetLabel: '금 00:00'});
  assert.deepEqual(parseClaudeDesktopBadge('Usage: Weekly · All models: 100% resets Sunday 12:00 PM'), {usedPercent: 100, resetsAt: null, resetLabel: '일 12:00'});
});

test('refuses unrelated, ambiguous, or invalid usage data', () => {
  for (const value of [
    '사용량: 주간 · Fable: 10% (금) 오전 3:00',
    '주간 · 모든 모델: 12% (금) 오전 3:00',
    'Usage: Weekly · All models: 101%',
    'Usage: Weekly · All models: 1% · Weekly · All models: 2%',
    '사용량: 이번 세션 7%',
  ]) assert.equal(parseClaudeDesktopBadge(value), null, value);
});

test('keeps percentage but does not invent missing, ambiguous, or malformed reset', () => {
  for (const value of [
    '사용량: 주간 · 모든 모델: 7%',
    '사용량: 주간 · 모든 모델: 7% (금) 오전 13:15에 초기화',
    'Usage: Weekly · All models: 8% resets sometime later',
    'Usage: Weekly · All models: 8% Fable resets Fri 3:00 PM',
  ]) {
    const result = parseClaudeDesktopBadge(value);
    assert.notEqual(result, null);
    assert.equal(result.resetsAt, null);
    assert.equal(result.resetLabel, null);
  }
});
