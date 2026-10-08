// Chart builders for the Insights view: plain data in, SVG DOM out.
//
// Two layers on purpose:
//   * pure helpers (dates, scales, binning, layout, descriptions) never touch `document`, so they run in
//     Node and are unit-tested in test/frontend/charts.test.js;
//   * builders (lineChart, calendarHeatmap, horizontalBars, dataTable) use dom.js's s()/h() and only
//     create nodes when called. Every dynamic string goes through text nodes / <title>, never markup.
//
// All dates are 'YYYY-MM-DD' calendar strings. Date math uses UTC midnights so daylight-saving shifts
// can never move a day. Colours come from CSS classes (see css/insights.css), not from attributes.
import { h, s } from './dom.js';

const DAY_MS = 86_400_000;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const r1 = (n) => Math.round(n * 10) / 10;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------ dates */

/** UTC milliseconds for a 'YYYY-MM-DD' string, or NaN when it is malformed or not a real date. */
export function parseYmd(str) {
  const m = YMD.exec(String(str));
  if (!m) return NaN;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  // Date.UTC rolls 2026-02-31 over into March; refuse such dates instead of silently shifting them.
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? ms : NaN;
}

/** 'YYYY-MM-DD' for a UTC millisecond timestamp. */
export function formatYmd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Add whole days to a date string. Returns '' when the input is not a valid date. */
export function addDaysYmd(str, n) {
  const ms = parseYmd(str);
  return Number.isNaN(ms) ? '' : formatYmd(ms + Math.trunc(n) * DAY_MS);
}

/** Whole days from date `a` to date `b` (negative when b is earlier). NaN for invalid input. */
export function daysBetween(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / DAY_MS);
}

/** Row of a date in a week grid: 0 = `weekStart` (1 = Monday, 0 = Sunday) ... 6. -1 for invalid input. */
export function weekdayIndex(str, weekStart = 1) {
  const ms = parseYmd(str);
  if (Number.isNaN(ms)) return -1;
  return (new Date(ms).getUTCDay() - weekStart + 7) % 7;
}

/** The `days` dates ending at `today`, oldest first. Empty for invalid input; capped at 3660 days. */
export function dateRange(today, days) {
  const n = Math.trunc(Number(days));
  if (Number.isNaN(parseYmd(today)) || !(n >= 1) || n > 3660) return [];
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(addDaysYmd(today, -i));
  return out;
}

/** "Oct 8", "Wed, Oct 8" or "Oct 8, 2026" in the viewer's locale (or `locale`). Invalid input yields ''. */
export function shortDate(ymd, { year = false, weekday = false, locale } = {}) {
  const ms = parseYmd(ymd);
  if (Number.isNaN(ms)) return '';
  const opts = { timeZone: 'UTC', month: 'short', day: 'numeric' };
  if (year) opts.year = 'numeric';
  if (weekday) opts.weekday = 'short';
  return new Date(ms).toLocaleDateString(locale, opts);
}

/**
 * Month name alone ("Oct", "Okt", "10月") in the viewer's locale. Formatted on its own because day+month strings
 * put the month in different places ("Oct 8", "8 Oct", "8. Okt.", "10月8日"), so they cannot be sliced.
 */
export function monthLabel(ymd, locale) {
  const ms = parseYmd(ymd);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleDateString(locale, { timeZone: 'UTC', month: 'short' });
}

/* ------------------------------------------------------------------- mood */

export const MOOD_WORDS = Object.freeze(['Awful', 'Low', 'Okay', 'Good', 'Great']);
export const MOOD_EMOJI = Object.freeze(['😞', '😕', '😐', '🙂', '😄']);

/** Nearest mood level 1..5 for an average (anything unusable is treated as the middle, 3). */
export function moodLevel(avg) {
  const n = Math.round(Number(avg));
  return Number.isFinite(n) ? clamp(n, 1, 5) : 3;
}

/** 'Awful' ... 'Great' for an average. */
export function moodWord(avg) {
  return MOOD_WORDS[moodLevel(avg) - 1];
}

/**
 * Daily bins vs weekly bins: a year of daily dots is noise, so long ranges are averaged per week.
 * @param {number} days
 */
export function chooseBinDays(days) {
  return days > 120 ? 7 : 1;
}

/**
 * Clean the server's mood series: drops rows with a bad date/average or outside [from, to], merges
 * duplicate dates (weighted by count) and sorts oldest first.
 * @param {Array<{date:string, avg:number, count?:number}>} series
 * @returns {Array<{date:string, avg:number, count:number}>}
 */
