import os from 'node:os';
import { statfs as statFileSystem, readdir as readDirectory } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;

export function cpuPercentBetween(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second) || !first.length || first.length !== second.length) return null;
  let idle = 0, total = 0;
  for (let i = 0; i < first.length; i++) {
    const a = first[i]?.times, b = second[i]?.times;
    if (!a || !b) return null;
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq']) {
      const diff = b[key] - a[key];
      if (!Number.isFinite(diff) || diff < 0) return null;
      total += diff;
      if (key === 'idle') idle += diff;
    }
  }
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : null;
}

export function parseMemoryPressure(output) {
  const match = /System-wide memory free percentage:\s*(\d+(?:\.\d+)?)\s*%/i.exec(String(output));
  return match ? finite(Number(match[1]), 0, 100) : null;
}

export function parseBattery(output) {
  const text = String(output);
  const line = text.split('\n').find(item => /InternalBattery/i.test(item));
  if (!line) return { present: false, percent: null, power: null };
  const value = /(\d+(?:\.\d+)?)\s*%/.exec(line);
  const power = /AC Power/i.test(text) ? 'ac' : /Battery Power/i.test(text) ? 'battery' : null;
  return { present: true, percent: value ? finite(Number(value[1]), 0, 100) : null, power };
}

/** Local macOS metrics. No network probes, cleanup, sudo, or remote commands.
 * Null means the metric was unavailable, not zero. Mole health is optional. */
// Inspect only mounted local volumes. The command receives each path as a separate argument.
// On APFS, statfs exposes container-wide block counts instead of the per-volume
// usage shown by macOS df. Use df's Capacity column for the volume and fall
// back to unknown usage rather than inventing a per-volume percentage.
export function parseDiskUsage(output) {
  const rows = String(output || '').trim().split(/\r?\n/).slice(1);
  if (rows.length !== 1) return null;
  const match = /^.+?\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+.+$/.exec(rows[0]);
  if (!match) return null;
  const [, size, used, available, capacity] = match.map(Number);
  if (![size, used, available, capacity, size * 1024, available * 1024, used + available].every(Number.isSafeInteger) ||
      size <= 0 || used + available <= 0 || capacity > 100 ||
      Math.abs(capacity - Math.ceil(100 * used / (used + available))) > 1) return null;
  return { totalBytes: size * 1024, availableBytes: available * 1024, usedPercent: capacity };
}

async function readDiskUsage(location, run, statfs) {
  try {
    const { stdout } = await run('/bin/df', ['-Pk', location], { timeout: 4000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' } });
    const result = parseDiskUsage(stdout);
    if (result) return result;
  } catch { /* A failed df leaves the percentage unknown. */ }
  try {
    const d = await statfs(location);
    const size = Number(d?.bsize), blocks = Number(d?.blocks), available = Number(d?.bavail);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(blocks) || blocks <= 0 ||
        !Number.isFinite(available) || available < 0 || available > blocks) return null;
    return { totalBytes: blocks * size, availableBytes: available * size, usedPercent: null };
  } catch { return null; }
}

export async function readExternalDrives({ readdir = readDirectory, run = execFileAsync, statfs = statFileSystem } = {}) {
  let entries;
  try { entries = await readdir('/Volumes'); } catch { return { status: 'unavailable', items: [] }; }
  if (!Array.isArray(entries)) return { status: 'unavailable', items: [] };
  const candidates = entries.filter(name => typeof name === 'string' && name.length > 0 && name.length <= 255 &&
    !name.startsWith('.') && !/[\\/\x00-\x1f\x7f]/.test(name)).sort();
  const results = await Promise.all(candidates.slice(0, 16).map(async name => {
    const location = path.join('/Volumes', name);
    try {
      const { stdout } = await run('/usr/sbin/diskutil', ['info', '-plist', location], { timeout: 4000, maxBuffer: 256 * 1024 });
      // Ignore volumes that diskutil cannot positively identify as external.
      if (!/<key>Internal<\/key>\s*<false\s*\/>/.test(stdout)) return { item: null };
      const disk = await readDiskUsage(location, run, statfs);
      if (!disk) return { item: { name, totalBytes: null, availableBytes: null, usedPercent: null }, failed: true };
      return { item: { name, ...disk }, failed: disk.usedPercent === null };
    } catch { return { item: null, failed: true }; }
  }));
  return { status: results.some(r => r.failed) || candidates.length > 16 ? 'partial' : 'ok',
    items: results.flatMap(r => r.item ? [r.item] : []) };
}

// Activity Monitor does not publish its exact algorithm. On macOS, vm_stat's
// displayed free pages exclude speculative pages; subtract those plus the
// file-backed cache from physical RAM to estimate its Memory Used reading.
export function parseMemoryUsed(stdout, totalBytes) {
  if (typeof stdout !== 'string' || typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) return null;
  const page = /page size of\s+(\d+)\s+bytes/i.exec(stdout);
  const free = /^Pages free:\s*(\d+)\./mi.exec(stdout);
  const file = /^File-backed pages:\s*(\d+)\./mi.exec(stdout);
  if (!page || !free || !file) return null;
  const [pageSize, freePages, filePages] = [Number(page[1]), Number(free[1]), Number(file[1])];
  if (![pageSize, freePages, filePages].every(Number.isSafeInteger) || pageSize <= 0 || freePages < 0 || filePages < 0) return null;
  const availableBytes = (freePages + filePages) * pageSize;
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0 || availableBytes > totalBytes) return null;
  const usedBytes = totalBytes - availableBytes;
  return { usedBytes, totalBytes, usedPercent: usedBytes * 100 / totalBytes, source: 'vm-stat-estimate' };
}

