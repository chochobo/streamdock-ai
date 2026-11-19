import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { wideSliceSvg, wideCanvasSvg, usageRows, WIDE_TYPES } from '../src/dashboard-widgets.mjs';
import { keyTileSvg } from '../src/device.mjs';

const rows = [{ label: 'Codex 5h', used: 42, reset: '15:30' }, { label: 'Claude 5h', used: 91, reset: '월 09:00' }];
const wide = (type, extra, part = 1, parts = 7) => ({ type, part, parts, language: 'ko', ...extra });

test('a slice is a 96 px tile that shows its own part of the wide picture', () => {
  const svg = wideSliceSvg(wide('usage', { rows }, 3));
  assert.match(svg, /^<svg [^>]*width="96"[^>]*height="96"/);
  assert.match(svg, /viewBox="192 0 96 96"/);
  const first = wideSliceSvg(wide('usage', { rows }, 1));
  assert.match(first, /viewBox="0 0 96 96"/);
});

test('all slices of one widget cut the same drawing', () => {
  const canvas = wideCanvasSvg(wide('graph', { cpu: [10, 20, 30], mem: [50, 50, 50] }, 1, 7));
  assert.match(canvas, /width="672"/);
  for (let part = 1; part <= 7; part++) {
    const slice = wideSliceSvg(wide('graph', { cpu: [10, 20, 30], mem: [50, 50, 50] }, part, 7));
    assert.ok(slice.includes(canvas.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')), 'the slice carries the full drawing');
  }
});

test('keyTileSvg draws a wide key through the same renderer', () => {
  const key = { kind: 'wide', language: 'ko', wide: { type: 'usage', part: 2, parts: 7, rows } };
  assert.equal(keyTileSvg(key), wideSliceSvg({ ...key.wide, language: 'ko' }));
});

test('a wide drawing renders to real pixels at every slice and every type', async () => {
  const samples = { usage: { rows }, graph: { cpu: [5, 40, 90, 20], mem: [60, 61, 62, 63] }, stack: { counts: { working: 3, blocked: 1, error: 0, done: 2, idle: 4 } } };
  for (const type of WIDE_TYPES) {
    for (let part = 1; part <= 7; part++) {
      const png = await sharp(Buffer.from(wideSliceSvg(wide(type, samples[type], part)))).png().toBuffer();
      const meta = await sharp(png).metadata();
      assert.deepEqual([meta.width, meta.height], [96, 96]);
    }
  }
});

test('usage rows show provider, percent and reset; missing values are not invented', () => {
  const svg = wideCanvasSvg(wide('usage', { rows: [{ label: 'Codex 5h', used: 42, reset: '15:30' }, { label: 'Claude 5h', used: null, reset: null }] }));
  assert.match(svg, /Codex 5h/);
  assert.match(svg, />42%</);
  assert.match(svg, /15:30/);
  assert.match(svg, /미확인/);
  assert.doesNotMatch(svg, />null%</);
  const en = wideCanvasSvg({ ...wide('usage', { rows: [{ label: 'Claude 5h', used: null, reset: null }] }), language: 'en' });
  assert.match(en, /Unknown/);
});

test('usage color follows the same thresholds as the quota keys', () => {
  const colorOf = used => /<rect [^>]*data-fill="([^"]+)"/.exec(wideCanvasSvg(wide('usage', { rows: [{ label: 'x', used, reset: null }] })))?.[1];
  assert.equal(colorOf(10), '#59d2ae');
  assert.equal(colorOf(60), '#ffc66d');
  assert.equal(colorOf(84), '#ffc66d');
  assert.equal(colorOf(85), '#fb7185');
  assert.equal(colorOf(100), '#fb7185');
});

test('the graph draws lines for both series, labels the latest values, and says when it is collecting', () => {
  const svg = wideCanvasSvg(wide('graph', { cpu: [10, 20, 30, 40], mem: [60, 60, 61, 62] }));
  assert.equal((svg.match(/<polyline/g) || []).length, 2);
  assert.match(svg, /CPU 40%/);
  assert.match(svg, /MEM 62%/);
  const collecting = wideCanvasSvg(wide('graph', { cpu: [10], mem: [20] }));
  assert.match(collecting, /수집 중/);
  assert.doesNotMatch(collecting, /<polyline/);
  assert.match(wideCanvasSvg({ ...wide('graph', { cpu: [], mem: [] }), language: 'en' }), /Collecting/);
});

test('graph points are clamped to 0..100 and bad numbers are dropped', () => {
  const svg = wideCanvasSvg(wide('graph', { cpu: [10, 'x', NaN, 250, -5, 40], mem: [50, 50, 50] }));
  const points = /<polyline[^>]*points="([^"]+)"/.exec(svg)?.[1].split(' ').map(pair => pair.split(',').map(Number)) ?? [];
  assert.ok(points.length >= 2);
  assert.ok(points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && y >= 0 && y <= 96));
});

