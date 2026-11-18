import test from 'node:test';
import assert from 'node:assert/strict';
import { focusSession } from '../src/focus.mjs';

const chat = { provider: 'codex', origin: 'codex-desktop', sessionId: '01234567-89ab-7cde-8fab-0123456789ab' };
const terminal = { provider: 'claude', sessionId: 'session-1', pid: 1234, processStart: 'Sun Nov  8 23:00:00 2026', tty: 'ttys012', bundle: 'com.apple.Terminal' };
function fakeRunner({ psStart = terminal.processStart, psTty = 'ttys012', psComm = '/usr/local/bin/claude', scriptResult = 'FOCUSED', scriptError = null } = {}) {
  const calls = [];
  const run = async (binary, args) => {
    calls.push({ binary, args });
    if (binary === '/bin/ps') {
      const field = args.at(-1);
      return { stdout: ({ 'lstart=': psStart, 'tty=': psTty, 'comm=': psComm })[field] || '' };
    }
    if (binary === '/usr/bin/osascript') {
      if (scriptError) throw scriptError;
      return { stdout: scriptResult };
    }
    return { stdout: '' };
  };
  return { run, calls };
}

test('Codex desktop uses a constrained UUID deep link and reports dispatch only', async () => {
  const { run, calls } = fakeRunner();
  const result = await focusSession(chat, { run, platform: 'darwin' });
  assert.deepEqual(result, { ok: true, code: 'dispatched', message: 'Codex에 채팅 열기를 요청했습니다.', verification: 'dispatch_only' });
  assert.deepEqual(calls[0].args, ['-b', 'com.openai.codex', `codex://threads/${chat.sessionId}`]);
  const malicious = await focusSession({ ...chat, sessionId: 'abc/../../?x=1' }, { run, platform: 'darwin' });
  assert.equal(malicious.code, 'invalid_target');
  assert.equal(calls.length, 1);
});

test('terminal focus checks live process identity and uses tty as an argument', async () => {
  const { run, calls } = fakeRunner();
  const result = await focusSession(terminal, { run, platform: 'darwin' });
  assert.equal(result.code, 'focused');
  assert.equal(result.verification, 'matched_tty');
  const osa = calls.find(c => c.binary === '/usr/bin/osascript');
  assert.equal(osa.args.at(-1), '/dev/ttys012');
  assert.equal(osa.args.at(-2), '--');
  assert.ok(!osa.args[1].includes('/dev/ttys012'));
});

test('changed PID, tty, executable or incomplete identity cannot focus', async () => {
  for (const opt of [{psStart:'other'}, {psTty:'ttys013'}, {psComm:'/bin/zsh'}]) {
    const { run, calls } = fakeRunner(opt);
    assert.equal((await focusSession(terminal, {run, platform:'darwin'})).code, 'identity_changed');
    assert.ok(!calls.some(c => c.binary === '/usr/bin/osascript'));
  }
  for (const target of [{...terminal, processStart:''}, {...terminal, tty:'ttys012" & bad'}, {...terminal, pid:0}]) {
    const {run, calls} = fakeRunner();
    assert.equal((await focusSession(target, {run, platform:'darwin'})).code, 'identity_unavailable');
    assert.equal(calls.length, 0);
  }
});

test('not found, ambiguous, permissions and unsupported target stay explicit failures', async () => {
  for (const [scriptResult, code] of [['NOT_FOUND','not_found'], ['AMBIGUOUS','ambiguous']]) {
    const {run} = fakeRunner({scriptResult});
    assert.equal((await focusSession(terminal, {run,platform:'darwin'})).code, code);
  }
  const {run} = fakeRunner({scriptError:{stderr:'Not authorized (-1743)'}});
  assert.equal((await focusSession(terminal, {run,platform:'darwin'})).code, 'automation_denied');
  assert.equal((await focusSession({...terminal,bundle:'com.unsupported'}, {run,platform:'darwin'})).code, 'unsupported_origin');
  assert.equal((await focusSession({...chat,hostId:'remote'}, {run,platform:'darwin'})).code, 'remote_unsupported');
  assert.equal((await focusSession(chat, {run,platform:'linux'})).code, 'unsupported_platform');
});

test('iTerm uses exact session tty and never interpolates it into AppleScript', async () => {
  const {run, calls} = fakeRunner();
  const result = await focusSession({...terminal,bundle:'com.googlecode.iterm2'}, {run,platform:'darwin'});
  assert.equal(result.code, 'focused');
  const osa = calls.find(c => c.binary === '/usr/bin/osascript');
  assert.match(osa.args[1], /sessions of t/);
  assert.equal(osa.args.at(-1), '/dev/ttys012');
});

test('Claude desktop dispatch requires unique nonarchived CLI-to-Desktop identity', async () => {
  const {run,calls} = fakeRunner();
  const t = {provider:'claude', origin:'claude-desktop', sessionId:chat.sessionId,
    desktopSessionId:'local_12345678-abcd', desktopSessionUnique:true, desktopArchived:false,
    desktopAccountId:chat.sessionId, desktopOrganizationId:'11111111-2222-3333-4444-555555555555'};
  const readClaudeScope = async () => ({account:t.desktopAccountId, organization:t.desktopOrganizationId});
  const result=await focusSession(t,{run,platform:'darwin',readClaudeScope});
  assert.equal(result.code,'dispatched');
  assert.equal(result.verification,'dispatch_only');
  assert.deepEqual(calls[0].args,['-b','com.anthropic.claudefordesktop',`claude://code/continue?session=${t.desktopSessionId}`]);
  for (const bad of [{...t,desktopSessionUnique:false},{...t,desktopArchived:true},{...t,desktopArchived:undefined},{...t,desktopSessionId:'local_x&danger=1'},{...t,sessionId:'not-a-uuid'}]) {
    assert.equal((await focusSession(bad,{run,platform:'darwin',readClaudeScope})).code,'identity_unavailable');
  }
  assert.equal((await focusSession(t,{run,platform:'darwin',readClaudeScope:async()=>({account:'different',organization:t.desktopOrganizationId})})).code,'account_changed');
  assert.equal((await focusSession(t,{run,platform:'darwin',readClaudeScope:async()=>({account:t.desktopAccountId,organization:'different'})})).code,'account_changed');
  assert.equal((await focusSession(t,{run,platform:'darwin',readClaudeScope:async()=>{throw new Error('missing')}})).code,'account_changed');
  assert.equal(calls.length,1);
});
