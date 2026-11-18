/**
 * Pure navigation for optional 293S feature pages.
 * Project, history and usage pages remain owned by deck.mjs. A caller can
 * open this hub with the project home's dedicated feature key, then route
 * the returned actions to feature-specific controllers.
 */

export const LONG_PRESS_MS = 800;
export const PAGE_CAPACITY = 12;
export const MODE_CATALOG = Object.freeze([
  { id: 'summary', label: '요약', detail: '한도와 작업' },
  { id: 'projects', label: '에이전트', detail: '프로젝트와 세션' },
  { id: 'history', label: '기록', detail: '이전 세션' },
  { id: 'usage', label: '사용량', detail: '계정 한도' },
  { id: 'machines', label: '머신', detail: '기기 상태' },
  { id: 'pomodoro', label: '타이머', detail: '집중과 휴식' },
  { id: 'market', label: '주식', detail: '시장 현황' },
  { id: 'games', label: '게임', detail: '미니게임' },
  { id: 'scenes', label: '장면', detail: '화면보호기' },
  { id: 'worktrees', label: '워크트리', detail: '작업 현황' },
  { id: 'parcels', label: '택배', detail: '배송 현황' },
  { id: 'credits', label: '크레딧', detail: '서비스 잔액' },
  { id: 'remote', label: '원격', detail: '원격 에이전트' },
  { id: 'settings', label: '설정', detail: '연결과 밝기' },
].map(Object.freeze));

const VALID_MODES = new Set(MODE_CATALOG.map(mode => mode.id));
const DEFAULT_AVAILABILITY = Object.freeze({ projects: true, history: true, usage: true });
const safeText = (value, max = 80) => Array.from(String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()).slice(0, max).join('');
const empty = index => ({ index, kind: 'empty', state: 'empty', label: '', action: 'none', disabled: true });
const control = (index, action, label, enabled = true) => ({ index, kind: 'control', state: 'control', label, action: enabled ? action : 'none', disabled: !enabled });

function reconcile(order, desired) {
  const allowed = new Set(desired);
  for (let index = 0; index < order.length; index++) if (order[index] && !allowed.has(order[index])) order[index] = null;
  const known = new Set(order.filter(Boolean));
  for (const id of desired) {
    if (known.has(id)) continue;
    const hole = order.indexOf(null);
    if (hole < 0) order.push(id); else order[hole] = id;
    known.add(id);
  }
  while (order.length && order.at(-1) === null) order.pop();
}

/** The feature key exists on the live project home, not on history pages. */
export function isModeHubShortcut({ view, scope, index } = {}) {
  return view === 'projects' && scope === 'live' && index === 11;
}

// Only pass explicitly measured percentages and validated meanings to renderers.
function safeBar(bar) {
  if (!bar || typeof bar !== 'object' || !Number.isFinite(bar.value) || bar.value < 0 || bar.value > 100 ||
      !['used', 'free', 'charge', 'score'].includes(bar.direction)) return null;
  const result = { value: bar.value, direction: bar.direction };
  if (bar.warningAt !== undefined || bar.criticalAt !== undefined) {
    if (!Number.isFinite(bar.warningAt) || !Number.isFinite(bar.criticalAt) || bar.warningAt < 0 ||
        bar.criticalAt > 100 || bar.warningAt > bar.criticalAt) return null;
    result.warningAt = bar.warningAt;
    result.criticalAt = bar.criticalAt;
  }
  if (bar.stale === true) result.stale = true;
  return result;
}

function safeMemory(memory, bar) {
  if (!memory || typeof memory !== 'object' || memory.estimated !== true || !bar || bar.direction !== 'used' ||
      !Number.isSafeInteger(memory.usedBytes) || !Number.isSafeInteger(memory.totalBytes) ||
      memory.usedBytes < 0 || memory.totalBytes <= 0 || memory.usedBytes > memory.totalBytes ||
      Math.round(100 * memory.usedBytes / memory.totalBytes) !== Math.round(bar.value)) return null;
  return { usedBytes: memory.usedBytes, totalBytes: memory.totalBytes, estimated: true };
}