export function cleanMoodSeries(series, from, to) {
  if (!Array.isArray(series)) return [];
  const lo = parseYmd(from);
  const hi = parseYmd(to);
  const byDate = new Map();
  for (const row of series) {
    if (!row || typeof row !== 'object') continue;
    const at = parseYmd(row.date);
    const avg = row.avg;
    // Number(null) is 0, so only genuine numbers count; anything else would draw a fake "awful" day.
    if (Number.isNaN(at) || typeof avg !== 'number' || !Number.isFinite(avg)) continue;
    if ((!Number.isNaN(lo) && at < lo) || (!Number.isNaN(hi) && at > hi)) continue;
    const count = Number.isFinite(Number(row.count)) && Number(row.count) > 0 ? Number(row.count) : 1;
    const prev = byDate.get(row.date);
    if (prev) {
      prev.sum += clamp(avg, 1, 5) * count;
      prev.count += count;
    } else {
      byDate.set(row.date, { sum: clamp(avg, 1, 5) * count, count });
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, v]) => ({ date, avg: v.sum / v.count, count: v.count }));
}

/**
 * Average a mood series into bins of `binDays` days counted from `from`. With binDays = 1 this only
 * cleans the series. Each bin carries its first date, how many calendar days it covers and the
 * entry-weighted average.
 * @returns {Array<{date:string, endDate:string, days:number, avg:number, count:number}>}
 */
export function binMoodSeries(series, { from, to, binDays = 1 } = {}) {
  const clean = cleanMoodSeries(series, from, to);
  const size = Math.max(1, Math.trunc(binDays) || 1);
  if (size === 1) return clean.map((p) => ({ ...p, endDate: p.date, days: 1 }));
  const bins = new Map();
  for (const p of clean) {
    const index = Math.floor(daysBetween(from, p.date) / size);
    const bin = bins.get(index) || { sum: 0, count: 0 };
    bin.sum += p.avg * p.count;
    bin.count += p.count;
    bins.set(index, bin);
  }
  return [...bins.entries()].sort(([a], [b]) => a - b).map(([index, bin]) => {
    const date = addDaysYmd(from, index * size);
    const last = addDaysYmd(from, index * size + size - 1);
    const endDate = daysBetween(last, to) < 0 ? to : last;
    return { date, endDate, days: daysBetween(date, endDate) + 1, avg: bin.sum / bin.count, count: bin.count };
  });
}

const Y_MIN = 0.6;
const Y_MAX = 5.4;

/**
 * Pure layout of the mood line chart.
 * @param {Array} series raw server series ({date, avg, count})
 * @param {{width?:number, height?:number, from:string, to:string, binDays?:number, maxGapDays?:number,
 *   margin?:object, locale?:string}} opts
 * @returns {{width:number, height:number, plot:{x0:number,y0:number,x1:number,y1:number},
 *   points:Array<{x:number,y:number,date:string,endDate:string,avg:number,count:number,level:number,index:number}>,
 *   segments:number[][], yTicks:Array<{y:number,value:number}>, xTicks:Array<{x:number,label:string}>}}
 */
export function lineChartGeometry(series, opts = {}) {
  const width = Math.max(240, Math.round(opts.width || 640));
  const height = Math.max(140, Math.round(opts.height || 240));
  const m = { top: 14, right: 16, bottom: 30, left: 40, ...(opts.margin || {}) };
  const { from, to } = opts;
  const span = Math.max(1, daysBetween(from, to) || 1);
  const x0 = m.left;
  const x1 = Math.max(x0 + 40, width - m.right);
  const y0 = m.top;
  const y1 = Math.max(y0 + 40, height - m.bottom);
  const binDays = opts.binDays || chooseBinDays(span + 1);
  const xAtOffset = (offset) => x0 + ((x1 - x0) * clamp(offset, 0, span)) / span;
  const yAt = (avg) => y1 - ((clamp(avg, 1, 5) - Y_MIN) / (Y_MAX - Y_MIN)) * (y1 - y0);

  const bins = binMoodSeries(series, { from, to, binDays });
  const points = bins.map((b, index) => {
    const offset = daysBetween(from, b.date) + (b.days - 1) / 2;
    return {
      index, date: b.date, endDate: b.endDate, avg: b.avg, count: b.count, level: moodLevel(b.avg),
      x: r1(xAtOffset(offset)), y: r1(yAt(b.avg)), offset,
    };
  });

  // Break the line where the writer was away: joining day 3 to day 40 would invent a trend.
  const maxGap = opts.maxGapDays || Math.max(3, Math.round(span / 10), binDays * 3);
  const segments = [];
  points.forEach((p, i) => {
    const prev = points[i - 1];
    if (prev && p.offset - prev.offset <= maxGap) segments[segments.length - 1].push(i);
    else segments.push([i]);
  });

  const yTicks = [1, 2, 3, 4, 5].map((value) => ({ value, y: r1(yAt(value)) }));

  const tickCount = clamp(Math.floor((x1 - x0) / 84), 2, 7);
  const multiYear = from.slice(0, 4) !== to.slice(0, 4);
  const xTicks = [];
  for (let i = 0; i < tickCount; i += 1) {
    const offset = Math.round((span * i) / (tickCount - 1));
    xTicks.push({ x: r1(xAtOffset(offset)), label: shortDate(addDaysYmd(from, offset), { year: multiYear, locale: opts.locale }) });
  }
  return { width, height, plot: { x0, y0, x1, y1 }, points, segments, yTicks, xTicks };
}

