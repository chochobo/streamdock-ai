import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const MAX_ROOTS = 16;
const MAX_WORKTREES = 100;
const STALE_MS = 72 * 60 * 60_000;
const SCAN_MS = 15_000;
const OID = /^[0-9a-f]{40,64}$/i;
const real = value => fs.realpath(value);
const idFor = (common, worktree) => 'wt-' + createHash('sha256').update(common).update('\0').update(worktree).digest('hex').slice(0, 24);

/** Run a local Git command without a shell, prompts, optional locks, hooks or fsmonitor. */
async function runGit(cwd, args, { timeout = 5000 } = {}) {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin', HOME: os.homedir(), TMPDIR: os.tmpdir(),
    LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_PAGER: 'cat',
  };
  return exec('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'credential.helper=', '-C', cwd, ...args], { env, timeout, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
}

function parseWorktreeList(text) {
  const result = [];
  let item;
  for (const field of String(text).split('\0')) {
    if (!field) { if (item) { result.push(item); item = undefined; } continue; }
    if (field.startsWith('worktree ')) {
      if (item) result.push(item);
      item = { path: field.slice(9) };
    } else if (item) {
      const split = field.indexOf(' ');
      const key = split < 0 ? field : field.slice(0, split);
      const value = split < 0 ? true : field.slice(split + 1);
      if (['HEAD', 'branch', 'locked', 'prunable', 'bare', 'detached'].includes(key)) item[key] = value;
    }
  }
  if (item) result.push(item);
  return result;
}

function parseStatus(text) {
  const fields = String(text).split('\0');
  let dirty = 0, ignored = 0;
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== ' ') throw new Error('Invalid Git status');
    const code = entry.slice(0, 2);
    if (code === '!!') ignored++;
    else dirty++;
    // Porcelain -z has a second pathname for a rename/copy.
    if (code.includes('R') || code.includes('C')) i++;
  }
  return { dirty, ignored };
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

async function baseFor(repo, git) {
  let symbolic;
  try { symbolic = (await git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).stdout.trim(); } catch { /* no remote HEAD */ }
  const candidates = [symbolic, 'refs/remotes/origin/main', 'refs/heads/main', 'refs/remotes/origin/master', 'refs/heads/master']
    .filter(value => typeof value === 'string' && /^refs\/(?:heads|remotes\/origin)\/[a-zA-Z0-9._/-]+$/.test(value));
  for (const ref of [...new Set(candidates)]) {
    try {
      const head = (await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim();
      if (OID.test(head)) return { ref, head };
    } catch { /* try the next local ref; never fetch */ }
  }
  return null;
}

async function mapLimit(items, limit, fn) {
  const values = Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; values[index] = await fn(items[index], index); }
  }));
  return values;
}

/**
 * Only inspect explicitly supplied local roots. `activity.paths` must contain every
 * known live session's absolute cwd, and `activity.complete` must be true only if
 * the caller can rule out unobserved sessions. No network or Git writes are used.
 */
