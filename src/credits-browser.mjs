import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PORT = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
const TARGETS = {
  flow: url => url.protocol === 'https:' && url.hostname === 'flow.google.com' && url.port === '' && !url.username && !url.password && url.pathname === '/',
  higgsfield: url => url.protocol === 'https:' && url.hostname === 'higgsfield.ai' && url.port === '' && !url.username && !url.password && url.pathname.replace(/\/$/, '') === '/me/settings/subscription',
};
// Only the matched quota snippets leave the page. No click, navigation, cookie,
// credential, account identifier, or page text is returned.
const EXPRESSIONS = {
  flow: `(() => {if(location.protocol!=='https:'||location.hostname!=='flow.google.com'||location.port!==''||location.pathname!=='/')return null;const n=document.querySelector('.credits-info');if(!n)return null;const t=(n.innerText||'').slice(0,1500);const c=t.match(/(?:크레딧\\s*([\\d,]+)|([\\d,]+)\\s*(?:AI\\s*)?credits)/i);const r=t.match(/(?:\\d{1,2}월\\s*\\d{1,2}일[^\\n]{0,35}초기화|Resets\\s+[A-Za-z]{3,9}\\.?\\s+\\d{1,2}[^\\n]{0,35})/i);return c?{balance:c[1]||c[2],resetLabel:r?r[0]:null}:null})()`,
  higgsfield: `(() => {if(location.protocol!=='https:'||location.hostname!=='higgsfield.ai'||location.port!==''||location.pathname.replace(/\\/$/,'')!=='/me/settings/subscription')return null;const w=document.createTreeWalker(document.body,NodeFilter.SHOW_ELEMENT);let n,i=0;while((n=w.nextNode())&&i++<5000){if(n.children.length)continue;const t=(n.innerText||'').trim().slice(0,300);const c=t.match(/Monthly credits left\\s*([\\d.,\\s]+?)\\s*\\/\\s*([\\d,\\s]+\\d)|([\\d.,]+)\\s*credits left/i);if(c)return {balance:c[1]||c[3],total:c[2]||null};}return null})()`,
};

async function dedicatedProfile(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home) || typeof process.getuid !== 'function') return null;
  const homePath = path.resolve(home);
  const expected = path.join(homePath, '.cache', 'streamdock-ai', 'credits-browser');
  const root = path.parse(expected).root;
  const parts = expected.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  const identities = [];
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    if ((current === homePath || current.startsWith(homePath + path.sep)) &&
        (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)) return null;
    identities.push(`${stat.dev}:${stat.ino}:${stat.uid}`);
  }
  // Never resolve a configured profile into a different path.
  if (await fs.realpath(expected) !== expected) return null;
  return { path: expected, identity: identities.join('/') };
}

export async function identifyDedicatedChrome({ port, home = os.homedir(), execute = run } = {}) {
  if (!PORT(port)) return null;
  try {
    const profile = await dedicatedProfile(home);
    if (!profile) return null;
    const listener = await execute('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], { timeout: 2500, maxBuffer: 8192 });
    const lines = String(listener.stdout || '').trim().split(/\r?\n/);
    const ids = [...new Set(lines.filter(x => /^p\d+$/.test(x)).map(x => x.slice(1)))];
    const addresses = lines.filter(x => x.startsWith('n')).map(x => x.slice(1));
    if (ids.length !== 1 || !addresses.length || addresses.some(x => x !== `127.0.0.1:${port}` && x !== `[::1]:${port}`)) return null;
    const pid = ids[0];
    const info = await execute('/bin/ps', ['-p', pid, '-o', 'uid=,lstart=,comm='], { timeout: 2000, maxBuffer: 8192, env: { ...process.env, LC_ALL: 'C' } });
    const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/s.exec(String(info.stdout || ''));
    const allowedExecutables = new Set(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      '/Applications/Chromium.app/Contents/MacOS/Chromium']);
    if (!match || Number(match[1]) !== process.getuid() || !allowedExecutables.has(match[3])) return null;
    const args = await execute('/bin/ps', ['-p', pid, '-o', 'args='], { timeout: 2000, maxBuffer: 65536 });
    const text = String(args.stdout || '');
    const profileFlag = new RegExp(`(?:^|\\s)--user-data-dir(?:=|\\s+)["']?${escapeRegex(profile.path)}["']?(?=\\s|$)`);
    const portFlag = new RegExp(`(?:^|\\s)--remote-debugging-port(?:=|\\s+)${port}(?=\\s|$)`);
    if (!profileFlag.test(text) || !portFlag.test(text)) return null;
    return { pid, started: match[2], uid: Number(match[1]), executable: match[3], profile: profile.identity, port };
  } catch { return null; }
}

