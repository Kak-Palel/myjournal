import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOverview, computeStreaks } from '../../src/journal/insights.js';
import { addDays } from '../../src/journal/dates.js';

const streak = (dates, today) => computeStreaks(dates, today);

// ------------------------------------------------------------------------------------------------ streaks

test('computeStreaks: no entries', () => {
  assert.deepEqual(streak([], '2026-10-08'), { current: 0, longest: 0, lastEntryDate: null });
  assert.deepEqual(streak(undefined, '2026-10-08'), { current: 0, longest: 0, lastEntryDate: null });
  assert.deepEqual(streak(['junk', null, 5, '2026-02-30'], '2026-10-08'), { current: 0, longest: 0, lastEntryDate: null });
});

test('computeStreaks: a single entry today, yesterday, or longer ago', () => {
  assert.deepEqual(streak(['2026-10-08'], '2026-10-08'), { current: 1, longest: 1, lastEntryDate: '2026-10-08' });
  assert.deepEqual(streak(['2026-10-07'], '2026-10-08'), { current: 1, longest: 1, lastEntryDate: '2026-10-07' }, 'yesterday still counts');
  assert.deepEqual(streak(['2026-10-06'], '2026-10-08'), { current: 0, longest: 1, lastEntryDate: '2026-10-06' }, 'two days ago: the streak is over');
});

test('computeStreaks: runs, gaps and the longest run', () => {
  const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-10-06', '2026-10-07', '2026-10-08'];
  assert.deepEqual(streak(dates, '2026-10-08'), { current: 3, longest: 5, lastEntryDate: '2026-10-08' });
  assert.deepEqual(streak(dates, '2026-10-09'), { current: 3, longest: 5, lastEntryDate: '2026-10-08' }, 'last entry yesterday');
  assert.deepEqual(streak(dates, '2026-10-10'), { current: 0, longest: 5, lastEntryDate: '2026-10-08' });
  assert.deepEqual(streak(['2026-10-08', '2026-10-06', '2026-10-05'], '2026-10-08'), { current: 1, longest: 2, lastEntryDate: '2026-10-08' }, 'a gap of one day breaks the run');
});

