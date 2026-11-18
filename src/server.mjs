import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { readFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDevice, keyTileSvg } from './device.mjs';
import { createNativeDevice } from './native-hid.mjs';
import { readAgents } from './agents.mjs';
import { buildSummary, summarySvgs, summaryKeySvgs } from './summary.mjs';
import { PROFILES, DEFAULT_PROFILE_ID, profileById, layoutFor, publicLayout } from './device-profiles.mjs';
import { createDeck } from './deck.mjs';
import { focusSession } from './focus.mjs';
import { createCodexUsageProvider } from './usage-codex.mjs';
import { buildUsagePace } from './usage-pace.mjs';
import { readClaudeUsage } from './usage-claude.mjs';
import { createClaudeDesktopUsageProvider } from './usage-claude-desktop.mjs';
import { createGameBridge } from './game-bridge.mjs';
import { createSceneBridge } from './scene-bridge.mjs';
import { createSoundController } from './sound.mjs';
import { createRemoteProvider } from './remote.mjs';
import { readCredits } from './credits.mjs';
import { createWorktreeService } from './worktrees.mjs';
import { createCleanupService } from './cleanup.mjs';
import { createSettings, validateSettingsPatch } from './settings.mjs';
import { createNativeProviderSettings } from './native-provider-settings.mjs';
import { translateKeys } from './i18n.mjs';
import { createAlertTracker } from './alerts.mjs';
import { createUpdater, readUpdateConfig } from './update.mjs';
import { createModeRouter } from './modes.mjs';
import { featureItems } from './feature-pages.mjs';
import { createPomodoro } from './pomodoro.mjs';
import { createMachineMonitor } from './machines.mjs';
import { createMarketProvider } from './market.mjs';
import { readMarketConfig } from './market-config.mjs';
import { createParcelsProvider } from './parcels.mjs';
import { createParcelImport } from './parcel-import.mjs';

const runExternal = promisify(execFile);
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const interval = 2000;
const mode = process.argv.includes('--device') ? 'hardware' : 'simulator';
// Only a native app which launched this instance receives this capability.
const nativeToken = /^[a-f0-9]{64}$/.test(process.env.STREAMDOCK_NATIVE_TOKEN || '') ? Buffer.from(process.env.STREAMDOCK_NATIVE_TOKEN, 'hex') : null;
let nativeSummaryKey = '';
let nativeSummaryFrames = [];
// The connected device decides the layout. Before one is detected, use
// STREAMDOCK_MODEL, else the 293S V3. device.profile() keeps the last
// detected model while disconnected, so the layout follows it.
const initialProfile = process.env.STREAMDOCK_MODEL ? profileById(process.env.STREAMDOCK_MODEL) : PROFILES[DEFAULT_PROFILE_ID];
let layout = layoutFor(initialProfile);
let nativeKeyCache = Array(layout.keyCount).fill(null);
const nativeProviders = nativeToken ? createNativeProviderSettings() : null;
const deck = createDeck();
const router = createModeRouter();
const pomodoro = await createPomodoro();
let marketConfig = await readMarketConfig();
let marketProvider = createMarketProvider(marketConfig);
const parcelsProvider = createParcelsProvider();
const parcelImporter = createParcelImport();
const immediateKeys = new Set();
const swiftHidPath = mode === 'hardware' ? process.env.STREAMDOCK_SWIFT_HID_PATH : undefined;
const deviceFactory = swiftHidPath ? options => createNativeDevice({ ...options, helperPath: swiftHidPath }) : createDevice;
const device = deviceFactory({ mode, profile: initialProfile, onKeyEvent: (index, action, heldMs) => {
  if (reconnecting) { immediateKeys.delete(index); return; }
  if (action === 'cancel') { immediateKeys.delete(index); return; }
  // Summary keys have no action; scenes and games only use the legacy area.
  if (!Number.isInteger(index) || index < 0 || index >= layout.keyCount || layout.summaryKeys.includes(index) ||
      (legacyFrameActive() && !layout.legacy.keys.includes(index))) { immediateKeys.delete(index); return; }
  const sceneExitKey = layout.legacy.keys[14];
  if (action === 'down' && legacyFrameActive()) {
    immediateKeys.add(index);
    if (router.current() === 'games') enqueueGameInput(index);
    else if (index !== sceneExitKey) handlePhysicalPress(index, 0);
    return;
  }
  if (action === 'up') {
    if (immediateKeys.delete(index)) {
      if (displayOwner === 'router' && router.current() === 'scenes' && sceneFrame && index === sceneExitKey) handlePhysicalPress(index, heldMs);
      return;
    }
    handlePhysicalPress(index, heldMs);
  }
}, onControl: event => handleRocker(event) });
let snapshot = { device: { connected: false, model: '', error: '시작 중' }, agents: [], warnings: [], updatedAt: null, refreshIntervalMs: interval };
let pending;
let reconnecting = false;
let reconnectPending;
let reconnectDelayMs = 1000;
let reconnectNextAttempt = 0;
let lastRender = '';
let alertPlan = null;
let blinkPending;
const alerts = createAlertTracker();
let lastSummary = '';
let targets = new Map();
let committedDeck = null;
let rendering = false;
let actionBusy = false;
let feedback = '';
let feedbackError = false;
let lastInputOutcome = null;
let displayOwner = 'deck';
let committedOwner = null;
let globalRevision = 0;
let globalSignature = '';
const machineMonitor = createMachineMonitor();
let machineSnapshot = null;
let machineLastAttempt = 0;
let machineGeneration = 0;
let cachedAgentResult = null;
let scheduledFullRefresh = null;
let machinePending;
let marketView = 'top';
let marketPortfolioConsent = false;
let marketSnapshot = null;
let marketLastAttempt = 0;
let marketPending;
let parcelsSnapshot = null;
let parcelsLastAttempt = 0;
let parcelsPending;
const marketViews = ['top', 'kosdaq', 'movers', 'portfolio', 'sectors', 'macro', 'indices'];
const featureAvailability = { projects: true, history: true, usage: true, summary: true, machines: true, pomodoro: true, market: true, parcels: true, worktrees: true, games: true, scenes: true, credits: true, remote: true, settings: true };
const games = createGameBridge();
const scenes = createSceneBridge();
const sound = createSoundController();
const settings = createSettings();
let settingsWarning = null;
let updateConfig = await readUpdateConfig();
let updater = createUpdater({ remoteUrl: updateConfig.remoteUrl || null, branch: updateConfig.branch || 'main' });
let updateSnapshot = { configured: updateConfig.enabled === true, status: updateConfig.enabled ? 'local_only' : 'not_configured', canCheck: updateConfig.enabled === true, canPrepare: false };
let updatePending;
let updateReview = null;
let updateConfigLastAttempt = 0;
try { await settings.load(); sound.setEnabled(settings.get().sound.enabled); }
catch { settingsWarning = '설정을 읽지 못했습니다.'; }
let lastInteraction = Date.now();
let autoScene = false;
const remoteProvider = createRemoteProvider();
const worktreeService = createWorktreeService({
  roots: () => [...new Set([...targets.values()].map(value => value?.cwd).filter(value => typeof value === 'string' && value.startsWith('/')))].slice(0, 16),
  getActivity: async () => ({ complete: false, paths: (snapshot.agents || []).filter(a => a.presence === 'live').map(a => targets.get(a.id)?.cwd).filter(Boolean) }),
});
const cleanupService = createCleanupService();
let remoteSnapshot = null, remotePending, remoteLastAttempt = 0, remoteReview = null;
let creditsSnapshot = null, creditsPending, creditsLastAttempt = 0;
let worktreesSnapshot = null, worktreesPending, worktreesLastAttempt = 0;
let parcelReview = null, parcelImportReview = null, parcelImportPending;
let cleanupState = null, cleanupPending;
let worktreeReview = null, worktreePending;
let gameFrame = null;
let sceneFrame = null;
let animationPending = false;
const gameInputs = [];
let gameInputDraining = false;
let gameHudCache = null;
let gameHudKey = '';
const gameLabels = { mole: '두더지', simon: '기억 게임', pairs: '짝 맞추기', slot: '슬롯', bj: '블랙잭', poker: '포커', race: '레이스', menu: '게임' };
const codexUsage = createCodexUsageProvider();
const claudeDesktopUsage = createClaudeDesktopUsageProvider();
let usageSnapshot = { accounts: [
  { id: 'codex-local-account', provider: 'codex', label: 'Codex 연결 계정', status: 'unavailable', updatedAt: null, windows: [] },
  { id: 'claude-unavailable', provider: 'claude', label: 'Claude 계정 미확인', status: 'unavailable', updatedAt: null, windows: [] },
], warnings: [], updatedAt: null };
let usagePending;
let usageLastAttempt = 0;

async function reloadMarketConfig() {
  const next = await readMarketConfig();
  if (JSON.stringify(next) !== JSON.stringify(marketConfig)) {
    marketConfig = next;
    marketProvider = createMarketProvider(marketConfig);
    marketPortfolioConsent = false;
  }
}

