import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildGallery } from '../scripts/tile-gallery.mjs';
import { galleryFixtures, TILE_SIZE, SCALED_SIZE } from '../scripts/tile-gallery-fixtures.mjs';

test('모든 갤러리 예시가 오류 없이 그려지고 PNG 크기가 맞다', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'tile-gallery-'));
  try {
    const { results, indexPath } = await buildGallery({ outDir });
    assert.equal(results.length, galleryFixtures().length);
    assert.ok(results.length > 100);
    for (const r of results) {
      const a = await sharp(r.png96).metadata();
      const b = await sharp(r.png80).metadata();
      assert.deepEqual([a.format, a.width, a.height], ['png', TILE_SIZE, TILE_SIZE], r.name);
      assert.deepEqual([b.format, b.width, b.height], ['png', SCALED_SIZE, SCALED_SIZE], r.name);
    }
    assert.equal((await readdir(join(outDir, 'svg'))).length, results.length);
    const html = await readFile(indexPath, 'utf8');
    assert.equal(html.match(/<img /g).length, results.length * 2);
    assert.doesNotMatch(html, /https?:\/\//);
  } finally { await rm(outDir, { recursive: true, force: true }); }
});
