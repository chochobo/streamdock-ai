import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idFor = (provider, id) => `${provider}-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
const unavailable = () => ({ available: false, ids: new Set() });
const copy = result => ({ codex: { ...result.codex, ids: new Set(result.codex.ids) }, claude: { ...result.claude, ids: new Set(result.claude.ids) } });

function processList(output, uid) {
  const list = [];
  for (const line of String(output || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match || Number(match[3]) !== uid) continue;
    list.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[4] });
  }
  return list;
}

// Read only the bounded metadata header, and return an opaque ID. Rollout
// contents and paths never leave this module.
async function rolloutId(file, root) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith('.jsonl')) return null;
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const h = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(stat.size, 65_536));
    const { bytesRead } = await h.read(buf, 0, buf.length, 0);
    const data = buf.subarray(0, bytesRead).toString('utf8');
    const end = data.indexOf('\n');
    if (end < 0) return null;
    const first = JSON.parse(data.slice(0, end));
    const id = first?.type === 'session_meta' ? first.payload?.id : null;
    return typeof id === 'string' && UUID.test(id) ? idFor('codex', id) : null;
  } finally { await h.close(); }
}

async function identity(run, proc, uid) {
  const result = await run('/bin/ps', ['-ww', '-p', String(proc.pid), '-o', 'pid=,ppid=,uid=,lstart=,comm='], { timeout: 2500, maxBuffer: 8192 });
  const value = String(result.stdout || '').trim();
  const fields = /^(\d+)\s+(\d+)\s+(\d+)\s+/.exec(value);
  if (!fields || Number(fields[1]) !== proc.pid || Number(fields[2]) !== proc.ppid || Number(fields[3]) !== uid || !value.endsWith(proc.command)) throw new Error('Process identity changed');
  return value;
}

async function inspectCodex(list, run, home, uid) {
  const appPids = new Set(list.filter(p => /\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)$/.test(p.command)).map(p => p.pid));
  const candidates = list.filter(p => appPids.has(p.ppid) && path.basename(p.command) === 'codex' && /\/(?:ChatGPT|Codex)\.app\/Contents\//.test(p.command));
  const result = { available: true, ids: new Set() };
  if (candidates.length > 12) return unavailable();
  const deadline = Date.now() + 5000;
  for (const proc of candidates) {
    if (Date.now() >= deadline) { result.available = false; break; }
    try {
      const before = await identity(run, proc, uid);
      if (Date.now() >= deadline) throw new Error('Scan timed out');
      const argsResult = await run('/bin/ps', ['-ww', '-p', String(proc.pid), '-o', 'args='], { timeout: 2500, maxBuffer: 131072 });
      if (!/(?:^|\s)app-server(?:\s|$)/.test(String(argsResult.stdout || ''))) continue;
      if (Date.now() >= deadline) throw new Error('Scan timed out');
      const open = await run('/usr/sbin/lsof', ['-nP', '-p', String(proc.pid), '-Fn'], { timeout: 4000, maxBuffer: 2_097_152 });
      if (Date.now() >= deadline) throw new Error('Scan timed out');
      const after = await identity(run, proc, uid);
      if (before !== after) throw new Error('Process identity changed');
      const root = path.join(home, '.codex', 'sessions');
      const files = new Set(String(open.stdout || '').split('\n').filter(line => line.startsWith('n/') && line.endsWith('.jsonl')).map(line => line.slice(1)).filter(file => file.startsWith(root + path.sep)));
      if (files.size > 1000) throw new Error('Too many rollouts');
      const ids = await Promise.all([...files].map(file => rolloutId(file, root).catch(() => null)));
      for (const id of ids) {
        if (id) result.ids.add(id);
        else result.available = false;
      }
    } catch { result.available = false; break; }
  }
  return result;
}

async function inspectClaude(list, run, uid) {
  const candidates = list.filter(p => path.basename(p.command) === 'claude');
  const result = { available: true, ids: new Set() };
  if (candidates.length > 100) return unavailable();
  const deadline = Date.now() + 5000;
  for (const proc of candidates) {
    if (Date.now() >= deadline) { result.available = false; break; }
    try {
      const before = await identity(run, proc, uid);
      if (Date.now() >= deadline) throw new Error('Scan timed out');
      const argsResult = await run('/bin/ps', ['-ww', '-p', String(proc.pid), '-o', 'args='], { timeout: 2500, maxBuffer: 131072 });
      const args = String(argsResult.stdout || '');
      const matches = [...args.matchAll(/(?:^|\s)--resume(?:=|\s+)([0-9a-f-]{36})(?=\s|$)/ig)].map(match => match[1]);
      if (Date.now() >= deadline) throw new Error('Scan timed out');
      const after = await identity(run, proc, uid);
      if (before !== after) throw new Error('Process identity changed');
      if (matches.length === 1 && UUID.test(matches[0])) result.ids.add(idFor('claude-code', matches[0]));
      else result.available = false; // A live process without a correlatable session is not evidence of absence.
    } catch { result.available = false; }
  }
  return result;
}

/** Loaded-process evidence only. It does not establish a running turn or approval state. */
export function createPresenceProvider({ home = os.homedir(), platform = process.platform, uid = process.getuid?.(), run = exec, now = Date.now, cacheMs = 5000 } = {}) {
  let cached;
  let cachedAt = -Infinity;
  let inFlight;
  return {
    async read() {
      const current = now();
      if (cached && current >= cachedAt && current - cachedAt < cacheMs) return copy(cached);
      if (inFlight) return copy(await inFlight);
      inFlight = (async () => {
        if (platform !== 'darwin' || !Number.isSafeInteger(uid)) return { codex: unavailable(), claude: unavailable() };
        try {
          const output = await run('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,uid=,comm='], { timeout: 4000, maxBuffer: 2_097_152 });
          const list = processList(output.stdout, uid);
          const [codex, claude] = await Promise.all([inspectCodex(list, run, home, uid), inspectClaude(list, run, uid)]);
          return { codex, claude };
        } catch { return { codex: unavailable(), claude: unavailable() }; }
      })().then(result => { cached = result; cachedAt = now(); return result; }).finally(() => { inFlight = undefined; });
      return copy(await inFlight);
    },
  };
}
