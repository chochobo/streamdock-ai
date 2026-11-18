#!/usr/bin/env python3
"""AgentDeck scene adapter for the 15-key 293S.

The vendored aquarium/fireplace/rain/beach code is MIT licensed; see
vendor/agentdeck/LICENSE. This process never opens a device or plays audio.
"""
import base64
import io
import json
import sys
import time
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / 'vendor' / 'agentdeck'))
# AgentDeck's scene feed hooks optionally call sfx.play. Suppress all audio.
sfx = types.ModuleType('sfx')
sfx.play = lambda *args, **kwargs: None
sys.modules['sfx'] = sfx

from PIL import Image, ImageOps
from aquarium import Aquarium
from fireplace import Fireplace
from scenes import Rain, Beach

KINDS = {'aquarium': Aquarium, 'fire': Fireplace, 'rain': Rain, 'beach': Beach}
scene = None
mode = ''
paused = False
last = time.monotonic()
frame_id = 0


def png(image):
    buffer = io.BytesIO()
    image.save(buffer, 'PNG', optimize=False, compress_level=3)
    raw = buffer.getvalue()
    if len(raw) > 262144:
        raise ValueError('image too large')
    return base64.b64encode(raw).decode('ascii')


def render():
    global frame_id
    if scene is None:
        return {'mode': '', 'active': False, 'paused': False, 'frame': frame_id, 'tiles': [], 'sideTiles': []}
    canvas = scene.canvas().convert('RGB')
    if canvas.size != (140, 84):
        raise ValueError('unexpected canvas size')
    cells = []
    for index in range(15):
        col, row = index % 5, index // 5
        image = canvas.crop((col * 28, row * 28, (col + 1) * 28, (row + 1) * 28)).resize((96, 96), Image.Resampling.NEAREST)
        cells.append({'index': index, 'png': png(image)})
    # Reflect the rightmost source strip so the display-only three panels
    # extend the 5x3 scene without losing any of the 15 physical keys.
    side = []
    for row in range(3):
        image = canvas.crop((112, row * 28, 140, (row + 1) * 28))
        image = ImageOps.mirror(image).resize((96, 96), Image.Resampling.NEAREST)
        side.append({'slot': 16 + row, 'png': png(image)})
    frame_id += 1
    return {'mode': mode, 'active': True, 'paused': paused, 'frame': frame_id, 'tiles': cells, 'sideTiles': side}


def handle(req):
    global scene, mode, paused, last
    op = req.get('op')
    if op == 'start':
        value = req.get('mode')
        if value not in KINDS:
            raise ValueError('unknown scene')
        scene = KINDS[value]()
        mode, paused, last = value, False, time.monotonic()
        return render()
    if op == 'stop':
        scene, mode, paused = None, '', False
        return render()
    if op == 'render':
        return render()
    if scene is None:
        raise ValueError('no scene')
    if op == 'tick':
        current = time.monotonic()
        delta = max(0.0, min(0.5, current - last))
        last = current
        if not paused:
            scene.step(delta)
        return render()
    if op == 'pause':
        value = req.get('paused')
        if not isinstance(value, bool):
            raise ValueError('invalid pause')
        paused, last = value, time.monotonic()
        return render()
    if op == 'press':
        index = req.get('index')
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < 15:
            raise ValueError('invalid key')
        if not paused:
            scene.feed(index)
        return render()
    raise ValueError('unknown operation')


for line in sys.stdin:
    request = None
    try:
        if len(line) > 4096:
            raise ValueError('request too large')
        request = json.loads(line)
        if not isinstance(request, dict) or not isinstance(request.get('id'), int):
            raise ValueError('invalid request')
        result = {'id': request['id'], 'ok': True, 'state': handle(request)}
    except Exception:
        result = {'id': request.get('id') if isinstance(locals().get('request'), dict) else None, 'ok': False}
    print(json.dumps(result, separators=(',', ':')), flush=True)
