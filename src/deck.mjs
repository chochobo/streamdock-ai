import { PROFILES, layoutFor } from './device-profiles.mjs';

/** The project/session selector. It never opens a session itself.
 * The caller must block key input during physical redraw, then commit only after
 * every key was written. Public IDs are opaque, not raw provider session IDs.
 * Key positions come from a device layout (see device-profiles.mjs); the
 * default is the 293S V3 layout. */
const DEFAULT_LAYOUT = layoutFor(PROFILES['293sv3']);
const PRIORITY = { blocked: 0, error: 1, working: 2, done: 3, idle: 4, unknown: 5 };
const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 160);
const statusOf = a => Object.hasOwn(PRIORITY, a.status) ? a.status : 'unknown';
const isEstimated = a => (a?.confidence ?? a?.statusConfidence) ? (a.confidence ?? a.statusConfidence) === 'inferred' : a?.source === 'codex-rollout';
const rank = (a, b) => PRIORITY[statusOf(a)] - PRIORITY[statusOf(b)] || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(a.id).localeCompare(String(b.id));

function reconcile(order, desired) {
  const allowed = new Set(desired);
  for (let i = 0; i < order.length; i++) if (order[i] && !allowed.has(order[i])) order[i] = null;
  const known = new Set(order.filter(Boolean));
  for (const id of desired) {
    if (known.has(id)) continue;
    const hole = order.indexOf(null);
    if (hole < 0) order.push(id); else order[hole] = id;
    known.add(id);
  }
  while (order.length && order.at(-1) === null) order.pop();
}

function aggregate(sessions) {
  const counts = { blocked: 0, error: 0, working: 0, done: 0, idle: 0, unknown: 0 };
  for (const session of sessions) counts[statusOf(session)]++;
  const state = Object.keys(PRIORITY).find(key => counts[key]) || 'unknown';
  return { counts, state, estimated: sessions.some(session => statusOf(session) === state && isEstimated(session)) };
}
function empty(index) { return { index, label: '', state: 'empty', kind: 'empty', action: 'none' }; }
function control(index, action, label, enabled) {
  return { index, label, state: 'control', kind: 'control', action: enabled ? action : 'none', disabled: !enabled };
}

// One 5-hour or 7-day window is displayed as two tiles: usage and reset.
function usageWindows(usage) {
  const provided = Array.isArray(usage?.accounts) ? usage.accounts : [];
  const accounts = provided.length ? provided : [
    { id: 'codex-unavailable', provider: 'codex', label: 'Codex', status: 'unavailable', windows: [] },
    { id: 'claude-unavailable', provider: 'claude', label: 'Claude', status: 'unavailable', windows: [] },
  ];
  const entries = [];
  const priority = { codex: 0, claude: 1 };
  const selected = accounts.slice(0, 64).filter(account => account && typeof account === 'object')
    .sort((a, b) => (priority[a.provider] ?? 2) - (priority[b.provider] ?? 2) || String(a.id || a.label || '').localeCompare(String(b.id || b.label || '')));
  const counts = new Map();
  for (const account of selected) counts.set(account.provider, (counts.get(account.provider) || 0) + 1);
  const seen = new Map();
  for (const account of selected) {
    if (!account || typeof account !== 'object') continue;
    const provider = account.provider === 'codex' ? 'codex' : account.provider === 'claude' ? 'claude' : 'other';
    const providerName = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : '계정';
    const position = (seen.get(account.provider) || 0) + 1;
    seen.set(account.provider, position);
    const label = (counts.get(account.provider) || 0) > 1 ? `${providerName} ${position}` : providerName;
    const accountLabel = clean(account.label || providerName);
    const reported = account.status === 'unavailable' ? [] : (Array.isArray(account.windows) ? account.windows.filter(window => window && typeof window === 'object').slice(0, 16) : []);
    const windows = reported.length ? reported : [{ label: '한도', accountUnavailable: true }];
    for (const window of windows) {
      if (!window || typeof window !== 'object') continue;
      const status = account.status === 'ok' ? (window.status === 'stale' ? 'stale' : 'ok') : account.status === 'stale' ? 'stale' : 'unavailable';
      const value = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 ? Math.round(window.usedPercent) : null;
      const reset = typeof window.resetsAt === 'string' ? new Date(window.resetsAt) : null;
      const validReset = reset && Number.isFinite(reset.getTime());
      // Desktop may expose only the weekday and time. Preserve that label;
      // it is not enough evidence to infer a calendar date or epoch.
      const resetLabel = typeof window.resetLabel === 'string' ? /^([월화수목금토일]) ([01][0-9]|2[0-3]):([0-5][0-9])$/u.exec(window.resetLabel) : null;
      const pad = value => String(value).padStart(2, '0');
      const bucketId = provider === 'codex' && typeof window.id === 'string' && window.id.includes(':') ? clean(window.id.split(':')[0]) : null;
      const windowLabel = clean(String(window.label || '한도').split('·').at(-1));
      entries.push({
        label: bucketId && bucketId !== 'codex' ? `C${(counts.get(account.provider) || 0) > 1 ? position : ''}:${bucketId}` : label, accountLabel, provider, bucketId, windowLabel,
        usedPercent: status === 'unavailable' ? null : value,
        resetDate: status === 'unavailable' ? null : validReset ? `${pad(reset.getMonth() + 1)}/${pad(reset.getDate())}` : resetLabel ? resetLabel[1] : null,
        resetTime: status === 'unavailable' ? null : validReset ? `${pad(reset.getHours())}:${pad(reset.getMinutes())}` : resetLabel ? `${resetLabel[2]}:${resetLabel[3]}` : null,
        usageStatus: window.accountUnavailable ? 'unavailable' : status,
        accountUnavailable: Boolean(window.accountUnavailable),
      });
    }
  }
  return entries;
}

