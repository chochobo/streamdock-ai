import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck } from '../src/deck.mjs';

const agent = (id, project, status = 'working', extra = {}) => ({ id, project, projectId: `project-${project}`, provider: 'codex', title: `Task ${id}`, status, presence: 'live', source: 'codex-rollout', updatedAt: '2026-11-09T00:00:00Z', ...extra });
const publish = (deck, agents) => deck.commit(deck.plan(agents));

test('groups root sessions by project and shows session list on press', () => {
  const deck = createDeck();
  const agents = [agent('a','one','working'), agent('b','one','blocked',{provider:'claude'}), agent('child','one','blocked',{isSubagent:true}), agent('c','two','done')];
  const home = publish(deck, agents);
  assert.equal(home.view, 'projects');
  assert.equal(home.projects.length, 2);
  assert.equal(home.keys[0].label, 'one');
  assert.equal(home.keys[0].count, 2);
  assert.equal(home.keys[0].caption, '확인 1?');
  assert.equal(home.keys.length, 15);
  assert.equal(Object.hasOwn(home, 'bindings'), false);
  assert.deepEqual(deck.press(0, home.revision), { type: 'navigate' });
  assert.deepEqual(deck.press(0, home.revision), { type: 'busy' });
  const sessions = publish(deck, agents);
  assert.equal(sessions.view, 'sessions');
  assert.equal(sessions.project.name, 'one');
  assert.equal(sessions.keys[0].label, 'Task b');
  assert.equal(sessions.keys[0].provider, 'claude');
  assert.equal(sessions.keys[1].label, 'Task a');
  assert.deepEqual(deck.press(0, sessions.revision), { type: 'focus', sessionId: 'b' });
  assert.equal(sessions.keys[12].action, 'back');
  assert.deepEqual(deck.press(12, sessions.revision), { type: 'navigate' });
  assert.equal(publish(deck, agents).view, 'projects');
});

test('retains positions across status changes and rejects stale web presses', () => {
  const deck = createDeck();
  let agents = [agent('a','alpha'), agent('b','bravo','done')];
  const first = publish(deck, agents);
  agents = [agent('a','alpha','done'), agent('b','bravo','blocked')];
  const updated = publish(deck, agents);
  assert.equal(updated.keys[0].label, first.keys[0].label);
  assert.equal(updated.keys[1].label, first.keys[1].label);
  assert.equal(updated.revision, first.revision);
  assert.deepEqual(deck.press(1, first.revision), {type:'navigate'});
  const selected = publish(deck, agents);
  assert.equal(selected.project.name, 'bravo');
  assert.equal(deck.press(0, first.revision).type, 'stale');
  assert.deepEqual(deck.press(0, selected.revision), {type:'focus', sessionId:'b'});
});

test('uses project identity rather than shared folder display name', () => {
  const deck = createDeck();
  const state = publish(deck, [agent('a','same','working',{projectId:'first'}), agent('b','same','done',{projectId:'second'})]);
  assert.equal(state.projects.length, 2);
  assert.deepEqual(state.projects.map(x => x.id).sort(), ['first','second']);
});

test('paginates projects and sessions with separate back and page controls', () => {
  const deck = createDeck();
  const agents = Array.from({length: 14}, (_, i) => agent(`p${i}`,`p${i}`));
  let state = publish(deck, agents);
  assert.equal(state.pages, 2);
  assert.equal(state.keys[14].action, 'next');
  assert.deepEqual(deck.press(14, state.revision), {type:'navigate'});
  state = publish(deck, agents);
  assert.equal(state.page, 2);
  assert.equal(state.keys[0].action, 'project');
  assert.equal(state.keys[13].action, 'prev');
  assert.equal(state.keys[14].action, 'none');

  const other = createDeck();
  const many = Array.from({length: 13}, (_, i) => agent(`s${i}`,'same'));
  let selection = publish(other,many);
  other.press(0,selection.revision);
  selection = publish(other,many);
  assert.equal(selection.pages,2);
  assert.equal(selection.keys[12].action,'back');
  assert.equal(selection.keys[14].action,'next');
  other.press(14,selection.revision);
  selection = publish(other,many);
  assert.equal(selection.page,2);
  assert.equal(selection.keys[0].action,'session');
  assert.equal(selection.keys[13].action,'prev');
});

test('does not apply a new mapping until commit, and leaves holes on removal', () => {
  const deck = createDeck();
  let agents = [agent('a','alpha'),agent('b','bravo'),agent('c','charlie')];
  const home = publish(deck,agents);
  agents = [agents[0],agents[2]];
  const pending = deck.plan(agents);
  assert.equal(pending.keys[1].action, 'none');
  assert.equal(pending.keys[2].label, home.keys[2].label);
  // Before a successful physical write, the old displayed mapping remains active.
  assert.deepEqual(deck.press(0,home.revision), {type:'navigate'});
  // While navigation is pending no old key can trigger a second action.
  assert.equal(deck.press(2,home.revision).type, 'busy');
  const next = publish(deck,agents);
  assert.equal(next.view,'sessions');
  assert.equal(deck.press(2,home.revision).type,'stale');
});

