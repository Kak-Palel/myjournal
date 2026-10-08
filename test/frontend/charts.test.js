import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseYmd, formatYmd, addDaysYmd, daysBetween, weekdayIndex, dateRange, shortDate, monthLabel,
  moodLevel, moodWord, chooseBinDays, cleanMoodSeries, binMoodSeries,
  lineChartGeometry, segmentPath, describeMoodSeries, moodTableData,
  heatLevel, layoutHeatmap, indexCalendar, cellLabel, describeCalendar, calendarTableData,
  truncateLabel, barsGeometry, barsTableData,
} from '../../public/js/lib/charts.js';

/* ------------------------------------------------------------------ dates */

test('importing charts.js needs no DOM', () => {
  assert.equal(typeof globalThis.document, 'undefined');
});

test('parseYmd accepts real dates only', () => {
  assert.equal(formatYmd(parseYmd('2026-10-08')), '2026-10-08');
  assert.equal(formatYmd(parseYmd('2024-02-29')), '2024-02-29'); // leap day
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '26-10-08', '2026-1-8', '', null, undefined, 'tomorrow', '2026-10-08T00:00', '0050-01-01']) {
    assert.ok(Number.isNaN(parseYmd(bad)), `expected NaN for ${String(bad)}`);
  }
});

test('addDaysYmd crosses months, years and leap days', () => {
  assert.equal(addDaysYmd('2026-10-08', 1), '2026-10-09');
  assert.equal(addDaysYmd('2026-10-31', 1), '2026-11-01');
  assert.equal(addDaysYmd('2026-01-01', -1), '2025-12-31');
  assert.equal(addDaysYmd('2024-02-28', 1), '2024-02-29');
  assert.equal(addDaysYmd('2025-02-28', 1), '2025-03-01');
  assert.equal(addDaysYmd('2026-10-08', 0), '2026-10-08');
  assert.equal(addDaysYmd('nope', 3), '');
});

test('daysBetween is signed and DST-proof', () => {
  assert.equal(daysBetween('2026-03-01', '2026-03-31'), 30);
  assert.equal(daysBetween('2026-10-08', '2026-10-01'), -7);
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2); // EU DST switch weekend
  assert.equal(daysBetween('2026-11-01', '2026-11-02'), 1); // US DST switch
  assert.ok(Number.isNaN(daysBetween('x', '2026-01-01')));
});

test('weekdayIndex honours the week start', () => {
  // 2026-10-08 is a Thursday.
  assert.equal(weekdayIndex('2026-10-08', 1), 3);
  assert.equal(weekdayIndex('2026-10-08', 0), 4);
  assert.equal(weekdayIndex('2026-10-05', 1), 0); // Monday
  assert.equal(weekdayIndex('2026-10-11', 1), 6); // Sunday
  assert.equal(weekdayIndex('bad', 1), -1);
});

test('dateRange returns the window ending today, oldest first', () => {
  assert.deepEqual(dateRange('2026-10-08', 3), ['2026-10-06', '2026-10-07', '2026-10-08']);
  assert.equal(dateRange('2026-10-08', 365).length, 365);
  assert.equal(dateRange('2026-10-08', 365)[0], '2025-10-09');
  assert.deepEqual(dateRange('2026-10-08', 0), []);
  assert.deepEqual(dateRange('2026-10-08', -4), []);
  assert.deepEqual(dateRange('2026-10-08', 'abc'), []);
  assert.deepEqual(dateRange('garbage', 5), []);
  assert.deepEqual(dateRange('2026-10-08', 1e9), []);
});

test('shortDate formats in UTC and rejects junk', () => {
  assert.equal(shortDate('2026-10-08', { locale: 'en-US' }), 'Oct 8');
  assert.equal(shortDate('2026-10-08', { locale: 'en-US', year: true }), 'Oct 8, 2026');
  assert.equal(shortDate('2026-10-08', { locale: 'en-US', weekday: true }), 'Thu, Oct 8');
  assert.equal(shortDate('2026-01-01', { locale: 'en-US' }), 'Jan 1'); // not shifted into Dec 31 by a negative UTC offset
  assert.equal(shortDate('<script>', { locale: 'en-US' }), '');
});