test('computeStreaks: several entries on one day count once; order and duplicates do not matter', () => {
  const shuffled = ['2026-10-08', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-06', '2026-10-08'];
  assert.deepEqual(streak(shuffled, '2026-10-08'), { current: 3, longest: 3, lastEntryDate: '2026-10-08' });
  assert.deepEqual(streak(['2026-10-08', '2026-10-08', '2026-10-08'], '2026-10-08'), { current: 1, longest: 1, lastEntryDate: '2026-10-08' });
});

test('computeStreaks is DST-safe', () => {
  assert.equal(streak(['2026-03-07', '2026-03-08', '2026-03-09'], '2026-03-09').current, 3, 'US spring forward');
  assert.equal(streak(['2026-03-28', '2026-03-29', '2026-03-30'], '2026-03-30').current, 3, 'EU spring forward');
  assert.equal(streak(['2026-10-24', '2026-10-25', '2026-10-26'], '2026-10-26').current, 3, 'EU fall back');
  assert.equal(streak(['2026-10-31', '2026-11-01', '2026-11-02'], '2026-11-02').current, 3, 'US fall back');
  assert.equal(streak(['2026-04-04', '2026-04-05', '2026-04-06'], '2026-04-06').current, 3, 'NZ/AU fall back');
  assert.equal(streak(['2026-09-26', '2026-09-27', '2026-09-28'], '2026-09-28').longest, 3);
});

test('computeStreaks is leap-year-safe', () => {
  assert.equal(streak(['2024-02-28', '2024-02-29', '2024-03-01'], '2024-03-01').current, 3);
  assert.equal(streak(['2024-02-28', '2024-03-01'], '2024-03-01').current, 1, '29 February 2024 exists, so this is a gap');
  assert.equal(streak(['2026-02-28', '2026-03-01'], '2026-03-01').current, 2, '2026 has no 29 February');
  assert.equal(streak(['2100-02-28', '2100-03-01'], '2100-03-01').current, 2, '2100 is not a leap year');
  assert.equal(streak(['2000-02-28', '2000-03-01'], '2000-03-01').current, 1, '2000 is a leap year');
  assert.equal(streak(['2025-12-30', '2025-12-31', '2026-01-01'], '2026-01-01').current, 3, 'year boundary');
});

test('computeStreaks ignores future dates and falls back when today is invalid', () => {
  assert.deepEqual(streak(['2026-10-07', '2026-10-08', '2026-10-09'], '2026-10-08'), { current: 2, longest: 2, lastEntryDate: '2026-10-08' });
  assert.deepEqual(streak(['2026-10-20'], '2026-10-08'), { current: 0, longest: 0, lastEntryDate: null });
  assert.deepEqual(streak(['2026-10-07', '2026-10-08'], 'not a date'), { current: 2, longest: 2, lastEntryDate: '2026-10-08' });
  assert.deepEqual(streak(['2026-10-07', '2026-10-08'], undefined), { current: 2, longest: 2, lastEntryDate: '2026-10-08' });
});

test('computeStreaks handles a very long history quickly', () => {
  const dates = [];
  for (let i = 0; i < 4000; i += 1) dates.push(addDays('2015-01-01', i));
  const t0 = Date.now();
  const r = streak(dates, addDays('2015-01-01', 3999));
  assert.equal(r.current, 4000);
  assert.equal(r.longest, 4000);
  assert.ok(Date.now() - t0 < 500);
});

// ------------------------------------------------------------------------------------------------ overview

const row = (date, extra = {}) => ({ date, mood: null, emotions: [], tags: [], wordCount: 0, status: 'open', ...extra });

test('computeOverview: empty input has the documented shape', () => {
  const o = computeOverview({ entries: [], today: '2026-10-08', days: 90 });
  assert.deepEqual(o, {
    today: '2026-10-08',
    streak: { current: 0, longest: 0, lastEntryDate: null },
    totals: { entries: 0, words: 0, daysWritten: 0, wrapped: 0 },
    mood: { average: null, series: [] },
    calendar: [],
    emotions: [],
    tags: [],
  });
  assert.deepEqual(Object.keys(computeOverview({ entries: [], today: '2026-10-08' })), ['today', 'streak', 'totals', 'mood', 'calendar', 'emotions', 'tags']);
});

test('computeOverview: totals, streak, calendar and mood series', () => {
  const entries = [
    row('2026-10-08', { mood: 4, wordCount: 120, status: 'wrapped', emotions: ['calm'], tags: ['work'] }),
    row('2026-10-08', { mood: 3, wordCount: 80, emotions: ['Calm', 'tired'], tags: ['work', 'family'] }),
    row('2026-10-07', { mood: 5, wordCount: 200, status: 'wrapped', emotions: ['calm'] }),
    row('2026-10-05', { mood: 2, wordCount: 40, tags: ['Work'] }),
    row('2026-10-03', { wordCount: 10 }),
  ];
  const o = computeOverview({ entries, today: '2026-10-08', days: 90 });
  assert.deepEqual(o.totals, { entries: 5, words: 450, daysWritten: 4, wrapped: 2 });
  assert.deepEqual(o.streak, { current: 2, longest: 2, lastEntryDate: '2026-10-08' });
  assert.deepEqual(o.calendar, [
    { date: '2026-10-03', count: 1, words: 10 },
    { date: '2026-10-05', count: 1, words: 40 },
    { date: '2026-10-07', count: 1, words: 200 },
    { date: '2026-10-08', count: 2, words: 200 },
  ]);
  assert.deepEqual(o.mood.series, [
    { date: '2026-10-05', avg: 2, count: 1 },
    { date: '2026-10-07', avg: 5, count: 1 },
    { date: '2026-10-08', avg: 3.5, count: 2 },
  ]);
  assert.equal(o.mood.average, 3.5, '(4 + 3 + 5 + 2) / 4');
  assert.deepEqual(o.emotions, [{ name: 'calm', count: 3 }, { name: 'tired', count: 1 }]);
  assert.deepEqual(o.tags, [{ name: 'work', count: 3 }, { name: 'family', count: 1 }]);
});

test('computeOverview: mood averages are rounded to two decimals', () => {
  const entries = [row('2026-10-08', { mood: 5 }), row('2026-10-08', { mood: 4 }), row('2026-10-08', { mood: 4 }), row('2026-10-07', { mood: 1 })];
  const o = computeOverview({ entries, today: '2026-10-08' });
  assert.equal(o.mood.series[1].avg, 4.33);
  assert.equal(o.mood.average, 3.5);
  const odd = computeOverview({ entries: [row('2026-10-08', { mood: 1 }), row('2026-10-08', { mood: 1 }), row('2026-10-07', { mood: 2 })], today: '2026-10-08' });
  assert.equal(odd.mood.average, 1.33);
  assert.equal(odd.mood.series[1].avg, 1);
});

test('computeOverview: the window is `days` long and includes today', () => {
  const entries = [row('2026-10-08', { wordCount: 1 }), row('2026-10-02', { wordCount: 1 }), row('2026-10-01', { wordCount: 1 }), row('2026-09-30', { wordCount: 1 })];
  const seven = computeOverview({ entries, today: '2026-10-08', days: 7 });
  assert.deepEqual(seven.calendar.map((c) => c.date), ['2026-10-02', '2026-10-08'], '7 days = 2 Oct .. 8 Oct inclusive');
  const one = computeOverview({ entries, today: '2026-10-08', days: 1 });
  assert.deepEqual(one.calendar.map((c) => c.date), ['2026-10-08']);
  const eight = computeOverview({ entries, today: '2026-10-08', days: 8 });
  assert.deepEqual(eight.calendar.map((c) => c.date), ['2026-10-01', '2026-10-02', '2026-10-08']);
  assert.equal(seven.totals.entries, 4, 'totals cover all entries, not just the window');
  assert.equal(seven.totals.daysWritten, 4);
  assert.deepEqual(computeOverview({ entries, today: '2026-10-08' }).calendar.length, 4, 'default window is 90 days');
});

test('computeOverview: window statistics (mood, emotions, tags) leave out older entries, streaks do not', () => {
  const entries = [
    row('2026-10-08', { mood: 5, emotions: ['calm'], tags: ['new'] }),
    row('2026-07-01', { mood: 1, emotions: ['sad'], tags: ['old'] }),
  ];
  const o = computeOverview({ entries, today: '2026-10-08', days: 30 });
  assert.equal(o.mood.average, 5);
  assert.deepEqual(o.emotions, [{ name: 'calm', count: 1 }]);
  assert.deepEqual(o.tags, [{ name: 'new', count: 1 }]);
  assert.equal(o.streak.longest, 1);
  assert.equal(o.totals.entries, 2);
});

test('computeOverview: top 10 emotions and tags, ties broken by name', () => {
  const entries = [];
  for (let i = 0; i < 14; i += 1) entries.push(row('2026-10-08', { emotions: [`e${String(i).padStart(2, '0')}`], tags: [`t${String(i).padStart(2, '0')}`] }));
  entries.push(row('2026-10-07', { emotions: ['e13', 'e13'], tags: ['t13'] }));
  const o = computeOverview({ entries, today: '2026-10-08' });
  assert.equal(o.emotions.length, 10);
  assert.equal(o.tags.length, 10);
  assert.deepEqual(o.emotions[0], { name: 'e13', count: 2 }, 'an entry counts a label once, but two entries count twice');
  assert.deepEqual(o.emotions.slice(1, 4).map((x) => x.name), ['e00', 'e01', 'e02'], 'ties sorted by name');
  assert.deepEqual(o.tags[0], { name: 't13', count: 2 });
});

test('computeOverview: an entry counts a label once; labels are normalised', () => {
  const o = computeOverview({ entries: [row('2026-10-08', { emotions: ['Calm', 'calm', ' CALM '], tags: '#Work, work' })], today: '2026-10-08' });
  assert.deepEqual(o.emotions, [{ name: 'calm', count: 1 }]);
  assert.deepEqual(o.tags, [{ name: 'work', count: 1 }]);
});

test('computeOverview ignores unusable rows and values', () => {
  const entries = [
    null, 'text', 7, {}, row('not a date'), row('2026-13-40'),
    row('2026-10-08', { mood: 9, wordCount: -5 }),
    row('2026-10-08', { mood: 2.5, wordCount: Number.NaN }),
    row('2026-10-08', { mood: '4', wordCount: '12' }),
    row('2026-10-08', { mood: 3, wordCount: 10, emotions: null, tags: 5 }),
  ];
  const o = computeOverview({ entries, today: '2026-10-08' });
  assert.equal(o.mood.average, 3, 'only the integer mood 1..5 counts');
  assert.deepEqual(o.mood.series, [{ date: '2026-10-08', avg: 3, count: 1 }]);
  assert.equal(o.totals.words, 10);
  assert.equal(o.calendar.length, 1);
  assert.equal(o.calendar[0].count, 4);
  assert.deepEqual(o.emotions, []);
  assert.equal(computeOverview({ entries: 'nope', today: '2026-10-08' }).totals.entries, 0);
  assert.equal(computeOverview().totals.entries, 0);
});

test('computeOverview: invalid `today` and `days` fall back sensibly', () => {
  const entries = [row('2026-10-08', { wordCount: 5 }), row('2026-10-07')];
  const o = computeOverview({ entries, today: 'garbage', days: 'many' });
  assert.equal(o.today, '2026-10-08', 'latest entry date stands in for today');
  assert.equal(o.calendar.length, 2);
  assert.equal(o.streak.current, 2);
  assert.equal(computeOverview({ entries, today: '2026-10-08', days: 0 }).calendar.length, 1, 'days is at least 1');
  assert.equal(computeOverview({ entries, today: '2026-10-08', days: -5 }).calendar.length, 1);
  assert.equal(computeOverview({ entries, today: '2026-10-08', days: 1e9 }).calendar.length, 2, 'days is capped');
  assert.equal(computeOverview({ entries, today: '2026-10-08', days: '1' }).calendar.length, 1, 'numeric strings from a query are accepted');
  assert.equal(computeOverview({ entries, today: '2026-10-08', days: '' }).calendar.length, 2, 'an empty value means the default');
});

test('computeOverview excludes entries dated after today from the window', () => {
  const o = computeOverview({ entries: [row('2026-10-09', { mood: 5 }), row('2026-10-08', { mood: 1 })], today: '2026-10-08' });
  assert.equal(o.mood.average, 1);
  assert.deepEqual(o.calendar.map((c) => c.date), ['2026-10-08']);
  assert.equal(o.streak.lastEntryDate, '2026-10-08');
});

test('computeOverview is fast with a large history', () => {
  const entries = [];
  for (let i = 0; i < 20000; i += 1) entries.push(row(addDays('2000-01-01', i % 9000), { mood: (i % 5) + 1, emotions: ['a', 'b'], tags: ['c'], wordCount: 10 }));
  const t0 = Date.now();
  const o = computeOverview({ entries, today: addDays('2000-01-01', 8999), days: 365 });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(o.calendar.length, 365);
});
