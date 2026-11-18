import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Official Codex app-server protocol. Credentials remain under Codex's control;
// this client does not read auth files, request login, or ask to refresh tokens.
export function queryCodexRateLimits({ spawnProcess = spawn, timeoutMs = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let reader;
    let timer;
    let settled = false;
    let outputBytes = 0;
    let account;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reader?.close();
      try { child?.stdin?.end(); } catch { /* already closed */ }
      try { child?.kill('SIGTERM'); } catch { /* already exited */ }
      if (error) reject(error); else resolve(value);
    }
    function send(message) {
      if (!child?.stdin?.writable) return finish(new Error('Codex service unavailable'));
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    try {
      child = spawnProcess('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
      reader = createInterface({ input: child.stdout });
      child.once('error', () => finish(new Error('Codex service unavailable')));
      child.once('exit', () => finish(new Error('Codex service exited')));
      child.stdin.on('error', () => finish(new Error('Codex service unavailable')));
      timer = setTimeout(() => finish(new Error('Codex service timed out')), timeoutMs);
      timer.unref?.();
      reader.on('line', line => {
        outputBytes += Buffer.byteLength(line);
        if (outputBytes > 1_000_000) return finish(new Error('Codex response too large'));
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.id === 0) {
          if (msg.error || !msg.result) return finish(new Error('Codex initialize failed'));
          send({ method: 'initialized', params: {} });
          send({ id: 1, method: 'account/read', params: { refreshToken: false } });
        } else if (msg.id === 1) {
          if (msg.error) return finish(new Error('Codex account unavailable'));
          account = msg.result?.account;
          if (account?.type !== 'chatgpt') return finish(null, { accountType: account?.type || null, rateLimits: null });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (msg.id === 2) {
          if (msg.error || !msg.result) return finish(new Error('Codex limits unavailable'));
          finish(null, { accountType: 'chatgpt', planType: account?.planType || null, rateLimits: msg.result });
        }
      });
      send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'streamdock-ai', title: 'StreamDock AI', version: '0.1.0' }, capabilities: {} } });
    } catch { finish(new Error('Codex service unavailable')); }
  });
}

function durationLabel(minutes, fallback) {
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}일`;
  if (minutes % 60 === 0) return `${minutes / 60}시간`;
  return `${minutes}분`;
}

function toWindow(bucketId, kind, bucket, multiple) {
  if (!bucket || typeof bucket !== 'object') return null;
  const percent = bucket.usedPercent;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  const seconds = bucket.resetsAt;
  const date = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
  const resetsAt = date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  const duration = durationLabel(bucket.windowDurationMins, kind === 'primary' ? '기본 한도' : '추가 한도');
  const durationMinutes = typeof bucket.windowDurationMins === 'number' && Number.isFinite(bucket.windowDurationMins) && bucket.windowDurationMins > 0 ? bucket.windowDurationMins : null;
  return { id: `${bucketId}:${kind}`, label: multiple ? `${bucketId} · ${duration}` : duration, usedPercent: percent, resetsAt, durationMinutes };
}

/** Convert official app-server output without exposing account identifiers or credentials. */
export function normalizeCodexUsage(result, now = Date.now()) {
  if (result?.accountType !== 'chatgpt') return null;
  const data = result.rateLimits;
  if (!data || typeof data !== 'object') return null;
  const buckets = data.rateLimitsByLimitId && typeof data.rateLimitsByLimitId === 'object'
    ? Object.entries(data.rateLimitsByLimitId).filter(([, value]) => value && typeof value === 'object') : [];
  if (!buckets.length && data.rateLimits && typeof data.rateLimits === 'object') buckets.push(['codex', data.rateLimits]);
  const windows = [];
  for (const [rawId, bucket] of buckets.slice(0, 10)) {
    const id = String(rawId).replace(/[^\w.-]/g, '').slice(0, 40) || 'codex';
    for (const kind of ['primary', 'secondary']) {
      const window = toWindow(id, kind, bucket[kind], buckets.length > 1);
      if (window) {
        // An expired reset refers to a prior window, even if the API call itself succeeded.
        // Other windows on this account may still be current.
        if (window.resetsAt && Date.parse(window.resetsAt) <= now) window.status = 'stale';
        windows.push(window);
      }
    }
  }
  if (!windows.length) return null;
  return { id: 'codex-local-account', provider: 'codex', label: 'Codex 연결 계정', status: 'ok', updatedAt: new Date(now).toISOString(), windows };
}

/** In-memory cache only. A failed update never makes a previous value fresh. */
export function createCodexUsageProvider({ query = queryCodexRateLimits, maxStaleMs = 86_400_000 } = {}) {
  let last = null;
  let inFlight;
  return {
    async read({ now = Date.now() } = {}) {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const raw = await query();
          const account = normalizeCodexUsage(raw, now);
          if (!account) throw new Error('Limits unavailable');
          last = account;
          return { accounts: [account], warnings: [] };
        } catch {
          if (last && now >= Date.parse(last.updatedAt) && now - Date.parse(last.updatedAt) <= maxStaleMs) {
            return { accounts: [{ ...last, label: 'Codex 이전 확인 (계정 미확인)', status: 'stale' }], warnings: ['Codex 사용량 갱신 실패: 마지막으로 확인한 값을 표시합니다.'] };
          }
          return { accounts: [{ id: 'codex-local-account', provider: 'codex', label: 'Codex 연결 계정', status: 'unavailable', updatedAt: null, windows: [] }], warnings: ['Codex 사용량을 확인할 수 없습니다.'] };
        }
      })().finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}
