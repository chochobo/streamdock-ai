import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { renderSummaryTiles, renderSummaryKeyImages } from './summary.mjs';
import { PROFILES, profileForUsb, layoutFor } from './device-profiles.mjs';

// Model definitions (USB IDs, slots, input codes) live in device-profiles.mjs.
// Both supported models share this report format and command set.
const REPORT_SIZE = 1024;
const MAX_SLOT = 32;
const hex = value => value.toString(16).padStart(4, '0');
const modelName = (profile, vendorId, productId) => `${profile.name} (${hex(vendorId)}:${hex(productId)})`;
const run = promisify(execFile);

export function commandPacket(command) {
  if (command.length + 5 > REPORT_SIZE) throw new Error('Command too long');
  const packet = Buffer.alloc(REPORT_SIZE + 1);
  Buffer.from([0x43, 0x52, 0x54, 0, 0]).copy(packet, 1);
  Buffer.from(command).copy(packet, 6);
  return packet;
}

export function imagePackets(id, jpeg) {
  if (!Number.isInteger(id) || id < 1 || id > MAX_SLOT || !jpeg.length || jpeg.length > 10240) throw new Error('Invalid key image');
  const header = Buffer.alloc(8);
  header.write('BAT', 0, 'ascii');
  header.writeUInt32BE(jpeg.length, 3);
  header[7] = id;
  const packets = [commandPacket(header)];
  for (let offset = 0; offset < jpeg.length; offset += REPORT_SIZE) {
    const data = Buffer.alloc(REPORT_SIZE + 1);
    jpeg.copy(data, 1, offset, offset + REPORT_SIZE);
    packets.push(data);
  }
  packets.push(commandPacket([0x53, 0x54, 0x50]));
  return packets;
}

// Reports use ACK bytes 0–2 and OK bytes 5–6; byte 9 is the input code, byte 10: 0 release, 1 press.
function validInputReport(data) {
  return Boolean(data && data.length >= 11 && data[0] === 0x41 && data[1] === 0x43 && data[2] === 0x4b &&
    data[5] === 0x4f && data[6] === 0x4b && (data[10] === 0 || data[10] === 1));
}

export function keyEventFromReport(data, profile = PROFILES['293sv3']) {
  if (!validInputReport(data)) return null;
  const index = profile.indexOfCode(data[9]);
  return index < 0 ? null : { index, phase: data[10] === 1 ? 'down' : 'up' };
}

/** Rocker input from a report: { code, control, action, phase }, or null for keys and unknown codes. */
export function controlEventFromReport(data, profile = PROFILES['293sv3']) {
  if (!validInputReport(data) || !Object.hasOwn(profile.rockers, data[9])) return null;
  const { rocker, dir } = profile.rockers[data[9]];
  return { code: data[9], control: rocker, action: dir, phase: data[10] === 1 ? 'down' : 'up' };
}

export function keyIndexFromReport(data, profile = PROFILES['293sv3']) {
  const event = keyEventFromReport(data, profile);
  return event?.phase === 'down' ? event.index : null;
}

const escape = text => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);

// Keep a fixed, readable font size. Split long project names across two lines
// and add an ellipsis instead of shrinking text to fit a tiny screen.
function labelLines(value) {
  const input = String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input), part => part.segment);
  const width = ch => {
    if (/\s/u.test(ch)) return 0.4;
    // Approximate bold sans-serif advances at 18 px. Narrow letters such as
    // t and i must not consume the same width as m and w.
    if (/^[\x00-\x7f]$/u.test(ch)) {
      if (/[MW@%]/.test(ch)) return 1.05;
      if (/[A-Z]/.test(ch)) return 0.8;
      if (/[mw]/.test(ch)) return 0.85;
      if (/[ilj1.]/.test(ch)) return 0.3;
      if (/[frt]/.test(ch)) return 0.4;
      return 0.6;
    }
    return 1.1;
  };
  // Four Hangul characters need 4.4 units. Keep them together while leaving
  // enough side padding for the 18 px labels and 20 px navigation labels.
  const limit = 4.45;
  const lines = ['', ''];
  let row = 0;
  let used = 0;
  let consumed = 0;
  for (const ch of chars) {
    const next = width(ch);
    if (used + next > limit) { row++; used = 0; }
    if (row >= lines.length) break;
    lines[row] += ch;
    used += next;
    consumed++;
  }
  if (consumed < chars.length) {
    let line = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(lines[1]), part => part.segment);
    while (line.length && line.reduce((n, ch) => n + width(ch), 0) + 0.9 > limit) line.pop();
    lines[1] = `${line.join('').trimEnd()}…`;
  }
  return lines.map(line => line.trim()).filter(Boolean);
}

