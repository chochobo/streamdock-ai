// XL RGB LED status light (#35). Pure rules: which state the LEDs show and
// when something has to be sent. The bytes live in device.mjs (one table).

/** Colors the LEDs show. Idle is off (brightness 0), not a color. */
export const LED_COLORS = Object.freeze({
  blocked: Object.freeze([255, 170, 0]),
  error: Object.freeze([255, 30, 30]),
  working: Object.freeze([0, 210, 110]),
});

const isLiveSession = agent => Boolean(agent) && typeof agent === 'object' && !agent.isSubagent && agent.presence === 'live';

/** The most urgent live session decides: waiting > error > working > idle. */
export function ledStateFor(agents) {
  const live = Array.isArray(agents) ? agents.filter(isLiveSession) : [];
  for (const state of ['blocked', 'error', 'working']) if (live.some(agent => agent.status === state)) return state;
  return 'idle';
}

/** What to send for a state. `key` changes whenever the LEDs would look different. */
export function ledTarget(state, brightness) {
  const rgb = LED_COLORS[state] ? [...LED_COLORS[state]] : null;
  const level = rgb ? brightness : 0;
  return { state, rgb, brightness: level, key: `${state}:${level}` };
}

/**
 * Keeps the LEDs matching the agents without resending an unchanged state.
 * Off (or no LEDs, or no connection) sends nothing; turning the feature off
 * restores the device's own effect once. A reconnect forgets what was sent so
 * the current state is applied again.
 */
export function createLedSync({ setLeds, resetLeds, maxFailures = 3 }) {
  let lastKey = null;
  let lastEpoch = null;
  let failedKey = null;
  let failures = 0;
  return {
    async sync({ enabled, supported, connected, agents, brightness, epoch = 0 }) {
      if (!supported || !connected) { lastKey = null; return 'skipped'; }
      // A new connection starts with the device's own effect: apply the state again.
      if (epoch !== lastEpoch) { lastEpoch = epoch; lastKey = null; failedKey = null; failures = 0; }
      if (!enabled) {
        if (lastKey === null) return 'idle';
        lastKey = null;
        await resetLeds();
        return 'reset';
      }
      const target = ledTarget(ledStateFor(agents), brightness);
      if (target.key === lastKey) return 'unchanged';
      // A device that keeps refusing a state is not asked again until the state changes.
      if (target.key === failedKey && failures >= maxFailures) return 'failed';
      const ok = await setLeds({ rgb: target.rgb, brightness: target.brightness });
      if (!ok) {
        failures = target.key === failedKey ? failures + 1 : 1;
        failedKey = target.key;
        return 'failed';
      }
      lastKey = target.key;
      failedKey = null;
      failures = 0;
      return 'set';
    },
    async shutdown() {
      if (lastKey === null) return;
      lastKey = null;
      await resetLeds();
    },
  };
}
