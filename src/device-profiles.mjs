// Hardware models and the logical key layout each one exposes.
//
// Index convention used everywhere above the driver: a zero-based,
// row-major position on the physical face, top-left first.
// The driver translates an index to the device's image slot (for drawing)
// and a device input code back to an index (for presses).
//
// Sources: Mirabox StreamDock-Device-SDK (MIT) — Python-SDK
// Devices/StreamDock293sV3.py and Devices/StreamDockXL.py; Bitfocus
// companion-surface-mirabox-stream-dock (MIT) — src/models/Mirabox-XL.ts.

// 293S V3: the same table maps index -> image slot and input code -> index.
const KEY_IDS_293S = [13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3];

// XL rockers (issue #8): input code -> { rocker, dir }. The vendor SDK names
// each rocker's inputs left/center/right, Companion names them up/push/down.
// Which physical direction sends the first code is not verified on hardware
// yet: swap 'up' and 'down' here if the device shows otherwise.
const ROCKERS_XL = {
  0x21: { rocker: 'left', dir: 'up' },
  0x22: { rocker: 'left', dir: 'push' },
  0x23: { rocker: 'left', dir: 'down' },
  0x24: { rocker: 'right', dir: 'up' },
  0x25: { rocker: 'right', dir: 'push' },
  0x26: { rocker: 'right', dir: 'down' },
};

function freeze(profile) {
  const rockers = Object.fromEntries(Object.entries(profile.rockers).map(([code, value]) => [code, Object.freeze({ ...value })]));
  return Object.freeze({ ...profile, productIds: Object.freeze([...profile.productIds]), sideSlots: Object.freeze([...profile.sideSlots]), rockers: Object.freeze(rockers) });
}

export const PROFILES = Object.freeze({
  '293sv3': freeze({
    id: '293sv3',
    name: 'Stream Dock 293S V3',
    vendorId: 0x6603,
    productIds: [0x1014],
    cols: 5,
    rows: 3,
    keyCount: 15,
    imageSize: 96,
    // sharp rotation applied to an upright tile before sending.
    rotate: -90,
    // Display-only screens next to the keys, in top-to-bottom order.
    sideSlots: [16, 17, 18],
    rockers: {},
    slotOf: index => KEY_IDS_293S[index],
    indexOfCode: code => KEY_IDS_293S.indexOf(code),
  }),
  xl: freeze({
    id: 'xl',
    name: 'Stream Dock XL',
    vendorId: 0x5548,
    // 0x1028 Chinese edition, 0x1031 international edition.
    productIds: [0x1028, 0x1031],
    cols: 8,
    rows: 4,
    keyCount: 32,
    imageSize: 80,
    rotate: 180,
    sideSlots: [],
    rockers: ROCKERS_XL,
    // Image slot 1 is bottom-left; slots run left to right, then upward.
    slotOf: index => (3 - Math.floor(index / 8)) * 8 + (index % 8) + 1,
    // Input code 0x01 is top-left; codes run left to right, then downward.
    // 0x21-0x26 are the rockers (see ROCKERS_XL) and are not keys.
    indexOfCode: code => (Number.isInteger(code) && code >= 0x01 && code <= 0x20 ? code - 1 : -1),
  }),
});

export const DEFAULT_PROFILE_ID = '293sv3';

export function profileById(id) {
  const profile = PROFILES[String(id || '').toLowerCase()];
  if (!profile) throw new RangeError(`Unknown device model: ${id}`);
  return profile;
}

/** Profile whose USB vendor/product IDs match, or null. */
export function profileForUsb(vendorId, productId) {
  return Object.values(PROFILES).find(profile => profile.vendorId === vendorId && profile.productIds.includes(productId)) || null;
}

/**
 * Logical layout shared by the deck, router, server and native preview.
 * - controls: the last four keys (modes/usage on home, back on pages, prev, next).
 * - summaryKeys: keys that show the status summary when the device has no
 *   side screens (right column, every row except the bottom one).
 * - homeContent / pageContent: content positions in row-major order.
 * - legacy: where a 293S-shaped 15-key + 3-side frame (scenes, games) is drawn.
 */
export function layoutFor(profile) {
  const { keyCount, cols, rows } = profile;
  const controls = { modes: keyCount - 4, usage: keyCount - 3, back: keyCount - 3, prev: keyCount - 2, next: keyCount - 1 };
  const summaryKeys = profile.sideSlots.length ? [] : Array.from({ length: rows - 1 }, (_, row) => row * cols + cols - 1);
  const reserved = new Set(summaryKeys);
  const all = Array.from({ length: keyCount }, (_, index) => index).filter(index => !reserved.has(index));
  const homeContent = all.filter(index => index < controls.modes);
  const pageContent = all.filter(index => index < controls.back);
  const legacyKeys = Array.from({ length: 15 }, (_, index) => Math.floor(index / 5) * cols + (index % 5));
  const legacySides = profile.sideSlots.length ? [] : [0, 1, 2].map(row => row * cols + 5);
  return Object.freeze({
    model: profile.id,
    name: profile.name,
    cols,
    rows,
    keyCount,
    sideSlots: profile.sideSlots,
    summaryKeys: Object.freeze(summaryKeys),
    controls: Object.freeze(controls),
    homeContent: Object.freeze(homeContent),
    pageContent: Object.freeze(pageContent),
    legacy: Object.freeze({ keys: Object.freeze(legacyKeys), sides: Object.freeze(legacySides) }),
  });
}

/** JSON-safe description of a layout for the HTTP API and native app. */
export function publicLayout(layout) {
  const { model, name, cols, rows, keyCount, sideSlots, summaryKeys, controls } = layout;
  return { model, name, cols, rows, keyCount, sideSlots: [...sideSlots], summaryKeys: [...summaryKeys], controls: { ...controls } };
}
