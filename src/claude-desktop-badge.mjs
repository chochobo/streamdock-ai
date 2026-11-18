// Parse only the documented-on-screen weekly all-models usage badge. This is
// an unofficial UI string; an unrecognized or ambiguous form is unavailable.
const WEEKDAY = new Map([
  ['일', 0], ['월', 1], ['화', 2], ['수', 3], ['목', 4], ['금', 5], ['토', 6],
  ['sun', 0], ['sunday', 0], ['mon', 1], ['monday', 1], ['tue', 2], ['tuesday', 2],
  ['wed', 3], ['wednesday', 3], ['thu', 4], ['thursday', 4],
  ['fri', 5], ['friday', 5], ['sat', 6], ['saturday', 6],
]);

/**
 * Extract weekly all-models subscription use from a single Claude Desktop
 * accessibility badge. The UI only supplies weekday and time, so return that
 * label without inventing a date or UTC timestamp.
 */
export function parseClaudeDesktopBadge(text) {
  if (typeof text !== 'string' || text.length > 512 || !/(?:사용량|\busage\b)/iu.test(text)) return null;
  const matcher = /(?:주간\s*[·•|\-]\s*모든\s*모델|weekly\s*[·•|\-]\s*all\s*models)\s*[:：]\s*(\d+(?:\.\d+)?)\s*%/giu;
  const matches = [...text.matchAll(matcher)];
  if (matches.length !== 1) return null;
  const usedPercent = Number(matches[0][1]);
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return null;
  const suffix = text.slice(matches[0].index + matches[0][0].length);
  let reset = /^\s*(?:[·•|,\-]\s*)?\(\s*(월|화|수|목|금|토|일)\s*\)\s*(오전|오후)\s*(\d{1,2}):(\d{2})/u.exec(suffix);
  let weekday, hour, minute, period;
  if (reset) {
    weekday = WEEKDAY.get(reset[1]);
    period = reset[2];
    hour = Number(reset[3]);
    minute = Number(reset[4]);
  } else {
    reset = /^\s*(?:[·•|,\-]\s*)?(?:\b(?:resets?|resetting)\b\s*(?:(?:on|at)\s*)?)?\(?\b(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b\)?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/iu.exec(suffix);
    if (reset) {
      weekday = WEEKDAY.get(reset[1].toLowerCase());
      hour = Number(reset[2]);
      minute = Number(reset[3] ?? 0);
      period = reset[4].toLowerCase();
    }
  }
  let resetLabel = null;
  if (reset && Number.isInteger(weekday) && hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59) {
    const isPm = period === '오후' || period === 'pm';
    const hour24 = (hour % 12) + (isPm ? 12 : 0);
    const dayName = ['일', '월', '화', '수', '목', '금', '토'][weekday];
    resetLabel = `${dayName} ${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  return { usedPercent, resetsAt: null, resetLabel };
}
