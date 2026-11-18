#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.some(value => value !== '--remove') || args.filter(value => value === '--remove').length > 1) {
  console.error('Usage: node scripts/install-codex-hook.mjs [--remove]');
  process.exit(2);
}
const removing = args.includes('--remove');
const home = os.homedir();
const dir = path.join(home, '.codex');
const target = path.join(dir, 'hooks.json');
const script = fileURLToPath(new URL('./codex-hook.py', import.meta.url));
const quote = text => "'" + text.replace(/'/g, "'\\''") + "'";
const command = `${quote('/usr/bin/python3')} ${quote(script)}`;
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd'];
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function load() {
  let bytes;
  try { bytes = await fs.readFile(target); }
  catch (error) { if (error.code === 'ENOENT') return { data: {}, bytes: null }; throw error; }
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Existing Codex hooks.json is not valid JSON; it was not modified.'); }
  if (!obj(data) || (data.hooks !== undefined && !obj(data.hooks))) throw new Error('Existing Codex hooks must be a JSON object; not modified.');
  return { data, bytes };
}

function update(data) {
  if (removing && !data.hooks) return false;
  const hooks = data.hooks || {};
  let changed = false;
  for (const event of events) {
    const groups = hooks[event];
    if (groups !== undefined && !Array.isArray(groups)) throw new Error(`Existing ${event} hooks must be an array; not modified.`);
    if (groups && groups.some(group => !obj(group) || !Array.isArray(group.hooks) || group.hooks.some(hook => !obj(hook)))) {
      throw new Error(`Existing ${event} hooks format is invalid; not modified.`);
    }
    if (removing) {
      if (!groups) continue;
      const filtered = [];
      for (const group of groups) {
        const remaining = group.hooks.filter(hook => !(hook.type === 'command' && hook.command === command));
        if (remaining.length !== group.hooks.length) changed = true;
        if (remaining.length) filtered.push(remaining.length === group.hooks.length ? group : { ...group, hooks: remaining });
        else if (remaining.length === group.hooks.length) filtered.push(group);
      }
      if (filtered.length) hooks[event] = filtered;
      else if (filtered.length !== groups.length) delete hooks[event];
    } else {
      if (groups?.some(group => group.hooks.some(hook => hook.type === 'command' && hook.command === command))) continue;
      hooks[event] = [...(groups || []), { hooks: [{ type: 'command', command, timeout: 2 }] }];
      changed = true;
    }
  }
  if (changed) {
    if (Object.keys(hooks).length) data.hooks = hooks;
    else delete data.hooks;
  }
  return changed;
}

async function main() {
  const { data, bytes } = await load();
  if (!update(data)) {
    console.log(removing ? 'No matching StreamDock Codex hooks found.' : 'StreamDock Codex hooks are already installed.');
    return;
  }
  if (!removing) await fs.access(script);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const suffix = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  let backup;
  if (bytes !== null) {
    backup = path.join(dir, `hooks.json.streamdock-backup-${suffix}`);
    await fs.writeFile(backup, bytes, { flag: 'wx', mode: 0o600 });
  }
  const temp = path.join(dir, `.hooks.streamdock-${suffix}.tmp`);
  try {
    await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const current = await load();
    if ((bytes === null && current.bytes !== null) || (bytes !== null && (current.bytes === null || !bytes.equals(current.bytes)))) {
      throw new Error('Codex hooks.json changed during installation; not modified.');
    }
    await fs.rename(temp, target);
  } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  console.log(removing ? 'Removed StreamDock Codex hook entries.' : 'Installed StreamDock Codex hook entries. Review and trust them in Codex /hooks before use.');
  if (backup) console.log(`Backup: ${backup}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
