import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, dateFromDayNumber, dayNumber, diffDays, formatLongDate, formatShortDate, formatWeekdayDate, isValidDateString, parseDateString, toDateString, weekdayIndex,
} from '../../src/journal/dates.js';

test('isValidDateString accepts real calendar days only', () => {
  for (const ok of ['2026-10-08', '2024-02-29', '2000-02-29', '1999-12-31', '2026-01-01']) assert.ok(isValidDateString(ok), ok);
  for (const bad of ['2026-02-29', '2100-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-1', '26-10-08', '2026-10-08T00:00:00', '', null, undefined, 20261008, ' 2026-10-08', '2026/10/08', '0099-01-01']) {
    assert.ok(!isValidDateString(bad), String(bad));
  }
});

test('dayNumber round-trips and is consecutive across month, year and leap boundaries', () => {
  assert.equal(dayNumber('1970-01-01'), 0);
  assert.equal(dayNumber('1970-01-02'), 1);
  assert.equal(dayNumber('1969-12-31'), -1);
  assert.ok(Number.isNaN(dayNumber('nope')));
  for (const [a, b] of [['2026-02-28', '2026-03-01'], ['2024-02-28', '2024-02-29'], ['2024-02-29', '2024-03-01'], ['2026-12-31', '2027-01-01'], ['2100-02-28', '2100-03-01']]) {
    assert.equal(dayNumber(b) - dayNumber(a), 1, `${a} -> ${b}`);
  }
  assert.equal(diffDays('2024-02-28', '2024-03-01'), 2, '2024 is a leap year');
  assert.equal(diffDays('2026-02-28', '2026-03-01'), 1, '2026 is not');
  assert.equal(diffDays('2100-02-28', '2100-03-01'), 1, '2100 is not a leap year');
  for (const d of ['2026-10-08', '2024-02-29', '1999-12-31', '2000-01-01']) assert.equal(dateFromDayNumber(dayNumber(d)), d);
});

test('addDays is DST- and year-safe', () => {
  assert.equal(addDays('2026-03-08', 1), '2026-03-09'); // US spring forward
  assert.equal(addDays('2026-03-29', 1), '2026-03-30'); // EU spring forward
  assert.equal(addDays('2026-10-25', 1), '2026-10-26'); // EU fall back
  assert.equal(addDays('2026-11-01', 1), '2026-11-02'); // US fall back
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(addDays('2026-10-08', -89), '2026-07-11');
  assert.equal(addDays('2026-10-08', 0), '2026-10-08');
  assert.equal(addDays('bad', 1), null);
});

test('weekdayIndex and formatting', () => {
  assert.equal(weekdayIndex('2026-10-08'), 4);
  assert.equal(weekdayIndex('1970-01-01'), 4);
  assert.equal(weekdayIndex('1969-12-31'), 3);
  assert.equal(weekdayIndex('2024-02-29'), 4);
  assert.equal(weekdayIndex('x'), -1);
  assert.equal(formatLongDate('2026-10-08'), 'Thursday, 8 October 2026');
  assert.equal(formatLongDate('2024-02-29'), 'Thursday, 29 February 2024');
  assert.equal(formatLongDate('nope'), '');
  assert.equal(formatShortDate('2026-10-03'), 'Oct 3');
  assert.equal(formatShortDate('2025-10-03', { withYear: true }), 'Oct 3, 2025');
  assert.equal(formatWeekdayDate('2026-10-02'), 'Fri 2 Oct');
  assert.equal(formatShortDate('x'), '');
});

test('parseDateString and toDateString', () => {
  assert.deepEqual(parseDateString('2026-10-08'), { year: 2026, month: 10, day: 8 });
  assert.equal(parseDateString('2026-10-8'), null);
  assert.equal(toDateString('2026-10-08'), '2026-10-08');
  assert.equal(toDateString('2026-02-30'), null);
  assert.equal(toDateString(new Date(2026, 9, 8, 23, 59)), '2026-10-08', 'Date objects are read in local time');
  assert.equal(toDateString(new Date(2026, 0, 1, 0, 0)), '2026-01-01');
  assert.equal(toDateString(new Date('invalid')), null);
  assert.equal(toDateString(null), null);
  assert.equal(toDateString(undefined), null);
  assert.equal(toDateString(NaN), null);
  assert.equal(toDateString(new Date(2026, 9, 8, 12).getTime()), '2026-10-08');
  assert.equal(toDateString(''), null);
});
