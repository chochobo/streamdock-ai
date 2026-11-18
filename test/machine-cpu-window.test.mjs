import test from 'node:test';
import assert from 'node:assert/strict';
import { createMachineMonitor } from '../src/machines.mjs';

function harness() {
  let clock = 1000;
  let user = 0;
  let idle = 0;
  const system = {
    hostname: () => 'test',
    cpus: () => [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }],
    networkInterfaces: () => ({}),
  };
  const monitor = createMachineMonitor({
    platform: 'darwin', system, useMole: false,
    now: () => clock,
    wait: async ms => { clock += ms; idle += ms; },
    run: async () => { throw new Error('unavailable'); },
    statfs: async () => { throw new Error('unavailable'); },
    readdir: async () => [],
  });
  return {
    monitor,
    busy(ms) { clock += ms; user += ms; },
  };
}

test('CPU uses the full interval between refreshes, including time outside the last 250ms', async () => {
  const { monitor, busy } = harness();
  try {
    assert.equal((await monitor.read()).cpuPercent, 0);
    busy(750);
    assert.equal((await monitor.read()).cpuPercent, 75);
  } finally { await monitor.close(); }
});

test('CPU discards the prior sample when the machine screen is invalidated', async () => {
  const { monitor, busy } = harness();
  try {
    assert.equal((await monitor.read()).cpuPercent, 0);
    busy(750);
    monitor.invalidate();
    assert.equal((await monitor.read()).cpuPercent, 0);
  } finally { await monitor.close(); }
});

test('CPU discards old counters after the monitor has been idle for over three seconds', async () => {
  const { monitor, busy } = harness();
  try {
    assert.equal((await monitor.read()).cpuPercent, 0);
    busy(3500);
    assert.equal((await monitor.read()).cpuPercent, 0);
  } finally { await monitor.close(); }
});
