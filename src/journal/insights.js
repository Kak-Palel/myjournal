// Numbers behind the Insights screen: streaks, mood series, calendar, top emotions and tags.
// All date arithmetic works on 'YYYY-MM-DD' strings via UTC midnight (dates.js), so daylight-saving
// changes and leap years cannot shift a day. "Today" always comes from the caller (the user's local date).

import { dateFromDayNumber, dayNumber } from './dates.js';
import { normalizeLabels } from './text.js';

const DEFAULT_DAYS = 90;
const MAX_DAYS = 3660;
const TOP_N = 10;

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

function validDayNumbers(dates) {
  const set = new Set();
  for (const d of Array.isArray(dates) ? dates : []) {
    const n = dayNumber(d);
    if (!Number.isNaN(n)) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Writing streaks.
 *
 * - `longest`: the longest run of consecutive days with at least one entry.
 * - `current`: the run that ends at the latest entry day, but only if that day is today or yesterday
 *   (so a streak survives until the end of the day after the last entry); otherwise 0.
 * - `lastEntryDate`: the latest entry day on or before `today`, or null.
 * Several entries on one day count once. Invalid and duplicate dates are ignored, and so are dates
 * after `today` (they have not happened yet in the user's calendar). If `today` is not a valid date,
 * the latest entry date stands in for it.
 * @param {string[]} dates entry dates, any order
 * @param {string} today `YYYY-MM-DD`, the user's local date
 * @returns {{current: number, longest: number, lastEntryDate: string|null}}
 */
export function computeStreaks(dates, today) {
  const all = validDayNumbers(dates);
  if (all.length === 0) return { current: 0, longest: 0, lastEntryDate: null };
  let todayN = dayNumber(today);
  if (Number.isNaN(todayN)) todayN = all[all.length - 1];
  const nums = all.filter((n) => n <= todayN);
  if (nums.length === 0) return { current: 0, longest: 0, lastEntryDate: null };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < nums.length; i += 1) {
    run = nums[i] === nums[i - 1] + 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  const last = nums[nums.length - 1];
  let current = 0;
  if (todayN - last <= 1) {
    current = 1;
    for (let i = nums.length - 1; i > 0 && nums[i - 1] === nums[i] - 1; i -= 1) current += 1;
  }
  return { current, longest, lastEntryDate: dateFromDayNumber(last) };
}

function topLabels(counts) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, TOP_N)
    .map(([name, count]) => ({ name, count }));
}

const isMood = (m) => Number.isInteger(m) && m >= 1 && m <= 5;
const safeCount = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * The Insights overview (ARCHITECTURE section 6).
 *
 * `entries` are minimal rows `{ date, mood, emotions, tags, wordCount, status }` (extra fields are ignored; rows
 * without a valid date are skipped). Streaks and `totals` cover ALL rows; `mood`, `calendar`, `emotions` and `tags`
 * cover only the last `days` days, counted back from and including `today`. Mood averages are rounded to 2 decimals,
 * emotions and tags list the 10 most frequent labels (an entry counts a label once), the calendar only has days
 * with entries.
 * @param {{entries: object[], today: string, days?: number}} args `today`: `YYYY-MM-DD`; `days` default 90 (1-3660)
 * @returns {{today: string, streak: object, totals: object, mood: object, calendar: object[], emotions: object[], tags: object[]}}
 */
export function computeOverview({ entries, today, days } = {}) {
  const rows = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object');
  const dated = rows.map((e) => ({ e, n: dayNumber(e.date) })).filter((x) => !Number.isNaN(x.n));

  let todayN = dayNumber(today);
  if (Number.isNaN(todayN)) todayN = dated.length > 0 ? Math.max(...dated.map((x) => x.n)) : 0;
  // Query-string values arrive as text.
  const requested = typeof days === 'string' && days.trim() !== '' ? Number(days) : days;
  const windowDays = Number.isFinite(requested) ? Math.min(MAX_DAYS, Math.max(1, Math.floor(requested))) : DEFAULT_DAYS;
  const from = todayN - (windowDays - 1);

  const totals = { entries: rows.length, words: 0, daysWritten: 0, wrapped: 0 };
  for (const e of rows) {
    totals.words += safeCount(e.wordCount);
    if (e.status === 'wrapped') totals.wrapped += 1;
  }
  totals.daysWritten = new Set(dated.map((x) => x.n)).size;

  const moodByDay = new Map();
  const calendarByDay = new Map();
  const emotionCounts = new Map();
  const tagCounts = new Map();
  let moodSum = 0;
  let moodCount = 0;
  for (const { e, n } of dated) {
    if (n < from || n > todayN) continue;
    const day = calendarByDay.get(n) || { count: 0, words: 0 };
    day.count += 1;
    day.words += safeCount(e.wordCount);
    calendarByDay.set(n, day);
    if (isMood(e.mood)) {
      const m = moodByDay.get(n) || { sum: 0, count: 0 };
      m.sum += e.mood;
      m.count += 1;
      moodByDay.set(n, m);
      moodSum += e.mood;
      moodCount += 1;
    }
    for (const label of normalizeLabels(e.emotions, { max: 50, maxLen: 40 })) emotionCounts.set(label, (emotionCounts.get(label) || 0) + 1);
    for (const label of normalizeLabels(e.tags, { max: 50, maxLen: 40 })) tagCounts.set(label, (tagCounts.get(label) || 0) + 1);
  }

  const byDate = (map, shape) => [...map.entries()].sort((a, b) => a[0] - b[0]).map(([n, v]) => ({ date: dateFromDayNumber(n), ...shape(v) }));
  return {
    today: Number.isNaN(dayNumber(today)) ? dateFromDayNumber(todayN) : today,
    streak: computeStreaks(dated.map((x) => x.e.date), dateFromDayNumber(todayN)),
    totals,
    mood: {
      average: moodCount > 0 ? round2(moodSum / moodCount) : null,
      series: byDate(moodByDay, (v) => ({ avg: round2(v.sum / v.count), count: v.count })),
    },
    calendar: byDate(calendarByDay, (v) => ({ count: v.count, words: v.words })),
    emotions: topLabels(emotionCounts),
    tags: topLabels(tagCounts),
  };
}