/** SVG used by the device: project names stay at 18 px, status at 19 px. */
// Small, fixed SVG pictograms. The names come from application-owned IDs, not user text.
const tileIcons = {
  folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
  codex: '<path d="M8 4l-5 8 5 8M16 4l5 8-5 8M14 5l-4 14"/>',
  claude: '<circle cx="12" cy="12" r="4"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M5 5l3 3m8 8 3 3M19 5l-3 3M8 16l-3 3"/>',
  menu: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  back: '<path d="M10 5l-7 7 7 7M4 12h10a7 7 0 0 1 7 7"/>',
  prev: '<path d="M15 4l-8 8 8 8"/>',
  next: '<path d="M9 4l8 8-8 8"/>',
  chart: '<path d="M3 20V4M3 20h18M6 16l4-5 4 3 6-8"/>',
  agents: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 15a5 5 0 0 1 5 5"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-7M3 4v5h5M12 7v5l4 2"/>',
  gauge: '<path d="M4 18a9 9 0 1 1 16 0M12 14l4-6M8 19h8"/>',
  machine: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M9 2h6M12 5V3m0 10 4-3"/>',
  game: '<path d="M7 8h10c3 0 5 7 4 10-1 2-3 2-5 0l-1-1H9l-1 1c-2 2-4 2-5 0-1-3 1-10 4-10zM7 11v4m-2-2h4m7-1h.1m2 3h.1"/>',
  scene: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="16" cy="9" r="2"/><path d="M4 18l5-6 4 4 2-2 5 4"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10M18 8c0 5-12 2-12 7"/>',
  parcel: '<path d="M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10M8 5l9 4"/>',
  credits: '<circle cx="12" cy="12" r="9"/><path d="M15 8c-1-2-6-2-6 1s6 2 6 5-5 3-6 1m3-9v12"/>',
  remote: '<rect x="3" y="5" width="18" height="13" rx="2"/><path d="M7 9l3 3-3 3m5 0h4M9 21h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2"/><circle cx="12" cy="12" r="8"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M9 2v5m6-5v5M9 17v5m6-5v5M2 9h5m-5 6h5m10-6h5m-5 6h5"/>',
  memory: '<path d="M3 8h18v9H3zM6 10h3v4H6zm5 0h3v4h-3zm5 0h3v4h-3zM7 17v3m5-3v3m5-3v3"/>',
  disk: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M5 14h14m-3 3h.1m2 0h.1"/>',
  network: '<path d="M3 9a14 14 0 0 1 18 0M6 12a10 10 0 0 1 12 0M9 15a5 5 0 0 1 6 0"/><circle cx="12" cy="18" r="1"/>',
  battery: '<rect x="3" y="7" width="17" height="10" rx="2"/><path d="M20 10h2v4h-2M7 10v4m4-4v4m4-4v4"/>',
  temperature: '<path d="M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0zM12 9v8"/>',
  health: '<path d="M3 12h4l2-5 4 10 2-5h6"/><path d="M20 5a5 5 0 0 0-8 0 5 5 0 0 0-8 0c-3 4 1 9 8 14 7-5 11-10 8-14z"/>',
  trash: '<path d="M5 7h14M9 7V4h6v3m-8 1 1 12h8l1-12M10 10v7m4-7v7"/>',
};

function tileIconName(key) {
  if (key.kind === 'project') return 'folder';
  if (key.kind === 'session') return key.provider === 'claude' ? 'claude' : key.provider === 'codex' ? 'codex' : 'agents';
  const names = {
    summary: 'chart', projects: 'agents', history: 'history', usage: 'gauge', machines: 'machine',
    pomodoro: 'timer', market: 'chart', games: 'game', scenes: 'scene', worktrees: 'branch',
    parcels: 'parcel', credits: 'credits', remote: 'remote', settings: 'settings',
    'machine-cpu': 'cpu', 'machine-memory': 'memory', 'machine-disk': 'disk',
    'machine-network': 'network', 'machine-battery': 'battery', 'machine-temp': 'temperature',
    'machine-health': 'health', 'cleanup-clean': 'trash', 'cleanup-purge': 'trash', 'cleanup-trash': 'trash',
    'game-menu': 'game',
  };
  if (typeof key.id === 'string' && key.id.startsWith('machine-drive-')) return 'disk';
  if (Object.hasOwn(names, key.id)) return names[key.id];
  if (key.kind !== 'control') return null;
  if (key.action === 'modes') return 'menu';
  if (key.action === 'usage') return 'gauge';
  if (key.action === 'back') return 'back';
  if (key.action === 'prev' || (key.disabled && key.index === 13)) return 'prev';
  if (key.action === 'next' || (key.disabled && key.index === 14)) return 'next';
  return null;
}

