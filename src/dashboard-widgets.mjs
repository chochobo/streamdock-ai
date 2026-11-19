// XL dashboard widgets (#36): one wide picture drawn across several keys.
//
// Each widget is drawn once on a canvas `parts` keys wide (96 px per key) and
// every key shows its own slice of it (the same drawing with the viewBox moved).
// A key only carries a small description (`type`, `part`, `parts`, the numbers
// to draw); everything here is pure and never reads the system or the network.
// Values that are missing are drawn as unknown, never guessed.

const KEY = 96;
export const WIDE_TYPES = Object.freeze(['usage', 'graph', 'stack']);
const MAX_SAMPLES = 120;
const COLOR = {
  bg: '#101923', white: '#f7fbff', muted: '#8793a8', track: '#223244', grid: '#2a3a4d',
  ok: '#59d2ae', warn: '#ffc66d', bad: '#fb7185', stale: '#8c99a8',
  cpu: '#84c7ff', mem: '#ffc66d',
  working: '#59d2ae', blocked: '#ffb976', error: '#fb7185', done: '#70a8ff', idle: '#8793a8',
};
const STATUS_LABELS = {
  ko: { working: '작업', blocked: '확인', error: '오류', done: '완료', idle: '대기' },
  en: { working: 'Work', blocked: 'Ask', error: 'Error', done: 'Done', idle: 'Idle' },
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
const clean = (value, max) => Array.from(String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()).slice(0, max).join('');
const finite = (value, min, max) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null);
const count = value => (Number.isFinite(value) && value > 0 ? Math.min(9999, Math.floor(value)) : 0);
const fixed = value => Math.round(value * 10) / 10;
const text = (x, y, value, { size = 18, fill = COLOR.white, anchor = 'start', weight = 'bold' } = {}) =>
  `<text x="${fixed(x)}" y="${fixed(y)}" fill="${fill}" font-family="sans-serif" font-size="${size}" font-weight="${weight}"${anchor === 'start' ? '' : ` text-anchor="${anchor}"`}>${esc(value)}</text>`;

/**
 * Runs of at least `min` keys that sit side by side on one row of the page content area
 * (the XL gives three rows of seven; the 293S none). A widget is drawn across one run.
 */
export function wideRuns(layout, min = 7) {
  const cols = layout?.cols, content = layout?.pageContent;
  if (!Number.isInteger(cols) || cols < 1 || !Array.isArray(content)) return [];
  const runs = [];
  let run = [];
  for (const index of content) {
    if (run.length && (index !== run.at(-1) + 1 || Math.floor(index / cols) !== Math.floor(run[0] / cols))) { runs.push(run); run = []; }
    run.push(index);
  }
  if (run.length) runs.push(run);
  return runs.filter(item => item.length >= min);
}

/** Keeps only what the renderer reads, bounded, so a key never carries stray data. */
export function safeWide(wide) {
  if (!wide || typeof wide !== 'object' || !WIDE_TYPES.includes(wide.type)) return null;
  const parts = Number.isInteger(wide.parts) ? Math.min(8, Math.max(1, wide.parts)) : 7;
  const out = { type: wide.type, parts, part: Number.isInteger(wide.part) ? Math.min(parts, Math.max(1, wide.part)) : 1 };
  if (wide.type === 'usage') out.rows = (Array.isArray(wide.rows) ? wide.rows : []).slice(0, 2).map(row => ({
    label: clean(row?.label, 14), used: finite(row?.used, 0, 100), reset: row?.reset ? clean(row.reset, 10) : null, stale: row?.stale === true }));
  if (wide.type === 'graph') { out.cpu = series(wide.cpu); out.mem = series(wide.mem); }
  if (wide.type === 'stack') {
    out.counts = Object.fromEntries(['working', 'blocked', 'error', 'done', 'idle'].map(state => [state, count(wide.counts?.[state])]));
    out.unknown = count(wide.unknown);
  }
  return out;
}

