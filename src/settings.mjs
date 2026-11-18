import { constants, promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const SCENES = new Set(['aquarium', 'fire', 'rain', 'beach']);
const DEFAULTS = Object.freeze({
  version: 1,
  language: 'ko',
  sound: Object.freeze({ enabled: false }),
  // Null preserves the device's current brightness at startup.
  brightness: null,
  screensaver: Object.freeze({ enabled: false, idleMinutes: 15, scene: 'aquarium' }),
});
const copy = value => structuredClone(value);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const allowed = (value, keys) => isRecord(value) && Object.keys(value).every(key => keys.includes(key));

function validate(value, partial = false) {
  if (!allowed(value, ['version', 'language', 'sound', 'brightness', 'screensaver'])) throw new TypeError('Invalid settings fields');
  if ((!partial || Object.hasOwn(value, 'version')) && value.version !== 1) throw new TypeError('Unsupported settings version');
  if (Object.hasOwn(value, 'language') && !['ko', 'en'].includes(value.language)) throw new TypeError('Invalid language');
  if (!partial || Object.hasOwn(value, 'sound')) {
    if (!allowed(value.sound, ['enabled']) || ((!partial || Object.hasOwn(value.sound, 'enabled')) && typeof value.sound.enabled !== 'boolean')) throw new TypeError('Invalid sound settings');
  }
  if (!partial || Object.hasOwn(value, 'brightness')) {
    if (value.brightness !== null && (!Number.isInteger(value.brightness) || value.brightness < 0 || value.brightness > 100)) throw new RangeError('Brightness must be null or an integer from 0 to 100');
  }
  if (!partial || Object.hasOwn(value, 'screensaver')) {
    if (!allowed(value.screensaver, ['enabled', 'idleMinutes', 'scene'])) throw new TypeError('Invalid screensaver settings');
    if ((!partial || Object.hasOwn(value.screensaver, 'enabled')) && typeof value.screensaver.enabled !== 'boolean') throw new TypeError('Invalid screensaver enabled value');
    if ((!partial || Object.hasOwn(value.screensaver, 'idleMinutes')) && (!Number.isInteger(value.screensaver.idleMinutes) || value.screensaver.idleMinutes < 1 || value.screensaver.idleMinutes > 1440)) throw new RangeError('Screensaver idleMinutes must be from 1 to 1440');
    if ((!partial || Object.hasOwn(value.screensaver, 'scene')) && !SCENES.has(value.screensaver.scene)) throw new TypeError('Unknown screensaver scene');
  }
}

async function readConfig(filename) {
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_384 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Unsafe settings file');
    const bytes = await handle.readFile();
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid settings JSON; the file was not changed'); }
    validate(parsed);
    return { value: { language: 'ko', ...parsed }, bytes };
  } catch (error) {
    if (error.code === 'ENOENT') return { value: copy(DEFAULTS), bytes: null };
    throw error;
  } finally { await handle?.close(); }
}

export function validateSettingsPatch(patch) {
  validate(patch, true);
  if (Object.hasOwn(patch, 'version')) throw new TypeError('Version cannot be changed through settings');
  return true;
}

function merge(current, patch) {
  validate(patch, true);
  const next = {
    ...current,
    ...patch,
    sound: { ...current.sound, ...(patch.sound || {}) },
    screensaver: { ...current.screensaver, ...(patch.screensaver || {}) },
  };
  validate(next);
  return next;
}

/** Persistent preferences only. No sound, display or screensaver action runs here. */
export function createSettings({ home = os.homedir(), file = path.join(home, '.config', 'streamdock-ai', 'settings.json') } = {}) {
  if (!path.isAbsolute(file)) throw new TypeError('Settings path must be absolute');
  let value = copy(DEFAULTS);
  let queue = Promise.resolve();
  function enqueue(fn) {
    const task = queue.then(fn);
    queue = task.catch(() => {});
    return task;
  }
  return {
    get() { return copy(value); },
    async load() { return enqueue(async () => { const current = await readConfig(file); value = current.value; return copy(value); }); },
    async update(patch) {
      return enqueue(async () => {
        const current = await readConfig(file);
        const next = merge(current.value, patch);
        if (JSON.stringify(next) === JSON.stringify(current.value)) { value = next; return copy(value); }
        const directory = path.dirname(file);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const dirStat = await fs.lstat(directory);
        if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (typeof process.getuid === 'function' && dirStat.uid !== process.getuid())) throw new Error('Unsafe settings directory');
        const temporary = path.join(directory, `.settings-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
        let handle;
        try {
          handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
          await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
          await handle.sync();
          await handle.close(); handle = undefined;
          const check = await readConfig(file);
          if ((current.bytes === null) !== (check.bytes === null) || (current.bytes && !current.bytes.equals(check.bytes))) throw new Error('Settings changed concurrently; not modified');
          await fs.rename(temporary, file);
        } finally { await handle?.close(); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        value = next;
        return copy(value);
      });
    },
  };
}