/** SVG path data ('M x y L x y ...') for the points of one segment. '' when it has fewer than 2 points. */
export function segmentPath(points, segment) {
  if (segment.length < 2) return '';
  return segment.map((idx, i) => `${i === 0 ? 'M' : 'L'}${points[idx].x} ${points[idx].y}`).join(' ');
}

/** One-sentence summary of a mood series for the chart's <desc> and for screen readers. */
export function describeMoodSeries(series, { from, to, locale } = {}) {
  const clean = cleanMoodSeries(series, from, to);
  if (clean.length === 0) return 'No mood has been recorded in this period.';
  const total = clean.reduce((sum, p) => sum + p.count, 0);
  const avg = clean.reduce((sum, p) => sum + p.avg * p.count, 0) / total;
  const high = clean.reduce((best, p) => (p.avg > best.avg ? p : best));
  const low = clean.reduce((best, p) => (p.avg < best.avg ? p : best));
  const days = plural(clean.length, 'day');
  const base = `Average mood ${avg.toFixed(1)} of 5 (${moodWord(avg)}) across ${days} with a mood.`;
  if (high.avg === low.avg) return base;
  return `${base} Best day ${shortDate(high.date, { locale })} (${high.avg.toFixed(1)}), lowest ${shortDate(low.date, { locale })} (${low.avg.toFixed(1)}).`;
}

/** Rows for the hidden table that mirrors the mood chart. */
export function moodTableData(series, { from, to, locale } = {}) {
  const rows = cleanMoodSeries(series, from, to).map((p) => [
    shortDate(p.date, { year: true, locale }), p.avg.toFixed(1), moodWord(p.avg), String(p.count),
  ]);
  return { caption: 'Average mood per day', headers: ['Date', 'Average mood (1-5)', 'Feeling', 'Entries'], rows };
}

/* --------------------------------------------------------------- heatmap */

/** Heat level 0..4 for a day: 0 = nothing written, then quartiles of the busiest day (or the raw count when small). */
export function heatLevel(count, max) {
  const c = Number(count);
  if (!(c > 0)) return 0;
  const top = Number(max);
  if (!(top > 4)) return clamp(Math.ceil(c), 1, 4);
  return clamp(Math.ceil((c / top) * 4), 1, 4);
}

/**
 * Pure layout of the calendar heatmap: one column per week, one row per weekday.
 * @returns {{cols:number, rows:number, cells:Array<{date:string,col:number,row:number}>, monthMarks:Array<{col:number,date:string,label:string}>}}
 */
export function layoutHeatmap({ today, days, weekStart = 1, locale } = {}) {
  const dates = dateRange(today, days);
  if (dates.length === 0) return { cols: 0, rows: 7, cells: [], monthMarks: [] };
  const lead = weekdayIndex(dates[0], weekStart);
  const cells = dates.map((date, i) => ({ date, col: Math.floor((lead + i) / 7), row: (lead + i) % 7 }));
  const cols = cells[cells.length - 1].col + 1;
  const monthMarks = [];
  let lastMonth = '';
  let lastCol = -10;
  for (const cell of cells) {
    const month = cell.date.slice(0, 7);
    if (month === lastMonth) continue;
    lastMonth = month;
    // A label needs ~3 columns of room; the first (partial) month is labelled only when it is long enough.
    if (cell.col - lastCol >= 3) {
      monthMarks.push({ col: cell.col, date: cell.date, label: monthLabel(cell.date, locale) });
      lastCol = cell.col;
    }
  }
  return { cols, rows: 7, cells, monthMarks };
}