/** Usage rows for the dashboard: the first window of each provider (Codex, then Claude), at most two. */
export function usageRows(usage) {
  const accounts = Array.isArray(usage?.accounts) ? usage.accounts.filter(account => account && typeof account === 'object') : [];
  const order = { codex: 0, claude: 1 };
  const rows = [];
  const seen = new Set();
  for (const account of [...accounts].sort((a, b) => (order[a.provider] ?? 2) - (order[b.provider] ?? 2))) {
    if (rows.length >= 2 || !Object.hasOwn(order, account.provider) || seen.has(account.provider)) continue;
    seen.add(account.provider);
    const name = account.provider === 'codex' ? 'Codex' : 'Claude';
    const windows = account.status === 'unavailable' || !Array.isArray(account.windows) ? [] : account.windows.filter(window => window && typeof window === 'object');
    const window = windows.find(item => finite(item.usedPercent, 0, 100) !== null) ?? null;
    const label = window ? clean(String(window.label || '').split('·').at(-1), 12) : '';
    const reset = typeof window?.resetsAt === 'string' ? formatReset(window.resetsAt) : (typeof window?.resetLabel === 'string' && /^[월화수목금토일] [0-2][0-9]:[0-5][0-9]$/u.test(window.resetLabel) ? window.resetLabel : null);
    rows.push({ label: label ? `${name} ${label}` : name, used: window ? Math.round(finite(window.usedPercent, 0, 100)) : null, reset, stale: account.status === 'stale' || window?.status === 'stale' });
  }
  return rows;
}

function formatReset(iso) {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  const pad = value => String(value).padStart(2, '0');
  const sameDay = new Date().toDateString() === at.toDateString();
  return sameDay ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : `${pad(at.getMonth() + 1)}/${pad(at.getDate())}`;
}

// Layout rule: bars and lines may run across keys (the physical gap between keys
// only interrupts them), but every piece of text stays inside one key, so no
// letter is ever cut by the bezel. Keys are 96 px wide: key n spans (n-1)*96..n*96.
function usageBody(width, wide, en) {
  const rows = (Array.isArray(wide.rows) ? wide.rows : []).slice(0, 2);
  const middle = width / 2;
  if (!rows.length) return text(middle, 50, en ? 'Usage' : '사용량', { size: 17, fill: COLOR.muted, anchor: 'middle' }) + text(middle, 72, en ? 'unknown' : '미확인', { size: 17, fill: COLOR.muted, anchor: 'middle' });
  // key 1: name, keys 2-5: bar, key 6: percent, key 7: reset time
  const barX = KEY + 4, barW = width - barX - 2 * KEY - 4, percentX = width - 2 * KEY + 6, rowH = 48, top = rows.length === 1 ? 24 : 0;
  return rows.map((row, i) => {
    const y = top + i * rowH;
    const used = finite(row?.used, 0, 100);
    const stale = row?.stale === true;
    const fill = used === null ? COLOR.muted : stale ? COLOR.stale : used >= 85 ? COLOR.bad : used >= 60 ? COLOR.warn : COLOR.ok;
    const fillWidth = used === null ? 0 : Math.max(used > 0 ? 4 : 0, (used / 100) * barW);
    return `<g data-row="${i}">` +
      text(8, y + 30, clean(row?.label, 12) || '-', { size: 15, fill: stale ? COLOR.stale : COLOR.white }) +
      `<rect x="${barX}" y="${y + 17}" width="${barW}" height="14" rx="7" fill="${COLOR.track}"/>` +
      (used === null ? '' : `<rect data-fill="${fill}" x="${barX}" y="${y + 17}" width="${fixed(fillWidth)}" height="14" rx="7" fill="${fill}"/>`) +
      text(percentX, y + 33, used === null ? (en ? 'Unknown' : '미확인') : `${Math.round(used)}%`, { size: used === null ? 17 : 25, fill }) +
      (row?.reset ? text(width - 8, y + 30, clean(row.reset, 10), { size: 14, fill: COLOR.muted, anchor: 'end' }) : '') +
      '</g>';
  }).join('');
}

const series = values => (Array.isArray(values) ? values : []).map(value => finite(value, 0, 100)).filter(value => value !== null).slice(-MAX_SAMPLES);

