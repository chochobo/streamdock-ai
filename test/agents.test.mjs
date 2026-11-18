import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readAgents } from '../src/agents.mjs';

async function tempHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'streamdock-agents-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test('reads hook observations and marks old states unknown without leaking payload', async t => {
  const home = await tempHome(t);
  const now = Date.now();
  const dir = path.join(home, '.cache', 'streamdock-ai', 'agents');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'a.json'), JSON.stringify({ id: 'claude-code-1', agent: 'claude-code', status: 'blocked', project: '/tmp/private-project', updated: now / 1000, prompt: 'SECRET' }));
  await fs.writeFile(path.join(dir, 'b.json'), JSON.stringify({ id: 'codex-2', agent: 'codex', status: 'working', project: 'old', updated: (now - 600_000) / 1000 }));
  await fs.writeFile(path.join(dir, 'broken.json'), '{');
  const { agents, warnings } = await readAgents({ home, now });
  assert.deepEqual(warnings, []);
  assert.equal(agents.length, 2);
  assert.equal(agents[0].status, 'blocked');
  assert.equal(agents[0].provider, 'claude');
  assert.equal(agents[0].project, 'private-project');
  assert.equal(agents[1].status, 'unknown');
  assert.equal(agents[1].stale, true);
  assert.ok(!JSON.stringify(agents).includes('SECRET'));
});

test('infers Codex status from lifecycle events, not message content', async t => {
  const home = await tempHome(t);
  const now = Date.now();
  const date = new Date(now);
  const dir = path.join(home, '.codex', 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  await fs.mkdir(dir, { recursive: true });
  const f = path.join(dir, 'rollout-test.jsonl');
  const line = value => JSON.stringify(value) + '\n';
  await fs.writeFile(f, line({ type: 'session_meta', payload: { id: '123', cwd: '/tmp/project', base_instructions: 'SECRET' } }) + line({ type: 'event_msg', payload: { type: 'task_started' } }) + line({ type: 'response_item', payload: { text: 'SECRET' } }));
  let result = await readAgents({ home, now: Date.now() });
  assert.equal(result.agents[0].status, 'working');
  assert.equal(result.agents[0].source, 'codex-rollout');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  await fs.appendFile(f, line({ type: 'event_msg', payload: { type: 'task_complete' } }));
  result = await readAgents({ home, now: Date.now() });
  assert.equal(result.agents[0].status, 'done');
  await fs.appendFile(f, line({ type: 'event_msg', payload: { type: 'turn_aborted' } }));
  result = await readAgents({ home, now: Date.now() });
  assert.equal(result.agents[0].status, 'unknown');
});

test('selects newest hook or rollout observation for the same Codex session', async t => {
  const home = await tempHome(t);
  const now = Date.now();
  const own = path.join(home, '.cache', 'streamdock-ai', 'agents');
  const deck = path.join(home, '.cache', 'd200', 'agents');
  await Promise.all([fs.mkdir(own, { recursive: true }), fs.mkdir(deck, { recursive: true })]);
  await fs.writeFile(path.join(own, 'one.json'), JSON.stringify({ id: 'codex-1', agent: 'codex', status: 'done', updated: (now - 10_000) / 1000 }));
  await fs.writeFile(path.join(deck, 'one.json'), JSON.stringify({ id: 'codex-1', agent: 'codex', status: 'working', updated: now / 1000 }));
  const { agents } = await readAgents({ home, now });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].status, 'working');
  assert.equal(agents[0].source, 'agentdeck-hook');
});

test('cached status still expires and completion time is not refreshed by later records', async t => {
  const home = await tempHome(t);
  const now = Date.now();
  const date = new Date(now);
  const dir = path.join(home, '.codex', 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  await fs.mkdir(dir, { recursive: true });
  const f = path.join(dir, 'rollout-cache.jsonl');
  const line = value => JSON.stringify(value) + '\n';
  await fs.writeFile(f,
    line({ type: 'session_meta', payload: { id: 'cached' } }) +
    line({ type: 'event_msg', timestamp: new Date(now - 400_000).toISOString(), payload: { type: 'task_complete' } }) +
    line({ type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'token_count' } }));
  let result = await readAgents({ home, now });
  assert.equal(result.agents[0].status, 'unknown');
  assert.equal(result.agents[0].stale, true);
  result = await readAgents({ home, now, maxAgeMs: 500_000 });
  assert.equal(result.agents[0].status, 'done');
  result = await readAgents({ home, now: now + 200_000, maxAgeMs: 500_000 });
  assert.equal(result.agents[0].status, 'unknown');
});

