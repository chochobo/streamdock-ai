import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseClaudeDesktopBadge } from './claude-desktop-badge.mjs';
import { warning } from './warnings.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('./claude-desktop-usage.swift', import.meta.url));

// No permission prompt, application activation, credential use, network call,
// or chat-body collection. The native helper outputs only matching badges.
export async function queryClaudeDesktopUsage({ execute = run, platform = process.platform } = {}) {
  if (platform !== 'darwin') return { status: 'unsupported', badges: [] };
  try {
    const { stdout } = await execute('/usr/bin/swift', [script], {
      timeout: 8_000, maxBuffer: 8_192, encoding: 'utf8', windowsHide: true,
    });
    const data = JSON.parse(stdout);
    if (!data || typeof data.status !== 'string' || !Array.isArray(data.badges)) throw new Error('Invalid result');
    if (data.badges.length > 8 || data.badges.some(v => typeof v !== 'string' || v.length > 512)) return { status: 'ambiguous', badges: [] };
    return { status: data.status, badges: data.badges };
  } catch {
    return { status: 'unavailable', badges: [] };
  }
}

/** Values are taken from a visible UI badge. updatedAt is observation time,
 * not a claim about when Claude refreshed its underlying server-side value. */
export function createClaudeDesktopUsageProvider({ query = queryClaudeDesktopUsage, maxStaleMs = 3_600_000 } = {}) {
  let last = null;
  let inFlight;
  return {
    async read({ now = Date.now() } = {}) {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        let failure = 'unavailable';
        try {
          const result = await query();
          failure = result?.status || 'unavailable';
          if (result?.status !== 'ok' || !Array.isArray(result.badges) || !result.badges.length || result.badges.length > 8) throw new Error('Unavailable');
          const observations = result.badges.map(text => parseClaudeDesktopBadge(text, { now }));
          if (observations.some(value => !value)) { failure = 'ambiguous'; throw new Error('Ambiguous badge'); }
          const fingerprints = new Set(observations.map(value => JSON.stringify([value.usedPercent, value.resetLabel || null])));
          if (fingerprints.size !== 1) { failure = 'ambiguous'; throw new Error('Conflicting badges'); }
          const value = observations[0];
          const window = { id: 'seven_day', label: '7일', usedPercent: value.usedPercent, resetsAt: null, resetLabel: value.resetLabel || null, durationMinutes: 10080 };
          last = { id: 'claude-desktop-ax', provider: 'claude', label: 'Claude Desktop · 계정 미확인', source: 'claude-desktop-ax', status: 'ok', updatedAt: new Date(now).toISOString(), windows: [window] };
          return { accounts: [last], warnings: [] };
        } catch {
          const observed = last && Date.parse(last.updatedAt);
          const issues = failure === 'permission_required' ? [{ provider: 'claude-desktop', code: 'permission_required' }] : [];
          if (Number.isFinite(observed) && now >= observed && now - observed <= maxStaleMs) {
            return { accounts: [{ ...last, status: 'stale' }], warnings: [warning('claude_desktop_usage_stale', 'Claude Desktop 화면을 읽지 못해 이전 관측값을 표시합니다.')], issues };
          }
          // The status-line provider supplies a separate unavailable card.
          const notice = failure === 'permission_required' ? warning('claude_desktop_permission_required', 'Claude Desktop 접근성 권한이 없어 사용량을 읽지 못했습니다.')
            : failure === 'ambiguous' ? warning('claude_desktop_usage_ambiguous', 'Claude Desktop에 서로 다른 사용량 표시가 있어 값을 선택하지 않았습니다.')
            : ['not_found', 'incomplete'].includes(failure) ? warning('claude_desktop_usage_not_found', 'Claude Desktop에서 주간 사용량 표시를 찾지 못했습니다.') : null;
          return { accounts: [], warnings: notice ? [notice] : [], issues };
        }
      })().finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}
