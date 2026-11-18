#!/usr/bin/env node
// 키 타일·요약 화면을 한 HTML 페이지로 뽑는 개발용 스크립트. 하드웨어·네트워크 불필요.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { galleryFixtures, TILE_SIZE, SCALED_SIZE } from './tile-gallery-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const slug = name => name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase();
const escapeHtml = text => String(text).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

export async function renderPng(svg, size) {
  return sharp(Buffer.from(svg), { density: 72 * size / TILE_SIZE }).resize(size, size).png().toBuffer();
}

/** outDir에 index.html과 svg/ 폴더를 쓴다. 각 예시의 PNG 크기도 돌려준다. */
export async function buildGallery({ outDir = join(root, 'build', 'tile-gallery') } = {}) {
  await mkdir(join(outDir, 'svg'), { recursive: true });
  const groups = new Map();
  const results = [];
  const used = new Set();
  for (const fixture of galleryFixtures()) {
    const svg = fixture.render();
    const png96 = await renderPng(svg, TILE_SIZE);
    const png80 = await renderPng(svg, SCALED_SIZE);
    let file = slug(fixture.name);
    while (used.has(file)) file += '-x';
    used.add(file);
    await writeFile(join(outDir, 'svg', `${file}.svg`), svg);
    const uri = png => `data:image/png;base64,${png.toString('base64')}`;
    const cell = `<figure><div class="pair"><img width="${TILE_SIZE}" height="${TILE_SIZE}" src="${uri(png96)}" alt="${escapeHtml(fixture.name)} 96px"><img width="${SCALED_SIZE}" height="${SCALED_SIZE}" src="${uri(png80)}" alt="${escapeHtml(fixture.name)} 80px"></div><figcaption>${escapeHtml(fixture.name)}</figcaption></figure>`;
    if (!groups.has(fixture.group)) groups.set(fixture.group, []);
    groups.get(fixture.group).push(cell);
    results.push({ name: fixture.name, group: fixture.group, file: `svg/${file}.svg`, png96, png80 });
  }
  const sections = [...groups].map(([group, cells]) => `<section><h2>${escapeHtml(group)} (${cells.length})</h2><div class="grid">${cells.join('')}</div></section>`).join('\n');
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>키 타일 갤러리</title>
<style>body{background:#2a2f36;color:#dfe6ee;font:13px sans-serif;margin:16px}h2{margin:24px 0 8px}.grid{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;width:200px}.pair{display:flex;gap:8px;align-items:flex-start}img{image-rendering:pixelated;outline:1px solid #556}figcaption{margin-top:4px;word-break:break-all;color:#9fb0c3}</style></head>
<body><h1>키 타일 갤러리</h1><p>왼쪽 ${TILE_SIZE}px(293S), 오른쪽 ${SCALED_SIZE}px(XL). 예시 ${results.length}개.</p>
${sections}
</body></html>
`;
  await writeFile(join(outDir, 'index.html'), html);
  return { outDir, indexPath: join(outDir, 'index.html'), results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.env.TILE_GALLERY_OUT || undefined;
  const { indexPath, results } = await buildGallery({ outDir });
  console.log(`${results.length}개 예시, 이미지 ${results.length * 2}장\n${indexPath}`);
}