export async function readMachineStatus({ platform = process.platform, system = os, run = execFileAsync,
  statfs = statFileSystem, readdir = readDirectory, wait = delay, now = Date.now, useMole = true } = {}) {
  const base = { name: system.hostname(), platform, status: 'unavailable', updatedAt: new Date(now()).toISOString(),
    cpuPercent: null, memoryFreePercent: null, memoryUsedPercent: null, memoryUsedBytes: null, memoryTotalBytes: null, memoryUsedSource: null, disk: null, battery: null,
    networkHasAddress: null, thermalC: null, healthScore: null, healthSource: null, externalDrives: null };
  if (platform !== 'darwin') return base;
  const commands = [
    (async () => { const first = system.cpus(); await wait(250); return cpuPercentBetween(first, system.cpus()); })(),
    run('/usr/bin/memory_pressure', [], { timeout: 4_000, maxBuffer: 64 * 1024 }).then(r => parseMemoryPressure(r.stdout)),
    readDiskUsage('/System/Volumes/Data', run, statfs),
    run('/usr/bin/pmset', ['-g', 'batt'], { timeout: 4_000, maxBuffer: 64 * 1024 }).then(r => parseBattery(r.stdout)),
    readExternalDrives({ readdir, run, statfs }),
    useMole ? run('mo', ['status', '--json'], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }).then(r => {
      const value = JSON.parse(r.stdout);
      return { score: finite(value?.health_score, 0, 100), thermal: finite(value?.thermal?.cpu_temp, 1, 150) };
    }) : Promise.resolve(null),
  ];
  commands.push(Promise.resolve().then(async () => parseMemoryUsed((await run('/usr/bin/vm_stat', [], { timeout: 4_000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout, system.totalmem())));
  const [cpu, memory, disk, battery, drives, mole, memoryUsed] = await Promise.allSettled(commands);
  const value = item => item.status === 'fulfilled' ? item.value : null;
  base.cpuPercent = value(cpu);
  base.memoryFreePercent = value(memory);
  const used = value(memoryUsed);
  base.memoryUsedPercent = used?.usedPercent ?? null;
  base.memoryUsedBytes = used?.usedBytes ?? null;
  base.memoryTotalBytes = used?.totalBytes ?? null;
  base.memoryUsedSource = used?.source ?? null;
  base.disk = value(disk);
  base.battery = value(battery);
  base.externalDrives = value(drives);
  const m = value(mole);
  base.healthScore = m?.score ?? null;
  base.healthSource = base.healthScore === null ? null : 'Mole';
  base.thermalC = m?.thermal ?? null;
  try {
    const addresses = Object.values(system.networkInterfaces()).flat().filter(Boolean);
    base.networkHasAddress = addresses.some(a => !a.internal && !!a.address);
  } catch { /* Keep unknown. */ }
  const known = [base.cpuPercent, base.memoryUsedPercent, base.disk, base.battery, base.networkHasAddress].filter(v => v !== null).length;
  base.status = known === 0 ? 'unavailable' : known === 5 ? 'ok' : 'partial';
  // The probes can take seconds; the earliest sample must not appear newer
  // than it is just because a separate probe finished later.
  return base;
}

/** Refresh CPU promptly while collecting slower local probes independently. */
export function createMachineMonitor({ platform = process.platform, system = os, run = execFileAsync,
  statfs = statFileSystem, readdir = readDirectory, wait = delay, now = Date.now, useMole = true } = {}) {
  const cache = new Map();
  const pending = new Map();
  const intervals = { memory: 1000, memoryUsed: 1000, disk: 5000, battery: 5000, network: 5000, drives: 15000, mole: 60000 };
  const grace = { memory: 4000, memoryUsed: 4000, disk: 4000, battery: 4000, network: 1000, drives: 8000, mole: 10000 };
  let epoch = 0;
  let lastReadAt = null;
  let previousCpuSample = null;
  let previousCpuAt = null;
  let reading;
  let closed = false;
  function schedule(name, operation, current) {
    const previous = cache.get(name);
    if (pending.has(name) || (previous && current >= previous.startedAt && current - previous.startedAt < intervals[name])) return;
    const expectedEpoch = epoch;
    const promise = Promise.resolve().then(operation)
      .then(value => ({ value: value ?? null }), () => ({ value: null }))
      .then(({ value }) => { if (!closed && epoch === expectedEpoch) cache.set(name, { value, startedAt: current }); })
      .finally(() => { if (pending.get(name) === promise) pending.delete(name); });
    pending.set(name, promise);
  }
  function cached(name, current) {
    const entry = cache.get(name);
    if (!entry || current < entry.startedAt || current - entry.startedAt > intervals[name] + grace[name]) return null;
    return entry.value;
  }
  function status(name, current) {
    const entry = cache.get(name);
    if (cached(name, current) === null || !entry) return 'unavailable';
    return current - entry.startedAt > intervals[name] ? 'stale' : 'ok';
  }
  function stamp(name, current) {
    const entry = cache.get(name);
    return cached(name, current) === null || !entry ? null : new Date(entry.startedAt).toISOString();
  }
  async function collect() {
    if (closed) throw new Error('Machine monitor is closed');
    const startedAt = now();
    // Do not present the last screen's old data as current after returning.
    if (lastReadAt !== null && (startedAt < lastReadAt || startedAt - lastReadAt > 3000)) {
      epoch++;
      cache.clear();
      previousCpuSample = null;
      previousCpuAt = null;
    }
    lastReadAt = startedAt;
    const base = { name: system.hostname(), platform, status: 'unavailable', updatedAt: new Date(startedAt).toISOString(),
      cpuPercent: null, memoryFreePercent: null, memoryUsedPercent: null, memoryUsedBytes: null, memoryTotalBytes: null, memoryUsedSource: null, disk: null, battery: null,
      networkHasAddress: null, thermalC: null, healthScore: null, healthSource: null, externalDrives: null,
      metricUpdatedAt: {}, metricStatus: {} };
    if (platform !== 'darwin') return base;
    schedule('memory', async () => parseMemoryPressure((await run('/usr/bin/memory_pressure', [], { timeout: 4000, maxBuffer: 64 * 1024 })).stdout), startedAt);
    schedule('memoryUsed', async () => parseMemoryUsed((await run('/usr/bin/vm_stat', [], { timeout: 4000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout, system.totalmem()), startedAt);
    schedule('disk', () => readDiskUsage('/System/Volumes/Data', run, statfs), startedAt);
    schedule('battery', async () => parseBattery((await run('/usr/bin/pmset', ['-g', 'batt'], { timeout: 4000, maxBuffer: 64 * 1024 })).stdout), startedAt);
    schedule('network', () => Object.values(system.networkInterfaces()).flat().filter(Boolean).some(a => !a.internal && !!a.address), startedAt);
    schedule('drives', () => readExternalDrives({ readdir, run, statfs }), startedAt);
    if (useMole) schedule('mole', async () => {
      const value = JSON.parse((await run('mo', ['status', '--json'], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 })).stdout);
      return { score: finite(value?.health_score, 0, 100), thermal: finite(value?.thermal?.cpu_temp, 1, 150) };
    }, startedAt);
    const sampleEpoch = epoch;
    try {
      const first = system.cpus();
      // Keep the initial 250ms sample for the first reading and allow fast
      // background probes to finish. Later readings cover the full interval
      // since the previous reading, rather than discarding the intervening CPU time.
      await wait(250);
      const second = system.cpus();
      const sampleAt = now();
      if (!closed && sampleEpoch === epoch) {
        const span = previousCpuAt === null ? 0 : sampleAt - previousCpuAt;
        const baseline = previousCpuSample && span > 0 && span <= 3000 ? previousCpuSample : first;
        base.cpuPercent = cpuPercentBetween(baseline, second);
        previousCpuSample = second;
        previousCpuAt = sampleAt;
      }
    } catch {
      previousCpuSample = null;
      previousCpuAt = null;
      // Keep CPU unknown if sampling fails.
    }
    const observedAt = now();
    base.memoryFreePercent = cached('memory', observedAt);
    const memoryUsed = cached('memoryUsed', observedAt);
    base.memoryUsedPercent = memoryUsed?.usedPercent ?? null;
    base.memoryUsedBytes = memoryUsed?.usedBytes ?? null;
    base.memoryTotalBytes = memoryUsed?.totalBytes ?? null;
    base.memoryUsedSource = memoryUsed?.source ?? null;
    base.disk = cached('disk', observedAt);
    base.battery = cached('battery', observedAt);
    base.networkHasAddress = cached('network', observedAt);
    base.externalDrives = cached('drives', observedAt);
    const mole = cached('mole', observedAt);
    base.healthScore = mole?.score ?? null;
    base.healthSource = base.healthScore === null ? null : 'Mole';
    base.thermalC = mole?.thermal ?? null;
    const fields = { cpuPercent: base.cpuPercent === null ? null : new Date(observedAt).toISOString(),
      memoryFreePercent: stamp('memory', observedAt), memoryUsedPercent: stamp('memoryUsed', observedAt), disk: stamp('disk', observedAt),
      battery: stamp('battery', observedAt), networkHasAddress: stamp('network', observedAt),
      externalDrives: stamp('drives', observedAt), healthScore: base.healthScore === null ? null : stamp('mole', observedAt),
      thermalC: base.thermalC === null ? null : stamp('mole', observedAt) };
    base.metricUpdatedAt = fields;
    base.metricStatus = { cpuPercent: base.cpuPercent === null ? 'unavailable' : 'ok',
      memoryFreePercent: status('memory', observedAt), memoryUsedPercent: status('memoryUsed', observedAt), disk: status('disk', observedAt),
      battery: status('battery', observedAt), networkHasAddress: status('network', observedAt),
      externalDrives: status('drives', observedAt), healthScore: base.healthScore === null ? 'unavailable' : status('mole', observedAt),
      thermalC: base.thermalC === null ? 'unavailable' : status('mole', observedAt) };
    const timestamps = Object.values(fields).filter(Boolean).sort();
    if (timestamps.length) base.updatedAt = timestamps[0];
    const known = [base.cpuPercent, base.memoryUsedPercent, base.disk, base.battery, base.networkHasAddress].filter(v => v !== null).length;
    base.status = known === 0 ? 'unavailable' : known === 5 ? 'ok' : 'partial';
    return base;
  }
  return {
    read() {
      if (closed) return Promise.reject(new Error('Machine monitor is closed'));
      if (reading) return reading;
      reading = collect().finally(() => { reading = undefined; });
      return reading;
    },
    invalidate() {
      epoch++;
      cache.clear();
      lastReadAt = null;
      previousCpuSample = null;
      previousCpuAt = null;
    },
    async close() {
      closed = true;
      epoch++;
      await Promise.allSettled([...(reading ? [reading] : []), ...pending.values()]);
    },
  };
}
