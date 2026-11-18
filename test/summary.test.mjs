import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { buildSummary, summarySvgs, renderSummaryTiles } from '../src/summary.mjs';

test('summarizes observed states without counting unknown as clear', () => {
  const summary = buildSummary([
    { status: 'working', source: 'codex-rollout' },
    { status: 'blocked', project: '<script>&example' },
    { status: 'done' }, { status: 'unknown' },
  ], '2026-11-09T01:30:00+09:00');
  assert.deepEqual([summary.working, summary.blocked, summary.done, summary.unknown], [1, 1, 1, 1]);
  assert.equal(summary.estimated, true);
  assert.match(summary.time, /^\d{2}:\d{2}$/);
  const images = summarySvgs(summary);
  assert.match(images[2], /\? 추정/);
  assert.match(images[1], /&lt;scr…/);
  assert.doesNotMatch(images[1], /<script>/);
});

test('distinguishes no alerts from unknown state and errors', () => {
  let summary = buildSummary([{status: 'unknown'}]);
  assert.match(summarySvgs(summary)[1], />미확인<\/text>/);
  assert.match(summarySvgs(summary)[1], />1개<\/text>/);
  summary = buildSummary([], null, ['read failed']);
  assert.match(summarySvgs(summary)[1], />상태<\/text>/);
  assert.doesNotMatch(summarySvgs(summary)[1], />오류<\/text>/);
  assert.equal(summary.time, '--:--');
});

test('renders three bounded 96x96 JPEGs in display slot order', async () => {
  const images = await renderSummaryTiles(buildSummary([]), sharp);
  assert.deepEqual(images.map((image) => image.slot), [16, 17, 18]);
  for (const image of images) {
    const metadata = await sharp(image.jpeg).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 96);
    assert.equal(metadata.height, 96);
    assert.ok(image.jpeg.length <= 10240);
  }
});

test('uses large labels and truncates long project names safely', () => {
  const images = summarySvgs(buildSummary([{status: 'blocked', project: '매우긴프로젝트이름&<'}], null));
  assert.match(images[0], /font-size="18"[^>]*>작업/);
  assert.match(images[0], /font-size="22"[^>]*>0/);
  assert.match(images[1], /매우…/);
  assert.doesNotMatch(images[1], /프로젝트이름/);
  assert.match(images[2], /font-size="26"[^>]*textLength="64"/);
  for (const image of images) {
    for (const match of image.matchAll(/<text x="(\\d+)"/g)) {
      assert.ok(Number(match[1]) >= 26, `text starts outside the safe area: ${match[0]}`);
    }
  }
});


test('renders the side summary in English within the calibrated area', () => {
  const summary = { ...buildSummary([{status: 'working'}, {status: 'blocked', project: '작업&팀'}, {status: 'done'}], '2026-11-09T12:00:00Z'), language: 'en', estimated: true };
  const [overview, attention, clock] = summarySvgs(summary);
  for (const label of ['WORK', 'ASK', 'DONE']) assert.match(overview, new RegExp(`>${label}</text>`));
  assert.match(attention, />WAITING<\/text>/);
  assert.match(attention, />1<\/text>/);
  assert.match(attention, /작업&amp;팀/);
  assert.match(clock, />UPDATED<\/text>/);
  assert.match(clock, /\? EST\./);
  for (const image of [overview, attention, clock]) {
    assert.match(image, /width="96" height="96"/);
    assert.doesNotMatch(image, /<text x="(?:[0-9]|1[0-9]|2[0-5])"/);
  }
  const englishEmpty = summarySvgs({...buildSummary([{status:'unknown'}]), language:'en'})[1];
  assert.match(englishEmpty, />SESSION<\/text>/);
  assert.match(englishEmpty, />UNSURE<\/text>/);
  assert.match(englishEmpty, />1<\/text>/);
  const englishWarning = summarySvgs({...buildSummary([], null, ['warning']), language:'en'})[1];
  assert.match(englishWarning, />STATUS<\/text>/);
  assert.match(englishWarning, />CHECK<\/text>/);
  assert.match(summarySvgs(buildSummary([]))[0], />작업<\/text>/);
});


test('shows the specific partial session warning without calling it an error', () => {
  const claude = buildSummary([], null, ['Claude 세션 실행 여부를 일부 확인할 수 없습니다.']);
  assert.equal(claude.warningKind, 'claude_sessions');
  const image = summarySvgs(claude)[1];
  assert.match(image, />Claude<\/text>/);
  assert.match(image, />일부 세션<\/text>/);
  assert.match(image, />미확인<\/text>/);
  assert.doesNotMatch(image, />오류<\/text>/);
  assert.equal(buildSummary([], null, ['Codex 열린 세션을 일부 확인할 수 없습니다.']).warningKind, 'codex_sessions');
  assert.equal(buildSummary([], null, ['Codex 열린 세션을 일부 확인할 수 없습니다.', 'Claude 세션 실행 여부를 일부 확인할 수 없습니다.']).warningKind, 'sessions');
});

test('prioritizes a waiting session and marks inferred waiting', () => {
  const summary = buildSummary([{ status: 'blocked', project: 'MyProject', confidence: 'inferred' }, { status: 'error' }], null,
    ['Claude 세션 실행 여부를 일부 확인할 수 없습니다.']);
  const image = summarySvgs(summary)[1];
  assert.match(image, />확인 대기<\/text>/);
  assert.match(image, />1건\?<\/text>/);
  assert.doesNotMatch(image, /Claude|>오류<\/text>/);
  const error = summarySvgs(buildSummary([{status:'error', project:'ExampleProject'}], null, ['Claude 세션 실행 여부를 일부 확인할 수 없습니다.']))[1];
  assert.match(error, />오류<\/text>/);
  assert.match(error, />Exa…<\/text>/);
  assert.doesNotMatch(error, /Claude|앱 확인/);
});

test('never renders arbitrary warning text or private paths', () => {
  const summary = buildSummary([], null, ['read failed: /Users/private/secret.txt']);
  assert.equal(summary.warningKind, 'other');
  const image = summarySvgs(summary)[1];
  assert.match(image, />확인 필요<\/text>/);
  assert.doesNotMatch(image, /private|secret|read failed/);
});


test('middle count and uncertainty refer only to the displayed project', () => {
  const summary = buildSummary([
    {status:'blocked', project:'Alpha', projectId:'a', confidence:'observed'},
    {status:'blocked', project:'Alpha', projectId:'a', confidence:'observed'},
    {status:'blocked', project:'Beta', projectId:'b', confidence:'inferred'},
  ]);
  assert.equal(summary.blocked, 3);
  assert.equal(summary.attentionProjectCount, 2);
  assert.equal(summary.attentionEstimated, false);
  const image = summarySvgs(summary)[1];
  assert.match(image, />2건<\/text>/);
  assert.doesNotMatch(image, />3건|\?/);
  const errors = buildSummary([
    {status:'error', project:'Alpha', projectId:'a', confidence:'observed'},
    {status:'error', project:'Beta', projectId:'b', confidence:'inferred'},
    {status:'error', project:'Beta', projectId:'b', confidence:'inferred'},
  ]);
  assert.equal(errors.errors, 3);
  assert.equal(errors.errorProjectCount, 1);
  assert.equal(errors.errorEstimated, false);
  assert.match(summarySvgs(errors)[1], />1건<\/text>/);
});
