import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_TARGETS = 1000;
const MAX_TRASH_ENTRIES = 10_000;
const MAX_OUTPUT = 2 * 1024 * 1024;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const REVIEWED_MOLE_VERSION = '1.64.0';

export function runCleanupProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeout = 180_000, env } = options;
    const child = spawn(command, args, { env, shell: false, detached: process.platform !== 'win32',
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let size = 0, cause = null, escalation;
    function signal(name) {
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, name); else child.kill(name); }
      catch (error) { if (error.code !== 'ESRCH') { try { child.kill(name); } catch {} } }
    }
    function stop(reason) {
      if (cause) return;
      cause = reason;
      signal('SIGTERM');
      escalation = setTimeout(() => signal('SIGKILL'), 1000);
      escalation.unref?.();
    }
    function capture(target, chunk) {
      size += chunk.length;
      if (size > MAX_OUTPUT) { stop('output_limit'); return; }
      target.push(chunk);
    }
    child.stdout?.on('data', chunk => capture(stdout, chunk));
    child.stderr?.on('data', chunk => capture(stderr, chunk));
    const timer = setTimeout(() => stop('timeout'), timeout);
    timer.unref?.();
    child.on('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error); });
    child.on('close', (code, signalName) => {
      clearTimeout(timer); clearTimeout(escalation);
      const out = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (cause || code !== 0) reject(Object.assign(new Error(cause || 'process_failed'), { code, signal: signalName, reason: cause }));
      else resolve(out);
    });
  });
}