function requestFeatureData(active, force = false) {
  const now = Date.now();
  if (active === 'machines' && force) {
    // Entering the page invalidates any previous snapshot or in-flight read.
    machineGeneration++;
    machineLastAttempt = 0;
    machineSnapshot = null;
  }
  if (active === 'machines' && !machinePending && (force || now - machineLastAttempt >= 1000)) {
    machineLastAttempt = now;
    const generation = machineGeneration;
    const stillViewingMachines = () => !closing && displayOwner === 'router' && router.current() === 'machines';
    machinePending = machineMonitor.read().then(value => {
      if (generation === machineGeneration && stillViewingMachines()) machineSnapshot = value;
    }).catch(() => {
      if (generation === machineGeneration && stillViewingMachines()) machineSnapshot = { status: 'unavailable' };
    }).finally(() => {
      machinePending = undefined;
      if (!stillViewingMachines()) return;
      if (generation !== machineGeneration) { requestFeatureData('machines'); return; }
      // Serialize a fast repaint after any full refresh already in flight, and
      // reuse its agent scan instead of reading all agent files every second.
      void (async () => {
        if (pending) await pending;
        if (stillViewingMachines()) await refresh(false, true);
      })();
    });
  }
  if (active === 'market' && marketView === 'portfolio' && !marketPortfolioConsent) {
    marketSnapshot = { status: marketConfig.portfolio.length ? 'consent_required' : 'unconfigured', view: 'portfolio', quotes: [], portfolioSymbols: marketConfig.portfolio };
    return;
  }
  if (active === 'market' && !marketPending && (force || now - marketLastAttempt >= 60_000)) {
    const requestedView = marketView;
    marketLastAttempt = now;
    if (process.env.STREAMDOCK_FEATURE_NETWORK_DISABLED === '1') {
      marketSnapshot = { status: 'unavailable', view: requestedView, quotes: [] };
    } else {
      marketPending = marketProvider.read({ view: requestedView, force }).then(value => {
        if (marketView === requestedView) marketSnapshot = value;
      }).catch(() => { if (marketView === requestedView) marketSnapshot = { status: 'unavailable', view: requestedView, quotes: [] }; })
        .finally(() => {
          marketPending = undefined;
          if (marketView !== requestedView && displayOwner === 'router' && router.current() === 'market') requestFeatureData('market', true);
          if (!closing) void refresh();
        });
    }
  }
  if (active === 'settings' && !updatePending && (force || now - updateConfigLastAttempt >= 60_000)) {
    updateConfigLastAttempt = now;
    updatePending = readUpdateConfig().then(config => {
      if (JSON.stringify(config) !== JSON.stringify(updateConfig)) {
        updateConfig = config;
        updater = createUpdater({ remoteUrl: config.remoteUrl || null, branch: config.branch || 'main' });
        updateSnapshot = { configured: config.enabled === true, status: config.enabled ? 'local_only' : 'not_configured', canCheck: config.enabled === true, canPrepare: false };
      }
    }).finally(() => { updatePending = undefined; if (!closing) void refresh(); });
  }
  if (active === 'remote' && !remotePending && (force || now - remoteLastAttempt >= 60_000)) {
    remoteLastAttempt = now;
    remotePending = remoteProvider.read().then(value => { remoteSnapshot = value; })
      .catch(() => { remoteSnapshot = { status: 'unavailable', hosts: [], observations: [] }; })
      .finally(() => { remotePending = undefined; if (!closing) void refresh(); });
  }
  if (active === 'credits' && !creditsPending && (force || now - creditsLastAttempt >= 60_000)) {
    creditsLastAttempt = now;
    creditsPending = (process.env.STREAMDOCK_FEATURE_NETWORK_DISABLED === '1' ? Promise.resolve({ services: [], warnings: [] }) : readCredits()).then(value => { creditsSnapshot = value; })
      .catch(() => { creditsSnapshot = { services: [], warnings: ['크레딧 정보를 읽지 못했습니다.'] }; })
      .finally(() => { creditsPending = undefined; if (!closing) void refresh(); });
  }
  if (active === 'worktrees' && !worktreesPending && (force || now - worktreesLastAttempt >= 60_000)) {
    worktreesLastAttempt = now;
    worktreesPending = worktreeService.list().then(value => { worktreesSnapshot = value; })
      .catch(() => { worktreesSnapshot = { status: 'unavailable', items: [] }; })
      .finally(() => { worktreesPending = undefined; if (!closing) void refresh(); });
  }
  if (active === 'parcels' && !parcelsPending && (force || now - parcelsLastAttempt >= 60_000)) {
    parcelsLastAttempt = now;
    parcelsPending = Promise.all([parcelsProvider.read(), parcelImporter.availability()]).then(([value, availability]) => { parcelsSnapshot = { ...value, ...availability }; })
      .catch(() => { parcelsSnapshot = { status: 'unavailable', parcels: [] }; })
      .finally(() => { parcelsPending = undefined; if (!closing) void refresh(); });
  }
}

async function gameSideImages(frame) {
  const hud = frame.hud || {};
  const key = JSON.stringify([frame.mode, frame.score, frame.coins, hud]);
  if (gameHudCache && gameHudKey === key) return gameHudCache;
  const compact = value => Array.from(String(value || '')).slice(0, 6).join('').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  const lines = [
    [gameLabels[frame.mode] || '게임', hud.phaseLabel || '진행 중'],
    ['상태', hud.primary || String(Math.round(frame.score))],
    ['정보', hud.secondary || `${Math.round(frame.coins)}코인`],
  ];
  const images = await Promise.all(lines.map(async ([title, value], index) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#101923"/><text x="26" y="32" fill="#aab8c8" font-family="sans-serif" font-size="14" font-weight="bold">${compact(title)}</text><text x="26" y="70" fill="#eef7ff" font-family="sans-serif" font-size="15" font-weight="bold">${compact(value)}</text></svg>`;
    return { slot: 16 + index, image: await sharp(Buffer.from(svg)).png().toBuffer() };
  }));
  gameHudKey = key;
  gameHudCache = images;
  return images;
}

function legacyFrameActive() {
  return displayOwner === 'router' && ((router.current() === 'games' && gameFrame) || (router.current() === 'scenes' && sceneFrame));
}

// Router layout while a scene or game frame is shown: its 15 positions are
// the legacy area, so controls sit where the 293S frame expects them.
function legacyRouterLayout() {
  const keys = layout.legacy.keys;
  return { ...layout, controls: { modes: keys[11], usage: keys[12], back: keys[12], prev: keys[13], next: keys[14] }, homeContent: keys.slice(0, 11), pageContent: keys.slice(0, 12) };
}

let blankKey = null;
async function blankKeyImage() {
  blankKey ||= await sharp({ create: { width: 96, height: 96, channels: 3, background: '#000000' } }).png().toBuffer();
  return blankKey;
}

// Place a 293S-shaped frame (tile index 0-14, side slots 16-18) on the
// current device. Devices without side screens draw the sides as keys and
// blank the summary keys, which render() never touches.
function placeLegacyFrame(tiles, sides, blank) {
  const keys = tiles.map(tile => ({ index: layout.legacy.keys[tile.index], image: tile.image })).filter(tile => Number.isInteger(tile.index));
  if (layout.sideSlots.length) return { keys, sides };
  for (const side of sides) {
    const index = layout.legacy.sides[side.slot - 16];
    if (Number.isInteger(index)) keys.push({ index, image: side.image });
  }
  for (const index of layout.summaryKeys) if (!keys.some(key => key.index === index)) keys.push({ index, image: blank });
  return { keys, sides: [] };
}

// Adopt the profile the device reports. A model change invalidates every
// cache keyed by key position.
function syncLayout() {
  const profile = typeof device.profile === 'function' ? device.profile() : null;
  if (!profile || !Object.values(PROFILES).includes(profile) || profile.id === layout.model) return;
  layout = layoutFor(profile);
  nativeKeyCache = Array(layout.keyCount).fill(null);
  nativeSummaryKey = '';
  nativeSummaryFrames = [];
  immediateKeys.clear();
  gameInputs.length = 0;
  lastRender = '';
  lastSummary = '';
}

// A reconnect can switch the device model while a refresh is awaiting I/O.
// Never send a plan built for one model to another; the next refresh re-plans.
function layoutCurrent() {
  const profile = typeof device.profile === 'function' ? device.profile() : null;
  return !profile || profile.id === layout.model;
}

function recordPhysicalInput(index, result) {
  lastInputOutcome = { index, code: typeof result?.code === 'string' ? result.code : 'error', at: new Date().toISOString() };
  snapshot = { ...snapshot, lastInput: lastInputOutcome };
}

function handlePhysicalPress(index, heldMs) {
  void press(index, undefined, heldMs).then(result => recordPhysicalInput(index, result)).catch(() => recordPhysicalInput(index, { code: 'error' }));
}

// XL rockers (#8). Default mapping, change it here:
// left up/down = the visible prev/next key, left push = the visible back key
// (each only when that key is shown and enabled); right up/down = brightness
// ±10 within 0..100, saved like the brightness setting; right push = reserved.
// Scenes and games ignore rockers.
const ROCKER_KEYS = { up: 'prev', down: 'next', push: 'back' };
const ROCKER_BRIGHTNESS_STEP = { up: 10, down: -10 };
// The rocker never turns the screen fully off (an unlabelled control could make
// the device look dead). The settings range itself stays 0..100.
const ROCKER_BRIGHTNESS_MIN = 10;
// With no saved or sent brightness the device keeps its own level, which the app
// cannot read. Step from the middle so neither direction jumps to an extreme.
const ROCKER_BRIGHTNESS_UNKNOWN = 50;

async function rockerAction(control, action) {
  if (reconnecting || legacyFrameActive()) return { ok: false, code: 'ignored' };
  if (control === 'left' && Object.hasOwn(ROCKER_KEYS, action)) {
    const key = committedDeck?.keys?.find(k => k.kind === 'control' && !k.disabled && k.action === ROCKER_KEYS[action]);
    return key ? press(key.index) : { ok: false, code: 'empty' };
  }
  if (control === 'right' && Object.hasOwn(ROCKER_BRIGHTNESS_STEP, action)) {
    if (rendering || actionBusy) return { ok: false, code: 'busy' };
    if (pending) await pending;
    if (rendering || actionBusy) return { ok: false, code: 'busy' };
    actionBusy = true;
    lastInteraction = Date.now();
    try {
      const requested = device.status().requestedBrightness;
      const saved = settings.get().brightness;
      const current = Number.isInteger(requested) ? requested : Number.isInteger(saved) ? saved : ROCKER_BRIGHTNESS_UNKNOWN;
      const step = ROCKER_BRIGHTNESS_STEP[action];
      // Going down never passes the floor and never brightens a level already below it.
      const value = step > 0 ? Math.min(100, current + step) : Math.max(Math.min(current, ROCKER_BRIGHTNESS_MIN), current + step);
      if (value === current && saved === value) return { ok: true, code: 'unchanged' };
      const changed = await device.setBrightness(value);
      if (!changed && device.status().mode !== 'simulator') return { ok: false, code: 'unavailable' };
      try {
        await settings.update({ brightness: value });
      } catch {
        // Keep the device and the saved setting in agreement, as the app's settings endpoint does.
        if (Number.isInteger(requested)) { try { await device.setBrightness(requested); } catch { /* Device error is reported by status. */ } }
        return { ok: false, code: 'error' };
      }
      await refresh(true);
      return { ok: true, code: 'updated' };
    } finally { actionBusy = false; }
  }
  return { ok: false, code: 'empty' };
}

function handleRocker({ control, action } = {}) {
  const record = result => {
    lastInputOutcome = { control: String(control), action: String(action), code: typeof result?.code === 'string' ? result.code : 'error', at: new Date().toISOString() };
    snapshot = { ...snapshot, lastInput: lastInputOutcome };
  };
  void rockerAction(control, action).then(record).catch(() => record({ code: 'error' }));
}

function publicReview(value) {
  if (!value) return null;
  const { token, ...safe } = value;
  return safe;
}

function publicParcelReview(value) {
  if (!value) return null;
  const { token, plan, ...safe } = value;
  return { ...safe, plan: plan ? { destination: plan.destination, count: plan.count, scope: plan.scope } : null };
}

function publicParcelImportReview(value) {
  if (!value) return null;
  const { token, plan, ...safe } = value;
  return { ...safe, plan: plan ? { source: plan.source, count: plan.count } : null };
}

