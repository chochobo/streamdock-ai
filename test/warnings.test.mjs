import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSummary } from '../src/summary.mjs';
import { WARNING_CODES, warning, warningCode, warningMessage, publicWarnings } from '../src/warnings.mjs';

// Every message a producer emits today, with its code.
const PRODUCED = [
  ['settings_unreadable', '설정을 읽지 못했습니다.'],
  ['refresh_failed', '상태를 갱신하지 못했습니다: ENOENT'],
  ['action_failed', '업데이트를 완료하지 못했습니다.'],
  ['codex_history_unreadable', 'Cannot read Codex session directory'],
  ['agent_history_unreadable', 'Cannot read streamdock-hook agent status directory'],
  ['agent_history_unreadable', 'Cannot read agentdeck-hook agent status directory'],
  ['sessions_unknown', '세션 실행 여부를 확인할 수 없습니다.'],
  ['claude_sessions_partial', 'Claude 세션 실행 여부를 일부 확인할 수 없습니다.'],
  ['codex_sessions_partial', 'Codex 열린 세션을 일부 확인할 수 없습니다.'],
  ['codex_usage_stale', 'Codex 사용량 갱신 실패: 마지막으로 확인한 값을 표시합니다.'],
  ['codex_usage_unavailable', 'Codex 사용량을 확인할 수 없습니다.'],
  ['claude_usage_unavailable', 'Claude 사용량을 확인할 수 없습니다.'],
  ['claude_desktop_usage_stale', 'Claude Desktop 화면을 읽지 못해 이전 관측값을 표시합니다.'],
  ['claude_desktop_permission_required', 'Claude Desktop 접근성 권한이 없어 사용량을 읽지 못했습니다.'],
  ['claude_desktop_usage_ambiguous', 'Claude Desktop에 서로 다른 사용량 표시가 있어 값을 선택하지 않았습니다.'],
  ['claude_desktop_usage_not_found', 'Claude Desktop에서 주간 사용량 표시를 찾지 못했습니다.'],
  ['claude_desktop_usage_unreadable', 'Claude Desktop 사용량을 읽지 못했습니다.'],
  ['credits_unreadable', '크레딧 정보를 읽지 못했습니다.'],
  ['credits_source_unsupported', 'Flow: 지원하지 않는 수집 방식입니다.'],
  ['credits_browser_setup_required', 'Flow: 전용 브라우저 설정이 필요합니다.'],
];

// Mirror of DiagnosticsReport.warningKinds in native/App/DiagnosticsReport.swift.
const nativeCategory = text => text.includes('설정') ? 'settings' : text.includes('크레딧') ? 'credits'
  : text.includes('사용량') ? 'usage' : text.includes('상태') ? 'status' : 'other';

test('every code is covered and every produced message keeps its code-free classification', () => {
  assert.deepEqual([...new Set(PRODUCED.map(([code]) => code))].sort(), Object.keys(WARNING_CODES).sort());
  for (const [code, message] of PRODUCED) {
    const coded = buildSummary([], null, [warning(code, message)]).warningKind;
    assert.equal(coded, buildSummary([], null, [message]).warningKind, code);
    assert.equal(coded, WARNING_CODES[code].summary, code);
    assert.equal(WARNING_CODES[code].category, nativeCategory(message), code);
  }
});

test('each source producer emits only known codes', () => {
  for (const file of ['agents', 'credits', 'usage-codex', 'usage-claude-desktop', 'server']) {
    const source = readFileSync(new URL(`../src/${file}.mjs`, import.meta.url), 'utf8');
    for (const [, code] of source.matchAll(/\bwarning\('([a-z_]+)'/g)) assert.ok(Object.hasOwn(WARNING_CODES, code), `${file}: ${code}`);
    assert.doesNotMatch(source, /warnings\.push\(['`]/, `${file} pushes an uncoded warning`);
  }
});

test('classification by code survives a reworded message', () => {
  assert.equal(buildSummary([], null, [warning('settings_unreadable', 'Settings could not be read')]).warningKind, 'settings');
  assert.equal(buildSummary([], null, [warning('refresh_failed', 'Refresh failed')]).warningKind, 'refresh');
  assert.equal(buildSummary([], null, [warning('codex_sessions_partial', 'x'), warning('claude_sessions_partial', 'y')]).warningKind, 'sessions');
  assert.equal(buildSummary([], null, [warning('claude_sessions_partial', '다르게 바꾼 문구')]).warningKind, 'claude_sessions');
  // A coded warning whose text happens to match a legacy rule is still classified by its code.
  assert.equal(buildSummary([], null, [warning('action_failed', '설정을 읽지 못했습니다.')]).warningKind, 'other');
});

test('plain string warnings still classify by the legacy text rules', () => {
  assert.equal(buildSummary([], null, ['설정을 읽지 못했습니다.']).warningKind, 'settings');
  assert.equal(buildSummary([], null, ['상태를 갱신하지 못했습니다: boom']).warningKind, 'refresh');
  assert.equal(buildSummary([], null, ['something new']).warningKind, 'other');
  // Priority across mixed string and coded warnings is unchanged.
  assert.equal(buildSummary([], null, [warning('codex_sessions_partial', 'x'), '설정을 읽지 못했습니다.']).warningKind, 'settings');
  assert.equal(buildSummary([], null, []).warningKind, null);
  assert.equal(buildSummary([], null, [42]).warningKind, null);
});

test('public form keeps string warnings with a parallel code array', () => {
  assert.deepEqual(publicWarnings([warning('sessions_unknown', 'a'), '설정을 읽지 못했습니다.', 'free text', { code: 'nope', message: 'b' }]),
    { warnings: ['a', '설정을 읽지 못했습니다.', 'free text', 'b'], warningCodes: ['sessions_unknown', 'settings_unreadable', 'unknown', 'unknown'] });
  assert.deepEqual(publicWarnings(undefined), { warnings: [], warningCodes: [] });
  assert.equal(warningCode(null), 'unknown');
  assert.equal(warningMessage({ code: 'x' }), '');
});

test('the native diagnostics report maps every warning code to the same category', async () => {
  const { readFile } = await import('node:fs/promises');
  const swift = await readFile(new URL('../native/App/DiagnosticsReport.swift', import.meta.url), 'utf8');
  const start = swift.indexOf('= [', swift.indexOf('warningCategories'));
  const block = swift.slice(start, swift.indexOf('\n    ]', start));
  const mapped = Object.fromEntries([...block.matchAll(/"([a-z_]+)":\s*"([a-z]+)"/g)].map(m => [m[1], m[2]]));
  const expected = Object.fromEntries(Object.entries(WARNING_CODES).map(([code, info]) => [code, info.category]));
  assert.deepEqual(mapped, expected);
});
