import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readAgents } from '../src/agents.mjs';

const opaque = (provider, id) => `${provider === 'codex' ? 'codex' : 'claude-code'}-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
const snapshot = (codex = [], claude = [], available = true) => ({ read: async () => ({ codex: {available, ids: new Set(codex)}, claude: {available, ids: new Set(claude)} }) });
async function fixture(t, { provider = 'codex', status = 'unknown', event = 'SessionStart', presence, confidence, ageMs = 0, origin = 'codex-desktop' } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'streamdock-presence-'));
  t.after(() => rm(home, {recursive:true, force:true}));
  const session = '11111111-1111-4111-8111-111111111111';
  const now = Date.now();
  const dir = path.join(home, '.cache', 'streamdock-ai', 'agents');
  await mkdir(dir, {recursive:true});
  await writeFile(path.join(dir, 'test.json'), JSON.stringify({id: opaque(provider, session),agent: provider === 'claude' ? 'claude-code' : provider,session,cwd:'/tmp/example',project:'example',origin,updated:(now-ageMs)/1000,status,event,presence,confidence}));
  return {home, now, id: opaque(provider,session)};
}

test('live process evidence does not turn unknown activity into working', async t => {
  const f = await fixture(t, {status:'unknown', ageMs:600_000});
  const {agents} = await readAgents({home:f.home, now:f.now, presenceProvider:snapshot([f.id])});
  assert.equal(agents[0].presence, 'live');
  assert.equal(agents[0].presenceEvidence, 'codex-open-rollout');
  assert.equal(agents[0].status, 'unknown');
  assert.equal(agents[0].confidence, 'unknown');
  assert.equal('reportedPresence' in agents[0], false);
  assert.equal('session' in agents[0], false);
});

test('fresh hook evidence expires, and missing process data never proves exit', async t => {
  const f = await fixture(t, {status:'working', event:'UserPromptSubmit', presence:'live'});
  let {agents} = await readAgents({home:f.home, now:f.now, presenceProvider:snapshot([],[],false)});
  assert.equal(agents[0].presence, 'live');
  assert.equal(agents[0].presenceEvidence, 'recent-event');
  assert.equal(agents[0].confidence, 'inferred');
  ({agents} = await readAgents({home:f.home, now:f.now+16_000, presenceProvider:snapshot([],[],false)}));
  assert.equal(agents[0].presence, 'unknown');
  assert.equal(agents[0].status, 'working');
});

test('Codex permission hook becomes unknown after short freshness window', async t => {
  const f = await fixture(t, {status:'blocked', event:'PermissionRequest', presence:'live', confidence:'inferred'});
  let {agents} = await readAgents({home:f.home, now:f.now, presenceProvider:snapshot([f.id])});
  assert.equal(agents[0].status,'blocked');
  assert.equal(agents[0].confidence,'inferred');
  ({agents} = await readAgents({home:f.home, now:f.now+31_000, presenceProvider:snapshot([f.id])}));
  assert.equal(agents[0].presence,'live');
  assert.equal(agents[0].status,'unknown');
  assert.equal(agents[0].stale,true);
});

test('session-end evidence is separate from a still-live process', async t => {
  const f = await fixture(t, {status:'unknown', event:'SessionEnd', presence:'ended'});
  let {agents} = await readAgents({home:f.home, now:f.now, presenceProvider:snapshot()});
  assert.equal(agents[0].presence,'ended');
  ({agents} = await readAgents({home:f.home, now:f.now, presenceProvider:snapshot([f.id])}));
  assert.equal(agents[0].presence,'ended');
});

test('Claude process evidence cannot promote an unverified session target', async t => {
  const f = await fixture(t, {provider:'claude', origin:'unknown', status:'unknown', ageMs:600_000});
  const {agents} = await readAgents({home:f.home, now:f.now, presenceProvider:snapshot([], [f.id], false)});
  assert.equal(agents[0].presence,'unknown');
});

test('inferred Claude approval also expires without a resolution event', async t => {
  const f = await fixture(t, {provider:'claude', origin:'unknown', status:'blocked', event:'Notification', presence:'live', confidence:'inferred'});
  let {agents} = await readAgents({home:f.home, now:f.now, presenceProvider:snapshot()});
  assert.equal(agents[0].status,'blocked');
  assert.equal(agents[0].confidence,'inferred');
  ({agents} = await readAgents({home:f.home, now:f.now+31_000, presenceProvider:snapshot()}));
  assert.equal(agents[0].status,'unknown');
  assert.equal(agents[0].confidence,'unknown');
});

test('Claude background work remains marked as inferred', async t => {
  const f = await fixture(t, {provider:'claude', origin:'unknown', status:'working', event:'Stop', presence:'live', confidence:'inferred'});
  const {agents} = await readAgents({home:f.home, now:f.now, presenceProvider:snapshot()});
  assert.equal(agents[0].status,'working');
  assert.equal(agents[0].confidence,'inferred');
});

test('partial process detection preserves positive matches and reports limited coverage', async t => {
  const f = await fixture(t, {status:'unknown', ageMs:600_000});
  const provider = {read:async()=>({codex:{available:false,ids:new Set([f.id])},claude:{available:false,ids:new Set()}})};
  const {agents,warnings} = await readAgents({home:f.home, now:f.now, presenceProvider:provider});
  assert.equal(agents[0].presence,'live');
  assert.deepEqual(warnings.map(x => x.code), ['codex_sessions_partial', 'claude_sessions_partial']);
  assert.ok(warnings.some(x => x.message.includes('Codex')));
  assert.ok(warnings.some(x => x.message.includes('Claude')));
});

test('presence provider errors do not imply a session exited', async t => {
  const f = await fixture(t, {status:'unknown', ageMs:600_000});
  const {agents,warnings} = await readAgents({home:f.home, now:f.now, presenceProvider:{read:async()=>{throw new Error('private details');}}});
  assert.equal(agents[0].presence,'unknown');
  assert.deepEqual(warnings.map(x => x.code), ['sessions_unknown']);
  assert.ok(!JSON.stringify(warnings).includes('private details'));
});

async function writeRollout(home, now, events) {
  const d = new Date(now);
  const dir = path.join(home,'.codex','sessions',String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'));
  await mkdir(dir,{recursive:true});
  const session = '11111111-1111-4111-8111-111111111111';
  const rows = [{type:'session_meta',payload:{id:session,cwd:'/tmp/example',originator:'Codex Desktop',source:'vscode'}},...events.map(e=>({type:'event_msg',timestamp:new Date(e.at).toISOString(),payload:{type:e.type}}))];
  await writeFile(path.join(dir,'rollout-test.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
}

test('recent rollout without a task event does not override a working hook', async t => {
  const f=await fixture(t,{status:'working',event:'PostToolUse',presence:'live',ageMs:5000,confidence:'inferred'});
  await writeRollout(f.home,f.now,[{type:'token_count',at:f.now-1000}]);
  const {agents}=await readAgents({home:f.home,now:f.now,presenceProvider:snapshot([f.id])});
  assert.equal(agents.length,1);
  assert.equal(agents[0].status,'working');
  assert.equal(agents[0].event,'PostToolUse');
  assert.equal(agents[0].source,'streamdock-hook');
  assert.equal('_statusEvidenceMs' in agents[0],false);
});

test('unrelated activity after task start cannot override a newer approval request', async t => {
  const f=await fixture(t,{status:'blocked',event:'PermissionRequest',presence:'live',ageMs:3000,confidence:'inferred'});
  await writeRollout(f.home,f.now,[{type:'task_started',at:f.now-10_000},{type:'token_count',at:f.now-1000}]);
  const {agents}=await readAgents({home:f.home,now:f.now,presenceProvider:snapshot([f.id])});
  assert.equal(agents[0].status,'blocked');
  assert.equal(agents[0].event,'PermissionRequest');
});

test('newer explicit completion and abort events override earlier working hook', async t => {
  for (const [event,status] of [['task_complete','done'],['turn_aborted','unknown']]) {
    const f=await fixture(t,{status:'working',event:'PostToolUse',presence:'live',ageMs:5000,confidence:'inferred'});
    await writeRollout(f.home,f.now,[{type:'task_started',at:f.now-10_000},{type:event,at:f.now-1000}]);
    const {agents}=await readAgents({home:f.home,now:f.now,presenceProvider:snapshot([f.id])});
    assert.equal(agents[0].status,status);
    assert.equal(agents[0].event,event);
  }
});

test('explicit session end is not overridden by a later rollout with no task event', async t => {
  const f=await fixture(t,{status:'unknown',event:'SessionEnd',presence:'ended',ageMs:5000,confidence:'inferred'});
  await writeRollout(f.home,f.now,[{type:'token_count',at:f.now-1000}]);
  const {agents}=await readAgents({home:f.home,now:f.now,presenceProvider:snapshot([f.id])});
  assert.equal(agents[0].event,'SessionEnd');
  assert.equal(agents[0].presence,'ended');
});