function tileIcon(name, x, y, size, color) {
  if (!Object.hasOwn(tileIcons, name)) return '';
  const path = tileIcons[name];
  return `<g data-icon="${name}" transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${path}</g>`;
}

// Bars use the same percentage and direction as the accompanying value.
// Unknown values have no bar; stale values retain their measured length in grey.
function percentBar(value, direction, stale = false, warningAt = 70, criticalAt = 90, y = 83) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return '';
  const mode = ['used', 'free', 'remaining', 'charge', 'score'].includes(direction) ? direction : 'neutral';
  const risk = mode === 'used' ? value : ['free', 'remaining', 'charge', 'score'].includes(mode) ? 100 - value : null;
  if (!Number.isFinite(warningAt) || !Number.isFinite(criticalAt) || warningAt < 0 || criticalAt > 100 || warningAt > criticalAt) { warningAt = 70; criticalAt = 90; }
  const fill = stale ? '#8c99a8' : risk === null ? '#84c7ff' : risk >= criticalAt ? '#fb7185' : risk >= warningAt ? '#ffc66d' : '#59d2ae';
  const width = Math.round(value * 80) / 100;
  return `<g data-bar-direction="${mode}" data-bar-value="${value}"><rect x="8" y="${y}" width="80" height="7" rx="3.5" fill="#354354"/>${width > 0 ? `<rect x="8" y="${y}" width="${width}" height="7" rx="3.5" fill="${fill}"/>` : ''}</g>`;
}