function publicRemoteReview(value) {
  if (!value) return null;
  const { token, plan, ...safe } = value;
  return { ...safe, plan: plan ? { label: plan.label, operation: plan.operation, scope: plan.scope } : null };
}

function publicUpdateReview(value) {
  if (!value) return null;
  const { token, plan, ...safe } = value;
  return { ...safe, plan: plan ? { action: plan.action, current: plan.current, target: plan.target, count: plan.files?.length || 0 } : null };
}

function activeFeatureItems(active, data) {
  if (active === 'games' && gameFrame) {
    const board = Array.from({ length: 10 }, (_, index) => ({ id: `game-key-${index}`, label: String(index + 1), caption: '선택', kind: 'feature', state: 'idle', action: `game:press:${index}` }));
    return [...board, { id: 'game-menu', label: '게임 메뉴', kind: 'control', action: 'game:menu' }, { id: 'game-next', label: '진행', kind: 'control', action: 'game:press:13' }];
  }
  if (active === 'scenes' && sceneFrame) {
    return Array.from({ length: 12 }, (_, index) => ({ id: `scene-key-${index}`, label: String(index + 1), caption: '효과', kind: 'feature', state: 'idle', action: `scene:press:${index}` }));
  }
  return featureItems(active, data);
}

async function refresh(force = false, useCachedAgents = false, reconnectRender = false) {
  if (reconnecting && !reconnectRender) {
    await reconnectPending;
    if (closing) return snapshot;
    return refresh(force, useCachedAgents);
  }
  if (pending) return pending;
  if (actionBusy && !force) return snapshot;
  pending = (async () => {
    if (blinkPending) await blinkPending;
    try {
      // Always yield before rendering so pending is installed even when the
      // agent result is cached; a simultaneous key can then wait safely.
      const result = await (useCachedAgents && cachedAgentResult ? Promise.resolve(cachedAgentResult) : readAgents());
      if (!useCachedAgents || !cachedAgentResult) cachedAgentResult = result;
      const agents = result.agents.map(a => ({
        ...a,
        name: a.title || a.displayName || a.project || a.provider || 'Agent',
        detail: [a.provider, a.displayName ? a.project : null, a.stale ? '오래된 상태' : null].filter(Boolean).join(' · '),
      }));
      alerts.update(agents);
      if (autoScene && sceneFrame && agents.some(a => !a.isSubagent && a.presence === 'live' && a.status === 'blocked')) {
        await scenes.stop();
        sceneFrame = null;
        autoScene = false;
        sound.stopAmbient();
        router.openMode('projects');
        deck.setScope('live');
        displayOwner = 'deck';
      }
      if (parcelReview?.stage === 'review' && Date.parse(parcelReview.expiresAt || '') <= Date.now()) { parcelsProvider.cancelRefresh(); parcelReview = null; }
      if (parcelImportReview?.stage === 'review' && Date.parse(parcelImportReview.expiresAt || '') <= Date.now()) { parcelImporter.cancel(); parcelImportReview = null; }
      if (remoteReview?.stage === 'review' && Date.parse(remoteReview.expiresAt || '') <= Date.now()) { remoteProvider.cancel(); remoteReview = null; }
      if (updateReview?.stage === 'review' && Date.parse(updateReview.expiresAt || '') <= Date.now()) { updater.cancel(); updateReview = null; }
      const usage = usageSnapshot;
      const serviceWarnings = [...(result.warnings || []), ...(settingsWarning ? [settingsWarning] : [])];
      syncLayout();
      const basePlan = deck.plan(agents, usage, layout);
      let plan = basePlan;
      if (displayOwner === 'router') {
        const active = router.current();
        requestFeatureData(active);
        let items = activeFeatureItems(active, { machine: machineSnapshot, pomodoro: pomodoro.snapshot(), market: marketSnapshot || { status: 'unavailable', view: marketView }, parcels: parcelsSnapshot, worktrees: worktreesSnapshot ? { ...worktreesSnapshot, review: publicReview(worktreeReview) } : null, cleanup: publicReview(cleanupState), remote: remoteSnapshot ? { ...remoteSnapshot, confirmation: remoteReview?.stage === 'review' && Date.parse(remoteReview.expiresAt || '') > Date.now() ? { id: remoteReview.id, operation: remoteReview.operation, reviewed: remoteReview.reviewed } : null } : null, credits: creditsSnapshot, usage, agents, settings: { ...settings.get(), sound: sound.status(), update: updateSnapshot, capabilities: { brightness: typeof device.setBrightness === 'function' } } });
        if (active === 'settings' && updateReview?.stage === 'review' && Date.parse(updateReview.expiresAt || '') > Date.now()) items = [
          { id: 'update-review', label: '업데이트', caption: `${updateReview.plan?.files?.length || 0}개 파일`, detail: '앱에서 전체 변경 내용을 확인하세요.', state: 'blocked', kind: 'feature', enabled: false },
          updateReview.reviewed
            ? { id: 'update-apply', label: '업데이트', caption: '소스 적용', detail: '확인 키를 1초 이상 누르면 검토한 소스를 적용합니다.', state: 'blocked', kind: 'feature', action: 'update:apply' }
            : { id: 'update-wait', label: '앱 검토', caption: '확인 필요', detail: '앱에서 전체 변경 내용을 확인하세요.', state: 'unknown', kind: 'feature', enabled: false },
          { id: 'update-cancel', label: '취소', caption: '돌아가기', detail: '업데이트를 취소합니다.', state: 'idle', kind: 'feature', action: 'update:cancel' },
        ];
        if (active === 'parcels' && parcelReview?.stage === 'review' && Date.parse(parcelReview.expiresAt) > Date.now()) items = [
          { id: 'parcel-review', label: 'Cainiao', caption: `${parcelReview.plan?.count || 0}건`, detail: '앱에서 전송할 운송장 번호 전체를 확인하세요.', state: 'blocked', kind: 'feature', enabled: false },
          parcelReview.reviewed
            ? { id: 'parcel-confirm', label: 'Cainiao', caption: '번호 전송', detail: '확인 키를 1초 이상 누르면 표시된 번호를 Cainiao로 전송합니다.', state: 'blocked', kind: 'feature', action: 'parcels:confirm' }
            : { id: 'parcel-wait', label: '앱 검토', caption: '확인 필요', detail: '앱에서 전송 대상을 확인하세요.', state: 'unknown', kind: 'feature', enabled: false },
          { id: 'parcel-cancel', label: '취소', caption: '돌아가기', detail: '배송 조회를 취소합니다.', state: 'idle', kind: 'feature', action: 'parcels:cancel' },
        ];
        const framed = (active === 'games' && gameFrame) || (active === 'scenes' && sceneFrame);
        plan = router.planPage({ items, availability: featureAvailability, layout: framed ? legacyRouterLayout() : layout });
      }
      const language = settings.get().language || 'ko';
      if (displayOwner === 'deck') plan = alerts.decorate(plan);
      plan = { ...plan, keys: translateKeys(plan.keys, language).map(key => ({ ...key, language })) };
      const renderKey = JSON.stringify(plan.keys);
      const nextSignature = `${displayOwner}:${plan._signature}`;
      const updatedAt = new Date().toISOString();
      rendering = true;
      let nativeSideFrames = [];
      let nativeRenderedKeys = [];
      let nativeSummary = null;
      let legacyFrames = [];
      try {
        let rendered = true;
        if (!layoutCurrent()) rendered = false;
        else if (renderKey !== lastRender) rendered = await device.render(plan.keys);
        const activeGame = displayOwner === 'router' && router.current() === 'games' && gameFrame;
        const activeScene = displayOwner === 'router' && router.current() === 'scenes' && sceneFrame;
        const frame = activeScene || activeGame;
        const placed = frame ? placeLegacyFrame(frame.tiles.filter(tile => activeScene || tile.index < 10).map(tile => ({ index: tile.index, image: tile.png })),
          activeScene ? frame.sideTiles.map(tile => ({ slot: tile.slot, image: tile.png })) : await gameSideImages(frame), await blankKeyImage()) : null;
        legacyFrames = placed ? placed.keys : [];
        if (placed && layoutCurrent() && (rendered || device.status().mode === 'simulator')) {
          nativeSideFrames = nativeFrameUrls(placed.sides);
          const frameRendered = await device.renderImages(placed);
          if (device.status().mode !== 'simulator') rendered = rendered && frameRendered;
          lastSummary = '';
        }
        const deviceStatus = device.status();
        if (rendered || deviceStatus.mode === 'simulator' || !deviceStatus.connected) {
          const committed = displayOwner === 'deck' ? deck.commit(plan) : router.commit(plan);
          if (nextSignature !== globalSignature) { globalRevision++; globalSignature = nextSignature; }
          committedOwner = displayOwner;
          alertPlan = displayOwner === 'deck' ? basePlan : null;
          committedDeck = { ...committed, revision: globalRevision, scope: basePlan.scope, projects: basePlan.projects, layout: publicLayout(layout),
            ...(legacyFrames.length ? { frames: legacyFrames.map(tile => ({ index: tile.index, url: `data:image/png;base64,${tile.image.toString('base64')}` })) } : {}) };
          targets = result.targets instanceof Map ? result.targets : new Map();
          if (rendered || deviceStatus.mode === 'simulator') lastRender = renderKey;
        }
        const scoped = agents.filter(a => !a.isSubagent && (basePlan.scope === 'history' ? a.presence !== 'live' : a.presence === 'live') && (displayOwner !== 'deck' || basePlan.view !== 'sessions' || a.projectId === basePlan.project?.id));
        const summary = { ...buildSummary(scoped, updatedAt, [...serviceWarnings, ...(feedbackError ? [feedback] : [])]), language };
        nativeSummary = nativeToken ? summary : null;
        const showSummary = !activeGame && !activeScene;
        if (showSummary && nativeToken) {
          try { nativeSideFrames = await nativeSummarySideFrames(summary); } catch { nativeSideFrames = []; }
        }
        if (nativeToken && committedDeck) {
          try { nativeRenderedKeys = await nativeKeyFrames(committedDeck.keys); } catch { nativeRenderedKeys = []; }
          committedDeck = { ...committedDeck, sideFrames: nativeSideFrames, keyFrames: nativeRenderedKeys };
        }
        const summaryKey = JSON.stringify(summary);
        if (showSummary && summaryKey !== lastSummary && layoutCurrent()) {
          const summaryRendered = await device.renderSummary(summary);
          if (summaryRendered || device.status().mode === 'simulator') lastSummary = summaryKey;
        }
      } finally { rendering = false; }
      snapshot = { device: device.status(), agents, usage, settings: settings.get(), ...(nativeToken ? { summary: nativeSummary } : {}), lastInput: lastInputOutcome, cleanup: publicReview(cleanupState), worktreeReview: publicReview(worktreeReview), parcelReview: publicParcelReview(parcelReview), parcelImportReview: publicParcelImportReview(parcelImportReview), remoteReview: publicRemoteReview(remoteReview), updateReview: publicUpdateReview(updateReview), warnings: serviceWarnings, updatedAt, refreshIntervalMs: interval,
        deck: committedDeck ? { ...committedDeck, message: feedback || committedDeck.message } : null };
    } catch (error) {
      const warnings = [`상태를 갱신하지 못했습니다: ${error.message}`];
      try { await device.renderSummary(buildSummary(snapshot.agents, snapshot.updatedAt, warnings)); } catch { /* Preserve the original error. */ }
      lastSummary = '';
      snapshot = { ...snapshot, device: device.status(), warnings };
    }
    return snapshot;
  })().finally(() => { pending = undefined; });
  return pending;
}