test('the stack bar splits by count, lists every state, and says when nothing is open', () => {
  const svg = wideCanvasSvg(wide('stack', { counts: { working: 3, blocked: 1, error: 0, done: 2, idle: 4 } }));
  for (const label of ['작업', '확인', '오류', '완료', '대기']) assert.match(svg, new RegExp(label));
  assert.match(svg, />3</);
  const empty = wideCanvasSvg(wide('stack', { counts: { working: 0, blocked: 0, error: 0, done: 0, idle: 0 } }));
  assert.match(empty, /열린 세션/);
  assert.match(empty, />없음</);
  const emptyEn = wideCanvasSvg({ ...wide('stack', { counts: { working: 0, blocked: 0, error: 0, done: 0, idle: 0 } }), language: 'en' });
  assert.match(emptyEn, />No open</);
  assert.match(emptyEn, />sessions</);
  const big = wideCanvasSvg(wide('stack', { counts: { working: 250, blocked: 0, error: 0, done: 0, idle: 0 } }));
  assert.match(big, /99\+/);
});

test('text from the data is escaped and counts are bounded', () => {
  const svg = wideCanvasSvg(wide('usage', { rows: [{ label: '<script>&"\'', used: 10, reset: '<b>' }] }));
  assert.doesNotMatch(svg, /<script>|<b>/);
  assert.match(svg, /&lt;script&gt;/);
  const many = wideCanvasSvg(wide('usage', { rows: Array.from({ length: 10 }, (_, i) => ({ label: `L${i}`, used: i, reset: null })) }));
  assert.equal((many.match(/data-row/g) || []).length, 2, 'at most two provider rows');
});

test('bad input never throws: unknown type, bad part, missing data', () => {
  assert.doesNotThrow(() => wideSliceSvg({ type: 'nope', part: 1, parts: 7 }));
  assert.doesNotThrow(() => wideSliceSvg({ type: 'graph', part: 99, parts: 7 }));
  assert.doesNotThrow(() => wideSliceSvg(undefined));
  assert.match(wideSliceSvg({ type: 'nope', part: 1, parts: 7 }), /^<svg /);
});

test('usageRows picks the first window of each provider, Codex first, two at most', () => {
  const picked = usageRows({ accounts: [
    { id: 'c1', provider: 'claude', label: 'Claude', status: 'ok', windows: [{ label: '5h', usedPercent: 91.4, resetsAt: '2026-11-20T06:00:00.000Z' }, { label: '주간', usedPercent: 10 }] },
    { id: 'x1', provider: 'codex', label: 'Codex', status: 'ok', windows: [{ label: '5h', usedPercent: 42 }] },
    { id: 'c2', provider: 'claude', label: 'Claude 2', status: 'ok', windows: [{ label: '5h', usedPercent: 5 }] },
  ] });
  assert.deepEqual(picked.map(r => r.label), ['Codex 5h', 'Claude 5h']);
  assert.deepEqual(picked.map(r => r.used), [42, 91]);
  assert.equal(usageRows({ accounts: [] }).length, 0);
  assert.equal(usageRows(undefined).length, 0);
  const unavailable = usageRows({ accounts: [{ id: 'a', provider: 'claude', label: 'Claude', status: 'unavailable', windows: [] }] });
  assert.deepEqual(unavailable.map(r => r.used), [null]);
});

test('no piece of text crosses a key boundary, so the bezel never cuts a letter', () => {
  // Every <text> must start and end inside one 96 px key. Width is estimated with a generous per-character bound.
  const samples = [
    wide('usage', { rows: [{ label: 'Claude 5h', used: 100, reset: '월 09:00' }, { label: 'Codex 5h', used: null, reset: null }] }),
    { ...wide('usage', { rows: [{ label: 'Claude 5h', used: 100, reset: 'Mon 09:00' }, { label: 'Codex 5h', used: null, reset: null }] }), language: 'en' },
    { ...wide('usage', { rows: [] }), language: 'en' }, wide('usage', { rows: [] }),
    wide('graph', { cpu: [1, 2, 3], mem: [4, 5, 6] }), wide('graph', { cpu: [], mem: [] }), { ...wide('graph', { cpu: [], mem: [] }), language: 'en' },
    wide('stack', { counts: { working: 120, blocked: 1, error: 1, done: 1, idle: 1 } }), { ...wide('stack', { counts: { working: 1, blocked: 1, error: 1, done: 1, idle: 1 } }), language: 'en' },
    wide('stack', { counts: {} }), { ...wide('stack', { counts: {} }), language: 'en' },
  ];
  const problems = [];
  for (const sample of samples) {
    const svg = wideCanvasSvg(sample);
    for (const match of svg.matchAll(/<text x="([\d.]+)" y="[\d.]+" fill="[^"]+" font-family="sans-serif" font-size="(\d+)" font-weight="bold"( text-anchor="(\w+)")?>([^<]*)<\/text>/g)) {
      const [, x, size, , anchor = 'start', content] = match;
      const widthOf = Array.from(content).reduce((sum, ch) => sum + (/[\x00-\x7f]/.test(ch) ? 0.62 : 1.0) * Number(size), 0);
      const left = anchor === 'middle' ? Number(x) - widthOf / 2 : anchor === 'end' ? Number(x) - widthOf : Number(x);
      const right = left + widthOf;
      if (Math.floor((left + 0.5) / 96) !== Math.floor((right - 0.5) / 96)) problems.push(`${sample.type}/${sample.language} "${content}" spans ${left.toFixed(0)}-${right.toFixed(0)}`);
    }
  }
  assert.deepEqual(problems, []);
});