export function keyTileSvg(key = {}) {
  const state = String(key?.state || 'empty').toLowerCase();
  const colors = { 'market-up': '#ff8b8b', 'market-down': '#85b7ff', 'market-flat': '#b2bed0', working: '#59d2ae', running: '#59d2ae', active: '#59d2ae', waiting: '#ffc66d', blocked: '#ffad78', error: '#fb7185', done: '#70a8ff', idle: '#b2bed0', unknown: '#b2bed0' };
  const captions = key.language === 'en' ? { working: 'Working', running: 'Working', active: 'Working', waiting: 'Review', blocked: 'Review', error: 'Error', done: 'Done', idle: 'Idle', unknown: 'Unknown' } : { working: '작업 중', running: '작업 중', active: '작업 중', waiting: '확인', blocked: '확인', error: '오류', done: '완료', idle: '대기', unknown: '미확인' };
  const pulse = (key.kind === 'project' || key.kind === 'session') && key.alertPulse === true && ['done', 'waiting', 'blocked'].includes(state);
  const color = pulse ? '#101923' : (colors[state] || '#b2bed0');
  const fill = pulse ? (state === 'done' ? '#59d2ae' : '#ffc66d') : state === 'market-up' ? '#51202a' : state === 'market-down' ? '#18365a' : '#101923';
  const textColor = pulse ? '#101923' : '#f7fbff';
  const background = `<rect width="96" height="96" rx="10" fill="${fill}"/>`;
  if (key.kind === 'quota' || key.kind === 'quota-reset') {
    const english = key.language === 'en';
    const unknown = english ? 'Unknown' : '미확인';
    const label = escape(labelLines(key.label || (english ? 'Account' : '계정'))[0] || (english ? 'Account' : '계정'));
    const window = escape(labelLines(key.windowLabel || (english ? 'Limit' : '한도'))[0] || (english ? 'Limit' : '한도'));
    const stale = key.usageStatus === 'stale';
    const used = typeof key.usedPercent === 'number' && Number.isFinite(key.usedPercent) && key.usedPercent >= 0 && key.usedPercent <= 100 ? Math.round(key.usedPercent) : null;
    const statusColor = stale ? '#b2bed0' : key.kind === 'quota' && used !== null ? (used >= 85 ? '#fb7185' : used >= 60 ? '#ffc66d' : '#59d2ae') : color;
    const small = (x, y, value, size = 14, fill = '#f7fbff') => `<text x="${x}" y="${y}" fill="${fill}" font-family="sans-serif" font-size="${size}" font-weight="bold">${escape(value)}</text>`;
    const header = `<text x="7" y="17" fill="#f7fbff" font-family="sans-serif" font-size="15" font-weight="bold">${label}</text>` +
      `<text x="7" y="36" fill="#b2bed0" font-family="sans-serif" font-size="${english ? 12 : 14}" font-weight="bold">${window} ${key.kind === 'quota' ? (english ? 'Used' : '사용') : (english ? 'Reset' : '리셋')}</text>`;
    let body;
    if (key.kind === 'quota') {
      const percent = used;
      const value = percent === null ? unknown : `${percent}%`;
      body = small(7, 66, value, percent === null ? (english ? 15 : 19) : 25, statusColor) +
        (stale ? small(7, percent === null ? 88 : 78, english ? 'Old' : '이전', 11, '#b2bed0') : '') +
        percentBar(percent, 'used', stale, 60, 85);
    } else if (key.resetDate && key.resetTime) {
      body = small(7, 59, key.resetDate, 17, statusColor) + small(7, 82, key.resetTime, 20, statusColor) + (stale ? small(58, 94, english ? 'Old' : '이전', 11, '#b2bed0') : '');
    } else {
      body = small(7, 68, unknown, english ? 15 : 19, '#b2bed0');
    }
    return `<svg width="96" height="96" xmlns="http://www.w3.org/2000/svg">${background}<rect x="0" y="0" width="96" height="4" fill="${statusColor}"/>${header}${body}</svg>`;
  }
  if (key.kind === 'control') {
    const lines = labelLines(key.label || '');
    const iconName = tileIconName(key);
    const iconColor = key.disabled ? '#697584' : '#84c7ff';
    const icon = tileIcon(iconName, 33, 8, 30, iconColor);
    const positions = icon ? (lines.length > 1 ? [64, 85] : [73]) : (lines.length > 1 ? [43, 67] : [57]);
    const labels = lines.map((line, i) => `<text x="48" y="${positions[i]}" text-anchor="middle" fill="${key.disabled ? '#697584' : '#f7fbff'}" font-family="sans-serif" font-size="20" font-weight="bold">${escape(line)}</text>`).join('');
    return `<svg width="96" height="96" xmlns="http://www.w3.org/2000/svg">${background}${icon}${labels}</svg>`;
  }
  if (state === 'empty') return `<svg width="96" height="96" xmlns="http://www.w3.org/2000/svg">${background}</svg>`;
  // Keep the absolute value, percentage and bar tied to the same observation.
  // The collector's physical-memory calculation is an estimate, not an Apple API.
  const memory = key.memory;
  const memoryValid = key.id === 'machine-memory' && memory?.estimated === true &&
    Number.isSafeInteger(memory.usedBytes) && Number.isSafeInteger(memory.totalBytes) &&
    memory.usedBytes >= 0 && memory.totalBytes > 0 && memory.usedBytes <= memory.totalBytes &&
    Number.isFinite(key.bar?.value) && key.bar.value >= 0 && key.bar.value <= 100 &&
    Math.round(memory.usedBytes * 100 / memory.totalBytes) === key.bar.value;
  if (memoryValid) {
    const en = key.language === 'en';
    const stale = key.bar?.stale === true;
    const title = stale ? (en ? 'Memory Old' : '메모리 이전') : (en ? 'Memory Used' : '메모리 사용');
    const amount = `${en ? '~' : '약 '}${(memory.usedBytes / (1024 ** 3)).toFixed(1)}GB`;
    const percent = `${en ? '~' : '약 '}${Math.round(key.bar.value)}%`;
    const amountSize = amount.length > 10 ? 12 : amount.length > 8 ? 14 : 16;
    const foreground = stale ? '#b2bed0' : '#f7fbff';
    const bar = percentBar(key.bar.value, key.bar.direction, stale, key.bar.warningAt, key.bar.criticalAt);
    return `<svg width="96" height="96" xmlns="http://www.w3.org/2000/svg">${background}<rect x="0" y="0" width="96" height="4" fill="${color}"/><text x="8" y="18" fill="${foreground}" font-family="sans-serif" font-size="${en ? 12 : 14}" font-weight="bold">${escape(title)}</text><text x="8" y="43" fill="${foreground}" font-family="sans-serif" font-size="${amountSize}" font-weight="bold">${escape(amount)}</text><text x="8" y="69" fill="${foreground}" font-family="sans-serif" font-size="19" font-weight="bold">${escape(percent)}</text>${bar}</svg>`;
  }
  const lines = key.id === 'machine-memory' && key.label === '메모리 사용' ? ['메모리', '사용']
    : key.id === 'machine-memory' && key.label === 'Memory Used' ? ['Memory', 'Used']
    : labelLines(key?.label || 'Agent');
  const positions = lines.length > 1 ? [27, 48] : [39];
  const labels = lines.map((line, i) => `<text x="8" y="${positions[i]}" fill="${textColor}" font-family="sans-serif" font-size="18" font-weight="bold">${escape(line)}</text>`).join('');
  const bar = percentBar(key.bar?.value, key.bar?.direction, key.bar?.stale === true, key.bar?.warningAt, key.bar?.criticalAt);
  const caption = (key.kind === 'project' || key.kind === 'feature') && key.caption ? (bar ? String(key.caption) : (labelLines(key.caption)[0] || '')) : `${captions[state] || (key.language === 'en' ? 'Unknown' : '미확인')}${key?.estimated ? '?' : ''}`;
  // librsvg does not consistently honor SVG textLength; use a slightly smaller
  // font for long value captions so the percent sign stays inside the key.
  const captionSize = bar && labelLines(caption).length > 1 ? Math.max(12, Math.min(17, Math.floor(119 / Array.from(caption).length))) : 19;
  const provider = key.kind === 'session' && key.provider === 'codex' ? 'CX' : key.kind === 'session' && key.provider === 'claude' ? 'CL' : '';
  const providerBadge = provider ? `<text x="89" y="93" text-anchor="end" fill="${textColor}" font-family="sans-serif" font-size="11" font-weight="bold">${provider}</text>` : '';
  // The icon stays below the caption baseline, so project names and values
  // retain their original readable font sizes and their two-line layout.
  const icon = bar ? '' : tileIcon(tileIconName(key), provider ? 62 : 77, 81, 14, color);
  const oldBar = Boolean(bar && key.bar?.stale === true);
  const oldLabel = oldBar ? `<text x="8" y="79" fill="#b2bed0" font-family="sans-serif" font-size="10" font-weight="bold">${key.language === 'en' ? 'Old' : '이전'}</text>` : '';
  return `<svg width="96" height="96" xmlns="http://www.w3.org/2000/svg">${background}<rect x="0" y="0" width="96" height="4" fill="${color}"/>${labels}<text x="8" y="${oldBar ? 68 : bar ? 70 : 80}" fill="${color}" font-family="sans-serif" font-size="${captionSize}" font-weight="bold">${escape(caption)}</text>${icon}${providerBadge}${oldLabel}${bar}</svg>`;
}

