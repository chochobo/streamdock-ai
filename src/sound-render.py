#!/usr/bin/env python3
"""Render one upstream MIT AgentDeck sound into StreamDock AI's local cache.

The upstream generators are reused lazily, so a short cue does not generate
all ambient tracks. This program never plays audio or accesses the network.
"""
import os
from pathlib import Path
import sys
import tempfile
import types

vendor = Path(__file__).resolve().parent / 'vendor' / 'agentdeck'
sys.path.insert(0, str(vendor))
config = types.ModuleType('config')
config.CFG = {'sound': {'enabled': False}}
sys.modules['config'] = config
import sfx


def sound(name):
    t, n, seq, mix, arp = sfx._tone, sfx._noise, sfx._seq, sfx._mix, sfx._arp
    recipes = {
        'tap': lambda: t(1400, .035, 'sine', vol=.4),
        'tick': lambda: t(2200, .015, 'square', vol=.15),
        'flip': lambda: n(.06, .35, .2),
        'hit': lambda: t(330, .09, 'square', sweep=-200, vol=.35),
        'coin': lambda: seq(t(988, .06, 'square', vol=.25), t(1319, .16, 'square', vol=.25)),
        'bad': lambda: t(110, .28, 'saw', vol=.35),
        'boom': lambda: mix(n(.45, .6, .85, release=.4), t(80, .4, 'sine', sweep=-40, vol=.5)),
        'win': lambda: arp([523, 659, 784, 1047], .09),
        'jackpot': lambda: seq(arp([523, 659, 784, 1047, 784, 1047, 1319, 1568], .08), t(2093, .4, 'square', vol=.25)),
        'lose': lambda: arp([392, 330, 262], .14, 'tri', .35),
        'card': lambda: n(.05, .3, .1),
        'bell': lambda: mix(t(880, .9, vol=.3, release=.35), t(1760, .6, vol=.12, release=.3), t(2640, .4, vol=.06, release=.3)),
        'gallop': lambda: seq(*[mix(n(.05, .6, .8, seed=k), t(90, .05, vol=.3)) for k in range(12)], gap=.09),
        'whoosh': lambda: mix(n(.7, .4, .3, swell=True), t(200, .7, 'sine', sweep=-120, vol=.15)),
        'cheer': lambda: n(1.8, .35, .55, swell=True, seed=7),
        'shutter': lambda: seq(t(3000, .012, 'square', vol=.3), n(.07, .4, .0)),
        'slash': lambda: n(.16, .45, .05, release=.3),
        'fire': lambda: mix(n(.45, .35, .5), t(150, .45, 'saw', sweep=250, vol=.15)),
        'roar': lambda: mix(n(1.3, .5, .92, release=.7, seed=3), t(70, 1.3, 'saw', sweep=-25, vol=.3)),
        'levelup': lambda: arp([523, 659, 784, 1047, 1319], .07),
        'heal': lambda: arp([784, 988, 1175], .08, 'sine', .3),
        'dead': lambda: arp([392, 370, 349, 330, 262], .16, 'tri', .35),
        'crackle': lambda: seq(*[n(.008, .5, .0, seed=k) + [0.0] * int(sfx.RATE * .03 * (k % 3 + 1)) for k in range(4)]),
        'intro': lambda: mix(seq(t(392, .12, 'tri', vol=.25), t(523, .12, 'tri', vol=.25), t(659, .12, 'tri', vol=.25), t(784, .7, 'tri', vol=.3, release=.5)), seq([0.0] * int(sfx.RATE * .36), t(1568, .6, 'sine', vol=.12, release=.4))),
        'amb_water': sfx._amb_water,
        'amb_fire': sfx._amb_fire,
        'amb_rain': sfx._amb_rain,
        'amb_waves': sfx._amb_waves,
        'thunder': lambda: sfx._loop(mix(n(2.6, .7, .97, release=.5, seed=4), n(.25, .4, .3, seed=6)), .01),
    }
    if name.startswith('note') and name[4:].isdigit() and 0 <= int(name[4:]) < len(sfx.SIMON):
        return t(sfx.SIMON[int(name[4:])], .28, 'tri', vol=.4, release=.5)
    if name not in recipes:
        raise ValueError('unknown sound')
    return recipes[name]()


def main():
    if len(sys.argv) != 2:
        raise ValueError('sound name required')
    name = sys.argv[1]
    if not name.isascii() or not name.replace('_', '').isalnum() or len(name) > 32:
        raise ValueError('invalid sound')
    directory = Path(os.environ.get('STREAMDOCK_SOUND_DIR') or (Path.home() / '.cache' / 'streamdock-ai' / 'sfx' / 'v6'))
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / (name + '.wav')
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(prefix='.sound-', suffix='.wav', dir=directory, delete=False) as handle:
            tmp = Path(handle.name)
        sfx._write(tmp, sound(name))
        os.chmod(tmp, 0o600)
        os.replace(tmp, target)
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit(1)
