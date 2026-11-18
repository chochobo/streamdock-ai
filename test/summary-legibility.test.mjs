import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { buildSummary, summarySvgs } from '../src/summary.mjs';

// On the 293sV3, the left bezel covers roughly the first 26 pixels. The
// right edge of the visible area is at approximately x=90. Check rendered
// pixels: librsvg does not reliably apply SVG textLength to every font.
test('attention messages render within the calibrated visible strip', async () => {
  const scenarios = [
    ['no alerts', buildSummary([])],
    ['unknown session', buildSummary([{ status: 'unknown' }])],
    ['long Latin project', buildSummary([{ status: 'blocked', project: 'streamdock-ai' }])],
    ['long Korean project', buildSummary([{ status: 'blocked', project: '매우긴프로젝트이름' }])],
    ['session warning', buildSummary([], null, ['Claude 세션 실행 여부를 일부 확인할 수 없습니다.'])],
    ['unknown warning', buildSummary([], null, ['알 수 없는 문제'])],
    ['English warning', { ...buildSummary([], null, ['warning']), language: 'en' }],
    ['English project', { ...buildSummary([{ status: 'blocked', project: 'WWWWWWWWWWWW' }]), language: 'en' }],
    ['agent error', buildSummary([{ status: 'error' }])],
    ['many inferred blocked', buildSummary(Array.from({ length: 101 }, () => ({ status: 'blocked', project: 'long-project', confidence: 'inferred' })))],
    ['many unknown', buildSummary(Array.from({ length: 101 }, () => ({ status: 'unknown' })))],
  ];
  for (const warningKind of ['claude_sessions', 'codex_sessions', 'sessions', 'codex_history', 'agent_history', 'settings', 'refresh', 'other']) {
    for (const language of ['ko', 'en']) scenarios.push([`${language} ${warningKind}`, { ...buildSummary([], null, ['warning']), warningKind, language }]);
  }
  const background = [16, 25, 35];
  for (const [name, summary] of scenarios) {
    const { data, info } = await sharp(Buffer.from(summarySvgs(summary)[1]))
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 96);
    assert.equal(info.height, 96);
    let painted = 0;
    const paintedRows = [0, 0, 0];
    for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
      const offset = (y * 96 + x) * info.channels;
      const delta = Math.max(...background.map((c, i) => Math.abs(c - data[offset + i])));
      if (delta <= 12) continue;
      painted++;
      paintedRows[y < 31 ? 0 : y < 61 ? 1 : 2]++;
      assert.ok(x >= 26 && x <= 90, `${name}: content outside visible area at x=${x}, y=${y}`);
    }
    assert.ok(painted > 20, `${name}: expected visible content`);
    const rowsNeeded = name === 'no alerts' ? 2 : 3;
    for (let row = 0; row < rowsNeeded; row++) assert.ok(paintedRows[row] > 5, `${name}: expected visible row ${row + 1}`);
  }
});

test('overview labels and counts remain separate inside the visible strip', async () => {
  for (const language of ['ko', 'en']) for (const count of [0, 9, 99, 100, 1000]) {
    const summary = { ...buildSummary([]), working: count, blocked: count, done: count, language };
    const tags = [...summarySvgs(summary)[0].matchAll(/<text\b[^>]*>[\s\S]*?<\/text>/g)].map(m => m[0]);
    assert.equal(tags.length, 6, 'three label and count pairs are required');
    const bounds = [];
    for (const tag of tags) {
      const image = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#101923"/><g font-family="sans-serif">${tag}</g></svg>`;
      const { data, info } = await sharp(Buffer.from(image)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let min = 96, max = -1;
      for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
        const offset = (y * 96 + x) * info.channels;
        if (Math.max(Math.abs(data[offset] - 16), Math.abs(data[offset + 1] - 25), Math.abs(data[offset + 2] - 35)) <= 12) continue;
        min = Math.min(min, x); max = Math.max(max, x);
      }
      assert.ok(min >= 26 && max <= 90 && max >= min, `${language} ${count}: visible bounds ${min}..${max}`);
      bounds.push({ min, max });
    }
    for (let row = 0; row < 3; row++) {
      assert.ok(bounds[row * 2].max + 1 < bounds[row * 2 + 1].min,
        `${language} ${count}: label and count overlap in row ${row + 1}`);
    }
  }
});