test('deduplicates a hashed hook ID with the Codex rollout session', async t => {
  const home = await tempHome(t);
  const now = Date.now();
  const date = new Date(now);
  const session = 'e0a14911-2211-4555-8111-d7ba3855c9f2';
  const codex = path.join(home, '.codex', 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  const own = path.join(home, '.cache', 'streamdock-ai', 'agents');
  await Promise.all([fs.mkdir(codex, { recursive: true }), fs.mkdir(own, { recursive: true })]);
  const id = `codex-${createHash('sha256').update(session).digest('hex').slice(0, 24)}`;
  await fs.writeFile(path.join(codex, 'rollout.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
  await fs.writeFile(path.join(own, 'hook.json'), JSON.stringify({ id, agent: 'codex', status: 'done', updated: now / 1000 }));
  const { agents } = await readAgents({ home, now: Date.now() });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, id);
  assert.ok(!JSON.stringify(agents).includes(session));
});

test('preserves sanitized subagent names when a newer hook supplies status', async t => {
  const home = await tempHome(t);
  const now = Date.now();
  const date = new Date(now);
  const session = 'subagent-session';
  const codex = path.join(home, '.codex', 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  const own = path.join(home, '.cache', 'streamdock-ai', 'agents');
  await Promise.all([fs.mkdir(codex, { recursive: true }), fs.mkdir(own, { recursive: true })]);
  const id = `codex-${createHash('sha256').update(session).digest('hex').slice(0, 24)}`;
  const meta = { type: 'session_meta', payload: { id: session, cwd: '/tmp/project', source: { subagent: {} }, agent_nickname: `  Alpha${String.fromCharCode(0, 0x202e)}  ` } };
  const event = { type: 'event_msg', timestamp: new Date(now - 1000).toISOString(), payload: { type: 'task_started' } };
  await fs.writeFile(path.join(codex, 'rollout.jsonl'), [meta, event].map(JSON.stringify).join('\n') + '\n');
  await fs.writeFile(path.join(own, 'hook.json'), JSON.stringify({ id, agent: 'codex', status: 'done', updated: now / 1000 }));
  const { agents } = await readAgents({ home, now });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].status, 'done');
  assert.equal(agents[0].source, 'streamdock-hook');
  assert.equal(agents[0].displayName, 'Alpha');
  assert.ok(!JSON.stringify(agents).includes(session));
});

test('does not use nickname from a non-subagent session', async t => {
  const home = await tempHome(t);
  const now = Date.now();
  const date = new Date(now);
  const dir = path.join(home, '.codex', 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  await fs.mkdir(dir, { recursive: true });
  const meta = { type: 'session_meta', payload: { id: 'main-session', cwd: '/tmp/project', source: 'vscode', agent_nickname: 'NotAnAgent' } };
  const event = { type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'task_started' } };
  await fs.writeFile(path.join(dir, 'rollout.jsonl'), [meta, event].map(JSON.stringify).join('\n') + '\n');
  const { agents } = await readAgents({ home, now });
  assert.equal(agents[0].project, 'project');
  assert.equal(agents[0].displayName, undefined);
});
test('keeps exact session targets private and separates projects sharing a folder name', async t => {
  const home = await tempHome(t);
  const now = Date.now();
  const date = new Date(now);
  const dir = path.join(home, '.codex', 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  await fs.mkdir(dir, { recursive: true });
  const line = value => JSON.stringify(value) + '\n';
  const rootId = '11111111-1111-4111-8111-111111111111';
  await fs.writeFile(path.join(home, '.codex', 'session_index.jsonl'), line({ id: rootId, thread_name: 'Local chat title' }));
  for (const [index, cwd, source] of [[1, '/tmp/one/project', 'vscode'], [2, '/tmp/two/project', 'vscode'], [3, '/tmp/one/project', { subagent: 'review' }]]) {
    await fs.writeFile(path.join(dir, `rollout-${index}.jsonl`), line({ type: 'session_meta', payload: { id: index === 1 ? rootId : `other-${index}`, cwd, originator: 'Codex Desktop', source } }) + line({ type: 'event_msg', payload: { type: 'task_started' } }));
  }
  const result = await readAgents({ home, now: Date.now() });
  assert.equal(result.agents.length, 3);
  const titled = result.agents.find(a => a.title === 'Local chat title');
  const subagent = result.agents.find(a => a.isSubagent);
  assert.ok(titled && subagent);
  assert.equal(titled.projectId, subagent.projectId);
  assert.equal(new Set(result.agents.map(a => a.projectId)).size, 2);
  assert.equal(result.targets.get(titled.id).sessionId, rootId);
  assert.equal(result.targets.get(titled.id).origin, 'codex-desktop');
  assert.ok(!JSON.stringify(result.agents).includes(rootId));
  assert.ok(!JSON.stringify(result.agents).includes('/tmp/one/project'));
});
test('Claude hook records only local target metadata and never stores prompt text', async t => {
  const { execFile } = await import('node:child_process');
  const home = await tempHome(t);
  const hook = path.resolve('scripts/agent-hook.py');
  const child = execFile('python3', [hook, 'claude'], { env: { ...process.env, HOME: home } });
  child.stdin.end(JSON.stringify({ session_id: 'session-123', cwd: '/tmp/example', hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE PROMPT CONTENT' }));
  await new Promise((resolve, reject) => child.once('error', reject).once('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  const dir = path.join(home, '.cache', 'streamdock-ai', 'agents');
  const [name] = await fs.readdir(dir);
  const file = path.join(dir, name);
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes('PRIVATE PROMPT CONTENT'));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const rec = JSON.parse(raw);
  assert.equal(rec.session, 'session-123');
  assert.equal(rec.cwd, '/tmp/example');
  const result = await readAgents({ home });
  assert.equal(result.targets.get(result.agents[0].id).sessionId, 'session-123');
  assert.ok(!JSON.stringify(result.agents).includes('session-123'));
});
test('reads archived-safe Codex index and does not mistake indexed chats for active sessions', async t => {
  const { execFileSync } = await import('node:child_process');
  const home = await tempHome(t);
  const codex = path.join(home, '.codex');
  await fs.mkdir(codex, {recursive:true});
  const db = path.join(codex, 'state_5.sqlite');
  const now = Date.now();
  const sql = `CREATE TABLE threads (id TEXT,cwd TEXT,name TEXT,title TEXT,originator TEXT,source TEXT,thread_source TEXT,archived INTEGER,updated_at_ms INTEGER,updated_at INTEGER,recency_at_ms INTEGER); INSERT INTO threads VALUES ('11111111-1111-4111-8111-111111111111','/tmp/sample','Chosen name','Fallback','Codex Desktop','vscode','user',0,${now},0,${now}),('22222222-2222-4222-8222-222222222222','/tmp/archived','','Archived','Codex Desktop','vscode','user',1,${now},0,${now}),('33333333-3333-4333-8333-333333333333','/tmp/child','','Child','Codex Desktop','subagent','subagent',0,${now},0,${now});`;
  execFileSync('sqlite3', [db, sql]);
  const result = await readAgents({home, now});
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].title, 'Chosen name');
  assert.equal(result.agents[0].status, 'unknown');
  assert.equal(result.targets.get(result.agents[0].id).origin, 'codex-desktop');
  assert.ok(!JSON.stringify(result.agents).includes('/tmp/sample'));
});

test('discovers Claude root sessions without exporting transcript content', async t => {
  const home = await tempHome(t);
  const dir = path.join(home, '.claude', 'projects', 'project');
  await fs.mkdir(dir, {recursive:true});
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await fs.writeFile(path.join(dir, `${id}.jsonl`), JSON.stringify({type:'user',isSidechain:false,sessionId:id,cwd:'/tmp/project',message:'NEVER EXPORT THIS'})+'\n');
  await fs.writeFile(path.join(dir, `${sub}.jsonl`), JSON.stringify({type:'user',isSidechain:true,sessionId:sub,cwd:'/tmp/project',message:'SECRET'})+'\n');
  const result = await readAgents({home});
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].provider, 'claude');
  assert.equal(result.agents[0].status, 'unknown');
  assert.equal(result.targets.get(result.agents[0].id).sessionId, id);
  assert.ok(!JSON.stringify(result.agents).includes('NEVER EXPORT THIS'));
  assert.ok(!JSON.stringify(result.agents).includes('/tmp/project'));
});
test('Claude desktop targets require a unique, unarchived local session mapping', async t => {
  const home = await tempHome(t);
  const appDir = path.join(home, 'Library', 'Application Support', 'Claude');
  const account = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const org = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const dir = path.join(appDir, 'claude-code-sessions', account, org);
  await fs.mkdir(dir, {recursive:true});
  await fs.writeFile(path.join(appDir, 'config.json'), JSON.stringify({lastKnownAccountUuid:account}));
  const unique = '11111111-1111-4111-8111-111111111111';
  const ambiguous = '22222222-2222-4222-8222-222222222222';
  const rows = [
    ['local_unique', unique, false], ['local_ambiguous1', ambiguous, false],
    ['local_ambiguous2', ambiguous, false], ['local_archived', '33333333-3333-4333-8333-333333333333', true],
  ];
  for (const [sessionId, cliSessionId, isArchived] of rows) {
    await fs.writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify({sessionId, cliSessionId, isArchived, cwd:'/tmp/project', title:'Private title', lastActivityAt:Date.now()}));
  }
  const result = await readAgents({home});
  assert.equal(result.agents.length, 1);
  const target = result.targets.get(result.agents[0].id);
  assert.equal(target.origin, 'claude-desktop');
  assert.equal(target.sessionId, unique);
  assert.equal(target.desktopSessionId, 'local_unique');
  assert.equal(target.desktopSessionUnique, true);
  assert.equal(target.desktopArchived, false);
  assert.ok(!JSON.stringify(result.agents).includes(unique));
  assert.ok(!JSON.stringify(result.agents).includes('local_unique'));
});
test('Claude Desktop ignores other accounts and fails closed for multiple organizations', async t => {
  const home = await tempHome(t);
  const app = path.join(home, 'Library', 'Application Support', 'Claude');
  const account = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const foreign = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const org1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const org2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const currentDir = path.join(app, 'claude-code-sessions', account, org1);
  const otherDir = path.join(app, 'claude-code-sessions', foreign, org2);
  await fs.mkdir(currentDir, {recursive:true});
  await fs.mkdir(otherDir, {recursive:true});
  await fs.writeFile(path.join(app, 'config.json'), JSON.stringify({lastKnownAccountUuid:account}));
  const currentId = '11111111-1111-4111-8111-111111111111';
  const foreignId = '22222222-2222-4222-8222-222222222222';
  const sharedId = '33333333-3333-4333-8333-333333333333';
  const row = (sessionId, cliSessionId) => JSON.stringify({sessionId,cliSessionId,isArchived:false,cwd:'/tmp/project',lastActivityAt:Date.now()});
  await fs.writeFile(path.join(currentDir,'local_current.json'), row('local_current',currentId));
  await fs.writeFile(path.join(otherDir,'local_foreign.json'), row('local_foreign',foreignId));
  await fs.writeFile(path.join(currentDir,'local_shared1.json'), row('local_shared1',sharedId));
  await fs.writeFile(path.join(otherDir,'local_shared2.json'), row('local_shared2',sharedId));
  const transcripts=path.join(home,'.claude','projects','example');
  await fs.mkdir(transcripts,{recursive:true});
  for (const sessionId of [foreignId,sharedId]) await fs.writeFile(path.join(transcripts,`${sessionId}.jsonl`),JSON.stringify({sessionId,isSidechain:false,cwd:'/tmp/project'})+'\n');
  let result = await readAgents({home});
  assert.equal(result.agents.length,2); // current target + ambiguous shared transcript; foreign-only omitted
  const targets=[...result.targets.values()];
  assert.ok(targets.some(target=>target.sessionId===currentId && target.desktopAccountId===account && target.desktopOrganizationId===org1));
  assert.ok(!targets.some(target=>target.sessionId===foreignId));
  assert.ok(targets.some(target=>target.sessionId===sharedId && target.origin==='unknown'));
  await fs.mkdir(path.join(app,'claude-code-sessions',account,org2),{recursive:true});
  result=await readAgents({home});
  assert.ok(![...result.targets.values()].some(target=>target.origin==='claude-desktop'));
  await fs.writeFile(path.join(app,'config.json'),'{}');
  result=await readAgents({home});
  assert.ok(![...result.targets.values()].some(target=>target.origin==='claude-desktop'));
});
