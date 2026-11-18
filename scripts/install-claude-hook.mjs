#!/usr/bin/env node
/** Opt-in, reversible Claude Code hook integration. Never replace existing hooks. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/install-claude-hook.mjs [--remove]\nBacks up and merges only StreamDock AI hook entries into ~/.claude/settings.json.');
  process.exit(0);
}
if (args.length > 1 || (args.length === 1 && args[0] !== '--remove')) {
  console.error('Unknown option. Use --help.');
  process.exit(2);
}
const removing = args[0] === '--remove';
const settingsDir = path.join(os.homedir(), '.claude');
const settingsPath = path.join(settingsDir, 'settings.json');
const hookPath = fileURLToPath(new URL('./agent-hook.py', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const command = `python3 ${quote(hookPath)} claude`;
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function load() {
  try {
    const stat = await fs.lstat(settingsPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('settings.json must be a regular file, not a symlink.');
    const bytes = await fs.readFile(settingsPath);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('settings.json is not valid JSON; it was not changed.'); }
    if (!isRecord(value)) throw new Error('settings.json must contain a JSON object.');
    return { value, bytes };
  } catch (error) {
    if (error.code === 'ENOENT') return { value: {}, bytes: null };
    throw error;
  }
}

function update(settings) {
  if (settings.hooks !== undefined && !isRecord(settings.hooks)) throw new Error('Existing hooks must be a JSON object.');
  if (removing && !settings.hooks) return false;
  const hooks = settings.hooks || {};
  let changed = false;
  for (const event of events) {
    const groups = hooks[event];
    if (groups !== undefined && !Array.isArray(groups)) throw new Error(`Existing ${event} hooks must be an array.`);
    if (groups && groups.some(group => !isRecord(group) || !Array.isArray(group.hooks) || group.hooks.some(hook => !isRecord(hook)))) {
      throw new Error(`Existing ${event} hook format is invalid.`);
    }
    if (removing) {
      if (!groups) continue;
      const filteredGroups = [];
      for (const group of groups) {
        const remaining = group.hooks.filter(hook => !(hook.type === 'command' && hook.command === command));
        if (remaining.length !== group.hooks.length) changed = true;
        if (remaining.length) filteredGroups.push(remaining.length === group.hooks.length ? group : { ...group, hooks: remaining });
        else if (remaining.length === group.hooks.length) filteredGroups.push(group);
      }
      if (filteredGroups.length) hooks[event] = filteredGroups;
      else if (filteredGroups.length !== groups.length) delete hooks[event];
    } else {
      // An existing exact command for this event is left untouched.
      if (groups?.some(group => group.hooks.some(hook => hook.type === 'command' && hook.command === command))) continue;
      const group = { ...(event === 'Notification' ? { matcher: 'permission_prompt' } : {}), hooks: [{ type: 'command', command }] };
      hooks[event] = [...(groups || []), group];
      changed = true;
    }
  }
  if (changed) {
    if (Object.keys(hooks).length) settings.hooks = hooks;
    else delete settings.hooks;
  }
  return changed;
}

async function main() {
  const { value, bytes } = await load();
  if (!update(value)) {
    console.log(removing ? 'No matching StreamDock AI hooks were found.' : 'StreamDock AI hooks are already installed.');
    return;
  }
  if (!removing) {
    try { await fs.access(hookPath); } catch { throw new Error('StreamDock AI hook script was not found.'); }
  }
  await fs.mkdir(settingsDir, { recursive: true, mode: 0o700 });
  const suffix = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  let backup;
  if (bytes !== null) {
    backup = path.join(settingsDir, `settings.json.streamdock-backup-${suffix}`);
    await fs.writeFile(backup, bytes, { flag: 'wx', mode: 0o600 });
  }
  const temp = path.join(settingsDir, `.settings.streamdock-${suffix}.tmp`);
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // Detect changes made during this operation and leave their file intact.
    const current = await load();
    if ((bytes === null && current.bytes !== null) || (bytes !== null && (current.bytes === null || !bytes.equals(current.bytes)))) {
      throw new Error('settings.json changed during installation; retry after reviewing it.');
    }
    await fs.rename(temp, settingsPath);
  } finally {
    await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  console.log(removing ? 'Removed StreamDock AI hook entries.' : 'Installed StreamDock AI hook entries.');
  if (backup) console.log(`Backup: ${backup}`);
  console.log(`Settings: ${settingsPath}`);
}

main().catch(error => { console.error(`Claude hook setup failed: ${error.message}`); process.exitCode = 1; });
