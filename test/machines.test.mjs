import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuPercentBetween, parseMemoryPressure, parseBattery, parseDiskUsage, readMachineStatus, readExternalDrives } from '../src/machines.mjs';

const times = (idle, user = 0, sys = 0) => [{ times: { idle, user, sys, nice: 0, irq: 0 } }];
test('CPU and battery parsing preserve missing values instead of inventing zero', () => {
  assert.equal(cpuPercentBetween(times(100), times(150, 30, 20)), 50);
  assert.equal(cpuPercentBetween(times(100), times(100)), null);
  assert.equal(cpuPercentBetween(times(100), []), null);
  assert.equal(parseMemoryPressure('System-wide memory free percentage: 57%'), 57);
  assert.equal(parseMemoryPressure('unavailable'), null);
  assert.deepEqual(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 100%; charged"), { present: true, percent: 100, power: 'ac' });
  assert.deepEqual(parseBattery("Now drawing from 'AC Power'"), { present: false, percent: null, power: null });
});

test('collects bounded local metrics and never reports network access from loopback', async () => {
  let sample = 0; const called = []; const timestamps = [1000, 9000];
  const system = { hostname: () => 'test', totalmem: () => 409600, cpus: () => sample++ ? times(150, 30, 20) : times(100), networkInterfaces: () => ({ lo0: [{ address: '127.0.0.1', internal: true }] }) };
  const run = async (file, args, options) => { called.push({ file, args, options });
    if (file === '/bin/df') return { stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1000 650 250 73% /System/Volumes/Data\n' };
    if (file.endsWith('/memory_pressure')) return { stdout: 'System-wide memory free percentage: 23%' };
    if (file.endsWith('/vm_stat')) return { stdout: 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 20.\nFile-backed pages: 30.\n' };
    if (file.endsWith('/pmset')) return { stdout: "Now drawing from 'Battery Power'\n -InternalBattery-0 77%; discharging" };
    if (file === 'mo') return { stdout: JSON.stringify({ health_score: 90, thermal: { cpu_temp: 62 }, top_processes: [{ name: 'PRIVATE' }] }) };
    throw new Error('unexpected command');
  };
  const value = await readMachineStatus({ platform: 'darwin', system, run, readdir: async () => [], wait: async () => {}, statfs: async () => ({ bsize: 10, blocks: 100, bavail: 30 }), now: () => timestamps.shift() });
  assert.equal(value.updatedAt, new Date(1000).toISOString());
  assert.equal(value.status, 'ok'); assert.equal(value.cpuPercent, 50); assert.equal(value.memoryFreePercent, 23); assert.equal(value.memoryUsedPercent, 50);
  // macOS df uses per-volume Used / (Used + Available), not container free blocks.
  assert.deepEqual(value.disk, { totalBytes: 1024000, availableBytes: 256000, usedPercent: 73 });
  assert.equal(value.battery.percent, 77); assert.equal(value.networkHasAddress, false);
  assert.equal(value.healthScore, 90); assert.equal(value.thermalC, 62);
  assert.ok(!JSON.stringify(value).includes('PRIVATE'));
  assert.deepEqual(called.map(x => x.file), ['/usr/bin/memory_pressure', '/bin/df', '/usr/bin/pmset', 'mo', '/usr/bin/vm_stat']);
  assert.ok(called.every(x => x.options.timeout <= 10000));
});

test('failed probes remain unknown and non-mac systems do not invoke programs', async () => {
  const system = { hostname: () => 'test', cpus: () => times(100), networkInterfaces: () => { throw Error('denied'); } };
  const run = async () => { throw Error('unavailable'); };
  const value = await readMachineStatus({ platform: 'darwin', system, run, readdir: async () => [], wait: async () => {}, statfs: async () => { throw Error('denied'); }, now: () => 1000 });
  assert.equal(value.status, 'unavailable'); assert.equal(value.cpuPercent, null); assert.equal(value.memoryFreePercent, null);
  assert.equal(value.disk, null); assert.equal(value.battery, null); assert.equal(value.healthScore, null); assert.equal(value.networkHasAddress, null);
  assert.equal((await readMachineStatus({ platform: 'linux', system, run: () => { throw Error('should not run'); }, now: () => 1000 })).status, 'unavailable');
});

test('df reports per-volume capacity and invalid output is unknown', () => {
  const header = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n';
  assert.deepEqual(parseDiskUsage(header + '/dev/disk3s5 3902665360 3543820112 333835112 92% /System/Volumes/Data'),
    { totalBytes: 3902665360 * 1024, availableBytes: 333835112 * 1024, usedPercent: 92 });
  assert.deepEqual(parseDiskUsage(header + '/dev/disk3s2 3902665360 9524032 333835112 3% /System/Volumes/Preboot'),
    { totalBytes: 3902665360 * 1024, availableBytes: 333835112 * 1024, usedPercent: 3 });
  assert.equal(parseDiskUsage(header + 'invalid data'), null);
  assert.equal(parseDiskUsage(header + '/dev/disk 1000 1 1 101% /Volumes/X'), null);
});

test('df failure keeps filesystem capacity unknown instead of guessing from shared APFS blocks', async () => {
  const result = await readExternalDrives({
    readdir: async () => ['External'],
    run: async file => { if (file === '/bin/df') throw Error('failed'); return { stdout: '<key>Internal</key><false/>' }; },
    statfs: async () => ({ bsize: 10, blocks: 100, bfree: 20, bavail: 20 }),
  });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.items, [{ name: 'External', totalBytes: 1000, availableBytes: 200, usedPercent: null }]);
});

test('external volumes report diskutil-confirmed drives without treating internal or unknown volumes as external', async () => {
  const calls = [];
  const result = await readExternalDrives({
    readdir: async () => ['Internal', 'External SSD', 'Missing'],
    run: async (file, args, options) => {
      calls.push({file, args, options});
      if (file === '/bin/df') return { stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk4s1 1000 500 300 63% /Volumes/External SSD\n' };
      if (args[2].endsWith('/Missing')) throw Error('unavailable');
      return {stdout: args[2].endsWith('/Internal') ? '<key>Internal</key><true/>' : '<key>Internal</key><false/>'};
    },
    statfs: async location => {
      assert.equal(location, '/Volumes/External SSD');
      return {bsize: 10, blocks: 100, bavail: 30};
    },
  });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.items, [{name:'External SSD', totalBytes:1024000, availableBytes:307200, usedPercent:63}]);
  assert.ok(calls.every(c => ['/usr/sbin/diskutil', '/bin/df'].includes(c.file) && c.options.timeout === 4000));
  assert.deepEqual(await readExternalDrives({readdir: async () => {throw Error('denied');}}), {status:'unavailable',items:[]});
});


test('machine monitor updates fast CPU without waiting for slow probes and does not overlap', async () => {
  const { createMachineMonitor } = await import('../src/machines.mjs');
  let releaseMole, releaseCpu;
  const moleWait = new Promise(resolve => { releaseMole = resolve; });
  const cpuWait = new Promise(resolve => { releaseCpu = resolve; });
  let samples = 0, moleCalls = 0, memoryCalls = 0;
  const system = { hostname: () => 'test', cpus: () => samples++ ? times(150, 30, 20) : times(100), networkInterfaces: () => ({}) };
  const run = async file => {
    if (file === 'mo') { moleCalls++; await moleWait; return { stdout: '{"health_score":90}' }; }
    if (file.endsWith('/memory_pressure')) { memoryCalls++; return { stdout: 'System-wide memory free percentage: 57%' }; }
    if (file.endsWith('/pmset')) return { stdout: '' };
    if (file === '/bin/df') return { stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1000 500 500 50% /System/Volumes/Data\n' };
    throw Error('unexpected');
  };
  const monitor = createMachineMonitor({ platform: 'darwin', system, run, readdir: async () => [], wait: () => cpuWait, now: () => 1000 });
  const a = monitor.read(), b = monitor.read();
  releaseCpu();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.cpuPercent, 50);
  assert.equal(second.cpuPercent, 50);
  assert.equal(samples, 2);
  assert.equal(moleCalls, 1);
  assert.equal(memoryCalls, 1);
  assert.equal(first.healthScore, null);
  releaseMole();
  await monitor.close();
});

test('machine monitor applies independent intervals and preserves measurement times', async () => {
  const { createMachineMonitor } = await import('../src/machines.mjs');
  let clock = 0, cpu = 0;
  const calls = { memory: 0, disk: 0, battery: 0, drives: 0, mole: 0 };
  const system = { hostname: () => 'test', cpus: () => times(100 + cpu++ * 50, cpu * 25), networkInterfaces: () => ({}) };
  const run = async file => {
    if (file.endsWith('/memory_pressure')) { calls.memory++; return { stdout: `System-wide memory free percentage: ${50 + calls.memory}%` }; }
    if (file.endsWith('/pmset')) { calls.battery++; return { stdout: '' }; }
    if (file === '/bin/df') { calls.disk++; return { stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1000 500 500 50% /System/Volumes/Data\n' }; }
    if (file === 'mo') { calls.mole++; return { stdout: '{"health_score":90}' }; }
    throw Error('unexpected');
  };
  const monitor = createMachineMonitor({ platform: 'darwin', system, run, readdir: async () => { calls.drives++; return []; }, wait: async () => {}, now: () => clock });
  let last;
  for (clock = 0; clock <= 5000; clock += 1000) {
    last = await monitor.read();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(calls.memory, 6);
  assert.equal(calls.disk, 2);
  assert.equal(calls.battery, 2);
  assert.equal(calls.drives, 1);
  assert.equal(calls.mole, 1);
  assert.equal(last.metricUpdatedAt.externalDrives, new Date(0).toISOString());
  assert.equal(last.updatedAt, new Date(0).toISOString());
  assert.equal(last.disk.usedPercent, 50);
  await monitor.close();
});

test('machine monitor clears expired screen state and rejects late prior-session results', async () => {
  const { createMachineMonitor } = await import('../src/machines.mjs');
  let clock = 0, sample = 0, releaseMemory, calls = 0;
  const firstMemory = new Promise(resolve => { releaseMemory = resolve; });
  const system = { hostname: () => 'test', cpus: () => times(100 + sample++ * 50, sample * 25), networkInterfaces: () => ({}) };
  const run = async file => {
    if (file.endsWith('/memory_pressure')) { calls++; if (calls === 1) return firstMemory; return { stdout: 'System-wide memory free percentage: 70%' }; }
    if (file.endsWith('/pmset')) return { stdout: '' };
    if (file === '/bin/df') return { stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1000 500 500 50% /System/Volumes/Data\n' };
    throw Error('unexpected');
  };
  const monitor = createMachineMonitor({ platform: 'darwin', system, run, useMole: false, readdir: async () => [], wait: async () => {}, now: () => clock });
  assert.equal((await monitor.read()).memoryFreePercent, null);
  await new Promise(resolve => setImmediate(resolve));
  clock = 5000;
  assert.equal((await monitor.read()).memoryFreePercent, null);
  releaseMemory({ stdout: 'System-wide memory free percentage: 20%' });
  await new Promise(resolve => setImmediate(resolve));
  clock = 6000;
  const result = await monitor.read();
  assert.notEqual(result.memoryFreePercent, 20);
  await new Promise(resolve => setImmediate(resolve));
  clock = 6500;
  assert.equal((await monitor.read()).memoryFreePercent, 70);
  await monitor.close();
});


test('machine monitor exposes stale values only during bounded refresh delay', async () => {
  const { createMachineMonitor } = await import('../src/machines.mjs');
  let clock = 0, sample = 0, releaseSlow, calls = 0;
  const delayed = new Promise(resolve => { releaseSlow = resolve; });
  const system = { hostname: () => 'test', cpus: () => times(100 + sample++ * 50, sample * 25), networkInterfaces: () => ({}) };
  const run = async file => {
    if (file.endsWith('/memory_pressure')) { calls++; return calls === 1 ? { stdout: 'System-wide memory free percentage: 55%' } : delayed; }
    if (file.endsWith('/pmset')) return { stdout: '' };
    if (file === '/bin/df') return { stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1000 500 500 50% /System/Volumes/Data\n' };
    throw Error('unexpected');
  };
  const monitor = createMachineMonitor({ platform: 'darwin', system, run, useMole: false, readdir: async () => [], wait: async () => {}, now: () => clock });
  await monitor.read();
  await new Promise(resolve => setImmediate(resolve));
  clock=1000; await monitor.read();
  await new Promise(resolve => setImmediate(resolve));
  clock=1500; let value = await monitor.read();
  assert.equal(value.memoryFreePercent,55);
  assert.equal(value.metricStatus.memoryFreePercent,'stale');
  assert.equal(value.metricUpdatedAt.memoryFreePercent,new Date(0).toISOString());
  for(clock=2500;clock<=5500;clock+=1000) value=await monitor.read();
  assert.equal(value.memoryFreePercent,null);
  assert.equal(value.metricStatus.memoryFreePercent,'unavailable');
  releaseSlow({ stdout: 'System-wide memory free percentage: 60%' });
  await monitor.close();
});

test('machine monitor invalidates old cached or in-flight values on screen exit', async () => {
  const { createMachineMonitor } = await import('../src/machines.mjs');
  let clock = 0, sample = 0, releaseMemory, calls = 0;
  const delayed = new Promise(resolve => { releaseMemory = resolve; });
  const system = { hostname: () => 'test', cpus: () => times(100 + sample++ * 50, sample * 25), networkInterfaces: () => ({}) };
  const run = async file => {
    if (file.endsWith('/memory_pressure')) { calls++; return calls === 1 ? delayed : { stdout: 'System-wide memory free percentage: 70%' }; }
    if (file.endsWith('/pmset')) return { stdout: '' };
    if (file === '/bin/df') return { stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1000 500 500 50% /System/Volumes/Data\n' };
    throw Error('unexpected');
  };
  const monitor = createMachineMonitor({ platform:'darwin', system, run, useMole:false, readdir:async()=>[], wait:async()=>{}, now:()=>clock });
  await monitor.read();
  await new Promise(resolve => setImmediate(resolve));
  monitor.invalidate();
  releaseMemory({ stdout:'System-wide memory free percentage: 10%' });
  await new Promise(resolve => setImmediate(resolve));
  clock=500;
  assert.notEqual((await monitor.read()).memoryFreePercent,10);
  await new Promise(resolve => setImmediate(resolve));
  clock=600;
  assert.equal((await monitor.read()).memoryFreePercent,70);
  await monitor.close();
});
