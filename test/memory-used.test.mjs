import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoryUsed, createMachineMonitor, readMachineStatus } from '../src/machines.mjs';

const sample = (pageSize, free, file) => `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)\nPages free: ${free}.\nFile-backed pages: ${file}.\n`;

test('physical memory estimate uses vm_stat page size and excludes free and file-backed pages', () => {
  assert.deepEqual(parseMemoryUsed(sample(4096, 20, 30), 409600), {
    usedBytes: 204800, totalBytes: 409600, usedPercent: 50, source: 'vm-stat-estimate',
  });
  assert.equal(parseMemoryUsed(sample(16384, 0, 0), 1638400).usedPercent, 100);
  assert.equal(parseMemoryUsed(sample(16384, 40, 60), 1638400).usedPercent, 0);
});

test('invalid or incomplete memory measurements are unavailable, never invented zero', () => {
  assert.equal(parseMemoryUsed('', 409600), null);
  assert.equal(parseMemoryUsed(sample(4096, 20, 100), 409600), null);
  assert.equal(parseMemoryUsed(sample(0, 1, 1), 409600), null);
  assert.equal(parseMemoryUsed(sample(4096, 1, 1), 0), null);
  assert.equal(parseMemoryUsed(sample(4096, -1, 1), 409600), null);
  assert.equal(parseMemoryUsed(sample(4096, 1, 1), Infinity), null);
  assert.equal(parseMemoryUsed(sample(4096, 1, 1), Number.MAX_SAFE_INTEGER + 1), null);
});

test('a memory-pressure value alone cannot make physical memory status complete', async () => {
  let tick = 0;
  const system = { hostname: () => 'test', totalmem: () => 409600,
    cpus: () => [{ times: { user: tick++ * 10, nice: 0, sys: 0, idle: tick * 10, irq: 0 } }], networkInterfaces: () => ({}) };
  const run = async file => {
    if (file === '/usr/bin/memory_pressure') return { stdout: 'System-wide memory free percentage: 45%' };
    if (file === '/bin/df') return { stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1000 500 500 50% /System/Volumes/Data\n' };
    if (file === '/usr/bin/pmset') return { stdout: 'No battery' };
    throw Error('unavailable');
  };
  const value = await readMachineStatus({ platform: 'darwin', system, run, useMole: false, readdir: async () => [], wait: async () => {} });
  assert.equal(value.memoryFreePercent, 45);
  assert.equal(value.memoryUsedPercent, null);
  assert.equal(value.status, 'partial');
});

test('machine monitor refreshes physical memory each second and preserves timestamp and stale state', async () => {
  let now = 0, reads = 0;
  const system = { hostname: () => 'test', totalmem: () => 409600,
    cpus: () => [{ times: { user: 10, nice: 0, sys: 10, idle: 80, irq: 0 } }], networkInterfaces: () => ({}) };
  const run = async file => {
    if (file === '/usr/bin/vm_stat') { reads++; return { stdout: sample(4096, reads === 1 ? 20 : 10, 30) }; }
    throw Error('unavailable');
  };
  const monitor = createMachineMonitor({ platform: 'darwin', system, run, useMole: false,
    statfs: async () => { throw Error('unavailable'); }, readdir: async () => [], wait: async () => {}, now: () => now });
  try {
    await monitor.read();
    await new Promise(resolve => setImmediate(resolve));
    now = 1000;
    await monitor.read();
    await new Promise(resolve => setImmediate(resolve));
    now = 1100;
    const current = await monitor.read();
    assert.equal(reads, 2);
    assert.equal(current.memoryUsedPercent, 60);
    assert.equal(current.memoryUsedBytes, 245760);
    assert.equal(current.memoryTotalBytes, 409600);
    assert.equal(current.memoryUsedSource, 'vm-stat-estimate');
    assert.equal(current.metricStatus.memoryUsedPercent, 'ok');
    assert.equal(current.metricUpdatedAt.memoryUsedPercent, new Date(1000).toISOString());
  } finally { await monitor.close(); }
});