async function refreshUsage() {
  if (process.env.STREAMDOCK_USAGE_DISABLED === '1') return usageSnapshot;
  if (usagePending) return usagePending;
  if (Date.now() - usageLastAttempt < 15_000) return usageSnapshot;
  usageLastAttempt = Date.now();
  usagePending = (async () => {
    const results = await Promise.allSettled([codexUsage.read(), readClaudeUsage(), process.env.STREAMDOCK_DESKTOP_USAGE_DISABLED === '1' ? Promise.resolve({ accounts: [], warnings: [] }) : claudeDesktopUsage.read()]);
    const sources = results.slice(0, 2);
    const desktopSource = results[2];
    const accounts = [];
    const warnings = [];
    const issues = [];
    for (const [index, source] of sources.entries()) {
      if (source.status === 'fulfilled' && source.value && Array.isArray(source.value.accounts)) {
        accounts.push(...source.value.accounts);
        if (Array.isArray(source.value.warnings)) warnings.push(...source.value.warnings);
      } else {
        const provider = index === 0 ? 'codex' : 'claude';
        accounts.push({ id: `${provider}-unavailable`, provider, label: provider === 'codex' ? 'Codex 연결 계정' : 'Claude 계정 미확인', status: 'unavailable', updatedAt: null, windows: [] });
        warnings.push(`${provider === 'codex' ? 'Codex' : 'Claude'} 사용량을 확인할 수 없습니다.`);
      }
    }
    if (desktopSource.status === 'fulfilled' && Array.isArray(desktopSource.value?.accounts)) {
      if (desktopSource.value.accounts.length) {
        for (let i = accounts.length - 1; i >= 0; i--) {
          if (accounts[i].provider === 'claude' && accounts[i].status === 'unavailable' && !accounts[i].windows?.length) accounts.splice(i, 1);
        }
        accounts.push(...desktopSource.value.accounts);
      }
      if (Array.isArray(desktopSource.value.warnings)) warnings.push(...desktopSource.value.warnings);
      if (Array.isArray(desktopSource.value.issues) && desktopSource.value.issues.some(issue => issue?.provider === 'claude-desktop' && issue?.code === 'permission_required')) {
        issues.push({ provider: 'claude-desktop', code: 'permission_required' });
      }
    } else {
      warnings.push('Claude Desktop 사용량을 읽지 못했습니다.');
    }
    const usage = { accounts, warnings, issues, updatedAt: new Date().toISOString() };
    usageSnapshot = { ...usage, pace: buildUsagePace(usage) };
    return usageSnapshot;
  })().finally(() => { usagePending = undefined; });
  const result = await usagePending;
  if (!closing) void refresh();
  return result;
}

