import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const development = 'A'.repeat(40);
const otherDevelopment = 'B'.repeat(40);
const developerID = 'C'.repeat(40);
const line = (hash, label) => `  1) ${hash} "${label}: Test (TESTTEAM)"`;
const run = (listing, pin = '', requested = '', allowChange = '0') => spawnSync('/bin/bash', ['-euc',
  'source scripts/native-signing.sh; native_select_signing_identity "$1" "$2" "$3" "$4"',
  '--', listing, pin, requested, allowChange], { cwd: root, encoding: 'utf8' });

test('chooses one Apple Development identity and ignores Developer ID for automatic choice', () => {
  const result = run(`${line(development, 'Apple Development')}\n${line(developerID, 'Developer ID Application')}`);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), development);
});

test('does not silently pick an absent, invalid, or ambiguous signing identity', () => {
  assert.notEqual(run('').status, 0);
  assert.notEqual(run(line(developerID, 'Developer ID Application')).status, 0);
  assert.notEqual(run(`${line(development, 'Apple Development')}\n${line(otherDevelopment, 'Apple Development')}`).status, 0);
  assert.notEqual(run(line(development, 'Apple Development'), 'invalid').status, 0);
});

test('pins an existing identity, fails closed if unavailable, and requires explicit change', () => {
  const identities = `${line(development, 'Apple Development')}\n${line(developerID, 'Developer ID Application')}`;
  assert.equal(run(identities, development.toLowerCase()).stdout.trim(), development);
  assert.notEqual(run(line(developerID, 'Developer ID Application'), development).status, 0);
  assert.notEqual(run(identities, development, developerID).status, 0);
  const allowed = run(identities, development, developerID, '1');
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), developerID);
});

test('only a valid ad-hoc app may migrate without an existing certificate pin', () => {
  const check = (pin, requirement) => spawnSync('/bin/bash', ['-euc',
    'source scripts/native-signing.sh; native_validate_existing_requirement "$1" "$2"',
    '--', pin, requirement], { cwd: root, encoding: 'utf8' });
  const adHoc = 'identifier "local.streamdock.ai" and cdhash H"1234"';
  const certificate = 'identifier "local.streamdock.ai" and anchor apple generic and certificate leaf[subject.OU] = "TESTTEAM"';
  assert.equal(check('', adHoc).status, 0);
  assert.notEqual(check('', certificate).status, 0);
  assert.equal(check(development, certificate).status, 0);
  assert.notEqual(check(development, adHoc).status, 0);
  assert.notEqual(check(development, '').status, 0);
});

const local = 'D'.repeat(40);
const localLine = hash => `  2) ${hash} "Local Code Signing"`;

test('a self-signed local identity is used only when named or already pinned', () => {
  const identities = `${localLine(local)}\n${line(developerID, 'Developer ID Application')}`;
  assert.notEqual(run(localLine(local)).status, 0);
  assert.notEqual(run(identities).status, 0);
  const named = run(identities, '', local.toLowerCase());
  assert.equal(named.status, 0);
  assert.equal(named.stdout.trim(), local);
  assert.equal(run(identities, local).stdout.trim(), local);
  assert.notEqual(run(line(development, 'Apple Development'), '', local).status, 0);
  // An Apple Development identity is still chosen automatically next to a local one.
  assert.equal(run(`${localLine(local)}\n${line(development, 'Apple Development')}`).stdout.trim(), development);
});

test('a stable requirement chains to Apple or pins the exact leaf certificate', () => {
  const stable = (requirement, fingerprint) => spawnSync('/bin/bash', ['-euc',
    'source scripts/native-signing.sh; native_requirement_is_stable "$1" "$2"',
    '--', requirement, fingerprint], { cwd: root, encoding: 'utf8' }).status;
  const leaf = hash => `designated => identifier "local.streamdock.ai" and certificate leaf = H"${hash.toLowerCase()}"`;
  assert.equal(stable('designated => identifier "local.streamdock.ai" and anchor apple generic and certificate leaf[subject.OU] = "TESTTEAM"', development), 0);
  assert.equal(stable(leaf(local), local), 0);
  assert.equal(stable(leaf(local), local.toLowerCase()), 0);
  assert.notEqual(stable(leaf(local), otherDevelopment), 0);
  assert.notEqual(stable(leaf(local), ''), 0);
  assert.notEqual(stable(`designated => identifier "other.app" and certificate leaf = H"${local.toLowerCase()}"`, local), 0);
  assert.notEqual(stable('designated => identifier "local.streamdock.ai" and cdhash H"1234"', local), 0);
  assert.notEqual(stable(`designated => identifier "local.streamdock.ai" and certificate leaf = H"${local.toLowerCase()}00"`, local), 0);
  assert.notEqual(stable(`designated => identifier "local.streamdock.ai" and certificate root = H"${local.toLowerCase()}"`, local), 0);
});

