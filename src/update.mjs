import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCleanupProcess } from './cleanup.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OID = /^[a-f0-9]{40,64}$/i;
const PLAN_MS = 120_000;
const MAX_FILES = 300;
const HASH = text => createHash('sha256').update(text).digest('hex');
const unavailable = (code, message) => ({ ok: false, status: 'unavailable', code, message });

function safeRemote(value) {
  if (typeof value !== 'string' || value.length > 1024) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname !== '/';
  } catch { return false; }
}

function safeBranch(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes('..') && !value.includes('//') &&
    !value.endsWith('/') && !value.endsWith('.') && !value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'));
}

/** Read the optional local configuration. This function never starts Git or uses the network. */
export async function readUpdateConfig({ home = os.homedir(), file = path.join(home, '.config', 'streamdock-ai', 'update.json') } = {}) {
  const invalid = () => ({ enabled: false, status: 'unavailable', code: 'invalid_config' });
  if (typeof file !== 'string' || !path.isAbsolute(file)) return invalid();
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4096 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) return invalid();
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) return invalid();
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['enabled', 'remoteUrl', 'branch'].includes(key)) || typeof value.enabled !== 'boolean') return invalid();
    if (!value.enabled && Object.keys(value).length === 1) return { enabled: false, status: 'disabled' };
    if (!safeRemote(value.remoteUrl) || !safeBranch(value.branch)) return invalid();
    if (!value.enabled) return { enabled: false, status: 'disabled' };
    return { enabled: true, status: 'configured', remoteUrl: value.remoteUrl, branch: value.branch };
  } catch (error) {
    return error.code === 'ENOENT' ? { enabled: false, status: 'unavailable', code: 'not_configured' } : invalid();
  } finally { await handle?.close(); }
}

async function runGit(cwd, args, { timeout = 10_000 } = {}) {
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: os.homedir(), TMPDIR: os.tmpdir(), LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CEILING_DIRECTORIES: '/',
    GIT_ALLOW_PROTOCOL: 'https', GIT_PAGER: 'cat' };
  return runCleanupProcess('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always', '-c', 'diff.external=', '-C', cwd, ...args], { env, timeout });
}

function parseRemoteHead(output, ref) {
  const rows = String(output || '').trim().split('\n').filter(Boolean).map(line => line.split('\t'));
  return rows.length === 1 && rows[0].length === 2 && OID.test(rows[0][0]) && rows[0][1] === ref ? rows[0][0].toLowerCase() : null;
}

/**
 * No polling, fetch, installation, restart, or update occurs on construction.
 * `remoteUrl` must be an explicitly trusted HTTPS origin URL without credentials.
 */