async function press(index, revision, heldMs = 0) {
  if (!Number.isInteger(index) || index < 0 || index >= layout.keyCount) return { ok: false, code: 'invalid', message: '버튼 번호가 올바르지 않습니다.' };
  if (actionBusy || reconnecting) return { ok: false, code: 'busy', message: '화면을 갱신 중입니다. 다시 눌러 주세요.' };
  // Preserve the mapping visible when the button was pressed. Wait for a
  // repaint instead of dropping physical input, then reject stale mappings.
  const expectedRevision = revision ?? committedDeck?.revision;
  if (rendering && !pending && !blinkPending) return { ok: false, code: 'busy', message: '화면을 갱신 중입니다. 다시 눌러 주세요.' };
  if (pending) await pending;
  else if (blinkPending) await blinkPending;
  if (rendering || actionBusy) return { ok: false, code: 'busy', message: '화면을 갱신 중입니다. 다시 눌러 주세요.' };
  if (!committedDeck || expectedRevision !== committedDeck.revision) return { ok: false, code: 'stale', message: '화면이 바뀌었습니다. 다시 선택해 주세요.' };
  actionBusy = true;
  lastInteraction = Date.now();
  try {
    // Scene input uses 293S legacy tile numbers; keys outside the area do nothing.
    const sceneIndex = layout.legacy.keys.indexOf(index);
    if (committedOwner === 'router' && router.current() === 'scenes' && sceneFrame && (revision === undefined || (sceneIndex >= 0 && sceneIndex < 12))) {
      if (sceneIndex < 0) return { ok: false, code: 'empty', message: '이 버튼에는 동작이 없습니다.' };
      if (sceneIndex === 14 && heldMs >= 1200) {
        await scenes.stop();
        sceneFrame = null;
        autoScene = false;
        sound.stopAmbient();
        router.openHub();
      } else sceneFrame = await scenes.press(sceneIndex);
      feedback = '';
      feedbackError = false;
      await refresh(true);
      return { ok: true, code: 'updated' };
    }
    const priorMode = committedOwner === 'router' ? router.current() : null;
    const action = committedOwner === 'router' ? router.press(index, { heldMs }) : deck.press(index);
    if (action.type === 'stale') return { ok: false, code: 'stale', message: '화면이 바뀌었습니다. 다시 선택해 주세요.' };
    if (action.type === 'busy') return { ok: false, code: 'busy', message: '화면을 갱신 중입니다. 다시 눌러 주세요.' };
    if (action.type === 'none') return { ok: false, code: 'empty', message: '이 버튼에는 동작이 없습니다.' };
    if (action.type === 'modes') {
      router.openMode('projects');
      router.openHub();
      displayOwner = 'router';
      feedback = '';
      feedbackError = false;
      await refresh(true);
      return { ok: true, code: 'navigated' };
    }
    if (action.type === 'open') {
      if (priorMode === 'machines' && action.mode !== 'machines') machineMonitor.invalidate();
      if (priorMode === 'market' && action.mode !== 'market') marketPortfolioConsent = false;
      if (priorMode === 'parcels' && action.mode !== 'parcels') {
        if (parcelReview?.stage === 'review') { parcelsProvider.cancelRefresh(); parcelReview = null; }
        if (parcelImportPending || parcelImportReview?.stage === 'review') { parcelImporter.cancel(); parcelImportReview = null; }
      }
      if (priorMode === 'remote' && action.mode !== 'remote' && remoteReview?.stage === 'review') { remoteProvider.cancel(); remoteReview = null; }
      if (priorMode === 'scenes' && action.mode !== 'scenes' && sceneFrame) {
        await scenes.stop(); sceneFrame = null; sound.stopAmbient();
      }
      if (priorMode === 'games' && action.mode !== 'games' && gameFrame) {
        await games.menu(); gameFrame = null;
      }
      if (action.mode === 'projects') { deck.setScope('live'); displayOwner = 'deck'; }
      else if (action.mode === 'history') { deck.setScope('history'); displayOwner = 'deck'; }
      else if (action.mode === 'usage') { deck.openUsage(); displayOwner = 'deck'; }
      else { displayOwner = 'router'; requestFeatureData(action.mode, true); }
      feedback = '';
      feedbackError = false;
      await refresh(true);
      return { ok: true, code: 'navigated' };
    }
    if (action.type === 'navigate') {
      feedback = '';
      feedbackError = false;
      await refresh(true);
      return { ok: true, code: 'navigated' };
    }
    if (action.type === 'action') {
      const command = action.action;
      if (action.mode === 'summary' && command === 'summary:projects') {
        router.openMode('projects');
        deck.setScope('live');
        displayOwner = 'deck';
      } else if (action.mode === 'summary' && command === 'summary:usage') {
        router.openMode('usage');
        deck.openUsage();
        displayOwner = 'deck';
      } else if (/^game:(mole|simon|pairs|slot|bj|poker|race)$/.test(command)) {
        gameFrame = await games.start(command.slice(5));
        for (const cue of gameFrame.sounds || []) void sound.play(cue);
      } else if (command === 'game:menu' && gameFrame) {
        await games.menu(); gameFrame = null;
      } else if (/^game:press:(?:[0-9]|13)$/.test(command) && gameFrame) {
        gameFrame = await games.press(Number(command.slice('game:press:'.length)));
        for (const cue of gameFrame.sounds || []) void sound.play(cue);
      } else if (/^scene:(aquarium|fire|rain|beach)$/.test(command)) {
        const scene = command.slice(6);
        sceneFrame = await scenes.start(scene);
        autoScene = false;
        void sound.startAmbient(scene === 'aquarium' ? 'aqua' : scene);
      } else if (command === 'update:check') {
        if (process.env.STREAMDOCK_FEATURE_NETWORK_DISABLED === '1') return { ok: false, code: 'unavailable', message: '업데이트 조회가 비활성화되어 있습니다.' };
        if (updatePending) return { ok: false, code: 'busy', message: '업데이트를 확인 중입니다.' };
        const config = await readUpdateConfig();
        if (!config.enabled) return { ok: false, code: 'unavailable', message: '업데이트 저장소가 설정되지 않았습니다.' };
        updateConfig = config;
        updater = createUpdater({ remoteUrl: config.remoteUrl, branch: config.branch });
        updateSnapshot = { configured: true, status: 'checking', canCheck: false, canPrepare: false };
        updatePending = updater.check({ remote: true }).then(result => {
          updateSnapshot = { configured: true, status: result.ok ? result.status : 'unavailable', canCheck: true, canPrepare: result.ok && result.status === 'update_available', message: result.message || '' };
        }).catch(() => { updateSnapshot = { configured: true, status: 'unavailable', canCheck: true, canPrepare: false, message: '업데이트를 확인하지 못했습니다.' }; })
          .finally(() => { updatePending = undefined; if (!closing) void refresh(); });
      } else if (command === 'update:prepare') {
        if (process.env.STREAMDOCK_FEATURE_NETWORK_DISABLED === '1') return { ok: false, code: 'unavailable', message: '업데이트 조회가 비활성화되어 있습니다.' };
        if (updatePending || !updateSnapshot.canPrepare) return { ok: false, code: 'unavailable', message: '검토할 업데이트가 없습니다.' };
        const config = await readUpdateConfig();
        if (JSON.stringify(config) !== JSON.stringify(updateConfig)) return { ok: false, code: 'stale', message: '업데이트 설정이 바뀌었습니다. 다시 확인하세요.' };
        updateReview = { stage: 'loading', reviewed: false, plan: null };
        updatePending = updater.prepare().then(result => {
          updateReview = result.ok && result.status === 'review'
            ? { stage: 'review', reviewId: randomBytes(24).toString('hex'), reviewed: false, viewed: false, plan: result.plan, token: result.token, expiresAt: result.expiresAt }
            : { stage: 'unavailable', reviewed: false, plan: null, message: result.message || '검토할 변경 내용을 가져오지 못했습니다.' };
        }).catch(() => { updateReview = { stage: 'unavailable', reviewed: false, plan: null, message: '업데이트를 준비하지 못했습니다.' }; })
          .finally(() => { updatePending = undefined; if (!closing) void refresh(); });
      } else if (command === 'update:cancel') {
        if (updatePending) return { ok: false, code: 'busy', message: '업데이트를 확인 중입니다.' };
        updater.cancel(); updateReview = null;
      } else if (command === 'update:apply') {
        if (revision !== undefined || heldMs < 1200) return { ok: false, code: 'device_required', message: '앱 검토 후 기기에서 적용 키를 길게 누르세요.' };
        if (updatePending || updateReview?.stage !== 'review' || !updateReview.reviewed || !updateReview.token || Date.parse(updateReview.expiresAt || '') <= Date.now()) return { ok: false, code: 'expired', message: '업데이트 확인이 없거나 만료되었습니다.' };
        if (JSON.stringify(await readUpdateConfig()) !== JSON.stringify(updateConfig)) return { ok: false, code: 'stale', message: '업데이트 설정이 바뀌었습니다.' };
        const token = updateReview.token;
        updateReview = { ...updateReview, stage: 'running', token: undefined };
        updatePending = updater.apply(token).then(result => {
          updateReview = { stage: result.ok ? 'completed' : 'unavailable', reviewed: false, plan: null, message: result.message || '업데이트 결과를 확인하세요.' };
          feedback = updateReview.message; feedbackError = !result.ok;
        }).catch(() => { updateReview = { stage: 'unavailable', reviewed: false, plan: null, message: '업데이트를 완료하지 못했습니다.' }; feedback = updateReview.message; feedbackError = true; })
          .finally(() => { updatePending = undefined; if (!closing) void refresh(); });
      } else if (command === 'settings:language') {
        await settings.update({ language: settings.get().language === 'en' ? 'ko' : 'en' });
      } else if (command === 'settings:sound') {
        const next = !settings.get().sound.enabled;
        await settings.update({ sound: { enabled: next } });
        sound.setEnabled(next);
      } else if (command === 'settings:screen:toggle') {
        await settings.update({ screensaver: { enabled: !settings.get().screensaver.enabled } });
      } else if (/^settings:screen:idle:(1|5|15)$/.test(command)) {
        await settings.update({ screensaver: { idleMinutes: Number(command.split(':').at(-1)) } });
      } else if (/^settings:screen:scene:(aquarium|fire|rain|beach)$/.test(command)) {
        await settings.update({ screensaver: { scene: command.split(':').at(-1) } });
      } else if (/^settings:brightness:(20|50|80|100)$/.test(command)) {
        const value = Number(command.split(':').at(-1));
        const changed = await device.setBrightness(value);
        if (!changed && device.status().mode !== 'simulator') return { ok: false, code: 'unavailable', message: '장치 밝기를 변경하지 못했습니다.' };
        await settings.update({ brightness: value });
      } else if (command.startsWith('pomodoro:start:')) {
        const minutes = Number(command.slice('pomodoro:start:'.length));
        if (![5, 10, 15, 20, 25, 30, 45, 50, 60, 90].includes(minutes)) return { ok: false, code: 'invalid', message: '타이머 시간을 확인할 수 없습니다.' };
        await pomodoro.start(minutes);
      } else if (command === 'pomodoro:pause') await pomodoro.pause();
      else if (command === 'pomodoro:resume') await pomodoro.resume();
      else if (command === 'pomodoro:reset') await pomodoro.reset();
      else if (command === 'market:next') {
        await reloadMarketConfig();
        marketView = marketViews[(marketViews.indexOf(marketView) + 1) % marketViews.length];
        marketPortfolioConsent = false;
        marketSnapshot = { status: marketView === 'portfolio' ? 'consent_required' : 'unavailable', view: marketView, quotes: [] };
        requestFeatureData('market', true);
      } else if (command === 'market:portfolio:confirm') {
        if (marketView !== 'portfolio') return { ok: false, code: 'stale', message: '시세 화면이 바뀌었습니다.' };
        const shownSymbols = JSON.stringify(marketSnapshot?.portfolioSymbols || []);
        await reloadMarketConfig();
        if (!marketConfig.portfolio.length || shownSymbols !== JSON.stringify(marketConfig.portfolio)) {
          marketPortfolioConsent = false;
          marketSnapshot = { status: marketConfig.portfolio.length ? 'consent_required' : 'unconfigured', view: 'portfolio', quotes: [], portfolioSymbols: marketConfig.portfolio };
          await refresh(true);
          return { ok: false, code: 'stale', message: '종목 설정이 바뀌었습니다. 다시 확인하세요.' };
        }
        if (process.env.STREAMDOCK_FEATURE_NETWORK_DISABLED === '1') return { ok: false, code: 'unavailable', message: '외부 조회가 비활성화되어 있습니다.' };
        marketPortfolioConsent = true;
        requestFeatureData('market', true);
      } else if (command === 'market:heattab') {
        if (process.env.STREAMDOCK_FEATURE_NETWORK_DISABLED === '1') return { ok: false, code: 'unavailable', message: '웹 열기가 비활성화되어 있습니다.' };
        await runExternal('/usr/bin/open', ['https://heattab.app/'], { timeout: 5000 });
      } else if (command === 'market:refresh') {
        if (Date.now() - marketLastAttempt < 15_000) return { ok: false, code: 'busy', message: '시세는 잠시 후 다시 조회하세요.' };
        requestFeatureData('market', true);
      } else if (/^cleanup:prepare:(clean|purge|trash)$/.test(command)) {
        if (cleanupPending) return { ok: false, code: 'busy', message: '정리 대상을 확인 중입니다.' };
        const kind = command.split(':').at(-1);
        cleanupState = { stage: 'loading', reviewed: false, plan: null };
        cleanupPending = cleanupService.prepare(kind).then(result => {
          cleanupState = result.ok
            ? { stage: 'review', reviewId: randomBytes(24).toString('hex'), reviewed: false, plan: result.plan, token: result.token, expiresAt: result.expiresAt }
            : { stage: result.plan?.ok ? 'review' : 'unavailable', reviewed: false, plan: result.plan || null, message: result.message || '실행 가능한 정리 대상을 확인하지 못했습니다.' };
          if (!result.ok) { feedback = cleanupState.message; feedbackError = true; }
        }).catch(() => { cleanupState = { stage: 'unavailable', reviewed: false, plan: null, message: '정리 계획을 만들지 못했습니다.' }; })
          .finally(() => { cleanupPending = undefined; if (!closing) void refresh(); });
      } else if (command === 'cleanup:cancel') {
        if (cleanupPending) return { ok: false, code: 'busy', message: '정리 대상을 확인 중입니다.' };
        cleanupService.cancel(); cleanupState = null;
      } else if (command === 'cleanup:confirm') {
        return { ok: false, code: 'execution_unavailable', message: '정리 실행은 대상 고정 방식이 검증될 때까지 지원하지 않습니다.' };
      } else if (/^worktree:prepare:wt-[a-f0-9]{24}$/.test(command)) {
        if (worktreePending) return { ok: false, code: 'busy', message: '워크트리를 확인 중입니다.' };
        const id = command.slice('worktree:prepare:'.length);
        worktreeReview = { stage: 'loading', reviewed: false, plan: null };
        worktreePending = worktreeService.prepareRemoval(id).then(result => {
          const plan = result.plan ? { ...result.plan, executable: false, count: 1, targets: [{ path: result.plan.path }] } : null;
          worktreeReview = result.ok ? { stage: 'review', reviewId: randomBytes(24).toString('hex'), reviewed: false, plan, token: result.token, expiresAt: result.expiresAt }
            : { stage: 'unavailable', reviewed: false, plan, message: '워크트리 제거 조건을 확인하지 못했습니다.' };
        }).catch(() => { worktreeReview = { stage: 'unavailable', reviewed: false, plan: null, message: '워크트리를 확인하지 못했습니다.' }; })
          .finally(() => { worktreePending = undefined; if (!closing) void refresh(); });
      } else if (command === 'worktree:cancel') {
        if (worktreePending) return { ok: false, code: 'busy', message: '워크트리를 확인 중입니다.' };
        worktreeService.cancelRemoval(); worktreeReview = null;
      } else if (command === 'worktree:confirm') {
        return { ok: false, code: 'execution_unavailable', message: '워크트리 제거는 대상 고정 방식이 검증될 때까지 지원하지 않습니다.' };
      } else if (command === 'parcels:import') {
        if (process.env.STREAMDOCK_FEATURE_NETWORK_DISABLED === '1') return { ok: false, code: 'unavailable', message: '브라우저 연결이 비활성화되어 있습니다.' };
        if (parcelImportPending || !parcelsSnapshot?.importAvailable) return { ok: false, code: 'unavailable', message: '전용 AliExpress 브라우저가 설정되지 않았습니다.' };
        parcelImportReview = { stage: 'loading', plan: null };
        parcelImportPending = parcelImporter.preview({ consent: true }).then(result => {
          parcelImportReview = result.ok
            ? { stage: 'review', reviewId: randomBytes(24).toString('hex'), viewed: false, plan: result.plan, token: result.token, expiresAt: result.expiresAt }
            : { stage: 'unavailable', plan: null, message: '열린 AliExpress 배송 탭에서 항목을 찾지 못했습니다.' };
        }).catch(() => { parcelImportReview = { stage: 'unavailable', plan: null, message: '가져올 배송 항목을 확인하지 못했습니다.' }; })
          .finally(() => { parcelImportPending = undefined; if (!closing) void refresh(); });
      } else if (command === 'parcels:refresh') {
        if (!parcelsSnapshot?.trackingEnabled) return { ok: false, code: 'unavailable', message: '배송 조회가 설정되지 않았습니다.' };
        const prepared = await parcelsProvider.prepareRefresh();
        if (!prepared.ok) return { ok: false, code: prepared.code || 'unavailable', message: '배송 조회 대상을 확인하지 못했습니다.' };
        parcelReview = { stage: 'review', reviewId: randomBytes(24).toString('hex'), reviewed: false, viewed: false, plan: prepared.plan, token: prepared.token, expiresAt: prepared.expiresAt };
        feedback = '앱에서 Cainiao에 전송할 번호를 확인하세요.';
      } else if (command === 'parcels:cancel') {
        parcelsProvider.cancelRefresh(); parcelReview = null;
      } else if (command === 'parcels:confirm') {
        if (process.env.STREAMDOCK_FEATURE_NETWORK_DISABLED === '1') return { ok: false, code: 'unavailable', message: '외부 조회가 비활성화되어 있습니다.' };
        if (revision !== undefined || heldMs < 1200) return { ok: false, code: 'device_required', message: '앱 검토 후 기기의 전송 키를 길게 누르세요.' };
        if (parcelReview?.stage !== 'review' || !parcelReview.reviewed || !parcelReview.token || Date.parse(parcelReview.expiresAt || '') <= Date.now()) return { ok: false, code: 'expired', message: '배송 조회 확인이 없거나 만료되었습니다.' };
        if (parcelsPending) return { ok: false, code: 'busy', message: '배송을 조회 중입니다.' };
        const token = parcelReview.token;
        parcelReview = { ...parcelReview, stage: 'running', token: undefined };
        parcelsPending = parcelsProvider.confirmRefresh(token).then(value => {
          if (value?.ok === false) {
            parcelReview = { stage: 'unavailable', reviewed: false, plan: null, message: '등록 내용이 바뀌었거나 조회가 취소됐습니다.' };
            feedback = parcelReview.message; feedbackError = true;
          } else {
            parcelsSnapshot = value;
            parcelReview = null;
            feedback = value?.status === 'ok' ? '배송 조회를 마쳤습니다.' : '배송 조회 결과를 확인하지 못했습니다.';
            feedbackError = value?.status !== 'ok';
          }
        }).catch(() => { parcelReview = { stage: 'unavailable', reviewed: false, plan: null, message: '배송 조회를 완료하지 못했습니다.' }; feedback = parcelReview.message; feedbackError = true; })
          .finally(() => { parcelsPending = undefined; if (!closing) void refresh(); });
      } else if (/^remote:prepare:[a-f0-9]{20}:(machine|agents|agy)$/.test(command)) {
        const [, , id, operation] = command.split(':');
        const prepared = await remoteProvider.prepare({ id, operation });
        if (!prepared.ok) return { ok: false, code: prepared.code || 'unavailable', message: '원격 조회 대상을 확인하지 못했습니다.' };
        remoteReview = { stage: 'review', id, operation, reviewId: randomBytes(24).toString('hex'), reviewed: false, viewed: false, plan: prepared.plan, token: prepared.token, expiresAt: prepared.expiresAt };
        feedback = '앱에서 원격 호스트와 포트를 확인하세요.';
      } else if (command === 'remote:cancel') {
        remoteProvider.cancel(); remoteReview = null;
      } else if (/^remote:confirm:[a-f0-9]{20}:(machine|agents|agy)$/.test(command)) {
        if (process.env.STREAMDOCK_FEATURE_NETWORK_DISABLED === '1') return { ok: false, code: 'unavailable', message: '원격 조회가 비활성화되어 있습니다.' };
        if (revision !== undefined || heldMs < 1200) return { ok: false, code: 'device_required', message: '앱 검토 후 기기의 연결 키를 길게 누르세요.' };
        const [, , id, operation] = command.split(':');
        if (remoteReview?.stage !== 'review' || !remoteReview.reviewed || !remoteReview.token || remoteReview.id !== id || remoteReview.operation !== operation || Date.parse(remoteReview.expiresAt || '') <= Date.now()) return { ok: false, code: 'expired', message: '원격 조회 확인이 없거나 만료되었습니다.' };
        if (remotePending) return { ok: false, code: 'busy', message: '원격 조회가 진행 중입니다.' };
        const token = remoteReview.token;
        remoteReview = { ...remoteReview, stage: 'running', token: undefined };
        remotePending = remoteProvider.confirm(token).then(async result => {
          if (result?.ok === false) {
            remoteReview = { stage: 'unavailable', reviewed: false, plan: null, message: '원격 대상이 바뀌었거나 조회가 취소됐습니다.' };
            feedback = remoteReview.message; feedbackError = true;
          } else {
            remoteSnapshot = await remoteProvider.read();
            remoteReview = null;
            feedback = result?.status === 'ok' ? '원격 조회를 마쳤습니다.' : '원격 조회 결과를 확인하지 못했습니다.';
            feedbackError = result?.status !== 'ok';
          }
        }).catch(() => { remoteReview = { stage: 'unavailable', reviewed: false, plan: null, message: '원격 조회를 완료하지 못했습니다.' }; feedback = remoteReview.message; feedbackError = true; })
          .finally(() => { remotePending = undefined; if (!closing) void refresh(); });
      } else return { ok: false, code: 'unavailable', message: '이 기능은 아직 사용할 수 없습니다.' };
      if (command !== 'parcels:refresh' && !command.startsWith('remote:prepare:')) feedback = '';
      feedbackError = false;
      await refresh(true);
      return { ok: true, code: 'updated' };
    }
    if (action.type === 'focus') {
      const result = await focusSession(targets.get(action.sessionId));
      if (result.ok) alerts.acknowledge(action.sessionId);
      feedback = result.message || (result.ok ? '열기 요청을 보냈습니다.' : '세션을 열지 못했습니다.');
      feedbackError = !result.ok;
      await refresh(true);
      return result;
    }
    return { ok: false, code: 'invalid', message: '지원하지 않는 동작입니다.' };
  } catch {
    feedback = '동작을 완료하지 못했습니다.';
    feedbackError = true;
    await refresh(true);
    return { ok: false, code: 'error', message: feedback };
  } finally { actionBusy = false; }
}

