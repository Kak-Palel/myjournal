// Decides which typed entry dates are worth sending to the server. Pure (no DOM): unit-tested in Node.

/** How long the date field must sit still before a picked or typed date is saved. */
export const DATE_SETTLE_MS = 700;

/**
 * The date as the server will accept it (`YYYY-MM-DD`, a real calendar day, year 1000 or later), else null.
 *
 * Why this exists: <input type="date"> reports a value for every keystroke that forms a valid date, so typing
 * the year 2025 passes through 0002, 0020 and 0202. The server rejects those, and saving each one would show
 * an error toast per keystroke and repaint the field under the writer's fingers.
 * @param {unknown} value the input's `.value`
 * @returns {string | null}
 */
export function committableDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1000) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? value : null;
}
