import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LABEL = 'local.streamdock-ai';
const xml = text => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

/** Generate a user-reviewable plist. This function never writes or calls launchctl. */
export function createLaunchdPlan({ root = ROOT, node = process.execPath, home = os.homedir(),
  port = 4174, device = false, keepAlive = false, codexDir = null, uid = process.getuid?.() } = {}) {
  if (!absolute(root) || !absolute(node) || !absolute(home)) throw new TypeError('Paths must be absolute and contain no control characters');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('Invalid port');
  if (typeof device !== 'boolean' || typeof keepAlive !== 'boolean') throw new TypeError('Invalid launch options');
  if (codexDir !== null && (!absolute(codexDir) || codexDir.includes(':'))) throw new TypeError('Invalid Codex directory');
  if (!Number.isSafeInteger(uid) || uid < 1) throw new TypeError('A non-root user ID is required');
  const program = [node, path.join(root, 'src', 'server.mjs'), ...(device ? ['--device'] : [])];
  const paths = [...new Set([codexDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean))];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
${program.map(item => `    <string>${xml(item)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(paths.join(':'))}</string>
    <key>PORT</key><string>${port}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><${keepAlive ? 'true' : 'false'}/>
  <key>ThrottleInterval</key><integer>60</integer>
</dict></plist>\n`;
  return { label: LABEL, root, node, port, device, keepAlive, plist,
    destination: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    bootstrapDomain: `gui/${uid}`,
    notes: [
      '검토 파일을 만드는 것만으로 자동 실행이 켜지지 않습니다.',
      '설치 전에 같은 포트의 기존 StreamDock AI 프로세스를 종료하세요.',
      '실제 장치 모드에서는 공식 StreamDock 앱을 함께 실행하지 마세요.',
      'Claude Desktop 사용량은 이 프로세스의 접근성 권한과 실행 중인 앱에 따라 달라집니다.',
      ...(keepAlive ? ['KeepAlive는 실패 시 재시작합니다. 포트 충돌이 있으면 반복 시도할 수 있습니다.'] : []),
    ] };
}

export function manualLaunchdCommands(plan, reviewFile) {
  if (!absolute(reviewFile) || !plan || !absolute(plan.destination) || !/^gui\/[1-9]\d*$/.test(plan.bootstrapDomain)) throw new TypeError('Invalid launchd plan');
  const steps = [
    ['/bin/mkdir', '-p', path.dirname(plan.destination)],
    ['/bin/cp', '-n', reviewFile, plan.destination],
    ['/usr/bin/cmp', '-s', reviewFile, plan.destination],
    ['/bin/launchctl', 'bootstrap', plan.bootstrapDomain, plan.destination],
  ];
  // cmp gates bootstrap if a different plist already exists and cp -n skips it.
  return [steps.map(args => args.map(quote).join(' ')).join(' && ')];
}