async function nativeHookDiagnostics() {
  const expected = {
    codex: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd'],
    claude: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'],
  };
  async function inspect(provider) {
    const target = provider === 'codex' ? path.join(os.homedir(), '.codex', 'hooks.json') : path.join(os.homedir(), '.claude', 'settings.json');
    const script = provider === 'codex' ? 'codex-hook.py' : 'agent-hook.py';
    const result = (registration, count = 0) => ({ registration, eventsDetected: count, eventsExpected: expected[provider].length, trust: 'unknown' });
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return result('unknown');
      const raw = await readFile(target, 'utf8');
      if (Buffer.byteLength(raw) > 1024 * 1024) return result('unknown');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.hooks != null && (typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks)))) return result('unknown');
      const hooks = parsed.hooks || {};
      const count = expected[provider].filter(event => Array.isArray(hooks[event]) && hooks[event].some(group =>
        Array.isArray(group?.hooks) && group.hooks.some(hook => hook?.type === 'command' && typeof hook.command === 'string' && hook.command.includes(script)))).length;
      return result(count === expected[provider].length ? 'detected' : count ? 'partial' : 'absent', count);
    } catch (error) { return result(error?.code === 'ENOENT' ? 'absent' : 'unknown'); }
  }
  const [codex, claude] = await Promise.all([inspect('codex'), inspect('claude')]);
  const status = device.status();
  return { codex, claude, device: { connected: status.connected === true, mode: status.mode || '', error: status.error || null } };
}

