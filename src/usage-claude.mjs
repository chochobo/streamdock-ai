import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A Claude Code status line is local and receives official rate_limits fields.
// It contains no verified account ID, so snapshots from different sources are
// kept separate and explicitly labelled as unattributed.
const MAX_BYTES = 64 * 1024;
const MAX_FUTURE_MS = 60_000;
const WINDOW_DEFS = [
  { id: 'five_hour', label: '5시간', capture: 'fiveHour', durationMinutes: 300 },
  { id: 'seven_day', label: '7일', capture: 'sevenDay', durationMinutes: 10080 },
];

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = Math.abs(value) < 10_000_000_000 ? value * 1000 : value;
    return Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function windowValue(raw, def, shape) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = shape === 'capture' ? raw.usedPercentage : raw.used_percentage;
  const usedPercent = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  const resetsAt = timestamp(shape === 'capture' ? raw.resetsAt : raw.resets_at);
  if (usedPercent === null && resetsAt === null) return null;
  return { id: def.id, label: def.label, usedPercent, resetsAt, durationMinutes: def.durationMinutes };
}

async function readSnapshot(file) {
  let handle;
  try {
    // Never follow a symlink into another file, and bound reads before parsing.
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const raw = await handle.readFile({ encoding: 'utf8' });
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? { value, mtime: stat.mtime.toISOString() } : null;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

function accountFrom(snapshot, { id, label, source, shape }, nowMs, maxAgeMs) {
  if (!snapshot) return null;
  const { value } = snapshot;
  if (shape === 'capture' && (value.provider !== 'claude' || value.source !== 'claude-statusline')) return null;
  const observedAt = shape === 'capture' ? timestamp(value.observedAt) : snapshot.mtime;
  if (!observedAt) return null;
  const age = nowMs - Date.parse(observedAt);
  if (!Number.isFinite(age) || age < -MAX_FUTURE_MS) return null;
  const rateLimits = shape === 'capture' ? value : value.rate_limits;
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const windows = WINDOW_DEFS.map(def => windowValue(rateLimits[shape === 'capture' ? def.capture : def.id], def, shape)).filter(Boolean);
  if (!windows.length) return null;
  const pastReset = windows.some(window => window.resetsAt && Date.parse(window.resetsAt) <= nowMs);
  return { id, provider: 'claude', label, source, status: age > maxAgeMs || pastReset ? 'stale' : 'ok', updatedAt: observedAt, windows };
}

/** Read local Claude Code rate-limit snapshots. No secrets or prompts are returned.
 * No account identifier is provided by statusline, so each source stays unattributed. */
export async function readClaudeUsage({ home = os.homedir(), now = Date.now(), maxAgeMs = 15 * 60_000 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new TypeError('Invalid time or maxAgeMs');
  const sources = [
    { id: 'claude-statusline', label: 'Claude Code · 계정 미확인', source: 'claude-statusline', shape: 'capture', file: path.join(home, '.cache', 'streamdock-ai', 'usage', 'claude-statusline.json') },
    { id: 'claude-agentdeck', label: 'Claude · AgentDeck · 계정 미확인', source: 'agentdeck-statusline', shape: 'agentdeck', file: path.join(home, '.cache', 'd200', 'claude_status.json') },
  ];
  const raw = await Promise.all(sources.map(source => readSnapshot(source.file)));
  const accounts = sources.map((source, i) => accountFrom(raw[i], source, nowMs, maxAgeMs)).filter(Boolean);
  if (!accounts.length) accounts.push({ id: 'claude-statusline', provider: 'claude', label: 'Claude Code · 계정 미확인', source: 'claude-statusline', status: 'unavailable', updatedAt: null, windows: [] });
  return { accounts, warnings: [] };
}