/** Index the server's calendar rows by date, dropping malformed ones. */
export function indexCalendar(calendar) {
  const map = new Map();
  if (!Array.isArray(calendar)) return map;
  for (const row of calendar) {
    if (!row || Number.isNaN(parseYmd(row.date))) continue;
    const count = Math.max(0, Math.trunc(Number(row.count)) || 0);
    const words = Math.max(0, Math.trunc(Number(row.words)) || 0);
    const prev = map.get(row.date);
    map.set(row.date, prev ? { count: prev.count + count, words: prev.words + words } : { count, words });
  }
  return map;
}

/** Text for one heatmap cell's tooltip: "Wed, Oct 8: 2 entries, 340 words" / "Wed, Oct 8: no entries". */
export function cellLabel(date, info, locale) {
  const when = shortDate(date, { weekday: true, locale });
  if (!info || info.count === 0) return `${when}: no entries`;
  const words = info.words > 0 ? `, ${plural(info.words, 'word')}` : '';
  return `${when}: ${plural(info.count, 'entry', 'entries')}${words}`;
}

/** Summary sentence for the heatmap's <desc>. */
export function describeCalendar(calendar, { today, days, locale } = {}) {
  const index = indexCalendar(calendar);
  const dates = dateRange(today, days);
  const written = dates.filter((d) => (index.get(d) || { count: 0 }).count > 0);
  if (written.length === 0) return `No entries in the last ${plural(dates.length, 'day')}.`;
  const busiest = written.reduce((best, d) => (index.get(d).count > index.get(best).count ? d : best));
  return `Wrote on ${written.length} of the last ${plural(dates.length, 'day')}. Busiest day ${shortDate(busiest, { locale })} with ${plural(index.get(busiest).count, 'entry', 'entries')}.`;
}

/** Rows for the hidden table that mirrors the heatmap (only days with entries). */
export function calendarTableData(calendar, { today, days, locale } = {}) {
  const index = indexCalendar(calendar);
  const rows = dateRange(today, days)
    .filter((d) => (index.get(d) || { count: 0 }).count > 0)
    .map((d) => [shortDate(d, { year: true, locale }), String(index.get(d).count), String(index.get(d).words)]);
  return { caption: 'Entries per day', headers: ['Date', 'Entries', 'Words'], rows };
}

/* ------------------------------------------------------------------ bars */

