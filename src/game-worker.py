#!/usr/bin/env python3
"""Local JSON-lines adapter for AgentDeck's MIT-licensed game engine.

Game images are generated in memory. The worker never opens a HID device,
performs network requests or touches the upstream ~/.cache/d200 state.
"""
import base64
import json
import math
import os
import time
from pathlib import Path
import sys
import types

VENDOR = Path(__file__).resolve().parent / 'vendor' / 'agentdeck'
sys.path.insert(0, str(VENDOR))

# Only public game sound cues cross the adapter; audio is optional for caller.
sounds = []
def play(name, *_args, **_kwargs):
    if isinstance(name, str) and len(sounds) < 64:
        sounds.append(name[:40])
sfx = types.ModuleType('sfx')
sfx.play = play
sys.modules['sfx'] = sfx
config = types.ModuleType('config')
config.CFG = {'ui_lang': 'ko'}
sys.modules['config'] = config

try:
    import games
except Exception:
    print(json.dumps({'error': 'game_engine_unavailable'}), flush=True)
    raise SystemExit(1)

games.SAVE = Path(os.environ.get('STREAMDOCK_GAME_STATE_DIR') or (Path.home() / '.cache' / 'streamdock-ai')) / 'games.json'
game = games.Games()

def encode(data):
    return base64.b64encode(data).decode('ascii')

def hud(now=None):
    """Summarize only game information already visible to the player."""
    now = time.time() if now is None else now
    labels = {'menu': '게임', 'mole': '두더지', 'simon': '순서 기억', 'pairs': '짝 맞추기',
              'slot': '슬롯', 'bj': '블랙잭', 'poker': '포커', 'race': '경마'}
    result = {'title': labels.get(game.mode, '게임'), 'phase': game.phase,
              'phaseLabel': '', 'primary': '', 'secondary': '', 'action': None}
    if game.mode == 'menu':
        result.update(phaseLabel='게임 선택', primary='게임을 고르세요')
    elif game.mode == 'mole':
        remaining = max(0, math.ceil(game.end_at - now)) if game.phase == 'play' else 0
        result.update(phaseLabel='진행 중' if game.phase == 'play' else '종료',
                      primary=f'{remaining}초', secondary=f'점수 {game.score}',
                      remainingSeconds=remaining, best=game.best.get('mole', 0))
    elif game.mode == 'simon':
        result.update(phaseLabel={'show':'잘 보세요', 'input':'따라 누르기', 'over':'종료'}.get(game.phase, '대기'),
                      primary=f'{len(game.seq)}단계', secondary=f'{game.pos}/{len(game.seq)}',
                      round=len(game.seq), position=game.pos, best=game.best.get('simon', 0))
    elif game.mode == 'pairs':
        matched = len(game.matched) // 2
        elapsed = max(0, int(now - game.started)) if game.started else 0
        result.update(phaseLabel='종료' if game.phase == 'over' else '맞추기',
                      primary=f'{matched}/5쌍', secondary=f'시도 {game.score}',
                      matchedPairs=matched, attempts=game.score, elapsedSeconds=elapsed)
    elif game.mode == 'slot':
        spinning = any(game.spinning)
        result.update(phaseLabel='회전 중' if spinning else ('종료' if game.phase == 'over' else '대기'),
                      primary=f'{game.coins}코인', secondary=f'당첨 {game.win}' if game.win and not spinning else '',
                      spinning=spinning, payout=game.win if not spinning else None)
    elif game.mode == 'bj':
        outcome = {'win':'승리', 'lose':'패배', 'push':'무승부', 'bj':'블랙잭'}.get(game.result)
        phases = {'bet':'베팅', 'play':'선택', 'dealer':'딜러 차례', 'done':outcome or '종료'}
        player = games.hand_value(game.player)[0] if game.player else None
        dealer = games.hand_value(game.dealer[:1] if game.hole else game.dealer)[0] if game.dealer else None
        action = '더블' if game.phase == 'play' and len(game.player) == 2 and game.coins >= game.bet else None
        result.update(phaseLabel=phases.get(game.phase, '대기'),
                      primary=f'내 점수 {player}' if player is not None else f'{game.coins}코인',
                      secondary=(f'딜러 {dealer}{" +?" if game.hole else ""}' if dealer is not None else f'베팅 {game.bet}'),
                      playerTotal=player, dealerVisibleTotal=dealer, dealerHidden=bool(game.hole and game.dealer),
                      bet=game.bet_now if game.phase != 'bet' else game.bet,
                      outcome=game.result if game.phase == 'done' else None,
                      payoutDelta=game.win if game.phase == 'done' else None, action=action)
    elif game.mode == 'poker':
        outcome = ({1:'승리', 0:'무승부', -1:'패배'}.get(game.poker_cmp) if game.phase == 'done' else None)
        phases = {'bet':'베팅', 'play':'카드 선택', 'opp':'상대 차례', 'done':outcome or '종료'}
        own_rank = games.POKER_NAMES[games.poker_rank(game.hand)[0]] if len(game.hand) == 5 else None
        action = {'bet':'딜', 'play':'교체', 'done':'베팅 변경'}.get(game.phase)
        result.update(phaseLabel=phases.get(game.phase, '대기'), primary=own_rank or f'{game.coins}코인',
                      secondary=f'베팅 {game.bet_now if game.phase != "bet" else game.bet}',
                      ownRank=own_rank, outcome=outcome, bet=game.bet_now if game.phase != 'bet' else game.bet,
                      payoutDelta=game.win if game.phase == 'done' else None, action=action)
    elif game.mode == 'race':
        phases = {'bet':'말 선택', 'gate':'출발 준비', 'run':'경주 중', 'done':'종료'}
        selected = [int(value) + 1 for value in game.race_pick]
        outcome = ('적중' if game.race_hit() else '실패') if game.phase == 'done' else None
        result.update(phaseLabel=outcome or phases.get(game.phase, '대기'),
                      primary=('·'.join(map(str, selected)) + '번') if selected else '말을 고르세요',
                      secondary=f'베팅 {game.bet_now if game.phase != "bet" else game.bet}',
                      selected=selected, bet=game.bet_now if game.phase != 'bet' else game.bet,
                      outcome=outcome, payoutDelta=game.win if game.phase == 'done' else None,
                      action='출발' if game.phase == 'bet' and selected else None)
    return result


