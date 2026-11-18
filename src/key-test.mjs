// Key test screen (issue #12): every key shows its logical index, row/col and
// the device image slot so the physical position and input can be checked.
// Pure SVG builders; the server converts them to PNG and sends them with
// renderImages (normal runtime key images only, never the boot logo).

/** Hold the bottom-right key this long to leave; any shorter press is tested. */
export const KEY_TEST_EXIT_HOLD_MS = 1200;

export const keyTestExitIndex = profile => profile.keyCount - 1;

const SIZE = 96;
const hex = code => Number.isInteger(code) ? `0x${code.toString(16).toUpperCase().padStart(2, '0')}` : '-';
const text = (x, y, size, fill, value, weight = 'bold') =>
  `<text x="${x}" y="${y}" fill="${fill}" font-family="sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="middle">${value}</text>`;
const svg = (background, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="${background}"/>${body}</svg>`;

/**
 * Upright SVG for one key. `last` is the most recent press ({index, code})
 * or null; the pressed key is drawn inverted with its raw input code.
 */
export function keyTestKeySvg(profile, index, { last = null, language = 'ko' } = {}) {
  const row = Math.floor(index / profile.cols), col = index % profile.cols;
  const pressed = last?.index === index;
  const fg = pressed ? '#101418' : '#f2f6fa', dim = pressed ? '#101418' : '#9fb0c2';
  const exit = index === keyTestExitIndex(profile);
  const bottom = pressed ? `${language === 'en' ? 'code' : '입력'} ${hex(last.code)}` : exit ? (language === 'en' ? 'Hold: exit' : '길게: 나가기') : '';
  return svg(pressed ? '#ffd84d' : exit ? '#3a1d1d' : '#14202c',
    text(48, 46, 40, fg, String(index)) +
    text(48, 66, 13, dim, `r${row} c${col}`) +
    text(48, 82, 13, dim, `slot ${profile.slotOf(index)}`) +
    (bottom ? text(48, 94, 10, fg, bottom) : ''));
}

/** Upright SVG for a display-only side screen (293S slots 16-18). */
export function keyTestSideSvg(profile, slot, { last = null, count = 0, language = 'ko' } = {}) {
  const position = profile.sideSlots.indexOf(slot);
  const en = language === 'en';
  const lines = [
    [en ? 'Last key' : '마지막 키', last ? String(last.index) : '-'],
    [en ? 'Input code' : '입력 코드', last ? hex(last.code) : '-'],
    [en ? `Exit: hold ${keyTestExitIndex(profile)}` : `${keyTestExitIndex(profile)}번 길게`, en ? `presses ${count}` : `누름 ${count}`],
  ][position] || ['', ''];
  return svg('#0d1620',
    text(48, 24, 14, '#9fb0c2', `slot ${slot}`) +
    text(48, 48, 13, '#9fb0c2', lines[0]) +
    text(48, 76, 22, '#f2f6fa', lines[1]));
}

/** SVGs for the whole connected device: {keys: [{index, svg}], sides: [{slot, svg}]}. */
export function keyTestFrame(profile, state = {}) {
  return {
    keys: Array.from({ length: profile.keyCount }, (_, index) => ({ index, svg: keyTestKeySvg(profile, index, state) })),
    sides: profile.sideSlots.map(slot => ({ slot, svg: keyTestSideSvg(profile, slot, state) })),
  };
}

/** One-line status for the app preview and /api/status. */
export function keyTestMessage(profile, { last = null, language = 'ko' } = {}) {
  const exit = keyTestExitIndex(profile);
  if (last?.rocker) {
    const en = language === 'en';
    const side = en ? { left: 'left', right: 'right' }[last.rocker] : { left: '왼쪽', right: '오른쪽' }[last.rocker];
    const move = en ? { up: 'up', down: 'down', push: 'push' }[last.action] : { up: '위', down: '아래', push: '누르기' }[last.action];
    return en ? `Key test: ${side} rocker ${move} (code ${hex(last.code)}). Hold key ${exit} to exit.`
      : `키 시험: ${side} 로커 ${move} (입력 코드 ${hex(last.code)}). 나가려면 ${exit}번 키를 길게 누르세요.`;
  }
  if (language === 'en') return last ? `Key test: key ${last.index} (code ${hex(last.code)}). Hold key ${exit} to exit.` : `Key test: press any key. Hold key ${exit} to exit.`;
  return last ? `키 시험: ${last.index}번 키 (입력 코드 ${hex(last.code)}). 나가려면 ${exit}번 키를 길게 누르세요.` : `키 시험: 아무 키나 누르세요. 나가려면 ${exit}번 키를 길게 누르세요.`;
}