function nativeAuthorized(req) {
  const supplied = req.headers['x-streamdock-native-token'];
  if (!nativeToken || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(nativeToken, Buffer.from(supplied, 'hex'));
}

async function nativeKeyFrames(keys) {
  if (!nativeToken || !Array.isArray(keys) || keys.length !== layout.keyCount) return [];
  const frames = await Promise.all(keys.map(async (key, index) => {
    if (!key || key.index !== index) return null;
    const svg = keyTileSvg(key);
    const cached = nativeKeyCache[index];
    if (cached?.svg === svg) return cached.frame;
    const image = await sharp(Buffer.from(svg)).png().toBuffer();
    if (!Buffer.isBuffer(image) || !image.length || image.length > 128 * 1024) return null;
    const frame = { index, url: `data:image/png;base64,${image.toString('base64')}` };
    nativeKeyCache[index] = { svg, frame };
    return frame;
  }));
  if (!frames.every(Boolean)) return [];
  // Devices without side screens show the summary on summary keys.
  for (const frame of nativeSummaryFrames) if (frame.index !== undefined && layout.summaryKeys.includes(frame.index)) frames[frame.index] = frame;
  return frames;
}

function nativePublicSnapshot(value, req) {
  if (!nativeToken || nativeAuthorized(req) || !value) return value;
  const { summary: _summary, ...rest } = value;
  if (!rest.deck) return rest;
  const { sideFrames: _side, keyFrames: _keys, ...deck } = rest.deck;
  return { ...rest, deck };
}

function nativeFrameUrls(sides) {
  if (!nativeToken || !Array.isArray(sides)) return [];
  return sides.filter(side => Number.isInteger(side?.slot) && side.slot >= 16 && side.slot <= 18 &&
    Buffer.isBuffer(side.image) && side.image.length > 0 && side.image.length <= 128 * 1024)
    .slice(0, 3).map(side => ({ slot: side.slot, url: `data:image/png;base64,${side.image.toString('base64')}` }));
}

async function nativeSummarySideFrames(summary) {
  if (!nativeToken) return [];
  const key = JSON.stringify([layout.model, summary]);
  if (nativeSummaryKey === key && nativeSummaryFrames.length === 3) return layout.sideSlots.length ? nativeSummaryFrames : [];
  if (!layout.sideSlots.length) {
    // Summary keys are previewed through keyFrames; nativeKeyFrames overlays them.
    const frames = (await Promise.all(summaryKeySvgs(summary).slice(0, layout.summaryKeys.length).map(async (svg, index) => {
      const image = await sharp(Buffer.from(svg)).png().toBuffer();
      if (!Buffer.isBuffer(image) || !image.length || image.length > 128 * 1024) return null;
      return { index: layout.summaryKeys[index], url: `data:image/png;base64,${image.toString('base64')}` };
    }))).filter(Boolean);
    if (frames.length === 3) { nativeSummaryKey = key; nativeSummaryFrames = frames; }
    return [];
  }
  const images = await Promise.all(summarySvgs(summary).map(async (svg, index) => ({
    slot: 16 + index, image: await sharp(Buffer.from(svg)).png().toBuffer(),
  })));
  const frames = nativeFrameUrls(images);
  if (frames.length === 3) { nativeSummaryKey = key; nativeSummaryFrames = frames; }
  return frames;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || '';
    if (!new RegExp(`^(localhost|127\\.0\\.0\\.1):${port}$`).test(host)) return send(res, 403, { error: 'Invalid host' });
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname.startsWith('/api/native/') && !nativeAuthorized(req)) return send(res, 403, { error: 'Native authentication required' });
    if (req.method === 'GET' && url.pathname === '/api/native/identity') return send(res, 200, { application: 'streamdock-ai', protocol: 1 });
    if (req.method === 'GET' && url.pathname === '/api/native/diagnostics') return send(res, 200, await nativeHookDiagnostics());
    if (req.method === 'GET' && url.pathname === '/api/native/settings') return send(res, 200, { settings: settings.get() });
    const providerMatch = new RegExp('^/api/native/providers/(market|parcels|remote|credits)$').exec(url.pathname);
    if (providerMatch && req.method === 'GET') return send(res, 200, await nativeProviders.read(providerMatch[1]));
    if (providerMatch && req.method === 'POST') {
      if (req.headers.origin !== `http://${host}`) return send(res, 403, { error: 'Invalid origin' });
      if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'JSON required' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 64 * 1024) return send(res, 413, { error: 'Request too large' }); }
      let value;
      try { value = JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['revision', 'patch'].includes(k))) return send(res, 400, { error: 'Invalid settings' });
      const kind = providerMatch[1];
      if (actionBusy || (kind === 'market' && marketPending) || (kind === 'parcels' && (parcelsPending || parcelImportPending)) || (kind === 'remote' && remotePending) || (kind === 'credits' && creditsPending)) return send(res, 409, { ok: false, code: 'busy' });
      actionBusy = true;
      try {
        const result = await nativeProviders.update(kind, value);
        if (!result.ok) return send(res, result.code === 'invalid' ? 400 : 409, result);
        if (kind === 'market') {
          await reloadMarketConfig();
          marketPortfolioConsent = false;
          marketLastAttempt = 0;
          marketSnapshot = { status: marketView === 'portfolio' && marketConfig.portfolio.length ? 'consent_required' : 'unavailable', view: marketView, quotes: [], ...(marketView === 'portfolio' ? { portfolioSymbols: marketConfig.portfolio } : {}) };
        } else if (kind === 'parcels') {
          parcelsProvider.cancelRefresh(); parcelImporter.cancel(); parcelReview = null; parcelImportReview = null; parcelsSnapshot = null; parcelsLastAttempt = 0;
        } else if (kind === 'remote') {
          remoteProvider.cancel(); remoteReview = null; remoteSnapshot = null; remoteLastAttempt = 0;
        } else if (kind === 'credits') { creditsSnapshot = null; creditsLastAttempt = 0; }
        return send(res, 200, result);
      } finally { actionBusy = false; }
    }
    if (req.method === 'POST' && url.pathname === '/api/native/settings') {
      if (req.headers.origin !== `http://${host}`) return send(res, 403, { error: 'Invalid origin' });
      if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'JSON required' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) return send(res, 413, { error: 'Request too large' }); }
      let patch;
      try { patch = JSON.parse(body); validateSettingsPatch(patch); } catch { return send(res, 400, { error: 'Invalid settings' }); }
      if (actionBusy) return send(res, 409, { ok: false, code: 'busy', message: '다른 동작이 진행 중입니다.' });
      if (pending) await pending;
      if (rendering || actionBusy) return send(res, 409, { ok: false, code: 'busy', message: '화면을 갱신 중입니다.' });
      actionBusy = true;
      try {
        const before = settings.get();
        const previousRequestedBrightness = device.status().requestedBrightness;
        let brightnessApplied = false;
        if (Object.hasOwn(patch, 'brightness') && patch.brightness !== null && patch.brightness !== before.brightness) {
          const changed = await device.setBrightness(patch.brightness);
          if (!changed) return send(res, 409, { ok: false, code: 'device_unavailable', message: '장치 밝기를 변경하지 못했습니다.' });
          brightnessApplied = true;
        }
        let next;
        try { next = await settings.update(patch); }
        catch {
          if (brightnessApplied) {
            let restored = false;
            if (Number.isInteger(previousRequestedBrightness) && previousRequestedBrightness >= 0 && previousRequestedBrightness <= 100) {
              try { restored = await device.setBrightness(previousRequestedBrightness); } catch { /* Device may have disconnected. */ }
            }
            if (!restored) return send(res, 409, { ok: false, code: 'brightness_applied_not_saved', message: '밝기는 장치에 적용됐지만 설정을 저장하지 못했습니다. 이전 밝기는 확인할 수 없습니다.' });
          }
          return send(res, 409, { ok: false, code: 'settings_not_saved', message: '설정을 저장하지 못했습니다.' });
        }
        sound.setEnabled(next.sound.enabled);
        await refresh(true);
        return send(res, 200, { ok: true, settings: next });
      } finally { actionBusy = false; }
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, nativePublicSnapshot(snapshot, req));
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      if (req.headers.origin !== `http://${host}`) return send(res, 403, { error: 'Invalid origin' });
      return send(res, 200, nativePublicSnapshot(await refresh(), req));
    }
    if (req.method === 'POST' && url.pathname === '/api/usage/refresh') {
      if (req.headers.origin !== `http://${host}`) return send(res, 403, { error: 'Invalid origin' });
      const usage = await refreshUsage();
      await refresh();
      return send(res, 200, { ok: true, usage });
    }
    if (req.method === 'GET' && url.pathname === '/api/parcel-import-review') {
      if (req.headers['x-streamdock-review'] !== '1') return send(res, 403, { error: 'Review header required' });
      if (parcelImportReview?.stage !== 'review' || url.searchParams.get('reviewId') !== parcelImportReview.reviewId || !parcelImportReview.token || Date.parse(parcelImportReview.expiresAt || '') <= Date.now()) return send(res, 404, { error: 'Review unavailable' });
      parcelImportReview.viewed = true;
      return send(res, 200, { ...parcelImportReview.plan, reviewId: parcelImportReview.reviewId });
    }
    if (req.method === 'GET' && url.pathname === '/api/parcel-review') {
      if (req.headers['x-streamdock-review'] !== '1') return send(res, 403, { error: 'Review header required' });
      if (parcelReview?.stage !== 'review' || url.searchParams.get('reviewId') !== parcelReview.reviewId || !parcelReview.token || Date.parse(parcelReview.expiresAt || '') <= Date.now()) return send(res, 404, { error: 'Review unavailable' });
      parcelReview.viewed = true;
      return send(res, 200, { ...parcelReview.plan, reviewId: parcelReview.reviewId });
    }
    if (req.method === 'GET' && url.pathname === '/api/remote-review') {
      if (req.headers['x-streamdock-review'] !== '1') return send(res, 403, { error: 'Review header required' });
      if (remoteReview?.stage !== 'review' || url.searchParams.get('reviewId') !== remoteReview.reviewId || !remoteReview.token || Date.parse(remoteReview.expiresAt || '') <= Date.now()) return send(res, 404, { error: 'Review unavailable' });
      remoteReview.viewed = true;
      return send(res, 200, { ...remoteReview.plan, reviewId: remoteReview.reviewId });
    }
    if (req.method === 'GET' && url.pathname === '/api/update-review') {
      if (req.headers['x-streamdock-review'] !== '1') return send(res, 403, { error: 'Review header required' });
      if (updateReview?.stage !== 'review' || url.searchParams.get('reviewId') !== updateReview.reviewId || !updateReview.token || Date.parse(updateReview.expiresAt || '') <= Date.now()) return send(res, 404, { error: 'Review unavailable' });
      updateReview.viewed = true;
      return send(res, 200, { ...updateReview.plan, reviewId: updateReview.reviewId });
    }
    if (req.method === 'POST' && url.pathname === '/api/parcel-import/apply') {
      if (req.headers.origin !== `http://${host}`) return send(res, 403, { error: 'Invalid origin' });
      if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'JSON required' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) return send(res, 413, { error: 'Request too large' }); }
      let value;
      try { value = JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      if (!value || !Number.isInteger(value.revision) || !/^[a-f0-9]{48}$/.test(value.reviewId || '') || !Array.isArray(value.selectedIds) || !value.selectedIds.length || value.selectedIds.length > 50 || value.selectedIds.some(id => !/^[a-f0-9]{20}$/.test(id))) return send(res, 400, { error: 'Invalid selection' });
      if (rendering || actionBusy || pending || value.revision !== committedDeck?.revision || committedOwner !== 'router' || router.current() !== 'parcels') return send(res, 409, { ok: false, message: '화면이 바뀌었거나 갱신 중입니다.' });
      if (parcelImportReview?.stage !== 'review' || parcelImportReview.reviewId !== value.reviewId || !parcelImportReview.viewed || !parcelImportReview.token || Date.parse(parcelImportReview.expiresAt || '') <= Date.now()) return send(res, 409, { ok: false, message: '가져오기 검토가 없거나 만료되었습니다.' });
      actionBusy = true;
      try {
        const result = await parcelImporter.apply(parcelImportReview.token, value.selectedIds);
        parcelImportReview = { stage: result.ok ? 'completed' : 'unavailable', plan: null, message: result.ok ? `${result.added || 0}개 항목을 등록했습니다.` : '가져오기 대상을 확인하지 못했습니다.' };
        if (result.ok) { parcelsLastAttempt = 0; requestFeatureData('parcels', true); }
        return send(res, result.ok ? 200 : 409, { ok: result.ok, code: result.code, message: parcelImportReview.message });
      } finally { actionBusy = false; void refresh(); }
    }
    if (req.method === 'POST' && url.pathname === '/api/review') {
      if (req.headers.origin !== `http://${host}`) return send(res, 403, { error: 'Invalid origin' });
      if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'JSON required' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024) return send(res, 413, { error: 'Request too large' }); }
      let value;
      try { value = JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      if (!value || !['cleanup', 'worktree', 'parcel', 'remote', 'update'].includes(value.kind) || !Number.isInteger(value.revision) || !/^[a-f0-9]{48}$/.test(value.reviewId || '')) return send(res, 400, { error: 'Invalid review' });
      if (rendering || actionBusy || pending || value.revision !== committedDeck?.revision) return send(res, 409, { ok: false, message: '화면이 바뀌었거나 갱신 중입니다.' });
      const review = value.kind === 'cleanup' ? cleanupState : value.kind === 'worktree' ? worktreeReview : value.kind === 'parcel' ? parcelReview : value.kind === 'remote' ? remoteReview : updateReview;
      const correctMode = value.kind === 'cleanup' ? 'machines' : value.kind === 'worktree' ? 'worktrees' : value.kind === 'parcel' ? 'parcels' : value.kind === 'remote' ? 'remote' : 'settings';
      const plan = review?.plan;
      const validTargets = value.kind === 'cleanup'
        ? ['clean', 'purge', 'trash'].includes(plan?.kind) && Number.isSafeInteger(plan.count) && plan.count > 0 && Array.isArray(plan.targets) && plan.targets.length === plan.count && plan.targets.every(item => typeof item?.path === 'string' && item.path.startsWith('/'))
        : value.kind === 'worktree' ? /^wt-[a-f0-9]{24}$/.test(plan?.id || '') && typeof plan?.path === 'string' && plan.path.startsWith('/') && plan.action === 'git worktree remove' && plan.eligible === true && plan.deletesBranch === false
        : value.kind === 'parcel' ? plan?.destination === 'Cainiao' && Number.isSafeInteger(plan.count) && plan.count > 0 && Array.isArray(plan.targets) && plan.targets.length === plan.count && plan.targets.every(item => typeof item?.tracking === 'string' && /^[A-Z0-9-]{5,60}$/.test(item.tracking))
        : value.kind === 'remote' ? typeof plan?.host === 'string' && !!plan.host && Number.isInteger(plan.port) && plan.port > 0 && plan.port <= 65535 && ['machine', 'agents', 'agy'].includes(plan.operation) && typeof plan.label === 'string'
        : plan?.action === 'fast-forward' && /^[a-f0-9]{40,64}$/i.test(plan.current || '') && /^[a-f0-9]{40,64}$/i.test(plan.target || '') && Array.isArray(plan.files) && plan.files.length > 0 && plan.files.length <= 300 && typeof plan.diff === 'string' && Buffer.byteLength(plan.diff) <= 2 * 1024 * 1024;
      if (committedOwner !== 'router' || router.current() !== correctMode || review?.stage !== 'review' || review.reviewId !== value.reviewId || (['parcel', 'remote', 'update'].includes(value.kind) && review.viewed !== true) || (!['parcel', 'remote', 'update'].includes(value.kind) && !plan?.executable) || !validTargets || !review.token || (review.expiresAt && Date.parse(review.expiresAt) <= Date.now())) return send(res, 409, { ok: false, message: '검토할 대상이 없거나 확인 시간이 지났습니다.' });
      review.reviewed = true;
      await refresh();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/press') {
      if (req.headers.origin !== `http://${host}`) return send(res, 403, { error: 'Invalid origin' });
      if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'JSON required' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024) return send(res, 413, { error: 'Request too large' });
      }
      let payload;
      try { payload = JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      if (!payload || !Number.isInteger(payload.index) || !Number.isInteger(payload.revision) || (payload.heldMs !== undefined && (!Number.isInteger(payload.heldMs) || payload.heldMs < 0 || payload.heldMs > 60_000))) return send(res, 400, { error: 'Invalid button, revision, or duration' });
      const result = await press(payload.index, payload.revision, payload.heldMs || 0);
      return send(res, result.ok ? 200 : 409, result);
    }
    return send(res, 404, { error: 'Not found' });
  } catch (error) { return send(res, 500, { error: 'Internal error' }); }
});

