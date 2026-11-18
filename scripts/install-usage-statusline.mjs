#!/usr/bin/env node
// Wrap only the existing statusLine command. Never print it or its input.
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const remove = process.argv.slice(2).includes('--remove');
const unknownArgs = process.argv.slice(2).filter(a => a !== '--remove');
if (unknownArgs.length) { console.error('Unknown option.'); process.exit(2); }
const home = os.homedir();
const settingsDir = path.join(home, '.claude');
const settingsPath = path.join(settingsDir, 'settings.json');
const stateDir = path.join(home, '.cache', 'streamdock-ai');
const statePath = path.join(stateDir, 'usage-statusline-install.json');
const script = fileURLToPath(new URL('./usage-statusline.py', import.meta.url));
const quote = text => `'${text.replace(/'/g, `'\\''`)}'`;
const capture = `/usr/bin/python3 ${quote(script)}`;
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);

async function loadJson(file, optional = false) {
  try {
    const bytes = await fs.readFile(file);
    const value = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(value)) throw new Error('Expected a JSON object.');
    return { value, bytes };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return { value: null, bytes: null };
    throw error;
  }
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function main() {
  const { value: existing, bytes } = await loadJson(settingsPath, true);
  const config = existing || {};
  const { value: state } = await loadJson(statePath, true);
  let next;
  let saveState = false;
  if (remove) {
    if (!state) { console.log('No StreamDock AI status-line wrapper found.'); return; }
    if (state.version !== 1 || !same(config.statusLine, state.installed)) {
      throw new Error('The status line changed after installation; leaving the configuration untouched.');
    }
    next = { ...config };
    if (state.hadOriginal) next.statusLine = state.original;
    else delete next.statusLine;
  } else {
    await fs.access(script);
    if (state) {
      if (state.version === 1 && same(config.statusLine, state.installed)) {
        console.log('StreamDock AI status-line wrapper is already installed.');
        return;
      }
      throw new Error('Existing installation state conflicts with the current status line; leaving it untouched.');
    }
    const hadOriginal = Object.hasOwn(config, 'statusLine');
    const original = config.statusLine;
    if (hadOriginal && (!isRecord(original) || original.type !== 'command' || typeof original.command !== 'string' || !original.command.trim())) {
      throw new Error('Existing statusLine is not a supported command; leaving it untouched.');
    }
    // The original text runs in Claude's same shell, as the last pipeline command.
    // The newline makes an existing trailing shell comment safe.
    const command = hadOriginal ? `${capture} --tee | {\n${original.command}\n}` : `${capture} --capture`;
    const installed = hadOriginal ? { ...original, command } : { type: 'command', command };
    next = { ...config, statusLine: installed };
    saveState = { version: 1, hadOriginal, original: hadOriginal ? original : null, installed };
  }

  await fs.mkdir(settingsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const suffix = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  let backup = null;
  if (bytes !== null) {
    backup = path.join(settingsDir, `settings.json.usage-backup-${suffix}`);
    await fs.writeFile(backup, bytes, { flag: 'wx', mode: 0o600 });
  }
  const temp = path.join(settingsDir, `.usage-settings-${suffix}.tmp`);
  let stateWritten = false;
  try {
    await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (saveState) {
      await fs.writeFile(statePath, `${JSON.stringify(saveState)}\n`, { flag: 'wx', mode: 0o600 });
      stateWritten = true;
    }
    const current = await loadJson(settingsPath, true);
    if ((bytes === null && current.bytes !== null) || (bytes !== null && (current.bytes === null || !bytes.equals(current.bytes)))) {
      throw new Error('Settings changed during installation; leaving the configuration untouched.');
    }
    await fs.rename(temp, settingsPath);
    if (remove) await fs.unlink(statePath);
  } catch (error) {
    if (stateWritten) await fs.unlink(statePath).catch(() => {});
    throw error;
  } finally { await fs.unlink(temp).catch(() => {}); }
  console.log(remove ? 'Removed StreamDock AI usage capture.' : 'Installed StreamDock AI usage capture.');
  if (backup) console.log(`Backup: ${backup}`);
}

main().catch(error => { console.error(`Usage status-line setup failed: ${error.message}`); process.exitCode = 1; });