/** Shorten a label to `max` characters (by code point) with an ellipsis. */
export function truncateLabel(text, max = 22) {
  const chars = Array.from(String(text ?? ''));
  return chars.length <= max ? chars.join('') : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/**
 * Pure layout of the horizontal bar chart.
 * @param {Array<{name:string,count:number}>} items
 * @returns {{width:number,height:number,labelW:number,barX:number,barMaxW:number,rowHeight:number,
 *   rows:Array<{label:string,full:string,count:number,y:number,barW:number}>}}
 */
export function barsGeometry(items, { width = 320, rowHeight = 30, countW = 34 } = {}) {
  const w = Math.max(200, Math.round(width));
  const clean = (Array.isArray(items) ? items : [])
    .filter((i) => i && typeof i.name === 'string' && Number(i.count) > 0)
    .map((i) => ({ name: i.name, count: Math.trunc(Number(i.count)) }));
  const labelW = Math.round(clamp(w * 0.38, 80, 160));
  const barX = labelW + 8;
  const barMaxW = Math.max(20, w - barX - countW);
  const max = clean.reduce((m, i) => Math.max(m, i.count), 0) || 1;
  const maxChars = Math.max(6, Math.floor(labelW / 7.2));
  const rows = clean.map((item, i) => ({
    label: truncateLabel(item.name, maxChars),
    full: item.name,
    count: item.count,
    y: i * rowHeight,
    barW: r1(Math.max(4, (item.count / max) * barMaxW)),
  }));
  return { width: w, height: rows.length * rowHeight, labelW, barX, barMaxW, rowHeight, rows };
}

/** Rows for the hidden table that mirrors a bar chart. */
export function barsTableData(items, { caption = 'Counts', nameHeader = 'Name' } = {}) {
  const rows = (Array.isArray(items) ? items : [])
    .filter((i) => i && typeof i.name === 'string')
    .map((i) => [i.name, String(Math.trunc(Number(i.count)) || 0)]);
  return { caption, headers: [nameHeader, 'Count'], rows };
}

/* -------------------------------------------------------------- builders */
let chartSeq = 0;
const nextChartId = () => `insights-chart-${(chartSeq += 1)}`;

function chartRoot({ width, height, title, desc, className }) {
  const id = nextChartId();
  const svg = s('svg', {
    class: ['insights-chart', className],
    width, height, viewBox: `0 0 ${width} ${height}`,
    role: 'img', 'aria-labelledby': `${id}-t ${id}-d`, focusable: 'false',
  });
  svg.append(s('title', { id: `${id}-t` }, title), s('desc', { id: `${id}-d` }, desc));
  return svg;
}

/**
 * Mood line chart.
 * @param {Array<{date:string,avg:number,count:number}>} series
 * @param {{today:string, days:number, width?:number, height?:number, locale?:string}} opts
 * @returns {SVGSVGElement}
 */
export function lineChart(series, opts) {
  const { today, days, locale } = opts;
  const from = addDaysYmd(today, -(days - 1));
  const geo = lineChartGeometry(series, { width: opts.width, height: opts.height, from, to: today, locale });
  const svg = chartRoot({
    width: geo.width, height: geo.height, className: 'insights-chart-line',
    title: `Mood over the last ${plural(days, 'day')}`,
    desc: describeMoodSeries(series, { from, to: today, locale }),
  });
  const { x0, x1, y0, y1 } = geo.plot;

  const grid = s('g', { 'aria-hidden': 'true' });
  for (const t of geo.yTicks) {
    grid.append(
      s('line', { class: 'insights-grid', x1: x0, x2: x1, y1: t.y, y2: t.y }),
      s('text', { class: 'insights-emoji', x: x0 - 8, y: t.y, 'text-anchor': 'end', 'dominant-baseline': 'central' }, MOOD_EMOJI[t.value - 1]),
    );
  }
  for (const t of geo.xTicks) {
    grid.append(s('text', { class: 'insights-axis', x: t.x, y: y1 + 20, 'text-anchor': t.x <= x0 + 1 ? 'start' : t.x >= x1 - 1 ? 'end' : 'middle' }, t.label));
  }
  svg.append(grid);

  const lines = s('g', { 'aria-hidden': 'true' });
  for (const seg of geo.segments) {
    const d = segmentPath(geo.points, seg);
    if (d) lines.append(s('path', { class: 'insights-line', d }));
  }
  svg.append(lines);

  const dotR = geo.points.length > 60 ? 3 : 4.5;
  const dots = s('g', { 'aria-hidden': 'true' });
  for (const p of geo.points) {
    const span = p.endDate !== p.date ? `${shortDate(p.date, { locale })} to ${shortDate(p.endDate, { locale })}` : shortDate(p.date, { weekday: true, locale });
    const dot = s('circle', {
      class: ['insights-dot', `level-${p.level}`], cx: p.x, cy: p.y, r: dotR,
      'data-date': p.date, 'data-avg': p.avg.toFixed(2), 'data-count': p.count,
    });
    dot.append(s('title', null, `${span}: mood ${p.avg.toFixed(1)} (${moodWord(p.avg)}), ${plural(p.count, 'entry', 'entries')}`));
    dots.append(dot);
  }
  svg.append(dots);

  if (geo.points.length === 0) {
    svg.append(s('text', { class: 'insights-note', x: (x0 + x1) / 2, y: (y0 + y1) / 2, 'text-anchor': 'middle', 'aria-hidden': 'true' }, 'Moods you add to entries will show up here'));
  }
  return svg;
}

/**
 * Calendar heatmap: one square per day, columns are weeks.
 * @param {Array<{date:string,count:number,words:number}>} calendar
 * @param {{today:string, days:number, width?:number, weekStart?:number, cellMin?:number, cellMax?:number, locale?:string}} opts
 *   `width` is the room available; the chart never gets narrower than cellMin allows (callers scroll it).
 * @returns {SVGSVGElement}
 */
export function calendarHeatmap(calendar, opts) {
  const { today, days, locale } = opts;
  const layout = layoutHeatmap({ today, days, weekStart: opts.weekStart ?? 1, locale });
  const index = indexCalendar(calendar);
  const gap = 3;
  const left = 30;
  const top = 18;
  const room = (opts.width || 640) - left;
  const cell = clamp(Math.floor(room / Math.max(1, layout.cols)) - gap, opts.cellMin ?? 10, opts.cellMax ?? 20);
  const step = cell + gap;
  const width = left + layout.cols * step;
  const height = top + 7 * step;
  const max = layout.cells.reduce((m, c) => Math.max(m, (index.get(c.date) || { count: 0 }).count), 0);

  const svg = chartRoot({
    width, height, className: 'insights-chart-heat',
    title: `Writing days in the last ${plural(days, 'day')}`,
    desc: describeCalendar(calendar, { today, days, locale }),
  });

  const labels = s('g', { 'aria-hidden': 'true' });
  const weekStart = opts.weekStart ?? 1;
  [0, 2, 4].forEach((row) => {
    const dayIndex = (row + weekStart) % 7; // 0 = Sunday
    const name = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dayIndex];
    labels.append(s('text', { class: 'insights-axis', x: 0, y: top + row * step + cell * 0.75 }, name));
  });
  for (const mark of layout.monthMarks) {
    labels.append(s('text', { class: 'insights-axis', x: left + mark.col * step, y: 11 }, mark.label));
  }
  svg.append(labels);

  const cells = s('g', { 'aria-hidden': 'true' });
  for (const c of layout.cells) {
    const info = index.get(c.date);
    const level = heatLevel(info ? info.count : 0, max);
    const rect = s('rect', {
      class: ['insights-cell', `level-${level}`], x: left + c.col * step, y: top + c.row * step,
      width: cell, height: cell, rx: Math.min(3, cell / 4), 'data-date': c.date,
      'data-count': info ? info.count : 0, 'data-words': info ? info.words : 0,
    });
    rect.append(s('title', null, cellLabel(c.date, info, locale)));
    cells.append(rect);
  }
  svg.append(cells);
  return svg;
}

