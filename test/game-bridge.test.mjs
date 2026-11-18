import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGameBridge } from '../src/game-bridge.mjs';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('all seven upstream games render and accept their physical board inputs', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'streamdock-game-test-'));
  const bridge = createGameBridge({ stateDir });
  t.after(async () => { await bridge.close(); await rm(stateDir, { recursive: true, force: true }); });
  const menu = await bridge.render();
  assert.equal(menu.mode, 'menu');
  assert.equal(menu.tiles.length, 10);
  for (const [index, mode] of ['mole', 'simon', 'pairs', 'slot', 'bj', 'poker', 'race'].entries()) {
    await bridge.menu();
    const selected = await bridge.press(index);
    assert.equal(selected.mode, mode, `menu selection ${index} starts ${mode}`);
    assert.ok(selected.hud?.title, 'each game has a readable HUD title');
    if (mode === 'mole') assert.ok(selected.hud.remainingSeconds >= 0 && selected.hud.remainingSeconds <= 30);
    if (mode === 'pairs') assert.equal(selected.hud.matchedPairs, 0);
    if (mode === 'bj') assert.equal(selected.hud.phaseLabel, '베팅');
    assert.ok(selected.tiles.length >= 10);
    assert.ok(selected.tiles.every(tile => tile.png.subarray(0, 8).equals(png)));
    assert.ok(selected.wide.subarray(0, 8).equals(png));
    const pressed = await bridge.press(mode === 'poker' ? 9 : 0);
    assert.equal(pressed.mode, mode);
    if (mode === 'bj') {
      const hand = await bridge.press(4);
      if (hand.phase === 'play') {
        assert.equal(hand.hud.dealerHidden, true);
        assert.ok(hand.hud.dealerVisibleTotal >= 2 && hand.hud.dealerVisibleTotal <= 11);
        assert.equal(hand.hud.outcome, null);
      } else {
        assert.equal(hand.phase, 'done');
        assert.ok(['bj', 'win', 'lose', 'push'].includes(hand.hud.outcome));
      }
      assert.equal('dealerCards' in hand.hud, false);
    }
    const ticked = await bridge.tick();
    assert.equal(ticked.mode, mode);
    assert.equal(typeof ticked.active, 'boolean');
  }
  await assert.rejects(bridge.press(12), /Invalid game key/);
  await assert.rejects(bridge.start('not-a-game'), /Invalid game mode/);
});

test('virtual wide control maps to original poker deal and preserves user cache isolation', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'streamdock-game-test-'));
  const bridge = createGameBridge({ stateDir });
  t.after(async () => { await bridge.close(); await rm(stateDir, { recursive: true, force: true }); });
  const started = await bridge.start('poker');
  assert.equal(started.phase, 'bet');
  const dealt = await bridge.press(13);
  assert.equal(dealt.phase, 'play');
  assert.ok(dealt.hud.ownRank, 'player hand rank appears in HUD');
  assert.equal(dealt.hud.action, '교체');
  assert.equal('opponentRank' in dealt.hud, false, 'hidden opponent cards are not exposed');
  const record = JSON.parse(await readFile(path.join(stateDir, 'games.json'), 'utf8'));
  assert.ok(Number.isFinite(record.slot_coins));
  const racing = await bridge.start('race');
  assert.equal(racing.phase, 'bet');
  const picked = await bridge.press(5);
  assert.deepEqual(picked.hud.selected, [1]);
  assert.equal(picked.hud.action, '출발');
  assert.equal('winner' in picked.hud, false, 'future race outcome remains hidden');
  const gate = await bridge.press(13);
  assert.equal(gate.mode, 'race');
  assert.equal(gate.phase, 'gate', 'virtual wide action starts the selected race');
});
