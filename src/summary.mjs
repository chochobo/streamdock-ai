// The 293s V3 has three display-only 96 × 96 image slots. Their physical
// order must be verified on the device; the protocol order is 16, 17, 18.
const SIZE = 96;
const COLORS = { background: '#101923', white: '#f0f5fa', muted: '#8793a8', working: '#59d2ae', blocked: '#ffb976', done: '#70a8ff', error: '#fb7185' };

const escapeXml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);

// Allow space for wide CJK glyphs. The full project name remains in the web UI.
function shorten(value, budget = 62) {
  const input = String(value || 'Unknown').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim() || 'Unknown';
  const characters = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input), part => part.segment);
  // Conservative widths for bold 16px text. Reserve space for the ellipsis.
  const width = character => {
    if (/\s/u.test(character)) return 6;
    if (!/^[\x00-\x7f]$/u.test(character)) return 16;
    if (/[MW@%]/.test(character)) return 17;
    if (/[A-Z]/.test(character)) return 14;
    if (/[mw]/.test(character)) return 14;
    if (/[ilj1.]/.test(character)) return 6;
    if (/[frt]/.test(character)) return 8;
    return 11;
  };
  const total = characters.reduce((sum, character) => sum + width(character), 0);
  if (total <= budget) return characters.join('');
  let result = '';
  let used = 0;
  for (const character of characters) {
    const next = width(character);
    if (used + next > budget - 16) break;
    result += character;
    used += next;
  }
  return `${result.trimEnd()}…`;
}

/** Summarize only observed states; unknown states are never counted as safe. */
// Only map known diagnostic messages. Never copy arbitrary warnings to the device.
function warningKind(warnings) {
  const values = new Set(Array.isArray(warnings) ? warnings.filter(value => typeof value === 'string') : []);
  if (!values.size) return null;
  if (values.has('설정을 읽지 못했습니다.')) return 'settings';
  if ([...values].some(value => value.startsWith('상태를 갱신하지 못했습니다:'))) return 'refresh';
  if (values.has('Cannot read Codex session directory')) return 'codex_history';
  if (values.has('Cannot read streamdock-hook agent status directory') || values.has('Cannot read agentdeck-hook agent status directory')) return 'agent_history';
  const claude = values.has('Claude 세션 실행 여부를 일부 확인할 수 없습니다.');
  const codex = values.has('Codex 열린 세션을 일부 확인할 수 없습니다.');
  if (values.has('세션 실행 여부를 확인할 수 없습니다.') || (claude && codex)) return 'sessions';
  if (claude) return 'claude_sessions';
  if (codex) return 'codex_sessions';
  return 'other';
}

export function buildSummary(agents = [], updatedAt = null, warnings = []) {
  const records = Array.isArray(agents) ? agents.filter((agent) => agent && typeof agent === 'object') : [];
  const count = (status) => records.filter((agent) => agent.status === status).length;
  const blocked = records.filter((agent) => agent.status === 'blocked');
  const errors = records.filter((agent) => agent.status === 'error');
  const attention = blocked[0];
  const sameProject = (records, first) => {
    if (!first) return [];
    if (typeof first.projectId === 'string' && first.projectId) return records.filter(agent => agent.projectId === first.projectId);
    if (typeof first.project === 'string' && first.project) return records.filter(agent => !agent.projectId && agent.project === first.project);
    return [first];
  };
  const attentionGroup = sameProject(blocked, attention);
  const errorGroup = sameProject(errors, errors[0]);
  const inferred = agent => agent.confidence === 'inferred' || agent.statusConfidence === 'inferred' || (!agent.confidence && agent.source === 'codex-rollout');
  const time = updatedAt ? new Date(updatedAt) : null;
  return {
    working: count('working'), blocked: blocked.length, done: count('done'),
    unknown: count('unknown'), errors: errors.length,
    estimated: records.some(inferred),
    attentionProject: attention ? String(attention.project || attention.name || 'Unknown') : null,
    attentionProjectCount: attentionGroup.length,
    attentionEstimated: attentionGroup.some(inferred),
    errorProject: errors[0] ? String(errors[0].project || errors[0].name || '') : '',
    errorProjectCount: errorGroup.length,
    errorEstimated: errorGroup.some(inferred),
    time: time && Number.isFinite(time.getTime()) ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(time) : '--:--',
    warning: Array.isArray(warnings) && warnings.length > 0,
    warningKind: warningKind(warnings),
  };
}

