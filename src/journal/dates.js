// Calendar-date helpers on 'YYYY-MM-DD' strings. Every calculation goes through UTC midnight, so
// daylight-saving changes and leap years cannot shift a result: a "day" is always exactly 86 400 000 ms.
// Pure functions, no clock access (callers pass "today" in).

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
export const MONTHS = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

const pad = (n, width) => String(n).padStart(width, '0');

function utcMs(year, month, day) {
  // Date.UTC treats years 0-99 as 1900-1999, so set the year explicitly.
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d.getTime();
}

/**
 * Parse a strict `YYYY-MM-DD` string that names a real calendar day (2026-02-30 is rejected).
 * @param {unknown} value
 * @returns {{year:number, month:number, day:number}|null}
 */
export function parseDateString(value) {
  if (typeof value !== 'string') return null;
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(utcMs(year, month, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** @param {unknown} value @returns {boolean} */
export function isValidDateString(value) {
  return parseDateString(value) !== null;
}

/**
 * Whole days since 1970-01-01 for a valid date string, `NaN` otherwise.
 * @param {unknown} value
 * @returns {number}
 */
export function dayNumber(value) {
  const p = parseDateString(value);
  return p ? Math.round(utcMs(p.year, p.month, p.day) / MS_PER_DAY) : NaN;
}

/**
 * Inverse of dayNumber().
 * @param {number} n
 * @returns {string} `YYYY-MM-DD`
 */
export function dateFromDayNumber(n) {
  const d = new Date(n * MS_PER_DAY);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

/**
 * Add (or subtract) whole days to a date string.
 * @param {string} value valid `YYYY-MM-DD`
 * @param {number} days
 * @returns {string|null} `null` for an invalid input date
 */
export function addDays(value, days) {
  const n = dayNumber(value);
  return Number.isNaN(n) ? null : dateFromDayNumber(n + days);
}

/**
 * Days from `a` to `b` (positive when b is later). `NaN` if either date is invalid.
 * @param {string} a
 * @param {string} b
 */
export function diffDays(a, b) {
  return dayNumber(b) - dayNumber(a);
}

/** @param {string} value valid date @returns {number} 0 = Sunday .. 6 = Saturday, or -1 if invalid */
export function weekdayIndex(value) {
  const n = dayNumber(value);
  if (Number.isNaN(n)) return -1;
  return (((n + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
}

/**
 * Normalise "a point in time" input to a calendar date. Strings in `YYYY-MM-DD` form pass through
 * untouched (the caller already knows the user's local day). Dates, epoch milliseconds and other
 * date-time strings are read in the host's local time, which is the user's own clock for a
 * self-hosted app; nothing here guesses a time zone.
 * @param {Date|number|string|null|undefined} input
 * @returns {string|null}
 */
export function toDateString(input) {
  if (typeof input === 'string' && DATE_RE.test(input)) return isValidDateString(input) ? input : null;
  let d = null;
  if (input instanceof Date) d = input;
  else if (typeof input === 'number' && Number.isFinite(input)) d = new Date(input);
  else if (typeof input === 'string' && input.trim() !== '') d = new Date(input);
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

/**
 * "Thursday, 8 October 2026".
 * @param {string} value valid date string
 * @returns {string} '' for an invalid date
 */
export function formatLongDate(value) {
  const p = parseDateString(value);
  if (!p) return '';
  return `${WEEKDAYS[weekdayIndex(value)]}, ${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

/**
 * "Oct 3", or "Oct 3, 2025" when `withYear` is true.
 * @param {string} value valid date string
 * @param {{withYear?: boolean}} [opts]
 * @returns {string} '' for an invalid date
 */
export function formatShortDate(value, { withYear = false } = {}) {
  const p = parseDateString(value);
  if (!p) return '';
  const base = `${MONTHS[p.month - 1].slice(0, 3)} ${p.day}`;
  return withYear ? `${base}, ${p.year}` : base;
}

/**
 * "Thu 2 Oct".
 * @param {string} value valid date string
 * @returns {string} '' for an invalid date
 */
export function formatWeekdayDate(value) {
  const p = parseDateString(value);
  if (!p) return '';
  return `${WEEKDAYS[weekdayIndex(value)].slice(0, 3)} ${p.day} ${MONTHS[p.month - 1].slice(0, 3)}`;
}