/* -------------------------------------------------------------------- mood */

test('moodLevel / moodWord clamp and round', () => {
  assert.equal(moodLevel(3.49), 3);
  assert.equal(moodLevel(3.5), 4);
  assert.equal(moodLevel(0), 1);
  assert.equal(moodLevel(99), 5);
  assert.equal(moodLevel(NaN), 3);
  assert.equal(moodLevel(undefined), 3);
  assert.equal(moodWord(1), 'Awful');
  assert.equal(moodWord(4.6), 'Great');
});

test('chooseBinDays: daily up to ~4 months, weekly beyond', () => {
  assert.equal(chooseBinDays(30), 1);
  assert.equal(chooseBinDays(90), 1);
  assert.equal(chooseBinDays(120), 1);
  assert.equal(chooseBinDays(365), 7);
});

test('cleanMoodSeries drops junk, merges duplicates and sorts', () => {
  const out = cleanMoodSeries([
    { date: '2026-10-03', avg: 4, count: 1 },
    { date: '2026-10-01', avg: 2, count: 1 },
    { date: '2026-10-03', avg: 2, count: 3 }, // duplicate day: weighted (4*1 + 2*3) / 4 = 2.5
    { date: 'bad', avg: 3, count: 1 },
    { date: '2026-10-02', avg: 'x', count: 1 },
    { date: '2026-10-02', avg: null, count: 1 },
    { date: '2025-01-01', avg: 3, count: 1 }, // before range
    { date: '2026-12-01', avg: 3, count: 1 }, // after range
    null, 7, 'str',
  ], '2026-09-30', '2026-10-08');
  assert.deepEqual(out, [
    { date: '2026-10-01', avg: 2, count: 1 },
    { date: '2026-10-03', avg: 2.5, count: 4 },
  ]);
  assert.deepEqual(cleanMoodSeries(null, '2026-01-01', '2026-02-01'), []);
  assert.deepEqual(cleanMoodSeries({}, '2026-01-01', '2026-02-01'), []);
});

test('cleanMoodSeries clamps out-of-range averages into 1..5 and defaults count to 1', () => {
  const out = cleanMoodSeries([{ date: '2026-10-01', avg: 99 }, { date: '2026-10-02', avg: -4, count: 0 }], '2026-09-01', '2026-10-31');
  assert.deepEqual(out, [{ date: '2026-10-01', avg: 5, count: 1 }, { date: '2026-10-02', avg: 1, count: 1 }]);
});

test('binMoodSeries with binDays 1 only normalises', () => {
  const out = binMoodSeries([{ date: '2026-10-02', avg: 3, count: 2 }], { from: '2026-10-01', to: '2026-10-08', binDays: 1 });
  assert.deepEqual(out, [{ date: '2026-10-02', endDate: '2026-10-02', days: 1, avg: 3, count: 2 }]);
});

test('binMoodSeries averages weekly bins weighted by entry count', () => {
  const from = '2026-01-01';
  const out = binMoodSeries([
    { date: '2026-01-01', avg: 5, count: 1 },
    { date: '2026-01-03', avg: 1, count: 3 }, // same week: (5 + 3) / 4 = 2
    { date: '2026-01-08', avg: 4, count: 1 }, // second week starts on day 7
  ], { from, to: '2026-03-31', binDays: 7 });
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].date, out[0].endDate, out[0].days, out[0].avg, out[0].count], ['2026-01-01', '2026-01-07', 7, 2, 4]);
  assert.deepEqual([out[1].date, out[1].endDate, out[1].days, out[1].avg, out[1].count], ['2026-01-08', '2026-01-14', 7, 4, 1]);
});

