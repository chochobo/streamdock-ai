import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createSceneBridge } from '../src/scene-bridge.mjs';

test('four AgentDeck scenes render all 15 keys and three side panels without audio', { timeout: 30_000 }, async t => {
  const engine = createSceneBridge();
  t.after(() => engine.close());
  for (const mode of ['aquarium', 'fire', 'rain', 'beach']) {
    let frame = await engine.start(mode);
    assert.equal(frame.active, true); assert.equal(frame.mode, mode); assert.equal(frame.paused, false);
    assert.deepEqual(frame.tiles.map(t => t.index), Array.from({ length: 15 }, (_, i) => i));
    assert.deepEqual(frame.sideTiles.map(t => t.slot), [16, 17, 18]);
    for (const item of [frame.tiles[0], frame.tiles[14], frame.sideTiles[0]]) {
      const metadata = await sharp(item.png).metadata();
      assert.equal(metadata.width, 96); assert.equal(metadata.height, 96);
    }
    frame = await engine.press(14); assert.equal(frame.mode, mode);
    frame = await engine.tick(); assert.equal(frame.mode, mode);
  }
  const stopped = await engine.stop(); assert.equal(stopped.active, false); assert.deepEqual(stopped.tiles, []);
});

test('pause freezes the scene and invalid operations never act', { timeout: 30_000 }, async t => {
  const engine = createSceneBridge(); t.after(() => engine.close());
  await assert.rejects(engine.start('invalid'));
  await assert.rejects(engine.press(15));
  await assert.rejects(engine.pause('yes'));
  await engine.start('aquarium');
  const paused = await engine.pause(true);
  await new Promise(resolve => setTimeout(resolve, 40));
  const next = await engine.tick();
  assert.equal(next.paused, true);
  assert.ok(paused.tiles.every((tile, i) => tile.png.equals(next.tiles[i].png)));
  assert.equal((await engine.pause(false)).paused, false);
  await engine.close();
  await assert.rejects(engine.render());
});