test('an existing app pinned to a local identity keeps that identity', () => {
  const check = (pin, requirement) => spawnSync('/bin/bash', ['-euc',
    'source scripts/native-signing.sh; native_validate_existing_requirement "$1" "$2"',
    '--', pin, requirement], { cwd: root, encoding: 'utf8' }).status;
  const pinnedLeaf = `identifier "local.streamdock.ai" and certificate leaf = H"${local.toLowerCase()}"`;
  assert.equal(check(local, pinnedLeaf), 0);
  assert.notEqual(check(otherDevelopment, pinnedLeaf), 0);
  assert.notEqual(check('', pinnedLeaf), 0);
});

// #43: apps built before the fix were signed with Python bytecode inside the seal, and Python
// rewrote it while the app ran. Such an app may be replaced; any other broken seal may not.
const bytecodeOnly = output => spawnSync('/bin/bash', ['-euc', 'source scripts/native-signing.sh; native_only_bytecode_failed "$1"', '--', output], { cwd: root, encoding: 'utf8' }).status === 0;
const bundle = '/Users/me/streamdock-ai/build/native/StreamDockAI.app';
const pyc = name => `${bundle}/Contents/Resources/backend/src/vendor/agentdeck/__pycache__/${name}.cpython-313.pyc`;

test('a seal broken only by Python bytecode files is accepted for replacement', () => {
  const summary = `${bundle}: a sealed resource is missing or invalid`;
  assert.equal(bytecodeOnly([summary, `file missing: ${pyc('scenes')}`, `file missing: ${pyc('sfx')}`].join('\n')), true);
  assert.equal(bytecodeOnly([summary, `file modified: ${pyc('clock')}`].join('\n')), true);
  assert.equal(bytecodeOnly([summary, `file added: ${bundle}/Contents/Resources/backend/src/__pycache__/x.cpython-313.pyc`].join('\n')), true);
  assert.equal(bytecodeOnly([summary, `file missing: ${pyc('a')}`, `file modified: ${pyc('b')}`, ''].join('\n')), true, 'a trailing newline is fine');
});

test('any other kind of seal problem still blocks the replacement', () => {
  const summary = `${bundle}: a sealed resource is missing or invalid`;
  assert.equal(bytecodeOnly(summary), false, 'no file named: nothing proves it is only bytecode');
  assert.equal(bytecodeOnly(''), false);
  assert.equal(bytecodeOnly([summary, `file modified: ${pyc('a')}`, `file modified: ${bundle}/Contents/MacOS/StreamDockAI`].join('\n')), false, 'the executable changed');
  assert.equal(bytecodeOnly([summary, `file modified: ${bundle}/Contents/Resources/backend/src/server.mjs`].join('\n')), false, 'a source file changed');
  assert.equal(bytecodeOnly([summary, `file modified: ${bundle}/Contents/Resources/backend/src/x.pyc`].join('\n')), false, 'a .pyc outside __pycache__');
  assert.equal(bytecodeOnly([summary, `file modified: ${bundle}/Contents/Frameworks/__pycache__/x.pyc`].join('\n')), false, 'a cache outside backend/');
  assert.equal(bytecodeOnly([summary, `file modified: ${bundle}/Contents/Resources/backend/../MacOS/__pycache__/x.pyc`].join('\n')), false, 'path tricks');
  assert.equal(bytecodeOnly([summary, `file modified: ${pyc('a')}`, 'code object is not signed at all'].join('\n')), false, 'an unknown message');
  assert.equal(bytecodeOnly(['invalid signature (code or signature have been modified)', `file modified: ${pyc('a')}`].join('\n')), false, 'a different failure');
  assert.equal(bytecodeOnly(`${bundle}: code object is not signed at all`), false);
});

test('the build leaves __pycache__ out of the signed bundle', async () => {
  const { readFile } = await import('node:fs/promises');
  const script = await readFile(new URL('../scripts/native-build.sh', import.meta.url), 'utf8');
  const copy = script.indexOf('cp -R "$workspace/src" "$resources/backend/src"');
  const prune = script.indexOf('-name __pycache__ -prune -exec /bin/rm -rf {} +');
  const sign = script.indexOf('codesign --force');
  assert.ok(copy > 0 && prune > copy, 'the cache is removed right after the sources are copied');
  if (sign > 0) assert.ok(prune < sign, 'and before anything is signed');
});
