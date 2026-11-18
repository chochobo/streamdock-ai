#!/usr/bin/env python3
"""Observe Codex lifecycle events without returning policy decisions or storing content."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time

EVENTS = {'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
          'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd'}
TOOL_EVENTS = {'PreToolUse', 'PostToolUse', 'PermissionRequest'}


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:24]


def main():
    observed = time.time_ns()
    data = json.load(sys.stdin)
    if not isinstance(data, dict):
        return
    event = data.get('hook_event_name')
    session = data.get('session_id')
    if event not in EVENTS or not isinstance(session, str) or not (0 < len(session) <= 256):
        return
    # These fields identify subagent events. Their session_id may refer to the parent.
    if data.get('agent_id') or data.get('agent_type') or data.get('agent_transcript_path'):
        return
    directory = Path.home() / '.cache' / 'streamdock-ai' / 'agents'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    record_id = 'codex-' + digest(session)
    target = directory / ('codex-lifecycle-' + digest(session) + '.json')
    lock_path = directory / ('.' + record_id + '.lock')
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        # Never block the user's agent behind another process or a stuck filesystem.
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            previous = json.loads(target.read_text(encoding='utf-8'))
            if not isinstance(previous, dict): previous = {}
        except (OSError, ValueError, TypeError):
            previous = {}
        if isinstance(previous.get('observedNs'), int) and previous['observedNs'] > observed:
            return
        raw_turn = data.get('turn_id')
        turn = digest(raw_turn) if isinstance(raw_turn, str) and 0 < len(raw_turn) <= 256 else None
        previous_turn = previous.get('turn')
        # Tool hooks may come from subagents while their session_id is the parent's.
        # Only accept events that can be tied to the main user-submitted turn.
        if event in TOOL_EVENTS and (not turn or not previous_turn or turn != previous_turn):
            return
        if event == 'SessionStart' and data.get('source') == 'compact' and previous.get('presence') == 'live':
            status = previous.get('status', 'unknown')
        elif event == 'UserPromptSubmit': status = 'working'
        elif event in ('PreToolUse', 'PostToolUse'): status = 'working'
        elif event == 'PermissionRequest': status = 'blocked'
        else: status = 'unknown'
        # A stop/interrupt can race another turn; ignore mismatched turn observations.
        if event in ('Stop', 'Interrupt') and previous_turn and turn and turn != previous_turn:
            return
        cwd = data.get('cwd') if isinstance(data.get('cwd'), str) else ''
        record = {'id': record_id, 'agent': 'codex', 'session': session,
                  'cwd': cwd, 'project': os.path.basename(cwd.rstrip('/')) or 'unknown',
                  'updated': observed / 1_000_000_000, 'observedNs': observed,
                  'event': event, 'status': status, 'confidence': 'inferred',
                  'presence': 'ended' if event == 'SessionEnd' else 'live'}
        if event == 'UserPromptSubmit' and turn:
            record['turn'] = turn
        elif previous_turn and event != 'SessionEnd':
            record['turn'] = previous_turn
        name = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=directory,
                                             prefix='.codex-status-', delete=False) as output:
                name = output.name
                os.fchmod(output.fileno(), 0o600)
                json.dump(record, output, ensure_ascii=False, separators=(',', ':'))
            os.replace(name, target)
        finally:
            if name:
                try: os.unlink(name)
                except FileNotFoundError: pass
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
