#!/usr/bin/env python3
"""Write a minimal local agent status record. Never store prompt or response text."""
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import time

EVENTS = {
    "SessionStart": "idle",
    "UserPromptSubmit": "working",
    "PreToolUse": "working",
    "PostToolUse": "working",
    "PostToolUseFailure": "working",
    "PermissionRequest": "blocked",
    "Stop": "done",
    "StopFailure": "error",
}


def claude_terminal_target():
    """Find the actual Claude ancestor, never the transient hook shell itself."""
    try:
        output = subprocess.check_output(
            ["/bin/ps", "-axo", "pid=,ppid=,tty=,lstart=,comm="],
            text=True, stderr=subprocess.DEVNULL, timeout=1.0)
        pattern = re.compile(r"^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+?)\s*$")
        processes = {}
        for line in output.splitlines():
            match = pattern.match(line)
            if match:
                pid, parent, tty, start, command = match.groups()
                processes[int(pid)] = (int(parent), tty, start, command)
        current = os.getppid()
        for _ in range(12):
            entry = processes.get(current)
            if not entry:
                break
            parent, tty, _start, command = entry
            if os.path.basename(command).lower() in ("claude", "claude-code"):
                if not re.fullmatch(r"ttys\d+", tty):
                    return {}
                bundle = os.environ.get("__CFBundleIdentifier", "")
                if bundle not in ("com.apple.Terminal", "com.googlecode.iterm2"):
                    term = os.environ.get("TERM_PROGRAM", "")
                    bundle = {"Apple_Terminal": "com.apple.Terminal", "iTerm.app": "com.googlecode.iterm2"}.get(term, "")
                if not bundle:
                    return {}
                process_start = subprocess.check_output(
                    ["/bin/ps", "-p", str(current), "-o", "lstart="],
                    text=True, stderr=subprocess.DEVNULL, timeout=1.0).strip()
                return {"pid": current, "tty": "/dev/" + tty,
                        "bundle": bundle, "processStart": process_start}
            current = parent
    except (OSError, subprocess.SubprocessError):
        pass
    return {}


def record(provider, data, status):
    session = data.get("session_id") if provider == "claude-code" else data.get("thread-id")
    if not isinstance(session, str) or not session:
        return
    digest = hashlib.sha256(session.encode("utf-8")).hexdigest()[:24]
    record_id = provider + "-" + digest
    directory = Path.home() / ".cache" / "streamdock-ai" / "agents"
    path = directory / (record_id + ".json")
    if status is None:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        return
    cwd = data.get("cwd")
    project = os.path.basename(cwd.rstrip("/")) if isinstance(cwd, str) else ""
    entry = {"id": record_id, "agent": provider, "status": status,
             "project": project or "unknown", "updated": time.time()}
    event = data.get("hook_event_name")
    if provider == "claude-code" and event in (*EVENTS, "Notification"):
        entry["event"] = event
        if status == "blocked":
            # PermissionRequest can also fire for noninteractive auto-denials.
            # Notification delivery can lag the prompt. Neither guarantees
            # that a user-facing prompt is still waiting at display time.
            entry["confidence"] = "inferred"
        elif event == "Stop" and status == "working":
            # The main response has ended, but reported background work is
            # still in flight. Its later completion may not emit another hook.
            entry["confidence"] = "inferred"
    # These fields stay in a private local file and are never returned in the
    # dashboard API. A verified process association is optional.
    entry["session"] = session
    if isinstance(cwd, str) and os.path.isabs(cwd):
        entry["cwd"] = cwd
    if provider == "claude-code":
        entry.update(claude_terminal_target())
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory,
                                         prefix=".status-", delete=False) as f:
            tmp = f.name
            json.dump(entry, f, ensure_ascii=False)
        os.replace(tmp, path)
    finally:
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)


def run_claude():
    data = json.load(sys.stdin)
    if not isinstance(data, dict):
        return
    # Tool events in subagents can share the parent session_id. They are not
    # evidence that the parent stopped waiting, failed, or ended its session.
    # Until child events are aggregated separately, do not overwrite the parent.
    if isinstance(data.get("agent_id"), str) and data["agent_id"]:
        return
    event = data.get("hook_event_name")
    if event == "SessionEnd":
        record("claude-code", data, None)
    elif event == "Notification" and data.get("notification_type") == "permission_prompt":
        record("claude-code", data, "blocked")
    elif event == "Stop":
        tasks = data.get("background_tasks")
        in_flight = (isinstance(tasks, list) and any(
            isinstance(task, dict) and task.get("status") in ("running", "pending", "queued", "in_progress")
            for task in tasks
        ))
        record("claude-code", data, "working" if in_flight else "done")
    elif event in EVENTS:
        record("claude-code", data, EVENTS[event])


def run_codex(args):
    # Codex appends its JSON argument after all configured arguments. Optional
    # -- lets an existing notify command receive that same JSON unchanged.
    if not args:
        return
    payload = args[-1]
    try:
        data = json.loads(payload)
        if isinstance(data, dict) and data.get("type") == "agent-turn-complete":
            record("codex", data, "done")
    except (OSError, ValueError, TypeError):
        pass
    if len(args) > 2 and args[0] == "--":
        try:
            subprocess.Popen(args[1:], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
        except OSError:
            pass


if __name__ == "__main__":
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "claude":
            run_claude()
        elif len(sys.argv) > 1 and sys.argv[1] == "codex":
            run_codex(sys.argv[2:])
    except Exception:
        # A monitoring failure must never block the agent.
        pass
