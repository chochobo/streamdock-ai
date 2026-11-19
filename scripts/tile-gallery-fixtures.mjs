// 키 타일 갤러리용 예시 목록. 실제 렌더러(keyTileSvg, summarySvgs)에 넣을 입력만 만든다.
import { keyTileSvg } from '../src/device.mjs';
import { summarySvgs } from '../src/summary.mjs';

export const TILE_SIZE = 96;
export const SCALED_SIZE = 80;

const LABELS = {
  short: 'api',
  normal: 'streamdock-ai',
  long: 'my-very-long-project-name',
  veryLong: 'a'.repeat(5) + '-' + 'w'.repeat(30) + '-extremely-long-repository-name',
  cjk: '스트림독 인공지능 대시보드',
  cjkJa: '日本語のプロジェクト名前',
  emoji: '🚀🔥 launch 🎉✨ party',
  wide: 'MMMMWWWW@@@@',
};
const PERCENTS = [0, 59, 60, 85, 100];
const STATES = ['working', 'waiting', 'blocked', 'error', 'done', 'idle', 'unknown'];
const LANGS = ['ko', 'en'];
const GIB = 1024 ** 3;

function keyFixtures() {
  const out = [];
  const add = (group, name, key) => out.push({ group, name, kind: 'key', render: () => keyTileSvg(key) });

  for (const language of LANGS) {
    for (const [label, text] of Object.entries(LABELS)) {
      add('project', `project ${language} ${label}`, { kind: 'project', label: text, state: 'working', caption: `${text} 3`, language });
      add('project', `project ${language} ${label} estimated`, { kind: 'project', label: text, state: 'waiting', estimated: true, caption: '확인 2?', language });
      add('session', `session claude ${language} ${label}`, { kind: 'session', provider: 'claude', label: text, state: 'working', language });
      add('session', `session codex ${language} ${label}`, { kind: 'session', provider: 'codex', label: text, state: 'done', language });
    }
    for (const state of STATES) {
      add('state', `session ${language} ${state}`, { kind: 'session', provider: 'claude', label: 'streamdock', state, language });
      add('state', `session ${language} ${state} estimated`, { kind: 'session', provider: 'codex', label: 'streamdock', state, estimated: true, language });
    }
    for (const state of ['done', 'waiting', 'blocked']) {
      add('alert', `alert pulse ${language} ${state} project`, { kind: 'project', label: 'streamdock', state, alertPulse: true, caption: 'x 1', language });
      add('alert', `alert pulse ${language} ${state} session`, { kind: 'session', provider: 'claude', label: 'streamdock', state, alertPulse: true, language });
    }
    for (const state of ['market-up', 'market-down', 'market-flat']) {
      add('feature', `market ${language} ${state}`, { kind: 'feature', id: 'market', label: 'BTC', state, caption: '+12.3%', language });
    }
    add('empty', `empty ${language}`, { kind: 'empty', state: 'empty', language });

    // XL 대시보드(#36): 여러 키에 걸친 그림의 조각들. 7칸이 한 줄이다
    const cpu = Array.from({ length: 80 }, (_, i) => Math.round(30 + 25 * Math.sin(i / 6) + (i % 7) * 2));
    const mem = Array.from({ length: 80 }, (_, i) => Math.round(58 + i * 0.08 + 3 * Math.sin(i / 11)));
    const widgets = {
      usage: { rows: [{ label: 'Codex 5h', used: 42, reset: '15:30' }, { label: 'Claude 5h', used: 91, reset: language === 'en' ? 'Mon 09:00' : '월 09:00' }] },
      graph: { cpu, mem },
      stack: { counts: { working: 3, blocked: 1, error: 0, done: 2, idle: 4 } },
      empty: { counts: { working: 0, blocked: 0, error: 0, done: 0, idle: 0 } },
    };
    for (const [name, data] of Object.entries(widgets)) {
      for (let part = 1; part <= 7; part++) add('dashboard', `dashboard ${language} ${name} ${part}`, { kind: 'wide', language, wide: { type: name === 'empty' ? 'stack' : name, part, parts: 7, ...data } });
    }

    // 바로가기(#33): 사용자 라벨은 그대로, 내장 키는 번역된다
    for (const [label, caption, state] of [['터미널', '앱 열기', 'idle'], ['GitHub', '링크', 'idle'], ['계속', '문구', 'idle'], ['빌드 배포', '길게', 'blocked'], ['🚀 릴리스', '앱 열기', 'idle'], ['스트림독 AI', '프롬프트', 'idle']]) {
      add('shortcut', `shortcut ${language} ${label}`, { kind: 'feature', id: 'sc-0-aaaaaaaa', label, caption, state, language });
    }
    const en = { '볼륨 +': 'Vol +', '볼륨 −': 'Vol −', '음소거': 'Mute', '화면끄기': 'Screen off', '보호기': 'Saver', '올리기': 'Up', '내리기': 'Down', '전환': 'Toggle', '절전': 'Sleep', '시작': 'Start' };
    for (const [label, caption] of [['볼륨 +', '올리기'], ['볼륨 −', '내리기'], ['음소거', '전환'], ['화면끄기', '절전'], ['보호기', '시작']]) {
      add('shortcut', `shortcut ${language} built-in ${label}`, { kind: 'feature', id: 'scb-x', label: language === 'en' ? en[label] : label, caption: language === 'en' ? en[caption] : caption, state: 'idle', language });
    }


    // 한도(quota)와 리셋
    for (const used of PERCENTS) {
      add('quota', `quota ${language} ${used}%`, { kind: 'quota', label: 'Claude', windowLabel: '5h', usedPercent: used, language });
      add('quota', `quota ${language} ${used}% stale`, { kind: 'quota', label: 'Codex', windowLabel: language === 'en' ? 'Weekly' : '주간', usedPercent: used, usageStatus: 'stale', language });
    }
    add('quota', `quota ${language} unknown`, { kind: 'quota', label: 'Claude', windowLabel: '5h', usedPercent: null, language });
    add('quota', `quota ${language} very long label`, { kind: 'quota', label: LABELS.veryLong, windowLabel: LABELS.cjk, usedPercent: 85, language });
    add('quota', `quota-reset ${language}`, { kind: 'quota-reset', label: 'Claude', windowLabel: '5h', resetDate: '11/19', resetTime: '14:30', language });
    add('quota', `quota-reset ${language} stale`, { kind: 'quota-reset', label: 'Codex', windowLabel: '7d', resetDate: '12/31', resetTime: '23:59', usageStatus: 'stale', language });
    add('quota', `quota-reset ${language} unknown`, { kind: 'quota-reset', label: 'Claude', windowLabel: '5h', language });

    // 막대가 있는 기능 타일
    for (const value of PERCENTS) {
      for (const direction of ['used', 'free', 'charge']) {
        add('bar', `bar ${language} ${direction} ${value}%`, { kind: 'feature', id: 'machine-cpu', label: 'CPU', state: 'idle', caption: `${value}%`, bar: { value, direction }, language });
      }
      add('bar', `bar ${language} stale ${value}%`, { kind: 'feature', id: 'machine-disk', label: 'Disk', state: 'idle', caption: `${value}%`, bar: { value, direction: 'used', stale: true }, language });
    }
    add('bar', `bar ${language} long caption`, { kind: 'project', label: LABELS.long, state: 'working', caption: `${LABELS.long} 100%`, bar: { value: 100, direction: 'used' }, language });

    // 메모리(추정값 '?' 포함)
    for (const [used, total] of [[0, 64], [51.8, 64], [64, 64], [512, 1024], [65536, 131072]]) {
      const value = Math.round(used * 100 / total);
      const memory = { usedBytes: Math.round(used * GIB), totalBytes: total * GIB, estimated: true };
      add('memory', `memory ${language} ${used}GB of ${total}GB`, { id: 'machine-memory', kind: 'feature', state: 'idle', label: language === 'en' ? 'Memory Used' : '메모리 사용', caption: `${value}%`, bar: { value, direction: 'used' }, memory, language });
    }
    add('memory', `memory ${language} stale`, { id: 'machine-memory', kind: 'feature', state: 'idle', label: language === 'en' ? 'Memory Used' : '메모리 사용', bar: { value: 81, direction: 'used', stale: true }, memory: { usedBytes: Math.round(51.8 * GIB), totalBytes: 64 * GIB, estimated: true }, language });

    // 제어 키(활성/비활성)
    for (const action of ['modes', 'usage', 'back', 'prev', 'next']) {
      add('control', `control ${language} ${action}`, { kind: 'control', action, label: { modes: language === 'en' ? 'Modes' : '모드', usage: language === 'en' ? 'Usage' : '사용량', back: language === 'en' ? 'Back' : '뒤로', prev: '이전', next: '다음' }[action], language });
      add('control', `control ${language} ${action} disabled`, { kind: 'control', action: 'none', disabled: true, index: action === 'prev' ? 13 : action === 'next' ? 14 : 0, label: action, language });
    }
    for (const id of ['summary', 'projects', 'history', 'usage', 'machines', 'pomodoro', 'market', 'games', 'scenes', 'worktrees', 'parcels', 'credits', 'remote', 'settings', 'cleanup-purge']) {
      add('control', `control ${language} icon ${id}`, { kind: 'control', id, action: id, label: id, language });
    }
    add('control', `control ${language} long cjk`, { kind: 'control', action: 'modes', label: LABELS.cjk, language });
    add('control', `control ${language} very long`, { kind: 'control', action: 'modes', label: LABELS.veryLong, language });
    add('control', `control ${language} emoji`, { kind: 'control', action: 'modes', label: LABELS.emoji, language });
  }
  return out;
}

