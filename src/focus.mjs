import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { readFile, readdir } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTY = /^(?:\/dev\/)?(ttys\d{3,})$/;
const FAIL = (code, message) => ({ ok: false, code, message });

async function currentClaudeScope() {
  const base = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  const config = JSON.parse(await readFile(path.join(base, 'config.json'), 'utf8'));
  const account = config?.lastKnownAccountUuid;
  if (typeof account !== 'string' || !UUID.test(account)) return null;
  const root = path.join(base, 'claude-code-sessions', account);
  const directories = (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory() && UUID.test(d.name));
  return directories.length === 1 ? { account, organization: directories[0].name } : null;
}

// Arguments are passed to osascript as argv, never interpolated into source.
// Count first and select only an unambiguous exact TTY match.
const TERMINAL_SCRIPT = `on run argv
  set wantedTTY to item 1 of argv
  tell application id "com.apple.Terminal"
    set matches to 0
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is wantedTTY then set matches to matches + 1
      end repeat
    end repeat
    if matches is 0 then return "NOT_FOUND"
    if matches is not 1 then return "AMBIGUOUS"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is wantedTTY then
          set selected of t to true
          set index of w to 1
          activate
          return "FOCUSED"
        end if
      end repeat
    end repeat
  end tell
  return "NOT_FOUND"
end run`;

const ITERM_SCRIPT = `on run argv
  set wantedTTY to item 1 of argv
  tell application id "com.googlecode.iterm2"
    set matches to 0
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is wantedTTY then set matches to matches + 1
        end repeat
      end repeat
    end repeat
    if matches is 0 then return "NOT_FOUND"
    if matches is not 1 then return "AMBIGUOUS"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is wantedTTY then
            select t
            select s
            set index of w to 1
            activate
            return "FOCUSED"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "NOT_FOUND"
end run`;

/**
 * Focus a private session target. Never pass targets through a browser API.
 *
 * Codex desktop target: {provider:'codex', origin:'codex-desktop', sessionId: UUID}.
 * Terminal target: {provider:'claude'|'codex', sessionId, pid, tty, bundle,
 * processStart}; `processStart` is the exact ps lstart string captured with PID.
 * Session-to-PID association must be supplied by a trusted live hook, not guessed.
 *
 * Returns {ok, code, message, verification}. A deep link is only `dispatched`,
 * because OS dispatch does not prove that the intended chat became visible.
 */
