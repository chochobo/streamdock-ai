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
/** Validation failure. `message` is a short Korean sentence with no paths or values; `code`, `field` and `allowed` are machine-readable. */
export class SettingsError extends TypeError {
  constructor(code, field, allowed, message) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
    this.field = field;
    this.allowed = allowed;
  }
}
const invalid = (field, allowed, message) => new SettingsError('settings_invalid_value', field, allowed, message);
const prefix = parent => (parent ? `${parent}.` : '');
function checkRecord(value, keys, parent = '') {
  if (!isRecord(value)) throw invalid(parent || 'settings', 'object', `${parent || '설정'} 항목은 객체여야 합니다.`);
  const unknown = Object.keys(value).find(key => !keys.includes(key));
  if (unknown !== undefined) throw new SettingsError('settings_unknown_field', `${prefix(parent)}${unknown}`, keys, `알 수 없는 설정 항목입니다. 사용할 수 있는 항목: ${keys.join(', ')}`);
}

function validate(value, partial = false) {
  checkRecord(value, ['version', 'language', 'sound', 'brightness', 'screensaver']);
  if ((!partial || Object.hasOwn(value, 'version')) && value.version !== 1) throw invalid('version', [1], 'version 값은 1이어야 합니다.');
  if (Object.hasOwn(value, 'language') && !['ko', 'en'].includes(value.language)) throw invalid('language', ['ko', 'en'], "language 값은 'ko' 또는 'en'이어야 합니다.");
  if (!partial || Object.hasOwn(value, 'sound')) {
    checkRecord(value.sound, ['enabled'], 'sound');
    if ((!partial || Object.hasOwn(value.sound, 'enabled')) && typeof value.sound.enabled !== 'boolean') throw invalid('sound.enabled', [true, false], 'sound.enabled 값은 true 또는 false여야 합니다.');
  }
  if (!partial || Object.hasOwn(value, 'brightness')) {
    if (value.brightness !== null && (!Number.isInteger(value.brightness) || value.brightness < 0 || value.brightness > 100)) throw invalid('brightness', { type: 'integer', min: 0, max: 100, nullable: true }, 'brightness 값은 null 또는 0에서 100 사이의 정수여야 합니다.');
  }
  if (!partial || Object.hasOwn(value, 'screensaver')) {
    checkRecord(value.screensaver, ['enabled', 'idleMinutes', 'scene'], 'screensaver');
    if ((!partial || Object.hasOwn(value.screensaver, 'enabled')) && typeof value.screensaver.enabled !== 'boolean') throw invalid('screensaver.enabled', [true, false], 'screensaver.enabled 값은 true 또는 false여야 합니다.');
    if ((!partial || Object.hasOwn(value.screensaver, 'idleMinutes')) && (!Number.isInteger(value.screensaver.idleMinutes) || value.screensaver.idleMinutes < 1 || value.screensaver.idleMinutes > 1440)) throw invalid('screensaver.idleMinutes', { type: 'integer', min: 1, max: 1440 }, 'screensaver.idleMinutes 값은 1에서 1440 사이의 정수여야 합니다.');
    if ((!partial || Object.hasOwn(value.screensaver, 'scene')) && !SCENES.has(value.screensaver.scene)) throw invalid('screensaver.scene', [...SCENES], `screensaver.scene 값은 ${[...SCENES].join(', ')} 중 하나여야 합니다.`);
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
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new SettingsError('settings_invalid_json', null, null, '설정 파일이 올바른 JSON이 아닙니다. 파일은 변경되지 않았습니다.'); }
    validate(parsed);
    return { value: { language: 'ko', ...parsed }, bytes };
  } catch (error) {
    if (error.code === 'ENOENT') return { value: copy(DEFAULTS), bytes: null };
    throw error;
  } finally { await handle?.close(); }
}

export function validateSettingsPatch(patch) {
  validate(patch, true);
  if (Object.hasOwn(patch, 'version')) throw new SettingsError('settings_readonly_field', 'version', null, 'version 항목은 설정 변경으로 바꿀 수 없습니다.');
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