async function tile(sharp, key, profile) {
  const svg = keyTileSvg(key);
  // Tiles are drawn upright at 96 px, then scaled and rotated for the model.
  // Pillow's 90-degree rotation in the vendor SDK is counter-clockwise.
  let image = sharp(Buffer.from(svg));
  if (profile.imageSize !== 96) image = image.resize(profile.imageSize, profile.imageSize, { fit: 'fill' });
  return image.rotate(profile.rotate).jpeg({ quality: 85 }).toBuffer();
}

async function officialAppRunning() {
  if (process.platform !== 'darwin') return false;
  try { await run('/usr/bin/pgrep', ['-x', 'StreamDock']); return true; }
  catch (error) { if (error.code === 1) return false; throw error; }
}

/**
 * mode: simulator (default), or hardware for any model in device-profiles.mjs.
 * profile: the starting model. In hardware mode start() switches to the profile
 * of the single connected supported device; profile() returns the current one.
 * onKey(index): receives a zero-based row-major position on a key press.
 * onKeyEvent(index, phase, heldMs): down/up/cancel; durations are monotonic and bounded.
 * onControl({control, action, phase}): a rocker press (XL only): control left|right,
 *   action up|down|push, phase 'down'. A held rocker fires once until released.
 * renderImages({keys, sides}) writes supplied PNG/JPEG buffers only, converted to the model's size.
 * render accepts [{index, label, state, estimated}]. status distinguishes HID connection
 * from simulation. start and stop never modify the device's boot image.
 */