test('binMoodSeries trims the last bin to the end of the range', () => {
  const out = binMoodSeries([{ date: '2026-01-09', avg: 3, count: 1 }], { from: '2026-01-01', to: '2026-01-10', binDays: 7 });
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].date, out[0].endDate, out[0].days], ['2026-01-08', '2026-01-10', 3]);
});

/* ------------------------------------------------------------ line geometry */

const range = { from: '2026-09-09', to: '2026-10-08' }; // 30 days

test('lineChartGeometry maps dates and moods into the plot box', () => {
  const geo = lineChartGeometry([
    { date: '2026-09-09', avg: 5, count: 1 },
    { date: '2026-10-08', avg: 1, count: 1 },
  ], { width: 600, height: 240, ...range });
  const { x0, x1, y0, y1 } = geo.plot;
  assert.equal(geo.points.length, 2);
  assert.equal(geo.points[0].x, x0);
  assert.equal(geo.points[1].x, x1);
  assert.ok(geo.points[0].y < geo.points[1].y, 'a better mood is higher (smaller y)');
  assert.ok(geo.points.every((p) => p.y >= y0 && p.y <= y1), 'dots stay inside the plot');
  assert.deepEqual(geo.yTicks.map((t) => t.value), [1, 2, 3, 4, 5]);
  assert.ok(geo.yTicks[0].y > geo.yTicks[4].y);
});

test('lineChartGeometry keeps everything inside the box for hostile input', () => {
  const geo = lineChartGeometry([
    { date: '2026-09-20', avg: 1e9, count: 1 },
    { date: '2026-09-21', avg: -1e9, count: 1 },
    { date: '2026-09-22', avg: Infinity, count: 1 },
    { date: '2026-09-23', avg: NaN, count: 1 },
  ], { width: 10, height: 10, ...range });
  assert.equal(geo.width, 240);
  assert.equal(geo.height, 140);
  for (const p of geo.points) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    assert.ok(p.x >= geo.plot.x0 && p.x <= geo.plot.x1);
    assert.ok(p.y >= geo.plot.y0 && p.y <= geo.plot.y1);
  }
  assert.equal(geo.points.length, 2, 'Infinity and NaN rows are dropped');
});

