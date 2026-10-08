// Pure logic for the Today view (grouping, streak wording, weekly-reflection nudge, prompt composing).
// No DOM access: unit-tested in Node.
import { addDays } from '../lib/ui.js';

export const CATEGORY_ORDER = Object.freeze(['Daily', 'Mind', 'Growth', 'Creative']);

/**
 * Group guided-journal templates by category in the canonical order; unknown categories follow, alphabetically.
 * @param {{ category?: string }[]} templates
 * @returns {{ category: string, templates: object[] }[]}
 */
export function groupTemplates(templates) {
  const byCategory = new Map();
  for (const t of Array.isArray(templates) ? templates : []) {
    const category = (t && t.category) || 'More';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(t);
  }
  const known = CATEGORY_ORDER.filter((c) => byCategory.has(c));
  const extra = [...byCategory.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort();
  return [...known, ...extra].map((category) => ({ category, templates: byCategory.get(category) }));
}

/**
 * Text for the streak chip.
 * @param {{ current?: number, longest?: number, lastEntryDate?: string|null } | null | undefined} streak
 * @param {string} today YYYY-MM-DD
 * @returns {{ count: number, label: string, hint: string, atRisk: boolean } | null} null = show nothing
 */
export function streakInfo(streak, today) {
  const count = streak && Number.isFinite(streak.current) ? streak.current : 0;
  if (count < 1) return null;
  const atRisk = Boolean(streak.lastEntryDate) && streak.lastEntryDate !== today;
  return {
    count,
    atRisk,
    label: count === 1 ? '1 day streak' : `${count} day streak`,
    hint: atRisk ? 'Write something today to keep your streak going.' : 'You have written today. Nice.',
  };
}

/** Entries written in the 7 days up to and including `today`, from the overview `calendar` rows. */
export function weekEntryCount(calendar, today) {
  const from = addDays(today, -6);
  let n = 0;
  for (const row of Array.isArray(calendar) ? calendar : []) {
    if (row && typeof row.date === 'string' && row.date >= from && row.date <= today) n += Number(row.count) || 0;
  }
  return n;
}

/**
 * Should the weekly-reflection nudge show? (>= 3 entries in the last 7 days and no report in the last 7 days)
 * @param {{ calendar: object[], reports: { createdAt?: number, periodEnd?: string }[], today: string, now?: number }} input
 * @returns {{ show: boolean, count: number }}
 */
export function nudgeState({ calendar, reports, today, now = Date.now() }) {
  const count = weekEntryCount(calendar, today);
  const from = addDays(today, -6);
  const recentReport = (Array.isArray(reports) ? reports : []).some((r) => (
    r && ((Number.isFinite(r.createdAt) && now - r.createdAt < 7 * 86_400_000) || (typeof r.periodEnd === 'string' && r.periodEnd >= from))
  ));
  return { show: count >= 3 && !recentReport, count };
}

/** Longest title the entry header accepts. */
const TITLE_MAX = 120;

/**
 * Body for `POST /entries` from the Today box. When the writer answers the prompt of the day, the question
 * becomes the entry's title and `content` stays exactly what they wrote: the API cannot seed an assistant
 * message (only templates do), and gluing the question into the user's own text put app wording into their
 * History previews, word counts and search results.
 * @param {{ text: string, mood?: number|null, prompt?: string, date: string }} input
 * @returns {{ content: string, date: string, mood?: number, kind?: 'guided', title?: string }}
 */
export function newEntryBody({ text, mood = null, prompt = '', date }) {
  const body = { content: String(text ?? '').trim(), date };
  if (mood) body.mood = mood;
  const question = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  if (question) {
    const chars = Array.from(question);
    body.kind = 'guided';
    body.title = chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('').trimEnd()}…` : question;
  }
  return body;
}

/** localStorage key remembering the day the nudge was dismissed. */
export const NUDGE_DISMISS_KEY = 'mj-nudge-dismissed';
