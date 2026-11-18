// Stable warning codes. Producers emit { code, message }; classification reads the
// code, so rewording a message never changes how it is shown. `summary` is the
// device summary kind (src/summary.mjs); `category` is the coarse diagnostics
// category the native app derives from the message text today.
export const WARNING_CODES = Object.freeze({
  settings_unreadable: { summary: 'settings', category: 'settings' },
  refresh_failed: { summary: 'refresh', category: 'status' },
  action_failed: { summary: 'other', category: 'other' },
  codex_history_unreadable: { summary: 'codex_history', category: 'other' },
  agent_history_unreadable: { summary: 'agent_history', category: 'other' },
  sessions_unknown: { summary: 'sessions', category: 'other' },
  claude_sessions_partial: { summary: 'claude_sessions', category: 'other' },
  codex_sessions_partial: { summary: 'codex_sessions', category: 'other' },
  codex_usage_stale: { summary: 'other', category: 'usage' },
  codex_usage_unavailable: { summary: 'other', category: 'usage' },
  claude_usage_unavailable: { summary: 'other', category: 'usage' },
  claude_desktop_usage_stale: { summary: 'other', category: 'other' },
  claude_desktop_permission_required: { summary: 'other', category: 'usage' },
  claude_desktop_usage_ambiguous: { summary: 'other', category: 'usage' },
  claude_desktop_usage_not_found: { summary: 'other', category: 'usage' },
  claude_desktop_usage_unreadable: { summary: 'other', category: 'usage' },
  credits_unreadable: { summary: 'other', category: 'credits' },
  credits_source_unsupported: { summary: 'other', category: 'other' },
  credits_browser_setup_required: { summary: 'other', category: 'settings' },
});

export const warning = (code, message) => ({ code, message });

// Legacy plain-string warnings: the exact texts the summary used to match.
function legacyCode(text) {
  if (text === '설정을 읽지 못했습니다.') return 'settings_unreadable';
  if (text.startsWith('상태를 갱신하지 못했습니다:')) return 'refresh_failed';
  if (text === 'Cannot read Codex session directory') return 'codex_history_unreadable';
  if (text === 'Cannot read streamdock-hook agent status directory' || text === 'Cannot read agentdeck-hook agent status directory') return 'agent_history_unreadable';
  if (text === '세션 실행 여부를 확인할 수 없습니다.') return 'sessions_unknown';
  if (text === 'Claude 세션 실행 여부를 일부 확인할 수 없습니다.') return 'claude_sessions_partial';
  if (text === 'Codex 열린 세션을 일부 확인할 수 없습니다.') return 'codex_sessions_partial';
  return 'unknown';
}

/** Code of a warning: its own known code, or the legacy text match for a plain string. */
export function warningCode(value) {
  if (typeof value === 'string') return legacyCode(value);
  if (value && typeof value === 'object' && Object.hasOwn(WARNING_CODES, value.code)) return value.code;
  return 'unknown';
}

/** Display text of a warning; anything else becomes an empty string. */
export function warningMessage(value) {
  if (typeof value === 'string') return value;
  return value && typeof value === 'object' && typeof value.message === 'string' ? value.message : '';
}

/** Public JSON form: `warnings` stays a string array; `warningCodes` is parallel to it. */
export function publicWarnings(list) {
  const values = Array.isArray(list) ? list : [];
  return { warnings: values.map(warningMessage), warningCodes: values.map(warningCode) };
}