function summaryFixtures() {
  const out = [];
  const base = { working: 2, blocked: 0, done: 1, unknown: 0, errors: 0, estimated: false, attentionProject: null, attentionProjectCount: 0, attentionEstimated: false, errorProject: '', errorProjectCount: 0, errorEstimated: false, time: '14:05', warning: false, warningKind: null };
  const cases = {
    'idle': {},
    'working 100+': { working: 150, done: 100 },
    'blocked': { blocked: 3, attentionProject: 'streamdock-ai', attentionProjectCount: 3 },
    'blocked long': { blocked: 1, attentionProject: LABELS.veryLong, attentionProjectCount: 1 },
    'blocked cjk estimated': { blocked: 120, attentionProject: LABELS.cjk, attentionProjectCount: 120, attentionEstimated: true, estimated: true },
    'blocked emoji': { blocked: 1, attentionProject: LABELS.emoji, attentionProjectCount: 1 },
    'error': { errors: 2, errorProject: 'api', errorProjectCount: 2 },
    'error no project': { errors: 1 },
    'unknown': { unknown: 4 },
    'estimated': { estimated: true, time: '23:59' },
    'no time': { time: '--:--' },
  };
  for (const kind of ['claude_sessions', 'codex_sessions', 'sessions', 'codex_history', 'agent_history', 'settings', 'refresh', 'other']) {
    cases[`warning ${kind}`] = { warning: true, warningKind: kind };
  }
  for (const language of LANGS) {
    for (const [name, patch] of Object.entries(cases)) {
      const summary = { ...base, ...patch, language };
      ['overview', 'attention', 'clock'].forEach((slot, i) => {
        out.push({ group: 'summary', name: `summary ${language} ${name} ${slot}`, kind: 'summary', render: () => summarySvgs(summary)[i] });
      });
    }
  }
  return out;
}

/** 갤러리와 테스트가 같이 쓰는 전체 예시. render()는 96px SVG 문자열을 돌려준다. */
export function galleryFixtures() {
  return [...keyFixtures(), ...summaryFixtures()];
}
