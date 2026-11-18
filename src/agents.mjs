import { promises as fs } from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPresenceProvider } from './presence.mjs';

const STATES = new Set(['working', 'blocked', 'done', 'idle', 'error', 'unknown']);
const TAIL_BYTES = 512 * 1024;
const MAX_FILES = 150;
const codexCache = new Map();
const defaultPresenceProvider = createPresenceProvider();

function codexId(session) {
  return `codex-${createHash('sha256').update(session).digest('hex').slice(0, 24)}`;
}
function claudeId(session) {
  return `claude-code-${createHash('sha256').update(session).digest('hex').slice(0, 24)}`;
}

async function projectIdFor(cwd, project) {
  const resolved = typeof cwd === 'string' && path.isAbsolute(cwd)
    ? await fs.realpath(cwd).catch(() => path.resolve(cwd)) : null;
  // Legacy hook records have only a basename; namespace separately to avoid merging different directories.
  const key = resolved ? `path:${resolved}` : `legacy:${String(project || 'Unknown')}`;
  return `project-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
}

function cleanText(value, max = 80) {
  return typeof value === 'string' ? Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()).slice(0, max).join('') : '';
}

function cleanTitle(value) {
  // Session titles can contain paths; keep those private while retaining a readable label.
  return cleanText(value, 200).replace(/(^|[\s([{])\/(?:[^\s)\]}>]+\/)*[^\s)\]}>]+/g, '$1[경로]').slice(0, 80);
}

function isSubagentSource(source) {
  return source === 'subagent' || Boolean(source && typeof source === 'object' && Object.hasOwn(source, 'subagent'));
}

let titleIndexCache = { file: null, key: null, names: new Map() };
async function readCodexTitles(home) {
  const file = path.join(home, '.codex', 'session_index.jsonl');
  try {
    const stat = await fs.stat(file);
    if (stat.size > 5_000_000) return new Map();
    const key = `${stat.size}:${stat.mtimeMs}`;
    if (titleIndexCache.file === file && titleIndexCache.key === key) return titleIndexCache.names;
    const names = new Map();
    for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
      try { const row = JSON.parse(line); const title = cleanTitle(row.thread_name); if (typeof row.id === 'string' && title) names.set(codexId(row.id), title); } catch { /* incomplete line */ }
    }
    titleIndexCache = { file, key, names };
    return names;
  } catch { return new Map(); }
}

const claudeDesktopFileCache = new Map();
async function readClaudeDesktopIndex(home) {
  const appDir = path.join(home, 'Library', 'Application Support', 'Claude');
  const root = path.join(appDir, 'claude-code-sessions');
  const empty = () => ({ records: [], foreignOnlyIds: new Set() });
  try {
    const configFile = path.join(appDir, 'config.json');
    const configStat = await fs.lstat(configFile);
    if (!configStat.isFile() || configStat.size > 1024*1024) return empty();
    const activeAccount = JSON.parse(await fs.readFile(configFile, 'utf8')).lastKnownAccountUuid;
    if (typeof activeAccount !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(activeAccount)) return empty();
    const accounts = (await fs.readdir(root, {withFileTypes:true})).filter(e => e.isDirectory() && /^[0-9a-f-]{36}$/i.test(e.name)).slice(0,100);
    const folders = (await Promise.all(accounts.map(async account => {
      const dir = path.join(root, account.name);
      try { return (await fs.readdir(dir, {withFileTypes:true})).filter(e => e.isDirectory()).slice(0,100).map(e=>({folder:path.join(dir,e.name), account:account.name})); } catch { return []; }
    }))).flat();
    // The application selects a session using both account and organization.
    // The active organization is not exposed in config, so only one folder is unambiguous.
    const activeFolders = folders.filter(item => item.account === activeAccount);
    const onlyOrganization = activeFolders.length === 1 ? path.basename(activeFolders[0].folder) : '';
    const activeOrganization = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(onlyOrganization) ? onlyOrganization : null;
    const paths = (await Promise.all(folders.map(async ({folder, account}) => {
      try { return (await fs.readdir(folder,{withFileTypes:true})).filter(e=>e.isFile() && /^local_[A-Za-z0-9_-]+\.json$/.test(e.name)).map(e=>({file:path.join(folder,e.name), account})); } catch { return []; }
    }))).flat().slice(0,1000);
    const pathSet = new Set(paths.map(p => p.file));
    for (const key of claudeDesktopFileCache.keys()) if (!pathSet.has(key)) claudeDesktopFileCache.delete(key);
    const observations = (await Promise.all(paths.map(async ({file,account})=>{
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > 1024*1024) return null;
        const key = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
        let cached = claudeDesktopFileCache.get(file);
        if (!cached || cached.key !== key) {
          const row = JSON.parse(await fs.readFile(file,'utf8'));
          const cli = row.cliSessionId, local = row.sessionId;
          if (typeof cli !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cli) || typeof local !== 'string' || !/^local_[A-Za-z0-9_-]+$/.test(local) || path.basename(file) !== `${local}.json`) return null;
          const cwd = typeof row.cwd === 'string' && path.isAbsolute(row.cwd) ? row.cwd : null;
          cached = {key, cli, local, cwd, account, organization:path.basename(path.dirname(file)), archived:row.isArchived, title:cleanTitle(row.title), updated:Number(row.lastActivityAt) || stat.mtimeMs};
          claudeDesktopFileCache.set(file, cached);
        }
        // Config can change accounts even when metadata has not changed.
        if (cached.account !== account) return null;
        return cached;
      } catch { return null; }
    }))).filter(Boolean);
    const byCli = new Map();
    for (const o of observations) {
      const list = byCli.get(o.cli) || [];
      list.push(o);
      byCli.set(o.cli,list);
    }
    const foreignOnlyIds = new Set();
    const unique = [];
    for (const [cli, list] of byCli) {
      if (!list.some(o => o.account === activeAccount)) { foreignOnlyIds.add(claudeId(cli)); continue; }
      const allAccounts = new Set(list.map(o=>o.account));
      const localIds = new Set(list.map(o=>o.local));
      if (allAccounts.size !== 1 || localIds.size !== 1) continue;
      const o = list.find(o=>o.account===activeAccount && o.organization===activeOrganization && o.archived===false);
      if (activeOrganization && o) unique.push(o);
    }
    unique.sort((a,b)=>b.updated-a.updated);
    const records = await Promise.all(unique.slice(0,100).map(async o=>{
      const project = path.basename(o.cwd || 'Unknown').slice(0,80);
      const updated = o.updated < 1e12 ? o.updated*1000 : o.updated;
      return {id:claudeId(o.cli), provider:'claude', project, projectId:await projectIdFor(o.cwd,project), isSubagent:false,
        title:o.title||undefined,status:'unknown',stale:true,updatedAt:Number.isFinite(updated)?new Date(updated).toISOString():null,source:'claude-desktop-index',
        _target:{provider:'claude',sessionId:o.cli,cwd:o.cwd,origin:'claude-desktop',desktopSessionId:o.local,desktopSessionUnique:true,desktopArchived:false,desktopAccountId:activeAccount,desktopOrganizationId:activeOrganization}};
    }));
    return { records, foreignOnlyIds };
  } catch { return empty(); }
}

const claudeCache = new Map();
async function readClaudeIndex(home) {
  const root = path.join(home, '.claude', 'projects');
  try {
    const directories = (await fs.readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).slice(0, 500);
    const perDir = await Promise.all(directories.map(async dir => {
      const folder = path.join(root, dir.name);
      try {
        const entries = await fs.readdir(folder, { withFileTypes: true });
        return await Promise.all(entries.filter(e => e.isFile() && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(e.name)).map(async entry => {
          const file = path.join(folder, entry.name);
          try { return {file, stat: await fs.lstat(file), sessionId: entry.name.slice(0, -6)}; } catch { return null; }
        }));
      } catch { return []; }
    }));
    const files = perDir.flat().filter(item => item?.stat.isFile()).sort((a,b) => b.stat.mtimeMs-a.stat.mtimeMs).slice(0,100);
    const retained = new Set(files.map(item => item.file));
    for (const key of claudeCache.keys()) if (!retained.has(key)) claudeCache.delete(key);
    const records = await Promise.all(files.map(async ({file,stat,sessionId}) => {
      try {
        const key = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        let metadata = claudeCache.get(file);
        if (!metadata || metadata.key !== key) {
          const handle = await fs.open(file, 'r');
          try {
            const chunk = await readSlice(handle, 0, Math.min(stat.size, 128*1024));
            for (const line of chunk.split('\n')) {
              try {
                const row = JSON.parse(line);
                if (row.sessionId === sessionId && row.isSidechain === false && typeof row.cwd === 'string' && path.isAbsolute(row.cwd)) {
                  metadata = { key, cwd: row.cwd };
                  claudeCache.set(file, metadata);
                  break;
                }
              } catch { /* incomplete or non-JSON line */ }
            }
          } finally { await handle.close(); }
        }
        if (!metadata) return null;
        const project = path.basename(metadata.cwd).slice(0, 80);
        return { id: claudeId(sessionId), provider: 'claude', project, projectId: await projectIdFor(metadata.cwd, project),
          isSubagent: false, status: 'unknown', stale: true, updatedAt: new Date(stat.mtimeMs).toISOString(), source: 'claude-index',
          _target: { provider: 'claude', sessionId, cwd: metadata.cwd, origin: 'unknown' } };
      } catch { return null; }
    }));
    return records.filter(Boolean);
  } catch { return []; }
}

let threadIndexCache = { file: null, key: null, records: [] };
async function readCodexThreadIndex(home) {
  const file = path.join(home, '.codex', 'state_5.sqlite');
  try {
    const stat = await fs.stat(file);
    const wal = await fs.stat(`${file}-wal`).catch(() => null);
    const key = `${stat.size}:${stat.mtimeMs}:${wal?.size || 0}:${wal?.mtimeMs || 0}`;
    if (threadIndexCache.file === file && threadIndexCache.key === key) return threadIndexCache.records;
    // Only local user-chat metadata is queried. A saved chat is not evidence of a running turn.
    const sql = "SELECT id,cwd,COALESCE(NULLIF(name,''),title) AS title,originator,source,COALESCE(updated_at_ms,updated_at*1000) AS updated FROM threads WHERE archived=0 AND (thread_source='user' OR (thread_source IS NULL AND source IN ('vscode','cli'))) ORDER BY COALESCE(recency_at_ms,updated_at_ms,updated_at*1000) DESC LIMIT 100";
    const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', file, sql], { timeout: 3000, maxBuffer: 2_000_000 });
    const rows = stdout.trim() ? JSON.parse(stdout) : [];
    const records = await Promise.all(rows.map(async row => {
      if (typeof row.id !== 'string') return null;
      const cwd = typeof row.cwd === 'string' && path.isAbsolute(row.cwd) ? row.cwd : null;
      const project = path.basename(cwd || 'Unknown').slice(0, 80);
      const updated = Number(row.updated);
      const updatedAt = Number.isFinite(updated) && updated > 0 ? new Date(updated).toISOString() : null;
      const origin = row.originator === 'Codex Desktop' ? 'codex-desktop' : row.source === 'cli' ? 'cli' : 'unknown';
      return { id: codexId(row.id), provider: 'codex', project, projectId: await projectIdFor(cwd, project),
        isSubagent: false, title: cleanTitle(row.title) || undefined, status: 'unknown', stale: true,
        updatedAt, source: 'codex-index', _target: { provider: 'codex', sessionId: row.id, cwd, origin } };
    }));
    threadIndexCache = { file, key, records: records.filter(Boolean) };
    return threadIndexCache.records;
  } catch { return []; } // Missing or changed internal schema: continue using rollout logs.
}

function normalizeStatus(status, updatedMs, now, maxAgeMs) {
  const stale = !Number.isFinite(updatedMs) || now - updatedMs > maxAgeMs || updatedMs > now + 60_000;
  return { status: stale || !STATES.has(status) ? 'unknown' : status, stale };
}

async function listDirectory(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function readHooks(dir, source, now, maxAgeMs, warnings) {
  let entries;
  try { entries = await listDirectory(dir); }
  catch { warnings.push(`Cannot read ${source} agent status directory`); return []; }
  const records = await Promise.all(entries.filter(e => e.isFile() && e.name.endsWith('.json')).slice(0, 500).map(async entry => {
    try {
      const stat = await fs.stat(path.join(dir, entry.name));
      if (stat.size > 32_768 || now - stat.mtimeMs > 86_400_000) return null;
      const record = JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8'));
      const provider = record.agent === 'claude-code' ? 'claude' : record.agent;
      if (!['claude', 'codex'].includes(provider) || typeof record.id !== 'string') return null;
      const updatedMs = typeof record.updated === 'number' ? record.updated * 1000 : Date.parse(record.updatedAt);
      let { status, stale } = normalizeStatus(record.status, updatedMs, now, maxAgeMs);
      // A permission hook can fire even when the request is immediately resolved.
      if (record.status === 'blocked' && (record.confidence === 'inferred' || provider === 'codex') && now - updatedMs > 30_000) {
        status = 'unknown';
        stale = true;
      }
      const id = provider === 'codex' && typeof record.session === 'string' ? codexId(record.session)
        : provider === 'codex' && /^codex-[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(record.id) ? codexId(record.id.slice(6))
        : provider === 'claude' && typeof record.session === 'string' ? claudeId(record.session)
        : record.id.slice(0, 160);
      const project = path.basename(String(record.project || record.cwd || 'Unknown')).slice(0, 80);
      const cwd = typeof record.cwd === 'string' && path.isAbsolute(record.cwd) ? record.cwd : null;
      const sessionId = typeof record.session === 'string' ? record.session : null;
      return { id, provider, status, project,
        projectId: await projectIdFor(cwd, project),
        isSubagent: record.isSubagent === true || record.top === false,
        _target: sessionId ? { provider, sessionId, cwd, pid: record.pid, tty: record.tty,
          bundle: record.bundle, processStart: record.processStart, origin: record.origin || 'unknown' } : undefined,
        updatedAt: Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : null,
        _statusEvidenceMs: Number.isFinite(updatedMs) && (typeof record.event === 'string' || record.status !== 'unknown') ? updatedMs : null,
        event: typeof record.event === 'string' && /^[A-Za-z]{1,40}$/.test(record.event) ? record.event : undefined,
        reportedPresence: ['live', 'ended'].includes(record.presence) ? record.presence : undefined,
        confidence: record.confidence === 'inferred' || provider === 'codex' ? 'inferred' : 'observed',
        stale, source };
    } catch { return null; }
  }));
  return records.filter(Boolean);
}

async function readSlice(handle, start, length) {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await handle.read(bytes, 0, length, start);
  return bytes.subarray(0, bytesRead).toString('utf8');
}

// Codex rollout logs are an observed, unofficial source. Only session metadata and
// task lifecycle event types are retained. Prompt and response text is discarded.
function subagentDisplayName(meta) {
  const source = meta?.source;
  const isSubagent = source === 'subagent' || (source && typeof source === 'object' && Object.hasOwn(source, 'subagent'));
  if (!isSubagent || typeof meta.agent_nickname !== 'string') return undefined;
  const clean = meta.agent_nickname.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return Array.from(clean).slice(0, 24).join('') || undefined;
}

async function parseCodexFile(file, stat, now, maxAgeMs) {
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  let observed = codexCache.get(file);
  if (!observed || observed.cacheKey !== cacheKey) {
    const handle = await fs.open(file, 'r');
    try {
      const first = await readSlice(handle, 0, Math.min(stat.size, TAIL_BYTES));
      const newline = first.indexOf('\n');
      if (newline < 0) return null;
      const meta = JSON.parse(first.slice(0, newline));
      if (meta.type !== 'session_meta' || !meta.payload?.id) return null;
      const tail = stat.size <= TAIL_BYTES ? first : await readSlice(handle, stat.size - TAIL_BYTES, TAIL_BYTES);
      let event = null;
      let eventMs = NaN;
      let lastActivityMs = NaN;
      for (const line of tail.split('\n')) {
        try {
          const row = JSON.parse(line);
          const timestamp = Date.parse(row.timestamp);
          if (row.type === 'event_msg' && Number.isFinite(timestamp)) lastActivityMs = timestamp;
          if (row.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(row.payload?.type)) {
            event = row.payload.type;
            eventMs = timestamp;
          }
        } catch { /* A partial or concurrent write is expected. */ }
      }
      const inferred = event === 'task_started' ? 'working' : event === 'task_complete' ? 'done' : 'unknown';
      // A working turn can run for a long time; recent event activity keeps it fresh.
      // A completed turn keeps its own event timestamp, even if other records follow.
      const updatedMs = inferred === 'working' && Number.isFinite(lastActivityMs) ? lastActivityMs
        : Number.isFinite(eventMs) ? eventMs : stat.mtimeMs;
      const cwd = typeof meta.payload.cwd === 'string' && path.isAbsolute(meta.payload.cwd) ? meta.payload.cwd : null;
      const project = path.basename(cwd || 'Unknown').slice(0, 80);
      const originator = meta.payload.originator;
      const origin = originator === 'Codex Desktop' ? 'codex-desktop' : originator === 'codex_cli_rs' ? 'cli' : 'unknown';
      observed = { cacheKey, inferred, updatedMs, event, eventMs, id: codexId(String(meta.payload.id)),
        provider: 'codex', project, projectId: await projectIdFor(cwd, project),
        isSubagent: isSubagentSource(meta.payload.source),
        _target: { provider: 'codex', sessionId: String(meta.payload.id), cwd, origin },
        displayName: subagentDisplayName(meta.payload), source: 'codex-rollout' };
      codexCache.set(file, observed);
    } finally { await handle.close(); }
  }
  const { status, stale } = normalizeStatus(observed.inferred, observed.updatedMs, now, maxAgeMs);
  return { id: observed.id, provider: observed.provider, project: observed.project, projectId: observed.projectId,
    isSubagent: observed.isSubagent, _target: observed._target, displayName: observed.displayName, source: observed.source,
    updatedAt: new Date(observed.updatedMs).toISOString(), event: observed.event || undefined,
    _statusEvidenceMs: Number.isFinite(observed.eventMs) ? observed.eventMs : null, status, stale };
}

async function readCodex(home, now, maxAgeMs, warnings) {
  const root = path.join(home, '.codex', 'sessions');
  const candidates = [];
  // Include previous days because sessions can continue after midnight.
  for (let days = 0; days < 7; days++) {
    const date = new Date(now - days * 86_400_000);
    const dir = path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    let entries;
    try { entries = await listDirectory(dir); }
    catch { warnings.push('Cannot read Codex session directory'); continue; }
    const files = await Promise.all(entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(async entry => {
      const file = path.join(dir, entry.name);
      try { return { file, stat: await fs.stat(file) }; } catch { return null; }
    }));
    candidates.push(...files.filter(item => item && now - item.stat.mtimeMs <= 3_600_000));
  }
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const current = new Set(candidates.slice(0, MAX_FILES).map(item => item.file));
  for (const key of codexCache.keys()) if (!current.has(key)) codexCache.delete(key);
  return (await Promise.all(candidates.slice(0, MAX_FILES).map(async ({file, stat}) => {
    try { return await parseCodexFile(file, stat, now, maxAgeMs); } catch { return null; }
  }))).filter(Boolean);
}

/** Return recent local agent observations without returning conversation text.
 * now is milliseconds since epoch; maxAgeMs controls when an observation becomes unknown. */
export async function readAgents({ home = os.homedir(), now = Date.now(), maxAgeMs = 5 * 60_000, presenceProvider = undefined } = {}) {
  const warnings = [];
  // A custom home is a fixture or alternate profile; never scan the host's processes for it.
  const detector = presenceProvider !== undefined ? presenceProvider
    : process.env.STREAMDOCK_PRESENCE_DISABLED === '1' || path.resolve(home) !== path.resolve(os.homedir()) ? null : defaultPresenceProvider;
  const presenceRead = detector && typeof detector.read === 'function'
    ? Promise.resolve().then(() => detector.read()).catch(() => null) : Promise.resolve(null);
  const [own, deck, codex, codexIndex, claudeIndex, claudeDesktopIndex, processPresence] = await Promise.all([
    readHooks(path.join(home, '.cache', 'streamdock-ai', 'agents'), 'streamdock-hook', now, maxAgeMs, warnings),
    readHooks(path.join(home, '.cache', 'd200', 'agents'), 'agentdeck-hook', now, maxAgeMs, warnings),
    readCodex(home, now, maxAgeMs, warnings),
    readCodexThreadIndex(home),
    readClaudeIndex(home),
    readClaudeDesktopIndex(home),
    presenceRead,
  ]);
  if (detector) {
    if (!processPresence) warnings.push('세션 실행 여부를 확인할 수 없습니다.');
    else {
      if (!processPresence.codex?.available) warnings.push('Codex 열린 세션을 일부 확인할 수 없습니다.');
      if (!processPresence.claude?.available) warnings.push('Claude 세션 실행 여부를 일부 확인할 수 없습니다.');
    }
  }
  // Prefer the newest observation for an identical provider/session ID.
  const unique = new Map();
  // Exclude transcript-only sessions known exclusively to belong to a different Desktop account.
  const visibleClaude = claudeIndex.filter(item => !claudeDesktopIndex.foreignOnlyIds.has(item.id));
  for (const record of [...own, ...deck, ...codex, ...codexIndex, ...visibleClaude, ...claudeDesktopIndex.records]) {
    const existing = unique.get(record.id);
    if (!existing) unique.set(record.id, record);
    else {
      const isIndex = item => ['codex-index', 'claude-index', 'claude-desktop-index'].includes(item.source);
      // File mtime or unrelated event activity cannot supersede an explicit status event.
      const evidenceTime = item => Number.isFinite(item._statusEvidenceMs) ? item._statusEvidenceMs : -Infinity;
      const terminalEvent = item => ['task_complete', 'turn_aborted', 'SessionEnd', 'Interrupt'].includes(item.event);
      const recordTime = evidenceTime(record);
      const existingTime = evidenceTime(existing);
      const newest = isIndex(record) && !isIndex(existing) ? existing : isIndex(existing) && !isIndex(record) ? record
        : recordTime > existingTime ? record : recordTime < existingTime ? existing
        : terminalEvent(record) && !terminalEvent(existing) ? record : existing;
      // Preserve session metadata even when a newer hook provides the state.
      const metadata = [record, existing].find(item => item.source === 'codex-rollout') || [record, existing].find(item => isIndex(item)) || newest;
      const privateSource = [record, existing].find(item => item._target?.processStart && item._target?.tty) || [record, existing].find(item => ['codex-desktop','claude-desktop'].includes(item._target?.origin)) || [record, existing].find(item => item._target) || metadata;
      unique.set(record.id, { ...newest, project: metadata.project, projectId: metadata.projectId,
        isSubagent: metadata.isSubagent, _target: privateSource._target, title: record.title || existing.title, displayName: record.displayName || existing.displayName });
    }
  }
  const priority = { blocked: 0, working: 1, error: 2, done: 3, idle: 4, unknown: 5 };
  const titles = await readCodexTitles(home);
  const targets = new Map();
  const agents = [...unique.values()].map(({ _target, _statusEvidenceMs, reportedPresence, ...record }) => {
    if (_target) targets.set(record.id, _target);
    // File/process evidence proves that a session is loaded or its process exists,
    // not that a turn is currently working.
    let presence = 'unknown';
    let presenceEvidence = 'none';
    const codexLive = record.provider === 'codex' && _target?.origin === 'codex-desktop'
      && processPresence?.codex?.ids instanceof Set && processPresence.codex.ids.has(record.id);
    const trustedClaude = (_target?.origin === 'claude-desktop' && _target?.desktopSessionUnique === true
      && _target?.desktopArchived === false && typeof _target?.desktopAccountId === 'string'
      && typeof _target?.desktopOrganizationId === 'string')
      || (Number.isSafeInteger(_target?.pid) && typeof _target?.processStart === 'string' && typeof _target?.tty === 'string');
    const claudeLive = record.provider === 'claude' && trustedClaude
      && processPresence?.claude?.ids instanceof Set && processPresence.claude.ids.has(record.id);
    const observedMs = Date.parse(record.updatedAt || '');
    const freshEvent = Number.isFinite(observedMs) && now >= observedMs && now - observedMs <= 15_000;
    if (reportedPresence === 'ended') {
      // An open file can remain cached after the explicit session-end event.
      presence = 'ended';
      presenceEvidence = 'session-end';
    } else if (codexLive || claudeLive) {
      presence = 'live';
      presenceEvidence = codexLive ? 'codex-open-rollout' : 'claude-process';
    } else if (freshEvent && (reportedPresence === 'live'
      || (record.source === 'codex-rollout' && record.status === 'working')
      || (record.provider === 'claude' && record.source === 'streamdock-hook' && record.event && record.status !== 'unknown'))) {
      presence = 'live';
      presenceEvidence = 'recent-event';
    }
    const confidence = record.status === 'unknown' ? 'unknown'
      : record.confidence === 'inferred' || record.source === 'codex-rollout' ? 'inferred' : 'observed';
    const title = record.provider === 'codex' && !record.isSubagent ? (record.title || titles.get(record.id)) : undefined;
    return { ...record, ...(title ? { title } : {}), presence, presenceEvidence, confidence };
  }).sort((a, b) => priority[a.status] - priority[b.status] || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { agents, warnings, targets };
}
