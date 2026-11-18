import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

// Uses a temporary app, fake local server and ephemeral port. It never opens HID
// or reads the real user's settings. The test is specific to the macOS app.
test('native app owns only its authenticated backend and preserves port conflicts',
  { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'streamdock-native-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const app = path.join(dir, 'Test.app', 'Contents');
    const resources = path.join(app, 'Resources');
    await mkdir(path.join(app, 'MacOS'), { recursive: true });
    await mkdir(path.join(resources, 'runtime'), { recursive: true });
    await mkdir(path.join(resources, 'backend', 'src'), { recursive: true });
    await writeFile(path.join(app, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>StreamDockAI</string><key>CFBundleIdentifier</key><string>local.streamdock.test</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
    const node = path.join(resources, 'runtime', 'node');
    await writeFile(node, '#!/bin/sh\nexec "$STREAMDOCK_TEST_NODE" "$1"\n');
    await chmod(node, 0o700);
    const helper = path.join(resources, 'runtime', 'streamdock-hid');
    await writeFile(helper, '#!/bin/sh\nexit 99\n');
    await chmod(helper, 0o700);
    await writeFile(path.join(resources, 'backend', 'src', 'server.mjs'), `
      import http from 'node:http';
      if ((process.env.STREAMDOCK_SWIFT_HID_PATH || '') !== (process.env.STREAMDOCK_TEST_EXPECT_HID || '')) process.exit(23);
      const server = http.createServer((req, res) => {
        if (req.url !== '/api/native/identity' || req.headers['x-streamdock-native-token'] !== process.env.STREAMDOCK_NATIVE_TOKEN) { res.writeHead(403); res.end(); return; }
        if (process.env.STREAMDOCK_TEST_REDIRECT) { res.writeHead(302, { location: process.env.STREAMDOCK_TEST_REDIRECT }); res.end(); return; }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ application:'streamdock-ai', protocol:1 }));
      });
      server.listen(Number(process.env.PORT), '127.0.0.1');
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
    `);
    const harness = path.join(dir, 'Harness.swift');
    await writeFile(harness, `
      import Foundation
      @main struct Harness {
        @MainActor static func main() async {
          let port = Int(ProcessInfo.processInfo.environment["STREAMDOCK_TEST_PORT"]!)!
          let conflict = ProcessInfo.processInfo.environment["STREAMDOCK_TEST_CONFLICT"] == "1"
          let redirect = ProcessInfo.processInfo.environment["STREAMDOCK_TEST_REDIRECT"] != nil
          let service = BackendService(port: port)
          service.start()
          for index in 0..<120 {
            if conflict && service.message.contains("사용 중") && service.token == nil {
              service.stop(); print("conflict-preserved"); exit(0)
            }
            if redirect && index == 20 && service.token == nil {
              service.stop(); try? await Task.sleep(nanoseconds: 700_000_000)
              print("redirect-blocked"); exit(0)
            }
            if !conflict, let token = service.token, token.count == 64 {
              service.stop(); try? await Task.sleep(nanoseconds: 700_000_000)
              print("authenticated-child-stopped"); exit(0)
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
          }
          print("failed: \\(service.message)"); service.stop(); exit(1)
        }
      }
    `);
    const executable = path.join(app, 'MacOS', 'StreamDockAI');
    await run('swiftc', ['-parse-as-library', path.join(root, 'native/App/BackendService.swift'), harness,
      '-o', executable, '-framework', 'Security'], { timeout: 20000 });
    const freePort = async () => {
      const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
      const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
    };
    const execute = (port, conflict = false, redirect = null, useNodeHID = false) => run(executable, useNodeHID ? ['--node-hid'] : [], { timeout: 15000, env: {
      ...process.env, HOME: dir, STREAMDOCK_TEST_NODE: process.execPath,
      STREAMDOCK_SWIFT_HID_PATH: '/tmp/untrusted-inherited-hid',
      STREAMDOCK_TEST_EXPECT_HID: useNodeHID ? '' : helper,
      STREAMDOCK_TEST_PORT: String(port), STREAMDOCK_TEST_CONFLICT: conflict ? '1' : '0',
      ...(redirect ? { STREAMDOCK_TEST_REDIRECT: redirect } : {}),
    }});
    const firstPort = await freePort();
    const first = await execute(firstPort);
    assert.match(first.stdout, /authenticated-child-stopped/);
    const recoveryPort = await freePort();
    const recovery = await execute(recoveryPort, false, null, true);
    assert.match(recovery.stdout, /authenticated-child-stopped/);
    const reusable = net.createServer();
    reusable.listen(firstPort, '127.0.0.1'); await once(reusable, 'listening');
    await new Promise(resolve => reusable.close(resolve));
    const occupied = net.createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
    t.after(() => occupied.close());
    const blocked = await execute(occupied.address().port, true);
    assert.match(blocked.stdout, /conflict-preserved/);
    assert.equal(occupied.listening, true);
    await new Promise(resolve => occupied.close(resolve));
    let redirectedRequests = 0;
    const redirectTarget = net.createServer(socket => { redirectedRequests++; socket.destroy(); });
    redirectTarget.listen(0, '127.0.0.1'); await once(redirectTarget, 'listening');
    t.after(() => redirectTarget.close());
    const redirectPort = await freePort();
    const redirected = await execute(redirectPort, false, `http://127.0.0.1:${redirectTarget.address().port}/steal`);
    assert.match(redirected.stdout, /redirect-blocked/);
    assert.equal(redirectedRequests, 0, 'identity token must not be sent to a redirect target');
    await new Promise(resolve => redirectTarget.close(resolve));
  });
