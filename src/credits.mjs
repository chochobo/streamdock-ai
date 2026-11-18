import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { readBrowserCredit } from './credits-browser.mjs';
import { warning } from './warnings.mjs';

const browserCache = new Map();

const PROVIDERS = Object.freeze([{ id: 'flow', label: 'Google Flow' }, { id: 'higgsfield', label: 'Higgsfield' }]);
const MAX_BYTES = 64 * 1024;
const STALE_MS = 3 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 60 * 1000;

async function readJson(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const value = JSON.parse(await handle.readFile('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}
const quantity = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15 ? value : null;
const when = value => {
  if (typeof value !== 'string' || value.length > 80) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const cleanTier = value => {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  // Plan names are deliberately allowlisted; never expose arbitrary cache text.
  return /^(?:free|pro|max|ultra|basic|standard|creator|business|enterprise|premium|plus|ultimate|starter)(?:\s+(?:plan|annual|monthly))?$/i.test(text) ? text : '';
};

/**
 * Optional Flow/Higgsfield credit snapshots. Disabled unless explicitly configured.
 * No login, token, cookie, or default browser profile is accessed. The optional
 * cdp source only reads already-open tabs in a separately verified dedicated
 * browser after explicit opt-in; it never launches, navigates, or clicks.
 * Values are observations, not API claims.
 */
export async function readCredits({ home = os.homedir(), configPath = path.join(home, '.config', 'streamdock-ai', 'credits.json'), now = Date.now(), browserReader = readBrowserCredit } = {}) {
  const config = await readJson(configPath);
  const warnings = [];
  const services = await Promise.all(PROVIDERS.map(async ({ id, label }) => {
    const setting = config?.sources?.[id];
    const base = { id, label, status: 'not-configured', source: null, balance: null, total: null, resetAt: null, resetLabel: null, resetQuality: null, tier: '', checkedAt: null };
    if (!setting || setting.enabled !== true) return base;
    if (!['agentdeck-cache', 'snapshot', 'cdp'].includes(setting.source)) {
      warnings.push(warning('credits_source_unsupported', `${label}: 지원하지 않는 수집 방식입니다.`));
      return { ...base, status: 'unavailable' };
    }
    if (setting.source === 'cdp') {
      if (setting.dedicatedProfile !== true || !Number.isInteger(setting.port) || setting.port < 1024 || setting.port > 65535) {
        warnings.push(warning('credits_browser_setup_required', `${label}: 전용 브라우저 설정이 필요합니다.`));
        return { ...base, source: 'cdp', status: 'unavailable' };
      }
      // A CDP browser must be explicitly opted in and proven dedicated on every
      // new poll. Cache reduces UI access to at most once per 30 minutes.
      const key = `${home}:\u0000${id}:\u0000${setting.port}`;
      let result = browserCache.get(key);
      if (!result || now < result.at || now - result.at >= 30 * 60 * 1000) {
        const value = await browserReader(id, setting, { home, now }).catch(() => null);
        result = { at: now, value: value || result?.value || null, available: !!value };
        browserCache.set(key, result);
      }
      if (!result.value) return { ...base, source: 'cdp', status: 'unavailable' };
      const checked = Date.parse(result.value.checkedAt || '');
      const stale = !result.available || !Number.isFinite(checked) || now - checked > STALE_MS || checked > now + MAX_FUTURE_MS;
      return { ...base, ...result.value, source: 'cdp', status: stale ? 'stale' : 'ok' };
    }
    const file = setting.source === 'agentdeck-cache'
      ? path.join(home, '.cache', 'd200', `${id}.json`)
      : path.join(home, '.cache', 'streamdock-ai', 'credits', `${id}.json`);
    const record = await readJson(file);
    const checkedAt = when(record?.checked ?? record?.checkedAt);
    const checked = checkedAt ? Date.parse(checkedAt) : null;
    const balance = quantity(record?.credits ?? record?.balance);
    const total = quantity(record?.total);
    if (!record || checked === null || checked > now + MAX_FUTURE_MS || balance === null) {
      return { ...base, source: setting.source, status: 'unavailable' };
    }
    const resetAt = when(record.reset ?? record.resetAt);
    // AgentDeck derives calendar dates when the upstream UI omits them.
    const resetQuality = resetAt ? (setting.source === 'agentdeck-cache' ? 'source-estimate' : 'user-provided') : null;
    return { ...base, source: setting.source, status: now - checked > STALE_MS ? 'stale' : 'ok',
      balance, total, resetAt, resetQuality, tier: cleanTier(record.tier), checkedAt };
  }));
  return { services, warnings, updatedAt: new Date(now).toISOString() };
}
