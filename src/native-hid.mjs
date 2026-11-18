import { spawn as defaultSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createDevice } from './device.mjs';

const IDS = [13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3];

/** node-hid compatible HID transport for the Swift helper; does not open a device until devicesAsync(). */
export function createSwiftHID({ executable, args = [], spawn = defaultSpawn, timeoutMs = 5000, allowSimulation = false } = {}) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || !Array.isArray(args) || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000) throw new TypeError('Invalid Swift HID helper configuration');
  let child, childClosed, active, readyPromise, readyResolve, readyReject, readyTimer, buffer = '', nextId = 1, closing = false, failed = false;
  const pending = new Map();
  function rejectPending(error) {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  }
  function fail(error) {
    if (failed || closing) return;
    failed = true;
    clearTimeout(readyTimer);
    readyReject?.(error);
    rejectPending(error);
    if (active?.listenerCount('error')) active.emit('error', error);
    child?.kill();
  }
  function message(value) {
    if (!value || typeof value !== 'object') return fail(new Error('Invalid Swift HID response'));
    if (value.event === 'ready') {
      if (typeof value.simulated !== 'boolean' || (value.simulated && !allowSimulation)) return fail(new Error('Swift HID simulator cannot represent a hardware connection'));
      clearTimeout(readyTimer); readyResolve?.(); return;
    }
    if (value.event === 'device-ack') { active?.emit('deviceAck'); return; }
    if (value.event === 'error') return fail(new Error(typeof value.message === 'string' ? value.message.slice(0, 256) : 'Swift HID error'));
    if (value.event === 'key') {
      if (!Number.isInteger(value.index) || value.index < 0 || value.index >= IDS.length || typeof value.pressed !== 'boolean') return fail(new Error('Invalid Swift HID key event'));
      const event = Buffer.from([0x41, 0x43, 0x4b, 0, 0, 0x4f, 0x4b, 0, 0, IDS[value.index], value.pressed ? 1 : 0]);
      active?.emit('data', event);
      return;
    }
    if (!Number.isSafeInteger(value.id) || typeof value.ok !== 'boolean') return fail(new Error('Invalid Swift HID acknowledgement'));
    const request = pending.get(value.id);
    if (!request) return fail(new Error('Unexpected Swift HID acknowledgement'));
    pending.delete(value.id); clearTimeout(request.timer);
    if (value.ok) request.resolve(1025);
    else { request.reject(new Error(typeof value.message === 'string' ? value.message.slice(0, 256) : 'Swift HID write failed')); fail(new Error('Swift HID write failed')); }
  }
  function launch() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    try { child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); }
    catch (error) { fail(error); return readyPromise; }
    childClosed = new Promise(resolve => child.once('close', resolve));
    readyTimer = setTimeout(() => fail(new Error('Swift HID startup timed out')), timeoutMs); readyTimer.unref?.();
    child.on('error', fail);
    child.on('exit', () => { if (!closing) fail(new Error('Swift HID helper exited')); });
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        if (end > 16384) return fail(new Error('Swift HID response too large'));
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { message(JSON.parse(line)); } catch { fail(new Error('Invalid Swift HID JSON')); return; }
      }
      if (buffer.length > 16384) fail(new Error('Swift HID response too large'));
    });
    return readyPromise;
  }
  class HID extends EventEmitter {
    constructor(devicePath) {
      super();
      if (devicePath !== 'swift-293sv3' || active || !child || failed || closing) throw new Error('Swift HID is unavailable');
      active = this;
    }
    writePacket(packet) {
      if (closing || failed || active !== this || !Buffer.isBuffer(packet) || packet.length !== 1025 || packet[0] !== 0) return Promise.reject(new Error('Invalid or disconnected Swift HID write'));
      if (pending.size >= 32) return Promise.reject(new Error('Swift HID queue is full'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error('Swift HID write timed out')), timeoutMs); timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, packet: packet.toString('base64') }) + '\n', error => { if (error) fail(error); });
      });
    }
    close() {
      if (closing) return;
      closing = true;
      clearTimeout(readyTimer);
      rejectPending(new Error('Swift HID closed'));
      active = undefined;
      child?.stdin.end();
      const processToStop = child;
      const timer = setTimeout(() => processToStop?.kill('SIGTERM'), 1000); timer.unref?.();
      child?.once('exit', () => clearTimeout(timer));
    }
  }
  return {
    async devicesAsync() { await launch(); if (failed || closing) throw new Error('Swift HID unavailable'); return [{ vendorId: 0x6603, productId: 0x1014, usagePage: 0xff00, usage: 1, path: 'swift-293sv3' }]; },
    async waitClosed() {
      if (!childClosed) return;
      let timer;
      try {
        await Promise.race([childClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Previous Swift HID helper is still running')), 2500); })]);
      } finally { clearTimeout(timer); }
    },
    HID,
  };
}

export function createNativeDevice({ helperPath, helperArgs = [], helperTimeoutMs, helperAllowSimulation = false, dependencies = {}, ...options } = {}) {
  const config = { executable: helperPath, args: helperArgs, timeoutMs: helperTimeoutMs, allowSimulation: helperAllowSimulation };
  let current, opening;
  const hid = {
    async devicesAsync() {
      if (opening) return opening;
      opening = (async () => {
        // The old helper must close its device before a replacement can open it.
        if (current) await current.waitClosed();
        current = createSwiftHID(config);
        return current.devicesAsync();
      })().finally(() => { opening = undefined; });
      return opening;
    },
    HID: class { constructor(devicePath) { if (!current) throw new Error('Swift HID is unavailable'); return new current.HID(devicePath); } },
  };
  return createDevice({ ...options, dependencies: { ...dependencies, hid } });
}
