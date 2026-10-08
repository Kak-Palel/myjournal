// Insights: stat cards, mood line chart, writing-days heatmap, top emotions / tags, and the weekly reflection.
// Charts come from lib/charts.js (pure data -> SVG) and are rebuilt when the container width changes.
import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { icon, skeleton, showError, todayString } from '../lib/ui.js';
import {
  lineChart, calendarHeatmap, horizontalBars, dataTable, moodTableData, calendarTableData, barsTableData, addDaysYmd,
} from '../lib/charts.js';
import { RANGES, normalizeRange, isEmptyOverview, statCards } from '../components/insights-logic.js';
import { createWeeklyCard } from '../components/insights-weekly.js';

const STORAGE_KEY = 'mj-insights-days';

function loadRange() {
  try { return normalizeRange(localStorage.getItem(STORAGE_KEY)); } catch { return normalizeRange(null); }
}
function saveRange(days) {
  try { localStorage.setItem(STORAGE_KEY, String(days)); } catch { /* private mode: the choice just is not remembered */ }
}

/** First day of the week for the viewer's locale as a JS weekday (0 = Sunday ... 6); Monday when the browser cannot say. */
function localeWeekStart() {
  try {
    const locale = new Intl.Locale(navigator.language);
    const info = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo;
    return info && Number.isInteger(info.firstDay) ? info.firstDay % 7 : 1;
  } catch {
    return 1;
  }
}

/** "30 days", "90 days", "year" - reads naturally after "over the last". */
const rangeWords = (days) => (days >= 365 ? 'year' : `${days} days`);

