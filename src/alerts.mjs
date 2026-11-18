// Track attention events without changing the agent's reported state. A session
// is acknowledged only after its window-opening request succeeds.
export function createAlertTracker({ maxAgeMs = 5 * 60_000, periodMs = 1000 } = {}) {
  const records = new Map();
  const validStatus = status => status === 'blocked' || status === 'done';
  function update(agents, now = Date.now()) {
    const seen = new Set();
    for (const agent of agents || []) {
      if (!agent || typeof agent.id !== 'string' || !agent.id || agent.isSubagent || agent.presence !== 'live') continue;
      seen.add(agent.id);
      const previous = records.get(agent.id);
      const time = Date.parse(agent.updatedAt || '');
      const fresh = Number.isFinite(time) && time <= now && now - time <= maxAgeMs && !agent.stale;
      const eligible = validStatus(agent.status) && fresh;
      const identity = eligible ? `${agent.status}:${time}` : null;
      // An index refresh can change timestamps without a new status event. Only
      // timestamp changes from explicit event sources can re-arm an alert.
      const eventSource = ['streamdock-hook', 'agentdeck-hook', 'codex-rollout'].includes(agent.source);
      const changed = eligible && (!previous || previous.status !== agent.status ||
        (eventSource && previous.identity !== identity && time > previous.time));
      records.set(agent.id, {
        status: agent.status, time: Number.isFinite(time) ? time : 0, identity,
        projectId: String(agent.projectId || agent.project || 'unknown'),
        estimated: agent.confidence !== 'observed',
        pending: eligible && (changed || Boolean(previous?.pending)),
      });
    }
    for (const id of records.keys()) if (!seen.has(id)) records.delete(id);
  }
  function acknowledge(sessionId) {
    const record = records.get(sessionId);
    if (!record || !record.pending) return false;
    record.pending = false;
    return true;
  }
  function decorate(plan, now = Date.now()) {
    if (!plan || !Array.isArray(plan.keys) || !Array.isArray(plan.bindings)) return plan;
    const lit = Math.floor(now / periodMs) % 2 === 0;
    const keys = plan.keys.map((key, index) => {
      const binding = plan.bindings[index];
      let alerts = [];
      if (key.kind === 'session' && binding?.sessionId) {
        const record = records.get(binding.sessionId);
        if (record?.pending) alerts = [record];
      } else if (key.kind === 'project' && binding?.projectId) {
        alerts = [...records.values()].filter(item => item.pending && item.projectId === binding.projectId);
      }
      if (!alerts.length) return key;
      // A project with active work can also have an unread completed session.
      // Show that real count while alerting; opening the project is not an acknowledgement.
      const state = alerts.some(item => item.status === 'blocked') ? 'blocked' : 'done';
      const matching = alerts.filter(item => item.status === state);
      if (key.kind === 'project') {
        const project = plan.projects?.find(item => item.id === binding.projectId);
        const estimated = matching.some(item => item.estimated);
        const count = project?.counts?.[state] || matching.length;
        return { ...key, state, estimated, caption: `${state === 'blocked' ? '확인' : '완료'} ${count}${estimated ? '?' : ''}`, alertPulse: lit };
      }
      return { ...key, alertPulse: lit };
    });
    return { ...plan, keys };
  }
  return { update, acknowledge, decorate };
}