/**
 * Horizontal bars (top emotions / tags).
 * @param {Array<{name:string,count:number}>} items
 * @param {{width?:number, title:string, desc?:string, tone?:string, rowHeight?:number}} opts
 * @returns {SVGSVGElement}
 */
export function horizontalBars(items, opts) {
  const geo = barsGeometry(items, { width: opts.width, rowHeight: opts.rowHeight });
  const total = geo.rows.reduce((sum, r) => sum + r.count, 0);
  const svg = chartRoot({
    width: geo.width, height: Math.max(geo.height, 1), className: ['insights-chart-bars', opts.tone ? `tone-${opts.tone}` : ''],
    title: opts.title,
    desc: opts.desc || (geo.rows.length ? `${plural(geo.rows.length, 'item')}, ${plural(total, 'mention')} in total. Most common: ${geo.rows[0].full} (${geo.rows[0].count}).` : 'Nothing to show yet.'),
  });
  for (const row of geo.rows) {
    const g = s('g', { 'aria-hidden': 'true' });
    // A nested <svg> clips long or wide-glyph labels to their column even when truncation guessed wrong.
    const label = s('svg', { x: 0, y: row.y, width: geo.labelW, height: geo.rowHeight });
    label.append(s('text', { class: 'insights-bar-label', x: 0, y: geo.rowHeight / 2, 'dominant-baseline': 'central' }, row.label));
    const bar = s('rect', { class: 'insights-bar', x: geo.barX, y: row.y + 6, width: row.barW, height: geo.rowHeight - 12, rx: 4 });
    bar.append(s('title', null, `${row.full}: ${row.count}`));
    g.append(
      label, bar,
      s('text', { class: 'insights-bar-count', x: geo.barX + row.barW + 6, y: row.y + geo.rowHeight / 2, 'dominant-baseline': 'central' }, String(row.count)),
    );
    svg.append(g);
  }
  return svg;
}

/**
 * Visually hidden table (inside an sr-only <div>) that carries the same data as a chart, for screen readers and as a text fallback.
 * @param {{caption:string, headers:string[], rows:string[][]}} data
 */
export function dataTable(data) {
  // The wrapper is what gets clipped: a table box ignores width/overflow, so it cannot be hidden reliably on its own.
  return h('div', { class: 'sr-only' }, h('table', null,
    h('caption', null, data.caption),
    h('thead', null, h('tr', null, data.headers.map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', null, data.rows.map((r) => h('tr', null, r.map((c, i) => h(i === 0 ? 'th' : 'td', i === 0 ? { scope: 'row' } : null, c))))),
  ));
}
