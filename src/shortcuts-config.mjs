import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// User-written shortcut definitions (#33). The file is the only source: nothing
// here is derived from agent, network or session data, and reading it never
// runs anything. A press runs an item only after re-reading this file.

const MAX_BYTES = 64_000;
const MAX_ITEMS = 100;
const MAX_LABEL = 40;
const MAX_CAPTION = 24;
const MAX_TEXT = 2000;
const MAX_URL = 2048;
const MAX_ARG = 512;
const MAX_ARGS = 16;
const URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Built-in system keys. Each entry is a ready item; they need no file.
 * Labels and captions are short on purpose: a key fits about 4 Hangul per line. */
export const SYSTEM_ACTIONS = Object.freeze({
  'volume-up': { label: '볼륨 +', caption: '올리기' },
  'volume-down': { label: '볼륨 −', caption: '내리기' },
  mute: { label: '음소거', caption: '전환' },
  'display-sleep': { label: '화면끄기', caption: '절전' },
  screensaver: { label: '보호기', caption: '시작' },
});

const hashOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8);
const hasControl = (value, allow = '') => Array.from(value).some(ch => {
  const code = ch.codePointAt(0);
  return (code < 0x20 || (code >= 0x7f && code <= 0x9f) || /\p{Cf}/u.test(ch)) && !allow.includes(ch);
});
const graphemes = value => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), part => part.segment).length;
const text = (value, max, { allow = '', required = true } = {}) => {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (required && !trimmed) return null;
  if (graphemes(value) > max || hasControl(value, allow)) return null;
  return trimmed;
};

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const label = text(raw.label, MAX_LABEL);
  const caption = text(raw.caption, MAX_CAPTION, { required: false });
  if (label === null || caption === null || typeof raw.type !== 'string') return null;
  const base = { label, ...(caption ? { caption } : {}), type: raw.type };
  switch (raw.type) {
    case 'app': {
      const app = text(raw.app, 120);
      return app && !app.startsWith('-') ? { ...base, app } : null;
    }
    case 'url': {
      const url = text(raw.url, MAX_URL);
      if (!url || url.startsWith('-')) return null;
      try { if (!URL_PROTOCOLS.has(new URL(url).protocol)) return null; } catch { return null; }
      return { ...base, url };
    }
    case 'text': {
      const value = raw.text;
      if (typeof value !== 'string' || !value.trim() || graphemes(value) > MAX_TEXT || hasControl(value, '\n\t')) return null;
      if (raw.submit !== undefined && typeof raw.submit !== 'boolean') return null;
      return { ...base, text: value, submit: raw.submit === true };
    }
    case 'command': {
      const argv = raw.command;
      if (!Array.isArray(argv) || !argv.length || argv.length > MAX_ARGS) return null;
      if (!argv.every(arg => typeof arg === 'string' && arg.length <= MAX_ARG && !arg.includes('\u0000'))) return null;
      if (!argv[0].startsWith('/') || hasControl(argv[0])) return null;
      // Commands never run on a plain tap; the key must be held.
      return { ...base, command: [...argv], hold: true };
    }
    case 'system':
      return Object.hasOwn(SYSTEM_ACTIONS, raw.system) ? { ...base, system: raw.system } : null;
    default:
      return null;
  }
}

// User ids carry a content hash so a changed item can never reuse a displayed
// id. Built-in ids are fixed names; the UI translates only those.
const withId = (item, index) => ({ ...item, id: item.builtin ? `scb-${item.system}` : `sc-${index}-${hashOf(item)}` });

/** The keys offered even without a file (the file can switch them off). */
export const SYSTEM_SHORTCUTS = Object.freeze(Object.entries(SYSTEM_ACTIONS).map(([system, { label, caption }]) => Object.freeze({ label, caption, type: 'system', system, builtin: true })));

function assemble(userItems, builtins, status, skipped) {
  const all = [...userItems, ...(builtins ? SYSTEM_SHORTCUTS : [])];
  return { status, skipped, items: all.map((item, index) => withId(item, index)) };
}

export async function readShortcutsConfig({ home = os.homedir(), file = path.join(home, '.config', 'streamdock-ai', 'shortcuts.json') } = {}) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    const unsafeOwner = typeof process.getuid === 'function' && stat.uid !== process.getuid();
    // Commands run from this file, so nobody but the owner may be able to edit it.
    if (!stat.isFile() || stat.size > MAX_BYTES || unsafeOwner || (stat.mode & 0o022) !== 0) return assemble([], true, 'unavailable', 0);
    const raw = await handle.readFile('utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1) return assemble([], true, 'unavailable', 0);
    if (data.items !== undefined && !Array.isArray(data.items)) return assemble([], true, 'unavailable', 0);
    if (data.builtins !== undefined && typeof data.builtins !== 'boolean') return assemble([], true, 'unavailable', 0);
    const source = data.items ?? [];
    const valid = [];
    let skipped = 0;
    for (const entry of source) {
      const item = valid.length < MAX_ITEMS ? normalize(entry) : null;
      if (item) valid.push(item); else skipped++;
    }
    return assemble(valid, data.builtins !== false, 'ok', skipped);
  } catch (error) {
    return assemble([], true, error?.code === 'ENOENT' ? 'unconfigured' : 'unavailable', 0);
  } finally { await handle?.close().catch(() => {}); }
}
