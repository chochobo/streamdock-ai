// Pace is a time-normalized quota observation, not a model-quality ranking.
// We need a recent real observation, an explicit duration and exact reset.
const DEFAULT_MAX_AGE_MS = 15 * 60_000;
const FUTURE_TOLERANCE_MS = 60_000;

function knownAccount(account) {
  // Multiple anonymous status-line sources can describe the same account.
  // Compare only a verified identity or the current authenticated Codex CLI.
  return account?.identityVerified === true || (account?.provider === 'codex' && account?.id === 'codex-local-account');
}

function trusted(account, window, now, maxAgeMs) {
  if (!account || account.status !== 'ok' || account.estimated === true || account.confidence === 'inferred') return false;
  if (!window || window.status === 'stale' || window.status === 'unavailable' || window.estimated === true || window.resetEstimated === true || window.resetIsEstimate === true || window.confidence === 'inferred') return false;
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return false;
  const updated = typeof account.updatedAt === 'string' ? Date.parse(account.updatedAt) : NaN;
  if (!Number.isFinite(updated) || now - updated > maxAgeMs || updated - now > FUTURE_TOLERANCE_MS) return false;
  return true;
}

/** A positive delta means quota is being used faster than elapsed time. */
export function calculatePace(account, window, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (!trusted(account, window, now, maxAgeMs)) return null;
  const used = window.usedPercent;
  const duration = window.durationMinutes;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null;
  if (!Number.isInteger(duration) || duration <= 0 || duration > 5_256_000) return null;
  const reset = typeof window.resetsAt === 'string' ? Date.parse(window.resetsAt) : NaN;
  const durationMs = duration * 60_000;
  if (!Number.isFinite(reset) || reset <= now || reset - now > durationMs) return null;
  const elapsedPercent = (1 - (reset - now) / durationMs) * 100;
  const deltaPercentPoints = used - elapsedPercent;
  return {
    elapsedPercent,
    deltaPercentPoints,
    classification: deltaPercentPoints > 10 ? 'fast' : deltaPercentPoints < -10 ? 'relaxed' : 'on_track',
  };
}

/**
 * Compare only eligible windows of the same duration from known accounts. A
 * recommendation is omitted when fewer than two accounts are comparable or
 * they tie; anonymous sources can still show their own individual pace.
 * If multiple durations match, use the longest shared window. Within an
 * account, its most-used eligible bucket for that duration is the limit.
 */
export function buildUsagePace(usage = {}, options = {}) {
  const source = Array.isArray(usage.accounts) ? usage.accounts : [];
  const grouped = new Map();
  const accounts = source.filter(account => account && typeof account === 'object').map(account => {
    const windows = (Array.isArray(account.windows) ? account.windows : []).map(window => {
      const pace = calculatePace(account, window, options);
      if (pace && knownAccount(account) && typeof account.id === 'string' && account.id) {
        const duration = window.durationMinutes;
        if (!grouped.has(duration)) grouped.set(duration, new Map());
        const bucket = grouped.get(duration);
        const previous = bucket.get(account.id);
        if (!previous || window.usedPercent > previous.usedPercent) {
          bucket.set(account.id, { id: account.id, label: String(account.label || account.provider || '계정'), usedPercent: window.usedPercent });
        }
      }
      return { id: window?.id, label: window?.label, pace };
    });
    return { id: account.id, label: account.label, provider: account.provider, windows };
  });
  const comparable = [...grouped.entries()].filter(([, accountsById]) => accountsById.size >= 2).sort((a, b) => b[0] - a[0]);
  let recommendation = null;
  if (comparable.length) {
    const [durationMinutes, byId] = comparable[0];
    const ordered = [...byId.values()].sort((a, b) => a.usedPercent - b.usedPercent);
    if (ordered[0].usedPercent < ordered[1].usedPercent) {
      recommendation = { id: ordered[0].id, label: ordered[0].label, remainingPercent: 100 - ordered[0].usedPercent, durationMinutes };
    }
  }
  return { accounts, recommendation };
}