test('lineChartGeometry breaks the line across long gaps', () => {
  const geo = lineChartGeometry([
    { date: '2026-09-10', avg: 3, count: 1 },
    { date: '2026-09-11', avg: 4, count: 1 },
    { date: '2026-09-12', avg: 4, count: 1 },
    { date: '2026-10-05', avg: 2, count: 1 }, // 23 days later
    { date: '2026-10-06', avg: 3, count: 1 },
  ], { width: 600, ...range });
  assert.deepEqual(geo.segments, [[0, 1, 2], [3, 4]]);
  assert.equal(segmentPath(geo.points, [0]), '', 'a lone point has no line');
  assert.match(segmentPath(geo.points, geo.segments[0]), /^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
});

test('lineChartGeometry bins a year into weekly points and places them mid-bin', () => {
  const from = '2025-10-09';
  const to = '2026-10-08';
  const series = [];
  for (let i = 0; i < 365; i += 1) series.push({ date: addDaysYmd(from, i), avg: 1 + (i % 5), count: 1 });
  const geo = lineChartGeometry(series, { width: 800, from, to });
  assert.ok(geo.points.length <= 53 && geo.points.length >= 52, `got ${geo.points.length}`);
  assert.equal(geo.segments.length, 1, 'continuous writing stays one line');
  assert.ok(geo.points[0].x > geo.plot.x0, 'a weekly bin is centred, not pinned to its first day');
  assert.ok(geo.xTicks.length >= 2 && geo.xTicks.length <= 7);
  assert.ok(geo.xTicks.some((t) => /20\d\d/.test(t.label)), 'ranges spanning two years show the year');
});

test('lineChartGeometry copes with an empty series and a one-day range', () => {
  const empty = lineChartGeometry([], { width: 400, ...range });
  assert.deepEqual(empty.points, []);
  assert.deepEqual(empty.segments, []);
  const oneDay = lineChartGeometry([{ date: '2026-10-08', avg: 3, count: 1 }], { width: 400, from: '2026-10-08', to: '2026-10-08' });
  assert.equal(oneDay.points.length, 1);
  assert.ok(Number.isFinite(oneDay.points[0].x));
});

test('describeMoodSeries and moodTableData tell the same story as the chart', () => {
  const series = [
    { date: '2026-10-01', avg: 2, count: 1 },
    { date: '2026-10-03', avg: 5, count: 1 },
    { date: '2026-10-04', avg: 4, count: 2 },
  ];
  const desc = describeMoodSeries(series, { ...range, locale: 'en-US' });
  assert.match(desc, /Average mood 3\.8 of 5 \(Good\) across 3 days/);
  assert.match(desc, /Best day Oct 3 \(5\.0\), lowest Oct 1 \(2\.0\)/);
  assert.equal(describeMoodSeries([], range), 'No mood has been recorded in this period.');
  assert.doesNotMatch(describeMoodSeries([{ date: '2026-10-01', avg: 3, count: 1 }], range), /Best day/);
  const table = moodTableData(series, { ...range, locale: 'en-US' });
  assert.deepEqual(table.headers, ['Date', 'Average mood (1-5)', 'Feeling', 'Entries']);
  assert.deepEqual(table.rows[0], ['Oct 1, 2026', '2.0', 'Low', '1']);
  assert.equal(table.rows.length, 3);
});

/* ------------------------------------------------------------------ heatmap */

test('heatLevel: raw counts for quiet journals, quartiles for busy ones', () => {
  assert.equal(heatLevel(0, 5), 0);
  assert.equal(heatLevel(-1, 5), 0);
  assert.equal(heatLevel(NaN, 5), 0);
  assert.deepEqual([1, 2, 3, 4].map((c) => heatLevel(c, 4)), [1, 2, 3, 4]);
  assert.equal(heatLevel(9, 3), 4, 'small max, larger count still caps at 4');
  assert.deepEqual([1, 5, 6, 10, 11, 15, 16, 20, 25].map((c) => heatLevel(c, 20)), [1, 1, 2, 2, 3, 3, 4, 4, 4]);
  assert.equal(heatLevel(1, 100), 1);
  assert.equal(heatLevel(100, 100), 4);
});

test('layoutHeatmap places each day in a Monday-first week grid', () => {
  // 2026-10-08 is a Thursday. 14 days ending then start on Friday 2026-09-25.
  const layout = layoutHeatmap({ today: '2026-10-08', days: 14, weekStart: 1 });
  assert.equal(layout.cells.length, 14);
  assert.deepEqual(layout.cells[0], { date: '2026-09-25', col: 0, row: 4 });
  const last = layout.cells[13];
  assert.deepEqual([last.date, last.row], ['2026-10-08', 3]);
  assert.equal(layout.cols, last.col + 1);
  assert.equal(layout.cols, 3);
  // Every cell is unique and rows are within 0..6.
  assert.equal(new Set(layout.cells.map((c) => `${c.col}:${c.row}`)).size, 14);
  assert.ok(layout.cells.every((c) => c.row >= 0 && c.row <= 6));
});

test('layoutHeatmap: Sunday-first shifts the rows', () => {
  const mon = layoutHeatmap({ today: '2026-10-08', days: 7, weekStart: 1 });
  const sun = layoutHeatmap({ today: '2026-10-08', days: 7, weekStart: 0 });
  assert.equal(mon.cells.at(-1).row, 3);
  assert.equal(sun.cells.at(-1).row, 4);
});

test('layoutHeatmap sizes and month marks for the three ranges', () => {
  for (const days of [30, 90, 365]) {
    const layout = layoutHeatmap({ today: '2026-10-08', days });
    assert.equal(layout.cells.length, days);
    assert.ok(layout.cols >= Math.ceil(days / 7) && layout.cols <= Math.ceil(days / 7) + 1, `cols for ${days}: ${layout.cols}`);
    assert.ok(layout.monthMarks.length >= 1);
    const marks = layout.monthMarks.map((m) => m.col);
    for (let i = 1; i < marks.length; i += 1) assert.ok(marks[i] - marks[i - 1] >= 3, 'month labels never collide');
  }
  assert.equal(layoutHeatmap({ today: '2026-10-08', days: 365 }).monthMarks.length >= 11, true);
});

// Regression: the month labels used to be shortDate(...).split(' ')[0], which is the day number in en-GB ("8 Oct"),
// "8." in de-DE and the whole date in ja-JP. They are now formatted as a month on its own.
const hasIcu = (locale) => Intl.DateTimeFormat.supportedLocalesOf([locale]).length === 1;

test('monthLabel is the month alone in any locale', { skip: !(hasIcu('de-DE') && hasIcu('ja-JP')) && 'needs full ICU' }, () => {
  assert.equal(monthLabel('2026-10-08', 'en-US'), 'Oct');
  assert.equal(monthLabel('2026-10-08', 'en-GB'), 'Oct');
  assert.equal(monthLabel('2026-10-08', 'de-DE'), 'Okt');
  assert.equal(monthLabel('2026-10-08', 'ja-JP'), '10月');
  assert.equal(monthLabel('2026-01-31', 'en-US'), 'Jan'); // UTC, never shifted by the viewer's time zone
  assert.equal(monthLabel('2026-02-30', 'en-US'), '');
  assert.equal(monthLabel('', 'en-US'), '');
});

test('layoutHeatmap month marks carry a month-only label for every locale', { skip: !(hasIcu('de-DE') && hasIcu('ja-JP')) && 'needs full ICU' }, () => {
  const expected = { 'en-US': 'Oct', 'en-GB': 'Oct', 'de-DE': 'Okt', 'ja-JP': '10月' };
  for (const [locale, october] of Object.entries(expected)) {
    const { monthMarks } = layoutHeatmap({ today: '2026-10-08', days: 90, locale });
    assert.ok(monthMarks.length >= 3, locale);
    for (const mark of monthMarks) {
      assert.equal(mark.label, monthLabel(mark.date, locale), locale);
      assert.ok(!/^\d+\.?$/.test(mark.label), `${locale}: "${mark.label}" is a bare day number`);
    }
    assert.equal(monthMarks.at(-1).label, october, locale);
  }
  // No locale given: still a label (the runtime default), never undefined.
  for (const mark of layoutHeatmap({ today: '2026-10-08', days: 90 }).monthMarks) assert.equal(typeof mark.label, 'string');
});

test('layoutHeatmap with bad input is empty', () => {
  assert.deepEqual(layoutHeatmap({ today: 'x', days: 30 }), { cols: 0, rows: 7, cells: [], monthMarks: [] });
  assert.equal(layoutHeatmap({ today: '2026-10-08', days: 0 }).cells.length, 0);
  assert.equal(layoutHeatmap().cells.length, 0);
});

test('indexCalendar tolerates malformed rows and sums duplicates', () => {
  const map = indexCalendar([
    { date: '2026-10-01', count: 2, words: 100 },
    { date: '2026-10-01', count: 1, words: 50 },
    { date: 'nope', count: 9, words: 9 },
    { date: '2026-10-02', count: 'x', words: -5 },
    null,
  ]);
  assert.deepEqual(map.get('2026-10-01'), { count: 3, words: 150 });
  assert.deepEqual(map.get('2026-10-02'), { count: 0, words: 0 });
  assert.equal(map.has('nope'), false);
  assert.equal(indexCalendar('junk').size, 0);
});

test('cellLabel / describeCalendar / calendarTableData read naturally', () => {
  assert.equal(cellLabel('2026-10-08', { count: 2, words: 340 }, 'en-US'), 'Thu, Oct 8: 2 entries, 340 words');
  assert.equal(cellLabel('2026-10-08', { count: 1, words: 1 }, 'en-US'), 'Thu, Oct 8: 1 entry, 1 word');
  assert.equal(cellLabel('2026-10-08', undefined, 'en-US'), 'Thu, Oct 8: no entries');
  const cal = [{ date: '2026-10-08', count: 1, words: 20 }, { date: '2026-10-05', count: 4, words: 400 }, { date: '2025-01-01', count: 9, words: 9 }];
  assert.equal(describeCalendar(cal, { today: '2026-10-08', days: 30, locale: 'en-US' }), 'Wrote on 2 of the last 30 days. Busiest day Oct 5 with 4 entries.');
  assert.equal(describeCalendar([], { today: '2026-10-08', days: 30 }), 'No entries in the last 30 days.');
  const table = calendarTableData(cal, { today: '2026-10-08', days: 30, locale: 'en-US' });
  assert.deepEqual(table.rows, [['Oct 5, 2026', '4', '400'], ['Oct 8, 2026', '1', '20']]);
});

/* --------------------------------------------------------------------- bars */

test('truncateLabel counts code points, not UTF-16 units', () => {
  assert.equal(truncateLabel('short', 10), 'short');
  assert.equal(truncateLabel('abcdefghij', 5), 'abcd…');
  assert.equal(truncateLabel('😀😀😀😀😀😀', 4), '😀😀😀…');
  assert.equal(Array.from(truncateLabel('😀'.repeat(100), 10)).length, 10);
  assert.equal(truncateLabel(null), '');
  assert.equal(truncateLabel('x'.repeat(100000), 22).length, 22);
});

test('barsGeometry scales to the largest count and keeps bars inside the box', () => {
  const geo = barsGeometry([{ name: 'calm', count: 8 }, { name: 'tired', count: 4 }, { name: 'x', count: 1 }], { width: 320 });
  assert.equal(geo.rows.length, 3);
  assert.equal(geo.rows[0].barW, geo.barMaxW);
  assert.ok(Math.abs(geo.rows[1].barW - geo.barMaxW / 2) < 0.2);
  assert.ok(geo.rows[2].barW >= 4, 'a tiny count is still visible');
  assert.ok(geo.barX + geo.barMaxW + 34 <= geo.width + 1e-6);
  assert.deepEqual(geo.rows.map((r) => r.y), [0, 30, 60]);
  assert.equal(geo.height, 90);
});

test('barsGeometry drops junk rows and handles empty input', () => {
  const geo = barsGeometry([{ name: 'ok', count: 2 }, { name: 'zero', count: 0 }, { name: 5, count: 3 }, null, { name: 'neg', count: -2 }], { width: 300 });
  assert.deepEqual(geo.rows.map((r) => r.full), ['ok']);
  const none = barsGeometry(undefined, { width: 300 });
  assert.equal(none.rows.length, 0);
  assert.equal(none.height, 0);
});

test('barsGeometry truncates hostile labels but keeps the full text for tooltips', () => {
  const evil = '<img src=x onerror=alert(1)>'.repeat(50);
  const geo = barsGeometry([{ name: evil, count: 3 }], { width: 260 });
  assert.ok(Array.from(geo.rows[0].label).length <= 23);
  assert.equal(geo.rows[0].full, evil);
  const tiny = barsGeometry([{ name: 'a', count: 1 }], { width: 10 });
  assert.equal(tiny.width, 200, 'width has a floor so the geometry never goes negative');
  assert.ok(tiny.barMaxW >= 20);
});

test('barsTableData keeps every row as text', () => {
  const t = barsTableData([{ name: 'calm', count: 7 }, { name: '<b>x</b>', count: '3' }], { caption: 'Top emotions', nameHeader: 'Emotion' });
  assert.equal(t.caption, 'Top emotions');
  assert.deepEqual(t.headers, ['Emotion', 'Count']);
  assert.deepEqual(t.rows, [['calm', '7'], ['<b>x</b>', '3']]);
});