export async function verifyDedicatedChrome(options = {}) {
  return !!(await identifyDedicatedChrome(options));
}

async function readLimited(response) {
  if (!response.ok || !response.body) throw new Error('Unavailable');
  const reader = response.body.getReader();
  let total = 0; const parts = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 131072) throw new Error('Response too large');
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

async function tabsFor(port, fetchFn = fetch) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 3000);
  try { return await readLimited(await fetchFn(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal, redirect: 'error' })); }
  finally { clearTimeout(timeout); }
}

async function evaluate(port, id, expression, WebSocketCtor = WebSocket) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid tab');
  return new Promise((resolve, reject) => {
    let settled = false; const ws = new WebSocketCtor(`ws://127.0.0.1:${port}/devtools/page/${id}`);
    const timeout = setTimeout(() => finish(new Error('Timeout')), 4000);
    function finish(error, value) { if (settled) return; settled = true; clearTimeout(timeout); try { ws.close(); } catch {} error ? reject(error) : resolve(value); }
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, silent: true } })));
    ws.addEventListener('error', () => finish(new Error('Unavailable')));
    ws.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > 8192) return finish(new Error('Invalid response'));
      try { const result = JSON.parse(event.data); if (result.id !== 1) return; if (result.error || result.result?.exceptionDetails) return finish(new Error('Evaluation failed')); finish(null, result.result?.result?.value ?? null); } catch { finish(new Error('Invalid response')); }
    });
  });
}
const parseNumber = value => {
  if (typeof value !== 'string' || value.length > 40 || !/^[\d,\s.]+$/.test(value)) return null;
  const result = Number(value.replace(/[,\s]/g, ''));
  return Number.isFinite(result) && result >= 0 && result <= 1e15 ? result : null;
};

/** Explicit opt-in only. Does not launch Chrome, navigate, click or read credentials. */
export async function readBrowserCredit(id, setting, { home = os.homedir(), verify = identifyDedicatedChrome, listTabs = tabsFor, readTab = evaluate, now = Date.now() } = {}) {
  if (!TARGETS[id] || setting?.enabled !== true || setting.source !== 'cdp' || setting.dedicatedProfile !== true || !PORT(setting.port)) return null;
  try {
    const identity = await verify({ port: setting.port, home });
    if (!identity) return null;
    const sameIdentity = next => !!next && JSON.stringify(next) === JSON.stringify(identity);
    const tabs = await listTabs(setting.port);
    if (!Array.isArray(tabs)) return null;
    const matches = tabs.filter(tab => {
      if (tab?.type !== 'page' || typeof tab.id !== 'string' || typeof tab.url !== 'string') return false;
      try { return TARGETS[id](new URL(tab.url)); } catch { return false; }
    });
    if (matches.length !== 1 || !sameIdentity(await verify({ port: setting.port, home }))) return null;
    const result = await readTab(setting.port, matches[0].id, EXPRESSIONS[id]);
    if (!sameIdentity(await verify({ port: setting.port, home }))) return null;
    const balance = parseNumber(result?.balance), total = result?.total == null ? null : parseNumber(result.total);
    if (balance === null || (result?.total != null && total === null)) return null;
    const candidate = typeof result?.resetLabel === 'string' ? result.resetLabel.trim() : '';
    // Do not return arbitrary page text through the API. Keep only a short,
    // recognizable reset date/time with no names, credentials, or extra text.
    const korean = /^\d{1,2}월\s*\d{1,2}일(?:\s*(?:오전|오후)?\s*\d{1,2}:\d{2})?\s*에?\s*초기화$/;
    const english = /^Resets\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?$/i;
    const resetLabel = candidate.length <= 80 && (korean.test(candidate) || english.test(candidate)) ? candidate : null;
    return { balance, total, resetAt: null, resetLabel: resetLabel || null, resetQuality: resetLabel ? 'displayed-text' : null, tier: '', checkedAt: new Date(now).toISOString() };
  } catch { return null; }
}
