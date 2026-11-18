#!/usr/bin/env python3
"""Capture only Claude Code's documented rate-limit fields, then pass stdin on."""
import datetime
import json
import math
import os
from pathlib import Path
import sys
import tempfile


def number(value, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) and minimum <= value <= maximum else None


def window(value):
    if not isinstance(value, dict):
        return None
    used = number(value.get('used_percentage'), 0, 100)
    if used is None:
        return None
    reset = number(value.get('resets_at'), 0, 253402300799)
    try:
        reset = datetime.datetime.fromtimestamp(reset, datetime.timezone.utc).isoformat().replace('+00:00', 'Z') if reset is not None else None
    except (OverflowError, OSError, ValueError):
        reset = None
    return {'usedPercentage': used, 'resetsAt': reset}


def capture(raw):
    try:
        data = json.loads(raw)
        rate = data.get('rate_limits') if isinstance(data, dict) else None
        if not isinstance(rate, dict):
            return
        five = window(rate.get('five_hour'))
        seven = window(rate.get('seven_day'))
        if five is None and seven is None:
            return
        record = {
            'provider': 'claude', 'source': 'claude-statusline', 'account': 'unknown',
            'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
            'fiveHour': five, 'sevenDay': seven,
        }
        directory = Path.home() / '.cache' / 'streamdock-ai' / 'usage'
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        name = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=directory, prefix='.claude-', delete=False) as output:
                name = output.name
                os.chmod(name, 0o600)
                json.dump(record, output, separators=(',', ':'))
            os.replace(name, directory / 'claude-statusline.json')
        finally:
            if name and os.path.exists(name):
                os.unlink(name)
    except (OSError, ValueError, TypeError, OverflowError):
        # Monitoring must never break the user's existing status line.
        return


if __name__ == '__main__':
    raw = sys.stdin.buffer.read()
    capture(raw)
    if '--tee' in sys.argv[1:]:
        try:
            sys.stdout.buffer.write(raw)
            sys.stdout.buffer.flush()
        except BrokenPipeError:
            # Avoid Python emitting a second flush error at shutdown when the
            # original command deliberately closes stdin before reading it.
            try:
                null = os.open(os.devnull, os.O_WRONLY)
                os.dup2(null, sys.stdout.fileno())
                os.close(null)
            except OSError:
                pass