export function createModeRouter() {
  let mode = 'projects';
  let returnMode = 'projects';
  let page = 0;
  let generation = 0;
  let revision = 0;
  let committedSignature = '';
  let committed = null;
  let navigationPending = false;
  const orders = new Map();

  function change(next) {
    mode = next;
    page = 0;
    generation++;
    navigationPending = true;
  }

  function openHub() {
    if (mode !== 'hub') returnMode = mode;
    change('hub');
    return { type: 'navigate', mode };
  }

  function openMode(next) {
    if (!VALID_MODES.has(next)) throw new TypeError('Unknown mode');
    change(next);
    return { type: 'navigate', mode };
  }

  function planPage({ items = [], title, availability = {} } = {}) {
    if (!Array.isArray(items)) throw new TypeError('Items must be an array');
    const isHub = mode === 'hub';
    if (!isHub && (mode === 'projects' || mode === 'usage')) throw new Error('Project and usage views are owned by deck.mjs');
    const source = isHub ? MODE_CATALOG.map(item => ({
      ...item,
      enabled: Object.hasOwn(availability, item.id) ? availability[item.id] === true : DEFAULT_AVAILABILITY[item.id] === true,
      action: 'open_mode',
    })) : items;
    const byId = new Map();
    for (const item of source) {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 160 || byId.has(item.id)) throw new TypeError('Each item needs a unique id');
      byId.set(item.id, item);
    }
    if (!orders.has(mode)) orders.set(mode, []);
    const order = orders.get(mode);
    reconcile(order, [...byId.keys()]);
    const pages = Math.max(1, Math.ceil(order.length / PAGE_CAPACITY));
    page = Math.min(page, pages - 1);
    const keys = Array.from({ length: 15 }, (_, index) => empty(index));
    const bindings = Array(15).fill(null);
    order.slice(page * PAGE_CAPACITY, (page + 1) * PAGE_CAPACITY).forEach((id, index) => {
      const item = byId.get(id);
      if (!item) return;
      const enabled = item.enabled !== false;
      const action = isHub ? 'open_mode' : 'feature_action';
      const bar = safeBar(item.bar);
      const memory = !isHub && mode === 'machines' && id === 'machine-memory' ? safeMemory(item.memory, bar) : null;
      keys[index] = {
        index, id, label: safeText(item.label || id), detail: safeText(item.detail),
        state: safeText(item.state || (isHub ? 'control' : 'idle'), 24),
        kind: safeText(item.kind || (isHub ? 'control' : 'feature'), 24),
        caption: safeText(item.caption, 40), action: enabled ? action : 'none', disabled: !enabled,
        ...(bar ? { bar } : {}),
        ...(memory ? { memory } : {}),
      };
      if (enabled) bindings[index] = isHub ? { action, mode: id } : { action, id, command: safeText(item.action || id, 80) };
    });
    keys[12] = control(12, 'back', '뒤로');
    keys[13] = control(13, 'prev', '이전', page > 0);
    keys[14] = control(14, 'next', '다음', page + 1 < pages);
    for (const index of [12, 13, 14]) if (!keys[index].disabled) bindings[index] = { action: keys[index].action };
    const signature = JSON.stringify({ mode, page, generation, bindings });
    return {
      view: isHub ? 'hub' : 'feature', mode, title: safeText(title || (isHub ? '기능' : MODE_CATALOG.find(item => item.id === mode)?.label || mode)),
      page: page + 1, pages, keys, bindings, revision: signature === committedSignature ? revision : revision + 1,
      _signature: signature, _generation: generation,
    };
  }

  function commit(plan) {
    if (!plan || plan.mode !== mode || plan._generation !== generation || !Array.isArray(plan.bindings) || plan.bindings.length !== 15 || typeof plan._signature !== 'string') throw new TypeError('Stale or invalid mode plan');
    committed = plan;
    committedSignature = plan._signature;
    revision = plan.revision;
    navigationPending = false;
    const { bindings, _signature, _generation, ...snapshot } = plan;
    return snapshot;
  }

  function press(index, { revision: expectedRevision, heldMs = 0 } = {}) {
    if (!committed || !Number.isInteger(index) || index < 0 || index >= 15) return { type: 'none' };
    if (expectedRevision !== undefined && expectedRevision !== revision) return { type: 'stale', revision };
    if (navigationPending || committed.mode !== mode) return { type: 'busy' };
    const binding = committed.bindings[index];
    if (!binding) return { type: 'none' };
    if (binding.action === 'feature_action') return { type: 'action', mode, id: binding.id, action: binding.command, longPress: Number.isFinite(heldMs) && heldMs >= LONG_PRESS_MS };
    if (binding.action === 'open_mode') { change(binding.mode); return { type: 'open', mode }; }
    if (binding.action === 'back') { const next = mode === 'hub' ? returnMode : 'hub'; change(next); return { type: 'open', mode }; }
    if (binding.action === 'prev' || binding.action === 'next') {
      page = Math.max(0, page + (binding.action === 'prev' ? -1 : 1));
      generation++;
      navigationPending = true;
      return { type: 'navigate', mode };
    }
    return { type: 'none' };
  }

  return { current: () => mode, openHub, openMode, planPage, commit, press };
}
