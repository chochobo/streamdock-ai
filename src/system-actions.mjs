import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

// Runs shortcut items (#33) and system controls. Callers decide *when* to run
// (a physical key or an authenticated press); nothing here reads agent or
// network data. Every external program is started directly, never through a
// shell, and failures return a short fixed message: command output, paths and
// error text never reach the device, status API or logs.

const execFileAsync = promisify(execFile);
const OSASCRIPT = '/usr/bin/osascript';
const OPEN = '/usr/bin/open';
export const VOLUME_STEP = 6;
const COMMAND_TIMEOUT_MS = 10_000;
const AUTOMATION_TIMEOUT_MS = 5_000;

// pbcopy reads the locale, which a GUI-launched process may not have; without
// an explicit UTF-8 locale Korean text arrives garbled.
function pbcopy(value) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error('pbcopy failed'))));
    child.stdin.on('error', reject);
    child.stdin.end(value);
  });
}

const ok = (code, message, extra = {}) => ({ ok: true, code, message, ...extra });
const fail = (code, message) => ({ ok: false, code, message });
const clamp = value => Math.max(0, Math.min(100, value));

export function createSystemActions({ run = execFileAsync, copy = pbcopy, platform = process.platform } = {}) {
  const osascript = (script, timeout = AUTOMATION_TIMEOUT_MS) => run(OSASCRIPT, ['-e', script], { timeout });

  async function currentVolume() {
    const { stdout } = await osascript('output volume of (get volume settings)');
    const value = Number.parseInt(String(stdout).trim(), 10);
    return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
  }

  /** Changes the output volume by `delta` points (clamped to 0..100). */
  async function adjustVolume(delta) {
    if (platform !== 'darwin') return fail('unsupported_platform', '현재 macOS에서만 쓸 수 있습니다.');
    try {
      const current = await currentVolume();
      if (current === null) return fail('volume_unavailable', '이 출력 장치는 볼륨을 조절할 수 없습니다.');
      const next = clamp(current + delta);
      if (next !== current) await osascript(`set volume output volume ${next}`);
      return ok('volume', `볼륨 ${next}%`, { volume: next });
    } catch {
      return fail('volume_failed', '볼륨을 바꾸지 못했습니다.');
    }
  }

  async function toggleMute() {
    if (platform !== 'darwin') return fail('unsupported_platform', '현재 macOS에서만 쓸 수 있습니다.');
    try {
      await osascript('set volume output muted (not (output muted of (get volume settings)))');
      return ok('mute', '음소거를 전환했습니다.');
    } catch {
      return fail('mute_failed', '음소거를 바꾸지 못했습니다.');
    }
  }

  async function system(name) {
    switch (name) {
      case 'volume-up': return adjustVolume(VOLUME_STEP);
      case 'volume-down': return adjustVolume(-VOLUME_STEP);
      case 'mute': return toggleMute();
      case 'display-sleep':
        try { await run('/usr/bin/pmset', ['displaysleepnow'], { timeout: AUTOMATION_TIMEOUT_MS }); return ok('display_sleep', '화면을 껐습니다.'); }
        catch { return fail('display_sleep_failed', '화면을 끄지 못했습니다.'); }
      case 'screensaver':
        try { await run(OPEN, ['-a', 'ScreenSaverEngine'], { timeout: AUTOMATION_TIMEOUT_MS }); return ok('screensaver', '화면보호기를 시작했습니다.'); }
        catch { return fail('screensaver_failed', '화면보호기를 시작하지 못했습니다.'); }
      default: return fail('unsupported', '지원하지 않는 동작입니다.');
    }
  }

  async function pasteText(item) {
    try { await copy(item.text); } catch { return fail('copy_failed', '클립보드에 복사하지 못했습니다.'); }
    try {
      await osascript('tell application "System Events" to keystroke "v" using command down');
      if (item.submit === true) await osascript('tell application "System Events" to key code 36');
      return ok('pasted', item.submit === true ? '붙여넣고 입력했습니다.' : '붙여넣었습니다.');
    } catch (error) {
      // 1002 is "not allowed to send keystrokes": the Accessibility permission.
      const denied = /1002|not allowed to send keystrokes/i.test(String(error?.stderr ?? error?.message ?? ''));
      return denied
        ? fail('permission_required', '클립보드에는 복사했습니다. 붙여넣으려면 손쉬운 사용 권한이 필요합니다.')
        : fail('paste_failed', '클립보드에는 복사했지만 붙여넣지 못했습니다.');
    }
  }

  async function runCommand(item) {
    const [file, ...args] = item.command;
    try {
      await run(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 });
      return ok('command_ran', '명령을 실행했습니다.');
    } catch (error) {
      return error?.killed === true || error?.signal === 'SIGTERM'
        ? fail('command_timeout', '명령이 시간 안에 끝나지 않았습니다.')
        : fail('command_failed', '명령이 실패했습니다.');
    }
  }

  async function execute(item) {
    if (platform !== 'darwin') return fail('unsupported_platform', '현재 macOS에서만 쓸 수 있습니다.');
    switch (item?.type) {
      case 'app':
        try { await run(OPEN, ['-a', item.app], { timeout: AUTOMATION_TIMEOUT_MS }); return ok('opened', '앱을 열었습니다.'); }
        catch { return fail('open_failed', '앱을 열지 못했습니다.'); }
      case 'url':
        try { await run(OPEN, [item.url], { timeout: AUTOMATION_TIMEOUT_MS }); return ok('opened', '링크를 열었습니다.'); }
        catch { return fail('open_failed', '링크를 열지 못했습니다.'); }
      case 'system': return system(item.system);
      case 'text': return pasteText(item);
      case 'command': return runCommand(item);
      default: return fail('unsupported', '지원하지 않는 동작입니다.');
    }
  }

  return { execute, adjustVolume, toggleMute };
}
