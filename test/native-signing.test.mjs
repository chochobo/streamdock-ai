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
