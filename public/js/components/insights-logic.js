// Pure logic for the Insights view (no DOM): range choices, stat cards, report labels and the wording of
// weekly-reflection failures.
import { daysBetween, shortDate, moodWord } from '../lib/charts.js';

export const RANGES = Object.freeze([
  Object.freeze({ days: 30, label: '30 days' }),
  Object.freeze({ days: 90, label: '90 days' }),
  Object.freeze({ days: 365, label: '1 year' }),
]);
export const DEFAULT_RANGE = 90;

/** Nearest allowed range (30 / 90 / 365) for anything a person or storage hands us. */
export function normalizeRange(value) {
  const n = Number(value);
  return RANGES.some((r) => r.days === n) ? n : DEFAULT_RANGE;
}

const PLURAL = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);

/** True when there is nothing to chart yet (no entries at all). */
export function isEmptyOverview(overview) {
  return !overview || !overview.totals || num(overview.totals.entries) === 0;
}

/**
 * Text for the streak card.
 * @param {{current?: number, longest?: number, lastEntryDate?: string|null}} streak
 * @param {string} today YYYY-MM-DD
 */
export function describeStreak(streak, today) {
  const current = num(streak && streak.current);
  const longest = num(streak && streak.longest);
  const last = streak && streak.lastEntryDate;
  const gap = last ? daysBetween(last, today) : NaN;
  let note;
  if (current > 0 && gap === 0) note = 'You have written today. Lovely.';
  else if (current > 0 && gap === 1) note = 'Write today to keep it going.';
  else if (longest > 0) note = 'Write today to start a new one.';
  else note = 'Write today to start your first.';
  return { value: current.toLocaleString(), unit: current === 1 ? 'day' : 'days', note, longest: longest > 0 ? `Longest: ${PLURAL(longest, 'day')}` : '' };
}

/**
 * Cards for the stats row.
 * @returns {Array<{id: string, label: string, value: string, unit?: string, note: string, icon?: string, mood?: number|null}>}
 */
export function statCards(overview, today, days) {
  const totals = (overview && overview.totals) || {};
  const streak = describeStreak(overview && overview.streak, today);
  const avg = overview && overview.mood && Number.isFinite(overview.mood.average) ? overview.mood.average : null;
  const entries = num(totals.entries);
  const words = num(totals.words);
  const daysWritten = num(totals.daysWritten);
  return [
    { id: 'streak', label: 'Current streak', value: streak.value, unit: streak.unit, note: [streak.note, streak.longest].filter(Boolean).join(' '), icon: 'flame' },
    { id: 'entries', label: 'Entries', value: entries.toLocaleString(), note: num(totals.wrapped) ? `${PLURAL(num(totals.wrapped), 'wrapped-up entry', 'wrapped-up entries')}` : 'All time' },
    { id: 'words', label: 'Words written', value: words.toLocaleString(), note: entries ? `About ${Math.round(words / entries).toLocaleString()} per entry` : 'All time' },
    { id: 'days', label: 'Days written', value: daysWritten.toLocaleString(), note: 'All time' },
    { id: 'mood', label: 'Average mood', value: avg === null ? '-' : avg.toFixed(1), unit: avg === null ? '' : '/ 5', note: avg === null ? 'Add a mood to an entry' : `${moodWord(avg)}, last ${days} days`, mood: avg },
  ];
}

const PROVIDER_LABELS = { gemini: 'Gemini', openai: 'OpenAI-compatible', local: 'Local model' };

/** "Oct 2 - Oct 8" for a report (falls back to when it was written). */
export function reportPeriod(report, locale) {
  const a = shortDate(report && report.periodStart, { locale });
  const b = shortDate(report && report.periodEnd, { year: true, locale });
  if (a && b) return `${a} - ${b}`;
  if (report && Number.isFinite(report.createdAt)) return new Date(report.createdAt).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
  return 'Weekly reflection';
}

/** "Gemini - gemini-flash-lite-latest - 5 entries" from a report's meta. */
export function reportMeta(report) {
  const meta = (report && report.meta) || {};
  const parts = [];
  if (typeof meta.provider === 'string' && meta.provider) parts.push(PROVIDER_LABELS[meta.provider] || meta.provider);
  if (typeof meta.model === 'string' && meta.model) parts.push(meta.model);
  const n = num(meta.entryCount);
  if (n) parts.push(PLURAL(n, 'entry', 'entries'));
  return parts.join(' - ');
}

/** Newest first, ignoring anything that is not a weekly report with text. */
export function sortReports(reports) {
  return (Array.isArray(reports) ? reports : [])
    .filter((r) => r && typeof r.id === 'string' && typeof r.content === 'string')
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

/**
 * How to present a failed weekly-reflection request (HTTP error before streaming, or an SSE `error` event).
 * @param {{code?: string, message?: string, hint?: string}} err
 * @param {string} providerId active provider ('' when none)
 * @returns {{tone: 'info'|'warn'|'error', message: string, hint: string, action: {href: string, label: string}|null, retry: boolean}}
 */
export function describeWeeklyFailure(err, providerId = '') {
  const code = (err && err.code) || 'unknown';
  const message = (err && err.message) || '';
  const hint = (err && err.hint) || '';
  const tab = ['gemini', 'openai', 'local'].includes(providerId) ? providerId : '';
  switch (code) {
    case 'not_enough_entries':
      return {
        tone: 'info', retry: false, action: { href: '#/?focus=1', label: 'Write an entry' },
        message: 'Not enough to reflect on yet',
        hint: 'Write a few entries during this period and come back. Private entries are never used.',
      };
    case 'ai_not_configured':
      return { tone: 'info', retry: false, action: { href: '#/settings', label: 'Set up AI' }, message: 'AI is not set up yet', hint: 'Choose Gemini, an OpenAI-compatible API or a local model, and your reflections will be written there.' };
    case 'ai_disabled':
      return { tone: 'info', retry: false, action: { href: '#/settings?tab=general', label: 'Turn AI on' }, message: 'The AI companion is switched off', hint: 'Turn it back on in Settings to write reflections.' };
    case 'generation_in_progress':
      return { tone: 'warn', retry: true, action: null, message: 'A reflection is already being written', hint: 'Give it a moment, then try again.' };
    case 'unauthorized':
      return { tone: 'error', retry: false, action: { href: '#/login', label: 'Sign in' }, message: message || 'Please sign in again', hint };
    default: {
      const providerProblem = ['auth', 'quota', 'model_not_found', 'bad_base_url', 'region', 'blocked', 'context_too_long', 'rate_limit', 'overloaded', 'timeout', 'empty', 'server'].includes(code);
      return {
        tone: 'error', retry: true,
        action: providerProblem || code === 'network' ? { href: tab ? `#/settings?tab=${tab}` : '#/settings', label: 'Open AI settings' } : null,
        message: message || 'The reflection could not be written',
        hint: hint || 'Your entries are safe. Try again in a moment.',
      };
    }
  }
}