export default async function insightsView(ctx) {
  const { root, signal, app } = ctx;
  const today = todayString();
  const weekStart = localeWeekStart();
  let days = loadRange();
  let overview = null;
  let loadToken = 0;

  /* ------------------------------------------------------------- shell */
  const rangeBtns = RANGES.map((r) => h('button', {
    type: 'button', class: 'insights-range-btn', role: 'radio', 'aria-checked': String(r.days === days), dataset: { days: r.days },
    onClick: () => setRange(r.days),
    onKeydown: (e) => onRangeKey(e, r.days),
  }, r.label));
  const rangeGroup = h('div', { class: 'insights-range', role: 'radiogroup', 'aria-label': 'Time range' }, rangeBtns);

  const statsHost = h('div', { class: 'insights-stats' });
  // Re-rendering the cards would make a screen reader read all five; announce one short line instead.
  const announce = h('p', { class: 'sr-only', role: 'status' });
  const bodyHost = h('div', { class: 'insights-body stack' });
  const weekly = createWeeklyCard({ app, signal, today });

  const page = h('div', { class: 'page page-wide insights-page' },
    h('header', { class: 'page-header' },
      h('div', null, h('h1', null, 'Insights'), h('p', { class: 'page-sub' }, 'Patterns in how you write and how you feel. All of it is worked out on this computer.')),
      rangeGroup),
    announce,
    statsHost,
    bodyHost,
    weekly.el);
  mount(root, page);

  function onRangeKey(e, current) {
    const idx = RANGES.findIndex((r) => r.days === current);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % RANGES.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + RANGES.length) % RANGES.length;
    if (next === -1) return;
    e.preventDefault();
    setRange(RANGES[next].days);
    rangeBtns[next].focus();
  }

  function paintRange() {
    for (const btn of rangeBtns) {
      const on = Number(btn.dataset.days) === days;
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
      btn.classList.toggle('is-active', on);
    }
  }

  function setRange(next) {
    if (next === days) return;
    days = next;
    saveRange(days);
    paintRange();
    loadOverview();
  }

  /* ---------------------------------------------------- stat cards */
  function paintStats() {
    mount(statsHost, statCards(overview, today, days).map((c) => h('div', { class: ['insights-stat', `insights-stat-${c.id}`] },
      h('div', { class: 'insights-stat-label' }, c.icon ? icon(c.icon, { size: 16 }) : null, c.label),
      h('div', { class: 'insights-stat-value' }, c.value, c.unit ? h('span', { class: 'insights-stat-unit' }, ` ${c.unit}`) : null),
      h('div', { class: 'insights-stat-note' }, c.note))));
  }

  /* ------------------------------------------------------- charts */
  const readoutText = 'Hover or tap a point for details.';
  let moodReadout;
  let heatReadout;
  let moodBox;
  let heatBox;
  let heatScroll;
  let emoBox;
  let tagBox;
  let lastWidth = 0;

  function widthOf(el, fallback) {
    const w = el ? Math.floor(el.getBoundingClientRect().width) : 0;
    return w > 40 ? w : fallback;
  }

  function paintCharts() {
    if (!overview || !moodBox) return;
    const locale = undefined;
    const mood = overview.mood || { average: null, series: [] };
    const mw = widthOf(moodBox, 600);
    mount(moodBox,
      lineChart(mood.series, { today, days, width: mw, height: mw < 420 ? 200 : 250, locale }),
      dataTable(moodTableData(mood.series, { from: addDaysYmd(today, -(days - 1)), to: today, locale })));

    const hw = widthOf(heatScroll, 640);
    mount(heatBox,
      calendarHeatmap(overview.calendar, { today, days, width: hw, cellMax: 26, weekStart, locale }),
      dataTable(calendarTableData(overview.calendar, { today, days, locale })));
    heatScroll.scrollLeft = heatScroll.scrollWidth;

    const bw = widthOf(emoBox, 320);
    mount(emoBox, ...barChart(overview.emotions, bw, 'Top emotions', 'Emotion', 'emotion'));
    mount(tagBox, ...barChart(overview.tags, widthOf(tagBox, 320), 'Top tags', 'Tag', 'tag'));
  }

  function barChart(items, width, title, header, tone) {
    const list = Array.isArray(items) ? items.filter((i) => i && Number(i.count) > 0) : [];
    if (!list.length) {
      return [h('p', { class: 'muted insights-none' }, tone === 'emotion'
        ? 'Emotions show up after you wrap up an entry and your companion names how it felt.'
        : 'Tags you add to entries show up here.')];
    }
    return [horizontalBars(list, { width, title, tone }), dataTable(barsTableData(list, { caption: title, nameHeader: header }))];
  }

  function chartCard({ id, title, sub, bodyNodes }) {
    return h('section', { class: 'card insights-card', 'aria-labelledby': `${id}-title` },
      h('h2', { class: 'insights-card-title', id: `${id}-title` }, title),
      sub ? h('p', { class: 'muted insights-card-sub' }, sub) : null,
      bodyNodes);
  }

  function heatLegend() {
    return h('div', { class: 'insights-legend', 'aria-hidden': 'true' },
      h('span', null, 'Less'),
      [0, 1, 2, 3, 4].map((l) => h('span', { class: ['insights-legend-cell', `level-${l}`] })),
      h('span', null, 'More'));
  }

  function paintBody() {
    if (isEmptyOverview(overview)) { paintEmpty(); return; }
    const mood = overview.mood || {};
    const avg = Number.isFinite(mood.average) ? mood.average : null;
    moodReadout = h('p', { class: 'insights-readout muted small', 'aria-live': 'polite' }, readoutText);
    heatReadout = h('p', { class: 'insights-readout muted small', 'aria-live': 'polite' }, 'Hover or tap a day for details.');
    moodBox = h('div', { class: 'insights-chart-box' });
    heatScroll = h('div', { class: 'insights-heat-scroll' }, heatBox = h('div', { class: 'insights-heat-box' }));
    emoBox = h('div', { class: 'insights-chart-box' });
    tagBox = h('div', { class: 'insights-chart-box' });
    mount(bodyHost,
      chartCard({
        id: 'insights-mood', title: 'Mood',
        sub: avg === null ? 'Pick a mood on an entry and your trend will draw itself.' : `Average ${avg.toFixed(1)} of 5 over the last ${rangeWords(days)}.`,
        bodyNodes: [moodBox, moodReadout],
      }),
      chartCard({
        id: 'insights-calendar', title: 'Writing days', sub: `Each square is a day. Darker means you wrote more, over the last ${rangeWords(days)}.`,
        bodyNodes: [heatScroll, heatLegend(), heatReadout],
      }),
      h('div', { class: 'insights-two' },
        chartCard({ id: 'insights-emotions', title: 'Top emotions', sub: 'What your entries were about, feeling-wise.', bodyNodes: [emoBox] }),
        chartCard({ id: 'insights-tags', title: 'Top tags', sub: 'The themes you tag most.', bodyNodes: [tagBox] })));
    paintCharts();
    lastWidth = widthOf(bodyHost, 0);
  }

  function paintEmpty() {
    moodBox = null;
    const ghost = calendarHeatmap([], { today, days: 90, width: 640 });
    mount(bodyHost, h('section', { class: 'card insights-empty' },
      h('div', { class: 'insights-empty-ghost', 'aria-hidden': 'true' }, ghost),
      h('div', { class: 'insights-empty-copy' },
        h('div', { class: 'empty-icon' }, icon('sprout', { size: 28 })),
        h('h2', { class: 'insights-empty-title' }, 'Your insights will grow with you'),
        h('p', { class: 'muted' }, 'Write your first entry and this page fills in: your streak, your mood over time, the days you showed up and the themes that keep coming back.'),
        h('a', { class: 'btn btn-primary', href: '#/?focus=1' }, icon('pen', { size: 16 }), 'Write your first entry'))));
  }

  /* ----------------------------------------------------------- loading */
  async function loadOverview() {
    const mine = ++loadToken;
    mount(statsHost, skeleton(2));
    mount(bodyHost, skeleton(6));
    try {
      const data = await api.get(`/insights/overview?today=${encodeURIComponent(today)}&days=${days}`, { signal });
      if (mine !== loadToken) return;
      overview = data;
      paintStats();
      paintBody();
      announce.textContent = isEmptyOverview(overview)
        ? 'No entries yet.'
        : `Showing the last ${rangeWords(days)}: ${Number(overview.totals.entries) || 0} entries, ${Number(overview.totals.daysWritten) || 0} days written.`;
    } catch (err) {
      if ((err && err.name === 'AbortError') || mine !== loadToken) return;
      mount(statsHost);
      showError(bodyHost, err, { onRetry: () => loadOverview() });
    }
  }

  paintRange();
  loadOverview();
  weekly.load();

  /* Rebuild charts when the container changes width (rotation, window resize, sidebar). */
  let resizeFrame = 0;
  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        const w = widthOf(bodyHost, 0);
        if (overview && moodBox && Math.abs(w - lastWidth) > 8) { lastWidth = w; paintCharts(); }
      });
    })
    : null;
  if (observer) observer.observe(bodyHost);

  /* Tap / click a dot or a day to read it out (the <title> tooltips do not exist on touch screens). */
  const onPick = (e) => {
    const target = e.target.closest ? e.target.closest('.insights-dot, .insights-cell') : null;
    if (!target) return;
    const title = target.querySelector('title');
    const line = target.classList.contains('insights-dot') ? moodReadout : heatReadout;
    if (title && line) line.textContent = title.textContent;
  };
  bodyHost.addEventListener('click', onPick);

  return () => {
    loadToken += 1;
    if (observer) observer.disconnect();
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    bodyHost.removeEventListener('click', onPick);
  };
}