export async function focusSession(target, { run = execFileAsync, platform = process.platform, readClaudeScope = currentClaudeScope } = {}) {
  if (platform !== 'darwin') return FAIL('unsupported_platform', '현재 macOS에서만 열 수 있습니다.');
  if (!target || !['claude', 'codex'].includes(target.provider)) return FAIL('invalid_target', '세션 정보를 확인할 수 없습니다.');
  if (target.remote || target.hostId) return FAIL('remote_unsupported', '원격 세션은 이 Mac에서 열 수 없습니다.');

  if (target.provider === 'codex' && target.origin === 'codex-desktop') {
    if (typeof target.sessionId !== 'string' || !UUID.test(target.sessionId)) return FAIL('invalid_target', '채팅 식별자를 확인할 수 없습니다.');
    try {
      // Observed in the installed ChatGPT app, but not a documented stable API.
      await run('/usr/bin/open', ['-b', 'com.openai.codex', `codex://threads/${target.sessionId}`], { timeout: 10_000 });
      return { ok: true, code: 'dispatched', message: 'Codex에 채팅 열기를 요청했습니다.', verification: 'dispatch_only' };
    } catch {
      return FAIL('open_failed', 'Codex에 채팅 열기를 요청하지 못했습니다.');
    }
  }

  if (target.provider === 'claude' && target.origin === 'claude-desktop') {
    // Only a unique, explicitly non-archived local index match may navigate.
    // The Desktop ID is not the CLI session ID. This is a version-sensitive
    // application URL, and dispatch does not prove the chat became visible.
    if (target.desktopSessionUnique !== true || target.desktopArchived !== false ||
        typeof target.sessionId !== 'string' || !UUID.test(target.sessionId) ||
        typeof target.desktopSessionId !== 'string' || !/^local_[A-Za-z0-9-]{1,64}$/.test(target.desktopSessionId) ||
        typeof target.desktopAccountId !== 'string' || !UUID.test(target.desktopAccountId) ||
        typeof target.desktopOrganizationId !== 'string' || !UUID.test(target.desktopOrganizationId)) {
      return FAIL('identity_unavailable', 'Claude 데스크톱 세션을 정확히 확인할 수 없습니다.');
    }
    let scope;
    try { scope = await readClaudeScope(); } catch { /* Missing or invalid configuration is not a match. */ }
    if (!scope || scope.account !== target.desktopAccountId || scope.organization !== target.desktopOrganizationId) {
      return FAIL('account_changed', '현재 Claude 계정이나 조직을 확인할 수 없습니다.');
    }
    try {
      await run('/usr/bin/open', ['-b', 'com.anthropic.claudefordesktop', `claude://code/continue?session=${target.desktopSessionId}`], { timeout: 10_000 });
      return { ok: true, code: 'dispatched', message: 'Claude에 세션 열기를 요청했습니다.', verification: 'dispatch_only' };
    } catch {
      return FAIL('open_failed', 'Claude에 세션 열기를 요청하지 못했습니다.');
    }
  }

  const bundles = { 'com.apple.Terminal': { process: 'Terminal', script: TERMINAL_SCRIPT }, 'com.googlecode.iterm2': { process: 'iTerm2', script: ITERM_SCRIPT } };
  const app = bundles[target.bundle];
  const tty = typeof target.tty === 'string' ? TTY.exec(target.tty.trim()) : null;
  if (!app) return FAIL('unsupported_origin', '이 세션의 실행 앱을 정확히 찾을 수 없습니다.');
  if (!tty || !Number.isSafeInteger(target.pid) || target.pid < 2 || typeof target.processStart !== 'string' || !target.processStart.trim() || typeof target.sessionId !== 'string' || !target.sessionId.trim()) {
    return FAIL('identity_unavailable', '세션과 터미널의 연결 정보를 확인할 수 없습니다.');
  }

  try {
    // Check PID reuse and terminal attachment before touching the UI.
    const pid = String(target.pid);
    const [start, terminal, command] = await Promise.all([
      run('/bin/ps', ['-p', pid, '-o', 'lstart='], { timeout: 3_000 }),
      run('/bin/ps', ['-p', pid, '-o', 'tty='], { timeout: 3_000 }),
      run('/bin/ps', ['-p', pid, '-o', 'comm='], { timeout: 3_000 }),
    ]);
    const actualTty = TTY.exec(String(terminal.stdout || '').trim());
    const executable = path.basename(String(command.stdout || '').trim()).toLowerCase();
    if (String(start.stdout || '').trim() !== target.processStart.trim() || !actualTty || actualTty[1] !== tty[1] || !executable.startsWith(target.provider)) {
      return FAIL('identity_changed', '세션 프로세스가 바뀌었거나 종료됐습니다.');
    }
    // Avoid launching a terminal application just to search its windows.
    await run('/usr/bin/pgrep', ['-x', app.process], { timeout: 3_000 });
    const result = await run('/usr/bin/osascript', ['-e', app.script, '--', `/dev/${tty[1]}`], { timeout: 10_000 });
    const output = String(result.stdout || '').trim();
    if (output === 'FOCUSED') return { ok: true, code: 'focused', message: '일치하는 터미널 탭을 선택했습니다.', verification: 'matched_tty' };
    if (output === 'AMBIGUOUS') return FAIL('ambiguous', '같은 터미널을 여러 창에서 찾았습니다.');
    return FAIL('not_found', '해당 터미널 탭을 찾지 못했습니다.');
  } catch (error) {
    const details = String(error?.stderr || error?.message || '');
    if (/-1743|-1744|not authorized|not permitted/i.test(details)) return FAIL('automation_denied', 'macOS 자동화 권한을 확인하세요.');
    return FAIL('focus_failed', '세션의 터미널을 열지 못했습니다.');
  }
}