export async function scanWorktrees({ roots = [], activity = { complete: false, paths: [] }, now = Date.now(), git = runGit } = {}) {
  if (!Array.isArray(roots) || roots.length > MAX_ROOTS) throw new TypeError(`Provide at most ${MAX_ROOTS} explicit roots`);
  const warnings = [];
  const deadline = Date.now() + SCAN_MS;
  let timedOut = false;
  const checkedGit = async (cwd, args, options = {}) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { timedOut = true; throw new Error('Scan deadline reached'); }
    try { return await git(cwd, args, { ...options, timeout: Math.min(options.timeout || 5000, remaining) }); }
    finally { if (Date.now() >= deadline) timedOut = true; }
  };
  const groups = new Map();
  const normalizedActive = [];
  let activityComplete = activity?.complete === true && Array.isArray(activity.paths);
  const activityPaths = Array.isArray(activity?.paths) ? activity.paths : [];
  if (activityPaths.length > 256) activityComplete = false;
  for (const item of activityPaths.slice(0, 256)) {
    if (typeof item !== 'string' || !path.isAbsolute(item)) { activityComplete = false; continue; }
    try { normalizedActive.push(await real(item)); } catch { activityComplete = false; }
  }
  for (const input of roots) {
    if (typeof input !== 'string' || !path.isAbsolute(input)) { warnings.push('절대 경로가 아닌 저장소를 건너뛰었습니다.'); continue; }
    try {
      const root = await real(input);
      if (Date.now() >= deadline) { timedOut = true; break; }
      const [commonOutput, listOutput] = await Promise.all([
        checkedGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        checkedGit(root, ['worktree', 'list', '--porcelain', '-z']),
      ]);
      const common = await real(commonOutput.stdout.trim());
      if (!groups.has(common)) groups.set(common, { common, root, entries: parseWorktreeList(listOutput.stdout) });
    } catch { warnings.push('저장소의 워크트리 목록을 읽지 못했습니다.'); }
  }
  const tasks = [];
  for (const group of groups.values()) {
    group.base = await baseFor(group.root, checkedGit);
    group.repo = path.basename(group.entries[0]?.path || group.root);
    for (const [index, entry] of group.entries.entries()) tasks.push({ group, entry, main: index === 0 });
  }
  let truncated = tasks.length > MAX_WORKTREES;
  const items = (await mapLimit(tasks.slice(0, MAX_WORKTREES), 3, async ({ group, entry, main }) => {
    if (!path.isAbsolute(entry.path || '')) return null;
    let worktree, stat;
    try { worktree = await real(entry.path); stat = await fs.stat(worktree); } catch {
      return { id: idFor(group.common, entry.path), repo: group.repo, name: path.basename(entry.path), path: entry.path,
        main, locked: Boolean(entry.locked), prunable: Boolean(entry.prunable), state: 'unknown', eligible: false, executable: false,
        blockedReason: '실행 불가: 대상 변동 안전성이 검증되지 않았습니다.', reasons: ['경로를 확인할 수 없습니다.'] };
    }
    let status = null, head = null, ageHours = null, merged = null, ahead = null;
    try { status = parseStatus((await checkedGit(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignored=matching'])).stdout); } catch { /* unknown */ }
    try { const value = (await checkedGit(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim(); if (OID.test(value)) head = value; } catch { /* unknown */ }
    try { const value = Number((await checkedGit(worktree, ['log', '-1', '--format=%ct'])).stdout.trim()); if (Number.isFinite(value) && value > 0) ageHours = Math.max(0, (now - value * 1000) / 3_600_000); } catch { /* unknown */ }
    if (head && group.base) {
      try { await checkedGit(worktree, ['merge-base', '--is-ancestor', head, group.base.head]); merged = true; }
      catch (error) { if (error.code === 1) merged = false; }
      try { const output = (await checkedGit(worktree, ['rev-list', '--count', `${group.base.head}..${head}`])).stdout.trim(); const value = Number(output); if (/^\\d+$/.test(output) && Number.isSafeInteger(value) && value >= 0) ahead = value; } catch { /* unknown */ }
    }
    const active = normalizedActive.some(candidate => within(worktree, candidate));
    const branch = typeof entry.branch === 'string' ? entry.branch.replace(/^refs\/heads\//, '') : null;
    const reasons = [];
    if (!stat.isDirectory()) reasons.push('디렉터리가 아닙니다.');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) reasons.push('현재 사용자가 소유한 디렉터리가 아닙니다.');
    if (main) reasons.push('주 워크트리입니다.');
    if (entry.locked) reasons.push('잠긴 워크트리입니다.');
    if (entry.prunable) reasons.push('Git이 경로 상태를 확인하지 못했습니다.');
    if (entry.bare || entry.detached || !branch) reasons.push('브랜치에 연결된 일반 워크트리가 아닙니다.');
    if (active) reasons.push('열린 세션이 사용 중입니다.');
    if (!activityComplete) reasons.push('열린 세션 전체를 확인할 수 없습니다.');
    if (!status) reasons.push('변경 파일을 확인할 수 없습니다.');
    else {
      if (status.dirty) reasons.push(`커밋하지 않은 변경 ${status.dirty}개가 있습니다.`);
      if (status.ignored) reasons.push(`무시된 파일 또는 폴더 ${status.ignored}개가 있습니다.`);
    }
    if (!head || !group.base || merged === null) reasons.push('기준 브랜치 병합 여부를 확인할 수 없습니다.');
    else if (!merged) reasons.push('기준 브랜치에 병합되지 않았습니다.');
    const eligible = reasons.length === 0;
    let state = 'unknown';
    if (main) state = 'main';
    else if (entry.locked || entry.prunable) state = 'locked';
    else if (active) state = 'active';
    else if (status?.dirty) state = 'dirty';
    else if (status?.ignored) state = 'ignored';
    else if (eligible) state = 'reviewable';
    else if (merged === false && ageHours !== null && ageHours * 3_600_000 >= STALE_MS) state = 'stale';
    else if (merged === false && status?.dirty === 0) state = 'unmerged';
    return { id: idFor(group.common, worktree), repo: group.repo, name: path.basename(worktree), path: worktree,
      branch, main, locked: Boolean(entry.locked), prunable: Boolean(entry.prunable), active,
      activityComplete, dirty: status?.dirty ?? null, ignored: status?.ignored ?? null, ageHours,
      base: group.base?.ref ?? null, baseHead: group.base?.head ?? null, head, merged, ahead,
      state, eligible, executable: false, blockedReason: '실행 불가: 대상 변동 안전성이 검증되지 않았습니다.', reasons, _common: group.common, _device: stat.dev, _inode: stat.ino, _repoRoot: group.root };
  })).filter(Boolean);
  if (truncated) warnings.push(`워크트리는 최대 ${MAX_WORKTREES}개까지 표시합니다.`);
  if (timedOut) { truncated = true; warnings.push('워크트리 검사 시간이 초과됐습니다.'); }
  return { items, warnings, truncated, scannedAt: new Date(now).toISOString() };
}

function publicItem(item) {
  const { _common, _device, _inode, _repoRoot, ...safe } = item;
  return safe;
}

/** Review candidate details. Removal is disabled until target-race safety is established. */
export function createWorktreeService({ roots = [], getActivity = async () => ({ complete: false, paths: [] }),
  git = runGit, clock = Date.now } = {}) {
  const rootsNow = async () => typeof roots === 'function' ? await roots() : roots;
  async function scan() {
    let activity;
    try { activity = await getActivity(); } catch { activity = { complete: false, paths: [] }; }
    return scanWorktrees({ roots: await rootsNow(), activity, now: clock(), git });
  }
  return {
    async list() { const result = await scan(); return { ...result, items: result.items.map(publicItem) }; },
    async prepareRemoval(id) {
      const result = await scan();
      const item = result.items.find(candidate => candidate.id === id);
      if (!item) return { ok: false, code: 'not_found', reasons: ['워크트리를 찾을 수 없습니다.'] };
      return { ok: true, code: 'execution_unavailable', stage: 'review', plan: {
        ...publicItem(item), executable: false,
        blockedReason: '실행 불가: 검사 후 워크트리 대상이 변하는 상황의 안전성이 검증되지 않았습니다.',
        scope: '기준 브랜치는 로컬 Git 기록으로만 확인했습니다. 이 계획으로 파일을 삭제할 수 없습니다.',
      } };
    },
    async confirmRemoval() {
      return { ok: false, code: 'execution_unavailable', message: '대상 변동 안전성 검증 전에는 삭제할 수 없습니다.' };
    },
    cancelRemoval() {},
  };
}
