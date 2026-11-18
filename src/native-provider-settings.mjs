import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

// These are settings for local, explicitly selected providers. This module never
// contacts a provider. The caller must authenticate and expose read() only when
// the user opens the corresponding settings screen: some fields are private.
const KINDS = new Set(['market', 'parcels', 'remote', 'credits']);
const MAX_BYTES = 256 * 1024;
const HOST = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/;
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const cleanText = (v, max) => typeof v === 'string' && v.trim() === v && v.length > 0 && Array.from(v).length <= max && !/[\p{Cc}\p{Cf}]/u.test(v);
const keysAllowed = (o, keys) => isObject(o) && Object.keys(o).every(k => keys.includes(k));
const unique = values => new Set(values).size === values.length;

function project(kind, raw) {
  if (!isObject(raw)) throw Error('invalid');
  if (kind === 'market') {
    const portfolio = raw.portfolio ?? [], favoriteSectors = raw.favoriteSectors ?? [];
    if (!Array.isArray(portfolio) || !Array.isArray(favoriteSectors) || portfolio.length > 10 || favoriteSectors.length > 10 ||
        portfolio.some(x => typeof x !== 'string' || !/^[A-Za-z0-9.\-]{1,16}$/.test(x)) ||
        favoriteSectors.some(x => typeof x !== 'string' || !x.trim() || Array.from(x).length > 50 || /[\p{Cc}\p{Cf}]/u.test(x))) throw Error('invalid');
    return { portfolio: [...new Set(portfolio)], favoriteSectors: [...new Set(favoriteSectors.map(x => x.trim()))] };
  }
  if (kind === 'parcels') {
    const parcels = raw.parcels;
    if (!Array.isArray(parcels) || parcels.length > 50 || (raw.trackingOptIn !== undefined && typeof raw.trackingOptIn !== 'boolean')) throw Error('invalid');
    const result = parcels.map(p => {
      const tracking = typeof p?.tracking === 'string' ? p.tracking.replace(/\s/g, '').toUpperCase() : '';
      if (!isObject(p) || !/^[A-Z0-9-]{5,60}$/.test(tracking) || (p.title !== undefined && typeof p.title !== 'string')) throw Error('invalid');
      const title = typeof p.title === 'string' ? Array.from(p.title.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()).slice(0, 80).join('') : '';
      return { tracking, title: title || '택배' };
    });
    if (!unique(result.map(p => p.tracking))) throw Error('invalid');
    return { trackingOptIn: raw.trackingOptIn === true, parcels: result };
  }
  if (kind === 'remote') {
    const hosts = raw.hosts ?? [];
    if (!Array.isArray(hosts) || hosts.length > 8 || (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')) throw Error('invalid');
    const result = hosts.map(h => {
      const port = h?.port ?? 22;
      if (!isObject(h) || !cleanText(h.label, 50) || typeof h.ssh !== 'string' || !HOST.test(h.ssh) || h.ssh.includes('..') ||
          !Number.isInteger(port) || port < 1 || port > 65535 || !Array.isArray(h.operations) ||
          h.operations.some(op => !['machine', 'agents', 'agy'].includes(op)) || !unique(h.operations)) throw Error('invalid');
      return { label: h.label, ssh: h.ssh, port, operations: h.operations };
    });
    if (!unique(result.map(h => `${h.ssh}\0${h.port}\0${h.label}`))) throw Error('invalid');
    return { enabled: raw.enabled === true, hosts: result };
  }
  if (kind === 'credits') {
    if (raw.sources !== undefined && !isObject(raw.sources)) throw Error('invalid');
    const sources = {};
    for (const id of ['flow', 'higgsfield']) {
      const v = raw.sources?.[id] ?? { enabled: false, source: 'agentdeck-cache' };
      if (!isObject(v) || (v.enabled !== undefined && typeof v.enabled !== 'boolean') || (v.source !== undefined && !['agentdeck-cache', 'snapshot', 'cdp'].includes(v.source))) throw Error('invalid');
      const entry = { enabled: v.enabled === true, source: v.source ?? 'agentdeck-cache' };
      if (v.dedicatedProfile !== undefined) { if (typeof v.dedicatedProfile !== 'boolean') throw Error('invalid'); entry.dedicatedProfile = v.dedicatedProfile; }
      if (v.port !== undefined) { if (!Number.isInteger(v.port) || v.port < 1024 || v.port > 65535) throw Error('invalid'); entry.port = v.port; }
      if (entry.enabled && entry.source === 'cdp' && (entry.dedicatedProfile !== true || !entry.port)) throw Error('invalid');
      sources[id] = entry;
    }
    return { sources };
  }
  throw Error('invalid');
}

function merge(kind, raw, patch, idForRow) {
  const fields = kind === 'market' ? ['portfolio', 'favoriteSectors'] : kind === 'parcels' ? ['trackingOptIn', 'parcels', 'deletedRowIds'] : kind === 'remote' ? ['enabled', 'hosts', 'deletedRowIds'] : ['sources'];
  if (!keysAllowed(patch, fields) || !Object.keys(patch).length) throw Error('invalid');
  const listKey = kind === 'parcels' ? 'parcels' : kind === 'remote' ? 'hosts' : null;
  if (Object.hasOwn(patch, 'deletedRowIds') && (!listKey || !Object.hasOwn(patch, listKey))) throw Error('invalid');
  const next = { ...raw };
  for (const [key, val] of Object.entries(patch)) {
    if (key === 'deletedRowIds') continue;
    if (kind === 'credits' && key === 'sources') {
      if (!keysAllowed(val, ['flow', 'higgsfield']) || !Object.keys(val).length) throw Error('invalid');
      next.sources = { ...(raw.sources || {}) };
      for (const [id, source] of Object.entries(val)) {
        if (!keysAllowed(source, ['enabled', 'source', 'dedicatedProfile', 'port']) || !Object.keys(source).length) throw Error('invalid');
        next.sources[id] = { enabled: false, source: 'agentdeck-cache', ...(raw.sources?.[id] || {}), ...source };
      }
    } else if (key === listKey) {
      if (!Array.isArray(val)) throw Error('invalid');
      const fields = kind === 'parcels' ? ['tracking', 'title'] : ['label', 'ssh', 'port', 'operations'];
      if (val.some(row => !keysAllowed(row, [...fields, 'rowId']))) throw Error('invalid');
      const originals = Array.isArray(raw[key]) ? raw[key] : [];
      const byId = new Map(originals.map((row, index) => [idForRow(index), row]));
      const deleted = patch.deletedRowIds ?? [];
      if (!Array.isArray(deleted) || deleted.some(id => typeof id !== 'string' || !byId.has(id)) || !unique(deleted)) throw Error('invalid');
      const removed = new Set(deleted), retained = new Set();
      next[key] = val.map(row => {
        const id = row.rowId ?? null;
        const clean = Object.fromEntries(Object.entries(row).filter(([name]) => name !== 'rowId'));
        if (kind === 'parcels' && (typeof clean.tracking !== 'string' || !/^[A-Z0-9-]{5,60}$/.test(clean.tracking) || !cleanText(clean.title, 80))) throw Error('invalid');
        if (id === null) return clean;
        if (typeof id !== 'string' || !byId.has(id) || retained.has(id) || removed.has(id)) throw Error('invalid');
        retained.add(id);
        const old = byId.get(id);
        const hidden = Object.keys(old).some(name => !fields.includes(name));
        const oldTracking = typeof old.tracking === 'string' ? old.tracking.replace(/\s/g, '').toUpperCase() : '';
        const changedIdentity = kind === 'parcels' ? oldTracking !== clean.tracking : old.ssh !== clean.ssh || (old.port ?? 22) !== (clean.port ?? 22);
        if (hidden && changedIdentity) throw Error('identity_changed');
        return { ...old, ...clean };
      });
      for (const id of byId.keys()) if (!retained.has(id) && !removed.has(id)) throw Error('rows_changed');
    } else next[key] = val;
  }
  if (kind === 'remote' && next.enabled === true && next.hosts === undefined) next.hosts = [];
  project(kind, next);
  return next;
}

export function createNativeProviderSettings({ home = os.homedir() } = {}) {
  const directory = path.join(home, '.config', 'streamdock-ai');
  const secret = randomBytes(32);
  const revisions = (kind, contents) => createHmac('sha256', secret).update(kind).update('\0').update(contents).digest('hex');
  // A row ID belongs to one file revision and reveals no host or tracking number.
  const rowId = (kind, revision, index) => createHmac('sha256', secret).update('row\0').update(kind).update('\0').update(revision).update('\0').update(String(index)).digest('hex').slice(0, 32);
  const publicConfig = (kind, config, revision) => {
    const key = kind === 'parcels' ? 'parcels' : kind === 'remote' ? 'hosts' : null;
    return key ? { ...config, [key]: config[key].map((row, index) => ({ ...row, rowId: rowId(kind, revision, index) })) } : config;
  };
  let operations = Promise.resolve();
  async function checkDirectory(create) {
    const records = [];
    for (const folder of [path.join(home, '.config'), directory]) {
      let info;
      try { info = await fs.lstat(folder); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) return null;
        try { await fs.mkdir(folder, { mode: 0o700 }); }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
        info = await fs.lstat(folder);
      }
      if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw Error('invalid directory');
      records.push([info.dev, info.ino]);
    }
    return JSON.stringify(records);
  }
  async function load(kind) {
    if (!KINDS.has(kind)) throw Error('invalid');
    let handle;
    try {
      if (!await checkDirectory(false)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      handle = await fs.open(path.join(directory, `${kind}.json`), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw Error('invalid');
      const contents = await handle.readFile('utf8');
      if (Buffer.byteLength(contents) > MAX_BYTES) throw Error('invalid');
      const raw = JSON.parse(contents);
      return { status: 'ok', raw, config: project(kind, raw), revision: revisions(kind, contents) };
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
      const raw = kind === 'market' ? { portfolio: [], favoriteSectors: [] } : kind === 'parcels' ? { trackingOptIn: false, parcels: [] } : kind === 'remote' ? { enabled: false, hosts: [] } : { sources: {} };
      return { status: 'unconfigured', raw, config: project(kind, raw), revision: revisions(kind, '<missing>') };
    } finally { await handle?.close().catch(() => {}); }
  }
  return {
    async read(kind) {
      try { const { status, config, revision } = await load(kind); return { status, config: publicConfig(kind, config, revision), revision }; }
      catch { return { status: 'unavailable', config: null, revision: null }; }
    },
    update(kind, { revision, patch } = {}) {
      const task = operations.then(async () => {
        if (!KINDS.has(kind) || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) return { ok: false, code: 'invalid' };
        let current, next;
        try { current = await load(kind); if (current.revision !== revision) return { ok: false, code: 'changed' }; next = merge(kind, current.raw, patch, index => rowId(kind, revision, index)); }
        catch (error) { return { ok: false, code: ['identity_changed', 'rows_changed'].includes(error?.message) ? error.message : 'invalid' }; }
        const contents = `${JSON.stringify(next, null, 2)}\n`;
        if (Buffer.byteLength(contents) > MAX_BYTES) return { ok: false, code: 'invalid' };
        let temp;
        try {
          const identity = await checkDirectory(true);
          temp = path.join(directory, `.${kind}-${randomBytes(12).toString('hex')}.tmp`);
          await fs.writeFile(temp, contents, { mode: 0o600, flag: 'wx' });
          if ((await load(kind)).revision !== revision || await checkDirectory(false) !== identity) return { ok: false, code: 'changed' };
          await fs.rename(temp, path.join(directory, `${kind}.json`)); temp = null;
          const result = await load(kind);
          return { ok: true, status: result.status, revision: result.revision, config: publicConfig(kind, result.config, result.revision) };
        } catch { return { ok: false, code: 'unavailable' }; }
        finally { if (temp) await fs.unlink(temp).catch(() => {}); }
      });
      operations = task.catch(() => {});
      return task;
    },
  };
}