await device.start();
await refresh();
server.listen(port, '127.0.0.1', () => { console.log(`StreamDock AI: http://127.0.0.1:${port} (${mode})`); void refreshUsage(); });
function enqueueGameInput(index) {
  if (!Number.isInteger(index) || index < 0 || index >= layout.keyCount || gameInputs.length >= 32 || !committedDeck) return;
  gameInputs.push({ index, revision: committedDeck.revision });
  if (gameInputDraining) return;
  gameInputDraining = true;
  void (async () => {
    try {
      while (gameInputs.length && !closing) {
        if (displayOwner !== 'router' || router.current() !== 'games' || !gameFrame) { gameInputs.length = 0; break; }
        if (rendering || actionBusy || pending || animationPending) {
          await new Promise(resolve => setTimeout(resolve, 25));
          continue;
        }
        const item = gameInputs.shift();
        if (item.revision !== committedDeck?.revision) continue;
        const result = await press(item.index, item.revision);
        recordPhysicalInput(item.index, result);
        if (result.code === 'busy') gameInputs.unshift(item);
      }
    } finally { gameInputDraining = false; }
  })();
}

// Repaint only the alert keys. Do not rescan sessions or interrupt game frames.
function blinkAlerts() {
  if (closing || reconnecting || blinkPending || rendering || pending || actionBusy ||
      displayOwner !== 'deck' || committedOwner !== 'deck' || !alertPlan || !committedDeck) return;
  const language = settings.get().language || 'ko';
  const keys = translateKeys(alerts.decorate(alertPlan).keys, language).map(key => ({ ...key, language }));
  const renderKey = JSON.stringify(keys);
  if (renderKey === lastRender || !layoutCurrent()) return;
  rendering = true;
  blinkPending = (async () => {
    try {
      const rendered = await device.render(keys);
      if (!closing && (rendered || device.status().mode === 'simulator')) {
        lastRender = renderKey;
        let keyFrames = [];
        if (nativeToken) { try { keyFrames = await nativeKeyFrames(keys); } catch { /* Text preview remains available. */ } }
        committedDeck = { ...committedDeck, keys, ...(nativeToken ? { keyFrames } : {}) };
        snapshot = { ...snapshot, device: device.status(), deck: { ...committedDeck, message: feedback || committedDeck.message } };
      }
    } finally {
      rendering = false;
    }
  })().catch(() => {}).finally(() => { blinkPending = undefined; });
}

async function animate() {
  if (closing || reconnecting || animationPending || gameInputDraining || actionBusy || rendering || pending || displayOwner !== 'router') return;
  const current = router.current();
  const prior = current === 'games' ? gameFrame : current === 'scenes' ? sceneFrame : null;
  if (!prior) return;
  animationPending = true;
  try {
    const frame = current === 'games' ? await games.tick() : await scenes.tick();
    if (closing || reconnecting || actionBusy || rendering || pending || displayOwner !== 'router' || router.current() !== current || (current === 'games' ? gameFrame !== prior : sceneFrame !== prior) || !layoutCurrent()) return;
    if (current === 'games') { gameFrame = frame; for (const cue of frame.sounds || []) void sound.play(cue); }
    else sceneFrame = frame;
    rendering = true;
    try {
      const images = frame.tiles.filter(tile => current === 'scenes' || tile.index < 10).map(tile => ({ index: tile.index, image: tile.png }));
      const placed = placeLegacyFrame(images, current === 'scenes' ? frame.sideTiles.map(tile => ({ slot: tile.slot, image: tile.png })) : await gameSideImages(frame), await blankKeyImage());
      await device.renderImages(placed);
      if (committedDeck) {
        const frames = placed.keys.map(tile => ({ index: tile.index, url: `data:image/png;base64,${tile.image.toString('base64')}` }));
        committedDeck = { ...committedDeck, frames, ...(nativeToken ? { sideFrames: nativeFrameUrls(placed.sides) } : {}) };
        snapshot = { ...snapshot, device: device.status(), deck: { ...committedDeck, message: feedback || committedDeck.message } };
      }
    } finally { rendering = false; }
  } catch {
    feedback = '화면을 갱신하지 못했습니다.';
    feedbackError = true;
    if (!closing) void refresh();
  } finally { animationPending = false; }
}
async function maybeStartScreensaver() {
  if (closing || reconnecting || actionBusy || rendering || pending || gameFrame || sceneFrame) return;
  const option = settings.get().screensaver;
  if (!option.enabled || Date.now() - lastInteraction < option.idleMinutes * 60_000) return;
  if ((snapshot.agents || []).some(a => !a.isSubagent && a.presence === 'live' && a.status === 'blocked')) return;
  actionBusy = true;
  try {
    if (displayOwner === 'router' && router.current() === 'machines') machineMonitor.invalidate();
    router.openMode('scenes');
    displayOwner = 'router';
    sceneFrame = await scenes.start(option.scene);
    autoScene = true;
    void sound.startAmbient(option.scene === 'aquarium' ? 'aqua' : option.scene);
    await refresh(true);
  } catch {
    sceneFrame = null;
    autoScene = false;
    feedback = '화면보호기를 시작하지 못했습니다.';
    feedbackError = true;
  } finally { actionBusy = false; }
}
// Reopen the device after USB removal or a failed startup. Only one attempt can
// run at a time, and an official app or missing device backs off to five seconds.
function tryReconnect() {
  if (closing || mode !== 'hardware' || reconnecting || device.status().connected || pending || rendering || blinkPending || animationPending || actionBusy || Date.now() < reconnectNextAttempt) return;
  reconnecting = true;
  const delay = reconnectDelayMs;
  reconnectNextAttempt = Date.now() + delay;
  reconnectDelayMs = Math.min(delay * 2, 5000);
  reconnectPending = (async () => {
    // Publish the promise before starting, so rendering waits for reconnect.
    await Promise.resolve();
    await device.start();
    if (closing) return;
    if (device.status().connected) {
      // Device-local caches were cleared on disconnect. Server-local caches
      // must also be invalidated so every visible key and side tile is redrawn.
      lastRender = '';
      lastSummary = '';
      await refresh(true, true, true);
      if (device.status().connected) {
        reconnectDelayMs = 1000;
        reconnectNextAttempt = 0;
      }
    } else {
      snapshot = { ...snapshot, device: device.status() };
    }
  })().catch(() => {
    snapshot = { ...snapshot, device: device.status() };
  }).finally(() => {
    reconnecting = false;
    reconnectPending = undefined;
  });
}
const reconnectTimer = setInterval(tryReconnect, 500);
const screensaverTimer = setInterval(maybeStartScreensaver, 2000);
const animationTimer = setInterval(animate, 500);
const alertTimer = setInterval(blinkAlerts, 1000);
const timer = setInterval(() => {
  // A 1-second machine repaint must not starve the regular agent scan.
  if (scheduledFullRefresh) return;
  scheduledFullRefresh = (async () => {
    while (pending && !closing) await pending;
    if (!closing) await refresh();
  })().finally(() => { scheduledFullRefresh = null; });
}, interval);
// A short scheduling tick starts at most one machine read per second and is
// idle outside the machine page; it never launches another agent scan.
const machineTimer = setInterval(() => {
  if (!closing && displayOwner === 'router' && router.current() === 'machines') requestFeatureData('machines');
}, 250);
const usageTimer = setInterval(refreshUsage, 60_000);
const pomodoroTimer = setInterval(() => { void pomodoro.tick().then(() => { if (displayOwner === 'router' && router.current() === 'pomodoro') void refresh(); }).catch(() => {}); }, 1000);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  clearInterval(reconnectTimer);
  clearInterval(machineTimer);
  clearInterval(animationTimer);
  clearInterval(alertTimer);
  clearInterval(screensaverTimer);
  clearInterval(usageTimer);
  clearInterval(pomodoroTimer);
  server.close();
  if (reconnectPending) await reconnectPending;
  if (pending) await pending;
  if (blinkPending) await blinkPending;
  if (usagePending) await usagePending;
  if (machinePending) await machinePending;
  await machineMonitor.close();
  await pomodoro.stop();
  await Promise.allSettled([games.close(), scenes.close()]);
  sound.close();
  await device.stop();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