function graphBody(width, wide, en) {
  const cpu = series(wide.cpu), mem = series(wide.mem);
  if (Math.max(cpu.length, mem.length) < 2) return text(width / 2, 57, en ? 'Collecting' : '수집 중…', { size: en ? 14 : 20, fill: COLOR.muted, anchor: 'middle' });
  const x0 = 8, x1 = width - 8, y0 = 28, y1 = 88, step = (x1 - x0) / (MAX_SAMPLES - 1);
  const yOf = value => fixed(y1 - (value / 100) * (y1 - y0));
  const grid = [0, 50, 100].map(level => `<line x1="${x0}" y1="${yOf(level)}" x2="${x1}" y2="${yOf(level)}" stroke="${COLOR.grid}" stroke-width="1"/>`).join('');
  const line = (values, color) => values.length < 2 ? '' :
    `<polyline fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${values.map((value, i) => `${fixed(x1 - (values.length - 1 - i) * step)},${yOf(value)}`).join(' ')}"/>`;
  const last = values => (values.length ? `${Math.round(values.at(-1))}%` : '--');
  // each label sits in its own key: CPU in key 1, MEM in key 2
  return grid + line(mem, COLOR.mem) + line(cpu, COLOR.cpu) +
    text(8, 18, `CPU ${last(cpu)}`, { size: 16, fill: COLOR.cpu }) + text(KEY + 8, 18, `MEM ${last(mem)}`, { size: 16, fill: COLOR.mem });
}

function stackBody(width, wide, en) {
  const counts = wide.counts && typeof wide.counts === 'object' ? wide.counts : {};
  const order = ['working', 'blocked', 'error', 'done', 'idle'];
  const values = Object.fromEntries(order.map(state => [state, count(counts[state])]));
  const total = order.reduce((sum, state) => sum + values[state], 0);
  const labels = STATUS_LABELS[en ? 'en' : 'ko'];
  const barX = 8, barW = width - 16;
  if (!total) {
    // Sessions whose state is unknown are never counted as idle or done.
    const unknownOnly = count(wide.unknown) > 0;
    return `<rect x="${barX}" y="18" width="${barW}" height="28" rx="9" fill="${COLOR.track}"/>` +
      text(width / 2, 68, unknownOnly ? (en ? 'Status' : '상태') : (en ? 'No open' : '열린 세션'), { size: 16, fill: COLOR.muted, anchor: 'middle' }) +
      text(width / 2, 88, unknownOnly ? (en ? 'unknown' : '미확인') : (en ? 'sessions' : '없음'), { size: 16, fill: COLOR.muted, anchor: 'middle' });
  }
  let cursor = barX;
  const segments = order.filter(state => values[state] > 0).map(state => {
    const w = Math.max(8, (values[state] / total) * barW);
    const segment = `<rect x="${fixed(cursor)}" y="18" width="${fixed(w)}" height="28" fill="${COLOR[state]}"/>`;
    cursor += w;
    return segment;
  }).join('');
  // One state per key, in the five middle keys (keys 2-6): dot, name, count.
  const legend = order.map((state, i) => {
    const keyX = (i + 1) * KEY;
    const shown = values[state] > 99 ? '99+' : String(values[state]);
    return `<circle cx="${keyX + 11}" cy="73" r="5" fill="${COLOR[state]}"/>` + text(keyX + 20, 78, labels[state], { size: 15, fill: values[state] ? COLOR.white : COLOR.muted }) +
      text(keyX + KEY - 8, 80, shown, { size: 20, fill: values[state] ? COLOR[state] : COLOR.muted, anchor: 'end' });
  }).join('');
  // The bar is clipped to a rounded rectangle so segment ends stay square inside it.
  return `<clipPath id="bar"><rect x="${barX}" y="18" width="${barW}" height="28" rx="9"/></clipPath><g clip-path="url(#bar)">${segments}</g>${legend}`;
}

function canvas(wide) {
  const safe = wide && typeof wide === 'object' ? wide : {};
  const parts = Number.isInteger(safe.parts) ? Math.min(8, Math.max(1, safe.parts)) : 7;
  const width = parts * KEY;
  const en = safe.language === 'en';
  const body = safe.type === 'usage' ? usageBody(width, safe, en)
    : safe.type === 'graph' ? graphBody(width, safe, en)
    : safe.type === 'stack' ? stackBody(width, safe, en) : '';
  return { parts, width, body: `<rect width="${width}" height="${KEY}" fill="${COLOR.bg}"/>${body}`, part: Number.isInteger(safe.part) ? Math.min(parts, Math.max(1, safe.part)) : 1 };
}

/** The whole picture (for previews and tests). */
export function wideCanvasSvg(wide) {
  const { width, body } = canvas(wide);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${KEY}" viewBox="0 0 ${width} ${KEY}">${body}</svg>`;
}

/** What one key shows: its 96 px part of the picture. */
export function wideSliceSvg(wide) {
  const { part, body } = canvas(wide);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY}" height="${KEY}" viewBox="${(part - 1) * KEY} 0 ${KEY} ${KEY}">${body}</svg>`;
}