async function defaultMolePath() {
  const dirs = [...new Set((process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin').split(path.delimiter).filter(Boolean))];
  for (const dir of dirs) {
    const candidate = path.join(dir, 'mo');
    try { await fs.access(candidate, constants.X_OK); return await fs.realpath(candidate); } catch { /* try next */ }
  }
  return null;
}

// Deny bare sudo calls from the reviewed non-root Mole scripts; never modify the user's PATH or sudo state.
async function guardedMole(pathname, args, { timeout = 180_000 } = {}) {
  if (!path.isAbsolute(pathname) || (typeof process.getuid === 'function' && process.getuid() === 0)) throw new Error('unsafe executable or identity');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamdock-no-sudo-'));
  try {
    await fs.writeFile(path.join(dir, 'sudo'), '#!/bin/sh\nexit 1\n', { mode: 0o700, flag: 'wx' });
    const env = { ...process.env, PATH: dir + path.delimiter + (process.env.PATH || '/usr/bin:/bin'),
      SUDO_ASKPASS: '/usr/bin/false', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', TERM: 'dumb' };
    return await runCleanupProcess(pathname, args, { timeout, env });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function sizeBytes(value) {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return null;
  const power = ['B', 'KB', 'MB', 'GB', 'TB'].indexOf(match[2].toUpperCase());
  const number = Math.round(Number(match[1]) * (1024 ** power));
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function safeTarget(raw, home) {
  if (typeof raw !== 'string' || !raw || /[\u0000-\u001f\u007f]/.test(raw) || raw.includes('[cloud]')) return null;
  const expanded = raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) return null;
  const normalized = path.resolve(expanded);
  const relative = path.relative(home, normalized);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  return normalized;
}

export function parseMolePreview(kind, stdout, listText = '', home = os.homedir()) {
  const output = String(stdout || '').replace(ANSI, '');
  const targets = [];
  let malformed = false;
  if (!['clean', 'purge'].includes(kind)) throw new TypeError('Unknown Mole action');
  if (kind === 'clean') {
    if (typeof listText !== 'string' || listText.length > MAX_OUTPUT || !listText.includes('Mole Cleanup Preview')) malformed = true;
    for (const line of String(listText || '').split(/\r?\n/)) {
      if (!line || line.startsWith('#') || /^\s*===/.test(line)) continue;
      const index = line.lastIndexOf('  # ');
      if (index < 0) { malformed = true; continue; }
      const target = safeTarget(line.slice(0, index), home);
      const match = line.slice(index + 4).match(/^([\d.]+\s*[KMGT]?B)(?:,.*)?$/i);
      const bytes = match ? sizeBytes(match[1]) : null;
      if (!target || bytes === null) { malformed = true; continue; }
      targets.push({ path: target, estimatedBytes: bytes });
    }
  } else {
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes('[DRY RUN]')) continue;
      const match = line.match(/\[DRY RUN\]\s+(.+),\s*([\d.]+\s*[KMGT]?B)\s*$/i);
      const target = match && safeTarget(match[1].trim(), home);
      const bytes = match ? sizeBytes(match[2]) : null;
      if (!target || bytes === null) { malformed = true; continue; }
      targets.push({ path: target, estimatedBytes: bytes });
    }
  }
  const sizeMatch = output.match(kind === 'clean' ? /Potential space:\s*([\d.]+\s*[KMGT]?B)(\+)?/i : /Would free(?: approximately)?:\s*([\d.]+\s*[KMGT]?B)(\+)?/i);
  const noItems = /no artifacts were removed|nothing to (?:clean|purge)|no additional space/i.test(output);
  const estimatedBytes = sizeMatch ? sizeBytes(sizeMatch[1]) : noItems ? 0 : null;
  const countMatch = output.match(/\bItems:\s*(\d+)/i);
  const expectedCount = countMatch ? Number(countMatch[1]) : noItems ? 0 : null;
  if (kind === 'purge' && expectedCount !== null && expectedCount !== targets.length) malformed = true;
  if (/incomplete|size unknown|unmeasured|scan failed|timed out|permission denied|operation not permitted|admin access available|grant full disk access/i.test(output) || sizeMatch?.[2]) malformed = true;
  if (targets.length > MAX_TARGETS || new Set(targets.map(target => target.path)).size !== targets.length) malformed = true;
  if (estimatedBytes === null || (estimatedBytes > 0 && !targets.length)) malformed = true;
  return { targets: targets.slice(0, MAX_TARGETS), estimatedBytes, expectedCount, complete: !malformed };
}

async function previewMarker(home) {
  const filename = path.join(home, '.config', 'mole', 'clean-list.txt');
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('untrusted preview file');
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readCleanPreview(home, startedAt, before) {
  const filename = path.join(home, '.config', 'mole', 'clean-list.txt');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    const marker = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (!stat.isFile() || stat.size > MAX_OUTPUT || stat.mtimeMs < startedAt - 2000 || marker === before ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('untrusted or unchanged preview file');
    return await handle.readFile({ encoding: 'utf8' });
  } finally { await handle.close(); }
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function snapshotTrash(home, clock = Date.now) {
  const canonicalHome = await fs.realpath(home);
  const trash = path.join(canonicalHome, '.Trash');
  const rootStat = await fs.lstat(trash);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(trash) !== trash ||
      (typeof process.getuid === 'function' && rootStat.uid !== process.getuid())) throw new Error('trash unavailable');
  const deadline = clock() + 10_000;
  const items = [];
  const metadata = [];
  let entries = 0;
  async function walk(full, relative, depth) {
    if (++entries > MAX_TRASH_ENTRIES || depth > 32 || clock() > deadline) throw new Error('trash scan incomplete');
    const stat = await fs.lstat(full);
    metadata.push([relative, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]);
    let bytes = stat.isFile() || stat.isSymbolicLink() ? stat.size : 0;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const children = (await fs.readdir(full)).sort();
      for (const child of children) bytes += await walk(path.join(full, child), path.join(relative, child), depth + 1);
    }
    return bytes;
  }
  for (const name of (await fs.readdir(trash)).sort()) {
    if (items.length >= MAX_TARGETS) throw new Error('too many trash items');
    const full = path.join(trash, name);
    const bytes = await walk(full, name, 0);
    items.push({ path: full, estimatedBytes: bytes });
  }
  return { targets: items, estimatedBytes: items.reduce((sum, item) => sum + item.estimatedBytes, 0), complete: true,
    _root: { path: trash, dev: rootStat.dev, ino: rootStat.ino }, _fingerprint: fingerprint(metadata) };
}

/** Explicit local preview only. Destructive cleanup is disabled until target stability can be guaranteed. */
export function createCleanupService({ home = os.homedir(), locateMole = defaultMolePath, runMole = guardedMole,
  readPreview = readCleanPreview, readTrash = snapshotTrash, clock = Date.now } = {}) {
  const userHome = path.resolve(home);
  let busy = false;
  async function preview(kind) {
    if (!['clean', 'purge', 'trash'].includes(kind)) return { ok: false, code: 'unsupported' };
    const observedAt = new Date(clock()).toISOString();
    if (kind === 'trash') {
      try {
        const data = await readTrash(userHome, clock);
        return { ok: true, kind, scope: '이 Mac의 사용자 홈 휴지통을 미리 봅니다. 외장 볼륨 휴지통은 포함하지 않습니다.',
          ...data, count: data.targets.length, executable: false,
          reasons: ['실행 불가: 미리보기 뒤 대상이 변하는 상황의 안전성이 검증되지 않았습니다.'], observedAt };
      } catch { return { ok: false, kind, code: 'trash_unavailable', message: '휴지통 접근 또는 전체 항목 확인이 불가능합니다.' }; }
    }
    let executable;
    try { executable = await locateMole(); } catch { executable = null; }
    if (!executable) return { ok: false, kind, code: 'mole_missing', message: 'Mole 실행 파일을 찾지 못했습니다.' };
    try {
      const versionOutput = await runMole(executable, ['--version'], { timeout: 5000 });
      const version = String(versionOutput.stdout || '').match(/Mole version\s+(\d+\.\d+\.\d+)/i)?.[1] || null;
      const before = kind === 'clean' ? await previewMarker(userHome) : null;
      const start = clock();
      const output = await runMole(executable, [kind, '--dry-run'], { timeout: 180_000 });
      const list = kind === 'clean' ? await readPreview(userHome, start, before) : '';
      const parsed = parseMolePreview(kind, `${output.stdout || ''}\n${output.stderr || ''}`, list, userHome);
      const reasons = [];
      if (version !== REVIEWED_MOLE_VERSION) reasons.push('검토한 Mole 버전과 달라 실행을 차단합니다.');
      if (!parsed.complete) reasons.push('전체 대상 또는 크기를 확인하지 못했습니다.');
      if (!parsed.targets.length) reasons.push('실행할 확인된 대상이 없습니다.');
      if (kind === 'clean' && parsed.targets.some(item => item.path === path.join(userHome, '.Trash') || item.path.startsWith(path.join(userHome, '.Trash') + path.sep))) {
        reasons.push('Mole 정리에 휴지통이 포함돼 별도 휴지통 검토가 필요합니다.');
      }
      const canonicalHome = await fs.realpath(userHome);
      for (const target of parsed.targets) {
        try {
          const stat = await fs.lstat(target.path);
          const canonicalTarget = await fs.realpath(target.path);
          const relative = path.relative(canonicalHome, canonicalTarget);
          if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
              canonicalTarget !== target.path || stat.isSymbolicLink() ||
              (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('untrusted target');
          target.identity = { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
        } catch { reasons.push('확인할 수 없거나 현재 사용자 소유가 아닌 대상이 있습니다.'); break; }
      }
      reasons.push('실행 불가: Mole이 실행 시 다시 탐색하므로 승인한 대상만 삭제한다고 보장할 수 없습니다.');
      return { ok: true, kind, scope: '사용자 홈의 확인된 대상만 미리 봅니다.',
        targets: parsed.targets, count: parsed.targets.length, estimatedBytes: parsed.estimatedBytes, complete: parsed.complete,
        executable: false, reasons, version, observedAt, _mole: executable };
    } catch { return { ok: false, kind, code: 'preview_failed', message: 'Mole 미리보기의 전체 결과를 확인하지 못했습니다.' }; }
  }
  function publicPreview(plan) { const { _root, _fingerprint, _mole, ...safe } = plan; return safe; }
  return {
    async preview(kind) {
      if (busy) return { ok: false, code: 'busy' };
      busy = true;
      try { return publicPreview(await preview(kind)); } finally { busy = false; }
    },
    async prepare(kind) {
      if (busy) return { ok: false, code: 'busy' };
      busy = true;
      try {
        const plan = await preview(kind);
        return { ok: false, code: plan.ok ? 'execution_unavailable' : 'not_eligible', plan: publicPreview(plan),
          message: '정리 대상을 고정해 안전하게 실행하는 방법이 검증되지 않아 실행을 차단합니다.' };
      } finally { busy = false; }
    },
    async confirm() {
      return { ok: false, code: 'execution_unavailable', message: '안전성 검증 전에는 정리를 실행할 수 없습니다.' };
    },
    cancel() {},
  };
}