test('orders new projects by status then latest session but does not reshuffle committed slots', () => {
  const deck = createDeck();
  const early = '2026-11-09T00:00:00Z';
  const later = '2026-11-09T00:10:00Z';
  const newest = '2026-11-09T00:20:00Z';
  const agents = [
    agent('old','alpha','unknown',{updatedAt:early}),
    agent('recent','zeta','unknown',{updatedAt:later}),
    agent('live','work','working',{updatedAt:early}),
    // Group recency is based on its most recent root session, not name.
    agent('newest','zeta','unknown',{updatedAt:newest}),
  ];
  const first = publish(deck,agents);
  assert.deepEqual(first.keys.slice(0,3).map(k => k.label),['work','zeta','alpha']);
  const updated = publish(deck, agents.map(a => a.id === 'old' ? {...a, updatedAt:'2026-11-09T01:00:00Z', status:'blocked'} : a));
  assert.deepEqual(updated.keys.slice(0,3).map(k => k.label),['work','zeta','alpha']);
  assert.equal(updated.revision,first.revision);
});

test('shows confirmed live roots by default and keeps unknown and ended in history', () => {
  const deck = createDeck();
  const agents = [
    agent('live','mixed','working'),
    agent('old','mixed','unknown',{presence:'unknown'}),
    agent('closed','other','done',{presence:'ended'}),
    agent('missing','third','unknown',{presence:undefined}),
    agent('sub','mixed','working',{isSubagent:true}),
  ];
  const live = publish(deck, agents);
  assert.equal(live.scope, 'live');
  assert.deepEqual(live.projects.map(p => [p.name,p.total]), [['mixed',1]]);
  assert.equal(live.keys[11].action, 'modes');
  assert.equal(live.keys[11].label, '기능');
  assert.equal(deck.press(0,live.revision).type, 'navigate');
  const liveSessions = publish(deck, agents);
  assert.deepEqual(liveSessions.keys.filter(k=>k.action==='session').map(k=>k.label), ['Task live']);
  assert.equal(deck.press(12,liveSessions.revision).type, 'navigate');
  const home = publish(deck, agents);
  assert.equal(deck.press(11,home.revision).type, 'modes');
  assert.equal(deck.press(0,home.revision).type, 'busy');
  assert.equal(deck.setScope('history').type, 'navigate');
  const history = publish(deck, agents);
  assert.equal(history.scope, 'history');
  assert.equal(history.keys[11].label, '열림');
  assert.deepEqual(new Set(history.projects.map(p=>p.name)), new Set(['mixed','other','third']));
  assert.equal(deck.press(11,home.revision).type,'stale');
  const mixed = history.keys.find(k=>k.action==='project' && k.label==='mixed');
  assert.equal(deck.press(mixed.index,history.revision).type,'navigate');
  const historySessions = publish(deck,agents);
  assert.deepEqual(historySessions.keys.filter(k=>k.action==='session').map(k=>k.label), ['Task old']);
});

test('shows an actionable empty live state while retaining history navigation', () => {
  const deck = createDeck();
  const screen = publish(deck, [agent('old','only','unknown',{presence:'unknown'})]);
  assert.deepEqual(screen.projects, []);
  assert.match(screen.message,/기록/);
  assert.equal(screen.keys[11].action,'modes');
  assert.equal(screen.keys[11].disabled,false);
  assert.equal(deck.press(11,screen.revision).type,'modes');
  assert.throws(() => deck.setScope('bad'), /Unknown scope/);
  deck.setScope('history');
  assert.equal(publish(deck, [agent('old','only','unknown',{presence:'unknown'})]).projects[0].name,'only');
});

test('marks inferred live states on project and session keys', () => {
  const deck = createDeck();
  const entries = [agent('inferred','alpha','working',{source:'claude-hook',confidence:'inferred'})];
  const home = publish(deck, entries);
  assert.equal(home.projects[0].estimated,true);
  assert.equal(home.keys[0].estimated,true);
  assert.equal(home.keys[0].caption,'작업 1?');
  assert.equal(deck.press(0,home.revision).type,'navigate');
  const session = publish(deck, entries).keys[0];
  assert.equal(session.estimated,true);
  assert.equal(session.state,'working');
});

test('an observed open but idle session is shown as idle, never working', () => {
  const deck = createDeck();
  const entries = [agent('idle','project','idle',{source:'codex-rollout',confidence:'observed',presence:'live'}), agent('older','project','unknown',{source:'codex-rollout',confidence:'inferred',presence:'live'})];
  const home = publish(deck, entries);
  assert.equal(home.keys[0].state,'idle');
  assert.equal(home.keys[0].caption,'대기 1');
  assert.equal(home.keys[0].estimated,false);
  assert.equal(deck.press(0,home.revision).type,'navigate');
  const session = publish(deck,entries).keys[0];
  assert.equal(session.state,'idle');
  assert.equal(session.estimated,false);
});