export function createDevice({ mode = 'simulator', profile: initialProfile = PROFILES['293sv3'], onKey = () => {}, onKeyEvent = () => {}, onControl = () => {}, maxHoldMs = 60_000, dependencies } = {}) {
  if (!['simulator', 'hardware'].includes(mode)) throw new Error('Unknown device mode');
  if (!Object.values(PROFILES).includes(initialProfile)) throw new TypeError('Unknown device profile');
  if (typeof onKey !== 'function' || typeof onKeyEvent !== 'function' || typeof onControl !== 'function') throw new TypeError('Key callbacks must be functions');
  if (!Number.isSafeInteger(maxHoldMs) || maxHoldMs < 10 || maxHoldMs > 300_000) throw new RangeError('Invalid maximum hold time');
  let profile = initialProfile;
  let state = { connected: false, model: mode === 'simulator' ? 'Simulator' : modelName(profile, profile.vendorId, profile.productIds[0]), error: null, mode };
  let handle, sharp, heartbeat, starting;
  let queue = Promise.resolve();
  const sent = new Map();
  const sentSummary = new Map();
  const pressed = new Map();
  // Timed-out keys stay suppressed until release; missing releases cannot create repeat presses.
  const expired = new Set();
  // Rocker codes held down; a missing release cannot create repeat presses.
  const heldControls = new Set();
  const clock = dependencies?.now || (() => performance.now());
  function invoke(callback, ...args) {
    try {
      const result = callback(...args);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch { /* A callback must not crash the HID reader. */ }
  }
  function elapsed(start) {
    const delta = clock() - start;
    return Number.isFinite(delta) ? Math.min(maxHoldMs, Math.max(0, Math.round(delta))) : 0;
  }
  function cancelKeys() {
    for (const [index, info] of pressed) {
      clearTimeout(info.timer);
      invoke(onKeyEvent, index, 'cancel', elapsed(info.startedAt));
    }
    pressed.clear();
    expired.clear();
    heldControls.clear();
  }
  function input(data) {
    if (!handle) return;
    // Vendor SDK identifies byte 9 == 0xff as a write confirmation. This
    // does not establish which frame is visible, so retain only a timestamp.
    if (data && data.length >= 10 && data[9] === 0xff) {
      state = { ...state, lastDeviceAcknowledgementAt: new Date().toISOString() };
      return;
    }
    // Do not dispatch a button against a previous screen while initial images
    // are still being sent after startup or reconnection.
    if (!state.connected) return;
    const control = controlEventFromReport(data, profile);
    if (control) {
      if (control.phase === 'up') { heldControls.delete(control.code); return; }
      if (heldControls.has(control.code)) return;
      heldControls.add(control.code);
      invoke(onControl, { control: control.control, action: control.action, phase: 'down' });
      return;
    }
    const event = keyEventFromReport(data, profile);
    if (!event) return;
    const { index, phase } = event;
    if (phase === 'down') {
      if (pressed.has(index) || expired.has(index)) return;
      const info = { startedAt: clock(), timer: undefined };
      info.timer = setTimeout(() => {
        if (pressed.get(index) !== info) return;
        pressed.delete(index);
        expired.add(index);
        // A timeout cannot be treated as a release or as a successful hold.
        invoke(onKeyEvent, index, 'cancel', maxHoldMs);
      }, maxHoldMs);
      info.timer.unref?.();
      pressed.set(index, info);
      invoke(onKeyEvent, index, 'down', 0);
      invoke(onKey, index);
    } else {
      if (expired.delete(index)) return;
      const info = pressed.get(index);
      if (!info) return;
      clearTimeout(info.timer);
      pressed.delete(index);
      invoke(onKeyEvent, index, 'up', elapsed(info.startedAt));
    }
  }
  const send = async packet => {
    if (!handle) throw new Error('Device is not connected');
    const current = handle;
    const written = typeof current.writePacket === 'function'
      ? await current.writePacket(packet)
      : current.write(Array.from(packet));
    if (handle !== current) throw new Error('Device disconnected during HID write');
    if (typeof written === 'number' && written !== packet.length) throw new Error('Incomplete HID write');
  };
  function fail(error) {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    const previous = handle;
    handle = undefined;
    try { previous?.close(); } catch { /* Device may already be disconnected. */ }
    sent.clear();
    sentSummary.clear();
    cancelKeys();
    state = { ...state, connected: false, lastDeviceAcknowledgementAt: null, error: String(error?.message || error) };
  }
  return {
    async start() {
      if (mode === 'simulator') return;
      if (starting) return starting;
      if (handle) return;
      starting = (async () => {
      try {
        if (await (dependencies?.officialAppRunning || officialAppRunning)()) throw new Error('먼저 공식 StreamDock 앱을 종료하세요.');
        const hid = dependencies?.hid || await import('node-hid');
        sharp = dependencies?.sharp || (await import('sharp')).default;
        const devices = await hid.devicesAsync();
        const matches = devices.filter(d => profileForUsb(d.vendorId, d.productId) && d.usagePage > 1025 && d.usage === 1 && d.path);
        if (matches.length !== 1) throw new Error(matches.length ? '일치하는 장치가 여러 개입니다.' : '지원하는 StreamDock 장치(293S V3, XL)를 찾지 못했습니다. USB 연결과 권한을 확인하세요.');
        // The connected device decides the model; caches are cleared below before connecting.
        profile = profileForUsb(matches[0].vendorId, matches[0].productId);
        state = { ...state, model: modelName(profile, matches[0].vendorId, matches[0].productId) };
        const opened = new hid.HID(matches[0].path);
        handle = opened;
        // Late callbacks from a previous handle must never act on a newly
        // connected device or invalidate its freshly rendered screen.
        opened.on('data', data => { if (handle === opened) input(data); });
        opened.on('deviceAck', () => { if (handle === opened) state = { ...state, lastDeviceAcknowledgementAt: new Date().toISOString() }; });
        opened.on('error', error => { if (handle === opened) fail(error); });
        state = { ...state, connected: false, error: null, lastDeviceAcknowledgementAt: null, lastTransportHeartbeatAt: null };
        await send(commandPacket([0x44, 0x49, 0x53]));
        await send(commandPacket([...Buffer.from('CONNECT')]));
        state = { ...state, lastTransportHeartbeatAt: new Date().toISOString() };
        if (dependencies?.skipInitialBlank !== true) {
          // Vendor SDK clearAllIcon + refresh: clears transient key overlays.
          // This does not write or erase the device's ROM boot logo.
          await send(commandPacket([0x43, 0x4c, 0x45, 0, 0, 0, 0xff]));
          await send(commandPacket([0x53, 0x54, 0x50]));
          // Runtime-only key images. Do not send the ROM boot-logo command.
          const size = profile.imageSize;
          const svg = Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" fill="#000000"/></svg>`);
          const black = await sharp(svg).jpeg({ quality: 85 }).toBuffer();
          let lastHeartbeat = performance.now();
          const slots = [...Array.from({ length: profile.keyCount }, (_, index) => profile.slotOf(index)), ...profile.sideSlots];
          for (const id of slots) {
            for (const packet of imagePackets(id, black)) await send(packet);
            // Never interleave a heartbeat in the middle of an image transfer.
            if (performance.now() - lastHeartbeat >= 6000) {
              await send(commandPacket([...Buffer.from('CONNECT')]));
              state = { ...state, lastTransportHeartbeatAt: new Date().toISOString() };
              lastHeartbeat = performance.now();
            }
          }
        }
        // Blank images must never populate the normal render caches.
        sent.clear();
        sentSummary.clear();
        state = { ...state, connected: true, error: null };
        heartbeat = setInterval(() => {
          const task = queue.then(async () => {
            await send(commandPacket([...Buffer.from('CONNECT')]));
            state = { ...state, lastTransportHeartbeatAt: new Date().toISOString() };
          });
          queue = task.catch(error => { fail(error); });
        }, 8000);
        heartbeat.unref?.();
      } catch (error) { fail(error); }
      })().finally(() => { starting = undefined; });
      return starting;
    },
    async setBrightness(percent) {
      if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new RangeError('Brightness must be an integer from 0 to 100');
      if (mode === 'simulator') {
        state = { ...state, requestedBrightness: percent };
        return true;
      }
      if (!handle) return false;
      const task = queue.then(() => send(commandPacket([0x4c, 0x49, 0x47, 0, 0, percent])));
      queue = task.catch(error => { fail(error); });
      await queue;
      if (state.connected) state = { ...state, requestedBrightness: percent };
      return state.connected;
    },
    async render(keys) {
      if (mode !== 'hardware' || !handle) return false;
      const task = queue.then(async () => {
        const current = profile;
        // Summary keys are drawn only by renderSummary.
        const summaryKeys = new Set(layoutFor(current).summaryKeys);
        const byIndex = new Map(keys.filter(k => Number.isInteger(k.index) && k.index >= 0 && k.index < current.keyCount).map(k => [k.index, k]));
        for (let index = 0; index < current.keyCount; index++) {
          if (summaryKeys.has(index)) continue;
          const key = byIndex.get(index) || {};
          const signature = JSON.stringify([key.id || '', key.action || '', key.index, key.label || '', key.state || '', Boolean(key.estimated), key.kind || '', key.caption || '', key.provider || '', Boolean(key.disabled), key.windowLabel || '', key.usedPercent ?? null, key.resetDate || '', key.resetTime || '', key.usageStatus || '', key.language || 'ko', Boolean(key.alertPulse), key.bar?.value ?? null, key.bar?.direction || '', Boolean(key.bar?.stale), key.bar?.warningAt ?? null, key.bar?.criticalAt ?? null,
            Number.isSafeInteger(key.memory?.usedBytes) && key.memory.usedBytes >= 0 ? (key.memory.usedBytes / (1024 ** 3)).toFixed(1) : null,
            key.memory?.estimated === true && Number.isSafeInteger(key.memory?.totalBytes) && key.memory.totalBytes > 0 && Number.isSafeInteger(key.memory?.usedBytes) && key.memory.usedBytes >= 0 && key.memory.usedBytes <= key.memory.totalBytes && Math.round(key.memory.usedBytes * 100 / key.memory.totalBytes) === key.bar?.value]);
          if (sent.get(index) === signature) continue;
          const image = await tile(sharp, key, current);
          for (const packet of imagePackets(current.slotOf(index), image)) await send(packet);
          sent.set(index, signature);
        }
      });
      queue = task.catch(error => { fail(error); });
      await queue;
      return state.connected;
    },
    async renderImages({ keys = [], sides = [] } = {}) {
      const current = profile;
      if (!Array.isArray(keys) || !Array.isArray(sides) || keys.length > current.keyCount || sides.length > current.sideSlots.length) throw new TypeError('Invalid image frame');
      const indices = new Set();
      const slots = new Set();
      const validImage = image => Buffer.isBuffer(image) && image.length >= 8 && image.length <= 2 * 1024 * 1024 &&
        (image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
         (image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff));
      for (const entry of keys) {
        if (!entry || !Number.isInteger(entry.index) || entry.index < 0 || entry.index >= current.keyCount || indices.has(entry.index) || !validImage(entry.image)) throw new TypeError('Invalid key image');
        indices.add(entry.index);
      }
      for (const entry of sides) {
        if (!entry || !Number.isInteger(entry.slot) || !current.sideSlots.includes(entry.slot) || slots.has(entry.slot) || !validImage(entry.image)) throw new TypeError('Invalid side image');
        slots.add(entry.slot);
      }
      if (mode !== 'hardware' || !handle) return false;
      let inputError;
      const task = queue.then(async () => {
        const keyed = keys.map(entry => ({ ...entry, signature: 'image:' + createHash('sha256').update(entry.image).digest('hex') }))
          .filter(entry => sent.get(entry.index) !== entry.signature);
        const items = [...keyed.map(entry => ({ ...entry, target: 'key' })), ...sides.map(entry => ({ ...entry, target: 'side' }))];
        let ready;
        try {
          ready = await Promise.all(items.map(async entry => {
            const make = quality => sharp(entry.image, { failOn: 'error', limitInputPixels: 4_194_304 })
              .resize(current.imageSize, current.imageSize, { fit: 'fill' }).rotate(current.rotate).jpeg({ quality }).toBuffer();
            let jpeg = await make(85);
            if (jpeg.length > 10_240) jpeg = await make(65);
            if (!Buffer.isBuffer(jpeg) || !jpeg.length || jpeg.length > 10_240) throw new Error('Output exceeds device limit');
            return { ...entry, jpeg };
          }));
        } catch {
          inputError = new Error('Could not decode the supplied image frame');
          return;
        }
        for (const entry of ready) {
          const id = entry.target === 'key' ? current.slotOf(entry.index) : entry.slot;
          if (entry.target === 'side' && sentSummary.get(id)?.equals(entry.jpeg)) continue;
          for (const packet of imagePackets(id, entry.jpeg)) await send(packet);
          if (entry.target === 'key') {
            sent.set(entry.index, entry.signature);
            // A summary key overwritten by a frame must be redrawn by the next summary.
            sentSummary.delete(id);
          } else sentSummary.set(id, Buffer.from(entry.jpeg));
        }
      });
      queue = task.catch(error => { fail(error); });
      await queue;
      if (inputError) throw inputError;
      return state.connected;
    },
    async renderSummary(summary) {
      if (mode !== 'hardware' || !handle) return false;
      const task = queue.then(async () => {
        const current = profile;
        let tiles;
        if (current.sideSlots.length) {
          tiles = await (dependencies?.renderSummaryTiles || renderSummaryTiles)(summary, sharp);
          if (!Array.isArray(tiles) || tiles.length !== 3 || new Set(tiles.map(tile => tile.slot)).size !== 3 || tiles.some(tile => !current.sideSlots.includes(tile.slot) || !Buffer.isBuffer(tile.jpeg))) {
            throw new Error('Invalid summary images');
          }
        } else {
          // No side screens: draw overview, attention, clock top-to-bottom on the summary keys.
          const summaryKeys = layoutFor(current).summaryKeys;
          const images = await (dependencies?.renderSummaryKeyImages || renderSummaryKeyImages)(summary, sharp, { size: current.imageSize, rotate: current.rotate });
          if (summaryKeys.length !== 3 || !Array.isArray(images) || images.length !== 3 || images.some(jpeg => !Buffer.isBuffer(jpeg))) throw new Error('Invalid summary images');
          tiles = summaryKeys.map((index, i) => ({ slot: current.slotOf(index), jpeg: images[i], index }));
        }
        for (const { slot, jpeg, index } of tiles) {
          if (sentSummary.get(slot)?.equals(jpeg)) continue;
          for (const packet of imagePackets(slot, jpeg)) await send(packet);
          sentSummary.set(slot, Buffer.from(jpeg));
          // An image frame may target this key later; it must not be skipped as cached.
          if (index !== undefined) sent.delete(index);
        }
      });
      queue = task.catch(error => { fail(error); });
      await queue;
      return state.connected;
    },
    status() { return { ...state }; },
    profile() { return profile; },
    async stop() {
      if (starting) await starting;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      await queue;
      const previous = handle;
      handle = undefined;
      try { previous?.close(); } catch { /* Already disconnected. */ }
      sent.clear();
      sentSummary.clear();
      cancelKeys();
      state = { ...state, connected: false, lastDeviceAcknowledgementAt: null };
    },
  };
}