// Split usage tiles into pages. A usage/reset pair needs two physically
// adjacent keys (index n and n + 1), so it never straddles a summary key or
// a gap; on the XL every such break is also a row break.
function usagePages(windows, positions) {
  const pages = [[]];
  let cursor = 0;
  for (const window of windows) {
    const size = window.accountUnavailable ? 1 : 2;
    for (let attempt = 0; attempt < 2; attempt++) {
      let at = cursor;
      if (size === 2) while (at + 1 < positions.length && positions[at + 1] !== positions[at] + 1) at++;
      if (at + size <= positions.length) {
        pages.at(-1).push({ window, indexes: positions.slice(at, at + size) });
        cursor = at + size;
        break;
      }
      if (attempt === 0 && pages.at(-1).length) { pages.push([]); cursor = 0; continue; }
      break;
    }
  }
  return pages;
}

// keyTileSvg infers the arrow of a disabled prev/next key only at the 293S
// positions 13/14. Elsewhere name the action; disabled keys stay unbound.
function nameDisabledArrows(keys, controls) {
  for (const action of ['prev', 'next']) {
    const index = controls[action];
    if (keys[index].disabled && index !== DEFAULT_LAYOUT.controls[action]) keys[index] = { ...keys[index], action };
  }
}

export function createDeck() {
  let view = 'projects';
  let scope = 'live';
  let selectedProject = null;
  let projectPage = 0;
  let sessionPage = 0;
  let usagePage = 0;
  const projectOrders = { live: [], history: [] };
  const sessionOrdersByScope = { live: new Map(), history: new Map() };
  let committed = null;
  let committedSignature = '';
  let revision = 0;
  let navigationPending = false;

  function plan(agents = [], usage = {}, layout = DEFAULT_LAYOUT) {
    const { keyCount, controls, homeContent, pageContent } = layout;
    const roots = agents.filter(a => a && typeof a.id === 'string' && a.id && !a.isSubagent && (scope === 'live' ? a.presence === 'live' : a.presence !== 'live'));
    const projectOrder = projectOrders[scope];
    const sessionOrders = sessionOrdersByScope[scope];
    const grouped = new Map();
    for (const agent of roots) {
      const id = clean(agent.projectId || agent.project || 'unknown');
      if (!id) continue;
      const name = clean(agent.project || '알 수 없음');
      let group = grouped.get(id);
      if (!group) { group = { id, name, sessions: [] }; grouped.set(id, group); }
      group.sessions.push(agent);
    }
    const orderedGroups = [...grouped.values()].map(group => {
      group.sessions.sort(rank);
      const latestUpdatedAt = group.sessions.reduce((latest, session) => String(session.updatedAt || '') > latest ? String(session.updatedAt) : latest, '');
      return { ...group, ...aggregate(group.sessions), total: group.sessions.length, latestUpdatedAt };
    }).sort((a, b) => PRIORITY[a.state] - PRIORITY[b.state] || b.latestUpdatedAt.localeCompare(a.latestUpdatedAt) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    reconcile(projectOrder, orderedGroups.map(group => group.id));
    for (const group of orderedGroups) {
      if (!sessionOrders.has(group.id)) sessionOrders.set(group.id, []);
      reconcile(sessionOrders.get(group.id), group.sessions.map(a => a.id));
    }
    for (const id of sessionOrders.keys()) if (!grouped.has(id) && id !== selectedProject?.id) sessionOrders.delete(id);
    const groupById = new Map(orderedGroups.map(group => [group.id, group]));
    const keys = Array.from({ length: keyCount }, (_, index) => empty(index));
    const bindings = Array(keyCount).fill(null);
    let page, pages, project = null;
    if (view === 'projects') {
      const capacity = homeContent.length;
      pages = Math.max(1, Math.ceil(projectOrder.length / capacity));
      projectPage = Math.min(projectPage, pages - 1);
      page = projectPage;
      projectOrder.slice(page * capacity, (page + 1) * capacity).forEach((id, slot) => {
        const group = groupById.get(id);
        if (!group) return;
        const index = homeContent[slot];
        const captionName = { blocked: '확인', error: '오류', working: '작업', done: '완료', idle: '대기', unknown: '미확인' }[group.state];
        keys[index] = { index, label: group.name, state: group.state, estimated: group.estimated, kind: 'project', action: 'project', count: group.total, caption: `${captionName} ${group.counts[group.state]}${group.estimated ? '?' : ''}`, detail: `${group.total}개 세션` };
        bindings[index] = { action: 'project', projectId: group.id, projectName: group.name };
      });
      keys[controls.modes] = scope === 'live' ? control(controls.modes, 'modes', '기능', true) : control(controls.modes, 'toggle_scope', '열림', true);
      keys[controls.usage] = control(controls.usage, 'usage', '사용량', true);
      keys[controls.prev] = control(controls.prev, 'prev', '이전', page > 0);
      keys[controls.next] = control(controls.next, 'next', '다음', page + 1 < pages);
    } else if (view === 'usage') {
      const pageGroups = usagePages(usageWindows(usage), pageContent);
      pages = pageGroups.length;
      usagePage = Math.min(usagePage, pages - 1);
      page = usagePage;
      for (const { window, indexes: [usageIndex, resetIndex] } of pageGroups[page]) {
        const state = window.usageStatus === 'ok' && window.usedPercent !== null
          ? (window.usedPercent >= 90 ? 'error' : window.usedPercent >= 70 ? 'blocked' : 'working') : 'unknown';
        keys[usageIndex] = { index: usageIndex, ...window, state, kind: 'quota', action: 'none', disabled: true };
        if (resetIndex !== undefined) keys[resetIndex] = { index: resetIndex, ...window, state, kind: 'quota-reset', action: 'none', disabled: true };
      }
      keys[controls.back] = control(controls.back, 'back', '뒤로', true);
      keys[controls.prev] = control(controls.prev, 'prev', '이전', page > 0);
      keys[controls.next] = control(controls.next, 'next', '다음', page + 1 < pages);
    } else {
      const group = groupById.get(selectedProject?.id);
      project = { ...selectedProject };
      const order = sessionOrders.get(selectedProject?.id) || [];
      const capacity = pageContent.length;
      pages = Math.max(1, Math.ceil(order.length / capacity));
      sessionPage = Math.min(sessionPage, pages - 1);
      page = sessionPage;
      const byId = new Map((group?.sessions || []).map(a => [a.id, a]));
      order.slice(page * capacity, (page + 1) * capacity).forEach((id, slot) => {
        const session = byId.get(id);
        if (!session) return;
        const index = pageContent[slot];
        const provider = clean(session.provider || 'agent');
        const label = clean(session.title || session.name || session.project || provider);
        keys[index] = { index, label, state: statusOf(session), estimated: isEstimated(session), kind: 'session', action: 'session', provider, detail: provider === 'claude' ? 'Claude Code' : provider === 'codex' ? 'Codex' : provider };
        bindings[index] = { action: 'session', sessionId: session.id };
      });
      keys[controls.back] = control(controls.back, 'back', '뒤로', true);
      keys[controls.prev] = control(controls.prev, 'prev', '이전', page > 0);
      keys[controls.next] = control(controls.next, 'next', '다음', page + 1 < pages);
    }
    for (const index of new Set(Object.values(controls))) {
      const key = keys[index];
      if (key.kind === 'control' && !key.disabled) bindings[index] = { action: key.action };
    }
    nameDisabledArrows(keys, controls);
    const signature = JSON.stringify({ view, scope, project, page, bindings });
    const nextRevision = signature === committedSignature ? revision : revision + 1;
    return { revision: nextRevision, view, scope, project, page: page + 1, pages, keys, bindings,
      projects: orderedGroups.map(({ id, name, counts, state, estimated, total }) => ({ id, name, counts, state, estimated, total })),
      message: view === 'sessions' && !groupById.has(selectedProject?.id) ? '프로젝트의 세션을 찾을 수 없습니다.' : view === 'projects' && !orderedGroups.length && scope === 'live' ? '열려 있는 세션을 확인하지 못했습니다. 기능에서 기록을 여세요.' : null,
      _signature: signature };
  }
  function commit(planned) {
    if (!planned || !Array.isArray(planned.bindings) || !Array.isArray(planned.keys) || planned.bindings.length !== planned.keys.length || !Object.values(PROFILES).some(profile => profile.keyCount === planned.bindings.length) || typeof planned._signature !== 'string') throw new TypeError('Invalid deck plan');
    committed = planned;
    committedSignature = planned._signature;
    revision = planned.revision;
    navigationPending = false;
    const { bindings, _signature, ...snapshot } = planned;
    return snapshot;
  }
  function press(index, expectedRevision) {
    if (!committed || !Number.isInteger(index) || index < 0 || index >= committed.bindings.length) return { type: 'none' };
    if (expectedRevision !== undefined && expectedRevision !== revision) return { type: 'stale', revision };
    if (navigationPending) return { type: 'busy' };
    const binding = committed.bindings[index];
    if (!binding) return { type: 'none' };
    if (binding.action === 'session') return { type: 'focus', sessionId: binding.sessionId };
    if (binding.action === 'modes') { navigationPending = true; return { type: 'modes' }; }
    if (binding.action === 'project') { view = 'sessions'; selectedProject = { id: binding.projectId, name: binding.projectName }; sessionPage = 0; }
    else if (binding.action === 'toggle_scope') { scope = scope === 'live' ? 'history' : 'live'; projectPage = 0; selectedProject = null; }
    else if (binding.action === 'usage') { view = 'usage'; selectedProject = null; usagePage = 0; }
    else if (binding.action === 'back') { view = 'projects'; selectedProject = null; }
    else if (binding.action === 'prev') { if (view === 'projects') projectPage = Math.max(0, projectPage - 1); else if (view === 'usage') usagePage = Math.max(0, usagePage - 1); else sessionPage = Math.max(0, sessionPage - 1); }
    else if (binding.action === 'next') { if (view === 'projects') projectPage++; else if (view === 'usage') usagePage++; else sessionPage++; }
    else return { type: 'none' };
    navigationPending = true;
    return { type: 'navigate' };
  }
  function setScope(next) {
    if (next !== 'live' && next !== 'history') throw new TypeError('Unknown scope');
    scope = next;
    view = 'projects';
    selectedProject = null;
    projectPage = 0;
    sessionPage = 0;
    committedSignature = '';
    navigationPending = true;
    return { type: 'navigate' };
  }
  function openUsage() {
    view = 'usage';
    selectedProject = null;
    usagePage = 0;
    committedSignature = '';
    navigationPending = true;
    return { type: 'navigate' };
  }
  return { plan, commit, press, setScope, openUsage };
}