export function createUpdater({ root = DEFAULT_ROOT, remoteUrl = null, branch = 'main', run = runGit,
  canonicalize = value => fs.realpath(value), clock = Date.now, token = () => randomBytes(24).toString('hex') } = {}) {
  let pending = null, busy = false;
  const validConfig = () => path.isAbsolute(root) && safeRemote(remoteUrl) && safeBranch(branch);

  async function inspect() {
    if (!validConfig()) return unavailable('not_configured', '신뢰할 HTTPS 저장소와 브랜치를 먼저 설정하세요.');
    let canonical, reported, head, branchRef, remote, dirty;
    try {
      canonical = await canonicalize(root);
      const results = await Promise.all([
        run(root, ['rev-parse', '--show-toplevel']), run(root, ['symbolic-ref', '--quiet', 'HEAD']),
        run(root, ['remote', 'get-url', '--all', 'origin']), run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']),
        run(root, ['rev-parse', '--verify', 'HEAD^{commit}']), run(root, ['check-ref-format', `refs/heads/${branch}`]),
      ]);
      reported = await canonicalize(results[0].stdout.trim());
      branchRef = results[1].stdout.trim();
      remote = results[2].stdout.trim().split(/\r?\n/).filter(Boolean);
      dirty = results[3].stdout.length > 0;
      head = results[4].stdout.trim().toLowerCase();
    } catch { return unavailable('repository_unavailable', '앱 저장소나 Git 상태를 확인할 수 없습니다.'); }
    if (canonical !== reported) return unavailable('wrong_root', '지정한 경로가 앱 저장소 최상위가 아닙니다.');
    if (branchRef !== `refs/heads/${branch}` || !OID.test(head)) return unavailable('wrong_branch', '설정한 브랜치와 현재 상태가 일치하지 않습니다.');
    if (remote.length !== 1 || remote[0] !== remoteUrl) return unavailable('remote_mismatch', 'origin과 신뢰한 주소가 일치하지 않습니다.');
    try {
      const rewrite = await run(root, ['config', '--local', '--includes', '--get-regexp', '^url\\..*\\.insteadof$']);
      if (rewrite.stdout.trim()) return unavailable('url_rewrite', '저장소의 URL 변환 설정을 확인해야 합니다.');
    } catch (error) { if (error.code !== 1) return unavailable('config_unavailable', '저장소 URL 설정을 확인할 수 없습니다.'); }
    try {
      const filters = await run(root, ['config', '--local', '--includes', '--get-regexp', '^filter\\..*\\.']);
      if (filters.stdout.trim()) return unavailable('filter_config', '로컬 Git 필터 설정이 있어 자동 업데이트하지 않습니다.');
    } catch (error) { if (error.code !== 1) return unavailable('config_unavailable', 'Git 필터 설정을 확인할 수 없습니다.'); }
    try {
      const httpConfig = await run(root, ['config', '--local', '--includes', '--get-regexp', '^http\\.']);
      if (httpConfig.stdout.trim()) return unavailable('http_config', '로컬 Git HTTP 인증·프록시 설정이 있어 자동 업데이트하지 않습니다.');
    } catch (error) { if (error.code !== 1) return unavailable('config_unavailable', 'Git HTTP 설정을 확인할 수 없습니다.'); }
    if (dirty) return unavailable('dirty', '수정되거나 추적되지 않은 파일이 있어 업데이트하지 않습니다.');
    return { ok: true, root: canonical, head, branch, remoteUrl };
  }

  async function remoteHead() {
    const ref = `refs/heads/${branch}`;
    try {
      // Run outside the repository so repo-local URL rewriting cannot redirect a check.
      const value = await run('/', ['ls-remote', '--exit-code', '--refs', remoteUrl, ref], { timeout: 15_000 });
      return parseRemoteHead(value.stdout, ref);
    } catch { return null; }
  }

  async function diffFor(info, target) {
    try {
      await run(info.root, ['merge-base', '--is-ancestor', info.head, target]);
      const [diff, names] = await Promise.all([
        run(info.root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', info.head, target], { timeout: 20_000 }),
        run(info.root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', info.head, target], { timeout: 20_000 }),
      ]);
      const files = names.stdout.split('\0').filter(Boolean);
      if (files.length > MAX_FILES || Buffer.byteLength(diff.stdout) > 2 * 1024 * 1024) return unavailable('diff_too_large', '변경 내용을 완전히 표시할 수 없어 업데이트를 중단했습니다.');
      return { ok: true, files, diff: diff.stdout, diffHash: HASH(diff.stdout) };
    } catch { return unavailable('not_fast_forward', '안전한 fast-forward와 전체 변경 내용을 확인할 수 없습니다.'); }
  }

  return {
    /** Local-only by default; remote lookup occurs only for an explicit remote=true. */
    async check({ remote = false } = {}) {
      if (busy) return unavailable('busy', '다른 업데이트 확인이 진행 중입니다.');
      busy = true;
      try {
        const info = await inspect();
        if (!info.ok) return info;
        if (!remote) {
          let tracking = null;
          try { const out = await run(info.root, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]); if (OID.test(out.stdout.trim())) tracking = out.stdout.trim().toLowerCase(); } catch { /* no local tracking ref */ }
          return { ok: true, status: 'local_only', current: info.head, tracking, checkedAt: new Date(clock()).toISOString() };
        }
        const latest = await remoteHead();
        if (!latest) return unavailable('remote_unavailable', '원격 브랜치를 확인할 수 없습니다.');
        return { ok: true, status: latest === info.head ? 'up_to_date' : 'update_available', current: info.head, latest,
          source: 'remote_check', checkedAt: new Date(clock()).toISOString() };
      } finally { busy = false; }
    },
    /** Explicit preparation fetches objects but does not move any branch or install packages. */
    async prepare() {
      if (busy) return unavailable('busy', '다른 업데이트 확인이 진행 중입니다.');
      busy = true; pending = null;
      try {
        const info = await inspect();
        if (!info.ok) return info;
        const latest = await remoteHead();
        if (!latest) return unavailable('remote_unavailable', '원격 브랜치를 확인할 수 없습니다.');
        if (latest === info.head) return { ok: true, status: 'up_to_date', current: info.head };
        try {
          await run(info.root, ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', '--no-write-commit-graph', '--', remoteUrl, `refs/heads/${branch}`], { timeout: 60_000 });
          await run(info.root, ['cat-file', '-e', `${latest}^{commit}`]);
        } catch { return unavailable('fetch_failed', '원격 변경 내용을 가져와 검토할 수 없습니다.'); }
        const after = await inspect();
        if (!after.ok || after.head !== info.head) return unavailable('changed', '저장소 상태가 바뀌어 준비를 취소했습니다.');
        const diff = await diffFor(after, latest);
        if (!diff.ok) return diff;
        const approval = token();
        pending = { info: after, latest, diffHash: diff.diffHash, approval, expiresAt: clock() + PLAN_MS };
        return { ok: true, status: 'review', token: approval, expiresAt: new Date(pending.expiresAt).toISOString(),
          plan: { root: info.root, branch, remoteUrl, current: info.head, target: latest, files: diff.files, diff: diff.diff,
            diffHash: diff.diffHash, action: 'fast-forward', dependenciesInstalled: false,
            note: '소스만 fast-forward합니다. 패키지 설치와 앱 재시작은 별도입니다.' } };
      } finally { busy = false; }
    },
    /** Explicit one-use confirmation. No reset, force, package install or restart. */
    async apply(approval) {
      if (busy) return unavailable('busy', '다른 업데이트 확인이 진행 중입니다.');
      if (!pending || clock() >= pending.expiresAt) { pending = null; return unavailable('expired', '검토 시간이 지나 다시 확인해야 합니다.'); }
      if (approval !== pending.approval) return unavailable('invalid_confirmation', '확인 정보가 올바르지 않습니다.');
      const plan = pending; pending = null; busy = true;
      try {
        const before = await inspect();
        if (!before.ok || before.head !== plan.info.head || before.root !== plan.info.root) return unavailable('changed', '저장소 상태가 바뀌어 업데이트를 취소했습니다.');
        const latest = await remoteHead();
        if (latest !== plan.latest) return unavailable('remote_changed', '원격 브랜치가 바뀌어 다시 검토해야 합니다.');
        const diff = await diffFor(before, latest);
        if (!diff.ok || diff.diffHash !== plan.diffHash || clock() >= plan.expiresAt) return unavailable('changed', '변경 내용이나 확인 시간이 바뀌어 취소했습니다.');
        try { await run(before.root, ['merge', '--ff-only', '--no-overwrite-ignore', latest], { timeout: 30_000 }); }
        catch { return unavailable('update_failed', 'Git이 업데이트를 완료하지 못했습니다. 저장소를 확인하세요.'); }
        let head;
        try { head = (await run(before.root, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim().toLowerCase(); }
        catch { return unavailable('verification_unavailable', '업데이트 후 HEAD를 확인할 수 없습니다.'); }
        if (head !== latest) return unavailable('verification_failed', '업데이트 후 HEAD가 예상한 커밋과 다릅니다.');
        try {
          const status = await run(before.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
          if (status.stdout.length) return { ok: true, status: 'updated_with_local_changes', current: head, message: '업데이트 뒤 로컬 변경이 확인돼 저장소를 검토해야 합니다.' };
        } catch { return unavailable('verification_unavailable', '업데이트 후 작업 트리 상태를 확인할 수 없습니다.'); }
        return { ok: true, status: 'updated', current: head, message: '소스 업데이트를 확인했습니다. 앱 재시작은 별도입니다.' };
      } finally { busy = false; }
    },
    cancel() { pending = null; },
  };
}