const svg = (content) => `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="96" height="96" fill="${COLORS.background}"/><g font-family="sans-serif">${content}</g></svg>`;
const text = (x, y, value, size, fill, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${escapeXml(value)}</text>`;

/** Create unrotated, inspectable SVGs for the three display slots. */
export function summarySvgs(summary) {
  // Only x=26..90 is visible through the physical bezel.
  const en = summary.language === 'en';
  const metric = (y, color, label, number) => {
    const count = Number.isSafeInteger(number) && number >= 0 ? number : 0;
    const value = count > 99 ? '99+' : String(count);
    return text(26, y, label, en ? 12 : 18, COLORS.white, 'font-weight="bold"') +
      text(90, y, value, count > 99 ? 14 : 22, color, 'text-anchor="end" font-weight="bold"');
  };
  const overview = svg(
    metric(26, COLORS.working, en ? 'WORK' : '작업', summary.working) +
    metric(57, COLORS.blocked, en ? 'ASK' : '확인', summary.blocked) +
    metric(88, COLORS.done, en ? 'DONE' : '완료', summary.done)
  );

  // The middle region is read-only. Show actionable waiting states first,
  // then real agent errors, then specific collection warnings. Diagnostic
  // strings are classified in buildSummary and never copied to the device.
  let lines;
  let tone = COLORS.muted;
  if (summary.blocked) {
    const count = summary.attentionProjectCount ?? summary.blocked;
    lines = [en ? 'WAITING' : '확인 대기', shorten(summary.attentionProject),
      `${count > 99 ? '99+' : count}${en ? '' : '건'}${summary.attentionEstimated ? '?' : ''}`];
    tone = COLORS.blocked;
  } else if (summary.errors) {
    const projectCount = summary.errorProjectCount ?? summary.errors;
    const count = projectCount > 99 ? '99+' : projectCount;
    lines = [en ? 'ERROR' : '오류', summary.errorProject ? shorten(summary.errorProject) : (en ? 'AGENT' : '에이전트'),
      `${count}${en ? '' : '건'}${summary.errorEstimated ? '?' : ''}`];
    tone = COLORS.error;
  } else if (summary.warning) {
    const labels = en ? {
      claude_sessions: ['Claude', 'SESSION', 'PARTIAL'],
      codex_sessions: ['Codex', 'SESSION', 'PARTIAL'],
      sessions: ['SESSION', 'STATUS', 'UNSURE'],
      codex_history: ['Codex', 'HISTORY', 'FAILED'],
      agent_history: ['AGENT', 'HISTORY', 'FAILED'],
      settings: ['SETUP', 'READ', 'FAILED'],
      refresh: ['STATUS', 'UPDATE', 'FAILED'],
      other: ['STATUS', 'CHECK', 'IN APP'],
    } : {
      claude_sessions: ['Claude', '일부 세션', '미확인'],
      codex_sessions: ['Codex', '일부 세션', '미확인'],
      sessions: ['세션', '실행 상태', '미확인'],
      codex_history: ['Codex', '기록 읽기', '실패'],
      agent_history: ['에이전트', '기록 읽기', '실패'],
      settings: ['설정', '읽기 실패', '앱 확인'],
      refresh: ['상태', '갱신 실패', '앱 확인'],
      other: ['상태', '확인 필요', '앱 확인'],
    };
    lines = labels[summary.warningKind] || labels.other;
  } else if (summary.unknown) {
    lines = en ? ['SESSION', 'UNSURE', String(summary.unknown > 99 ? '99+' : summary.unknown)]
      : ['세션', '미확인', `${summary.unknown > 99 ? '99+' : summary.unknown}개`];
  } else {
    lines = en ? ['ALERT', 'NONE', ''] : ['알림', '없음', ''];
  }
  const sizes = en ? [14, 13, 13] : [16, 16, 16];
  const attention = svg(lines.map((value, i) => value
    ? text(26, [22, 52, 82][i], value, sizes[i], i === 0 ? COLORS.muted : (i === 2 ? tone : COLORS.white), 'font-weight="bold"')
    : '').join(''));
  const clock = svg(
    text(26, 22, en ? 'UPDATED' : '갱신', 18, COLORS.muted,
      'font-weight="bold"' + (en ? ' textLength="64" lengthAdjust="spacingAndGlyphs"' : '')) +
    text(26, 59, summary.time, 26, COLORS.white,
      'textLength="64" lengthAdjust="spacingAndGlyphs" font-weight="bold"') +
    (summary.estimated ? text(26, 86, en ? '? EST.' : '? 추정', 16, COLORS.muted, 'font-weight="bold"') : '')
  );
  return [overview, attention, clock];
}

/** Return rotated JPEGs ready for the manufacturer's image slots. */
export async function renderSummaryTiles(summary, sharp) {
  if (typeof sharp !== 'function') throw new TypeError('sharp is required');
  return Promise.all(summarySvgs(summary).map(async (image, index) => ({
    slot: 16 + index,
    jpeg: await sharp(Buffer.from(image)).rotate(-90).jpeg({ quality: 85 }).toBuffer(),
  })));
}

// The 293S tiles keep their content at x=26..90 because the bezel covers the
// left edge of the side screens. A full key shows the whole face, so shift
// the content left by 10 px to centre it (x=16..80).
const KEY_SHIFT = -10;

/** Upright 96 × 96 SVGs for devices that show the summary on regular keys. */
export function summaryKeySvgs(summary) {
  return summarySvgs(summary).map(image => image.replace('<g font-family="sans-serif">', `<g font-family="sans-serif" transform="translate(${KEY_SHIFT} 0)">`));
}

/** Return [overview, attention, clock] JPEGs sized and rotated for the model's keys. */
export async function renderSummaryKeyImages(summary, sharp, { size = SIZE, rotate = 0 } = {}) {
  if (typeof sharp !== 'function') throw new TypeError('sharp is required');
  if (!Number.isInteger(size) || size < 16 || size > 256 || ![0, 90, -90, 180, 270].includes(rotate)) throw new RangeError('Invalid summary key image options');
  return Promise.all(summaryKeySvgs(summary).map(async image => {
    const make = quality => sharp(Buffer.from(image)).resize(size, size, { fit: 'fill' }).rotate(rotate).jpeg({ quality }).toBuffer();
    let jpeg = await make(85);
    if (jpeg.length > 10_240) jpeg = await make(65);
    if (jpeg.length > 10_240) throw new Error('Summary image exceeds device limit');
    return jpeg;
  }));
}