def state():
    items = game.tiles()
    if not isinstance(items, dict) or len(items) > 15:
        raise ValueError('invalid game frame')
    tiles = []
    for index, image in sorted(items.items()):
        if not isinstance(index, int) or index < 0 or index > 14 or not isinstance(image, bytes) or len(image) > 500_000:
            raise ValueError('invalid game tile')
        tiles.append({'index': index, 'png': encode(image)})
    wide = game.wide()
    if not isinstance(wide, bytes) or len(wide) > 500_000:
        raise ValueError('invalid game panel')
    cues = sounds[:]
    sounds.clear()
    return {'mode': game.mode, 'phase': game.phase, 'active': game.active,
            'fullscreen': game.fullscreen, 'score': game.score, 'coins': game.coins,
            'hud': hud(), 'tiles': tiles, 'wide': encode(wide), 'sounds': cues}

def dispatch(request):
    if not isinstance(request, dict) or not isinstance(request.get('id'), int) or isinstance(request.get('id'), bool):
        raise ValueError('invalid request')
    op = request.get('op')
    if op == 'press':
        index = request.get('index')
        if not isinstance(index, int) or isinstance(index, bool) or (index not in range(10) and index != 13):
            raise ValueError('invalid game key')
        game.press(index)
    elif op == 'tick':
        game.tick()
    elif op == 'menu':
        game.menu()
    elif op == 'start':
        mode = request.get('mode')
        if mode not in games.GAMES:
            raise ValueError('invalid game mode')
        game.start(mode)
    elif op != 'render':
        raise ValueError('invalid operation')
    return {'id': request['id'], 'ok': True, 'state': state()}

while True:
    line = sys.stdin.buffer.readline(1_000_001)
    if not line:
        break
    if len(line) > 1_000_000 or not line.endswith(b'\n'):
        # Do not attempt to interpret a partial or oversized JSON command.
        print(json.dumps({'ok': False, 'error': 'invalid_request'}), flush=True)
        break
    request = None
    try:
        request = json.loads(line)
        response = dispatch(request)
    except Exception:
        request_id = request.get('id') if isinstance(request, dict) else None
        response = {'id': request_id, 'ok': False, 'error': 'invalid_or_unavailable'}
    print(json.dumps(response, ensure_ascii=False, separators=(',', ':')), flush=True)
