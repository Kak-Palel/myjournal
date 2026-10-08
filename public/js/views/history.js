// History view: search, filters, month-grouped list and "Load more".
// Every request gets its own AbortController (a newer search cancels the older one) and results from
// a superseded request are ignored, so fast typing can never show stale results.
import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { icon, emptyState, skeleton, showError, formatMonth, todayString } from '../lib/ui.js';
import { createFilters } from '../components/history-filters.js';
import { renderEntryCard } from '../components/history-card.js';
import {
  parseFilters, filtersToParams, hasActiveFilters, listPath, groupByMonth, monthStart, searchTerms,
} from '../components/history-format.js';

const PAGE_SIZE = 30;

function listSkeleton() {
  return h('div', { class: 'hist-skeleton', 'aria-hidden': 'true' },
    Array.from({ length: 4 }, () => h('div', { class: 'hist-skeleton-card' }, skeleton(3))));
}

export default async function historyView(ctx) {
  const { root, query, signal, app } = ctx;
  let filters = parseFilters(query);
  let nextBefore = null;
  let token = 0;
  let controller = null;
  let disposed = false;
  let loadedCount = 0;
  let lastKey = null; // month of the last rendered card (so "Load more" continues the open group)
  let lastList = null;
  let flatList = null;

  const status = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const countEl = h('p', { class: 'hist-count muted', hidden: true });
  const resultsEl = h('div', { class: 'hist-results' });
  const moreWrap = h('div', { class: 'hist-more' });

  const filterBar = createFilters({ filters, onChange: onFilters });
  mount(root, h('div', { class: 'page hist-page' },
    h('header', { class: 'page-header' }, h('div', null, h('h1', null, 'History'), h('p', { class: 'page-sub' }, 'Everything you have written, newest first.'))),
    filterBar.el,
    countEl,
    resultsEl,
    moreWrap,
    status));

  /* ------------------------------------------------------------- rendering */
  const searching = () => Boolean(filters.q.trim());

  function resetList() {
    lastKey = null;
    lastList = null;
    flatList = null;
    loadedCount = 0;
  }

  function appendCards(entries) {
    const terms = searching() ? searchTerms(filters.q) : [];
    const card = (e) => renderEntryCard(e, { terms, onTag: filterByTag });

    if (searching()) { // ranked results: month grouping would scramble the ranking
      if (!flatList) { flatList = h('ul', { class: 'hist-list' }); resultsEl.replaceChildren(flatList); }
      flatList.append(...entries.map(card));
      return;
    }
    if (resultsEl.querySelector('.hist-skeleton, .empty, .notice')) resultsEl.replaceChildren();
    for (const group of groupByMonth(entries, lastKey)) {
      if (group.continues && lastList) {
        lastList.append(...group.entries.map(card));
      } else {
        const list = h('ul', { class: 'hist-list' }, group.entries.map(card));
        const heading = monthStart(group.key) ? formatMonth(monthStart(group.key)) : 'Undated';
        resultsEl.append(h('section', { class: 'hist-month', 'aria-label': heading }, h('h2', { class: 'hist-month-title' }, heading), list));
        lastList = list;
      }
      lastKey = group.key;
    }
  }

  function renderEmpty() {
    if (hasActiveFilters(filters)) {
      resultsEl.replaceChildren(emptyState({
        icon: 'search',
        title: searching() ? `Nothing matches “${filters.q.trim()}”` : 'No entries match these filters',
        body: 'Try different words, or clear the filters to see everything.',
        action: h('button', { type: 'button', class: 'btn', onClick: () => applyFilters({ q: '', mood: null, tag: '', pinned: false }) }, 'Clear search and filters'),
      }));
    } else {
      resultsEl.replaceChildren(emptyState({
        icon: 'book',
        title: 'Your journal is waiting',
        body: 'Entries you write show up here, grouped by month. Nothing leaves this computer unless you connect an AI.',
        action: h('a', { class: 'btn btn-primary', href: '#/?focus=1' }, icon('pen', { size: 18 }), 'Write your first entry'),
      }));
    }
  }

  function paintMore(loading = false) {
    moreWrap.replaceChildren(...(nextBefore !== null
      ? [h('button', { type: 'button', class: 'btn hist-more-btn', disabled: loading, onClick: () => load({ append: true }) }, loading ? 'Loading…' : 'Load more')]
      : []));
  }

  function paintCount() {
    if (searching() && loadedCount > 0) {
      countEl.textContent = `${loadedCount} ${loadedCount === 1 ? 'result' : 'results'} for “${filters.q.trim()}”`;
      countEl.hidden = false;
    } else {
      countEl.hidden = true;
    }
  }

  /* --------------------------------------------------------------- loading */
  async function load({ append = false } = {}) {
    if (controller) controller.abort();
    const ctl = new AbortController();
    controller = ctl;
    const onNav = () => ctl.abort();
    signal.addEventListener('abort', onNav, { once: true });
    const mine = ++token;

    if (append) {
      paintMore(true);
    } else {
      resetList();
      nextBefore = null;
      resultsEl.replaceChildren(listSkeleton());
      moreWrap.replaceChildren();
      countEl.hidden = true;
    }

    try {
      const res = await api.get(listPath(filters, { before: append ? nextBefore : null, limit: PAGE_SIZE }), { signal: ctl.signal });
      if (mine !== token || disposed) return;
      const entries = res.entries || [];
      nextBefore = res.nextBefore ?? null;
      if (!append && entries.length === 0) {
        renderEmpty();
        paintMore();
        status.textContent = searching() ? 'No results.' : 'No entries.';
        return;
      }
      appendCards(entries);
      loadedCount += entries.length;
      paintCount();
      paintMore();
      if (append) status.textContent = `Loaded ${entries.length} more ${entries.length === 1 ? 'entry' : 'entries'}.`;
      else if (searching()) status.textContent = `${entries.length} ${entries.length === 1 ? 'result' : 'results'}.`;
    } catch (err) {
      if (mine !== token || disposed || (err && err.name === 'AbortError')) return;
      if (append) {
        app.toast(err && err.message ? err.message : 'Could not load more.', { kind: 'error' });
        paintMore(false);
      } else {
        showError(resultsEl, err, { onRetry: () => load() });
        moreWrap.replaceChildren();
      }
    } finally {
      signal.removeEventListener('abort', onNav);
    }
  }

  function syncUrl() {
    const qs = filtersToParams(filters).toString();
    history.replaceState(null, '', `#/history${qs ? `?${qs}` : ''}`);
  }

  function onFilters(next) {
    filters = next;
    syncUrl();
    load();
  }

  /** Change filters from outside the filter bar (tag chip on a card, "clear" in the empty state). */
  function applyFilters(next) {
    filterBar.set(next);
    onFilters(next);
  }

  function filterByTag(tag) { applyFilters({ ...filters, tag }); }

  /* ------------------------------------------------------------- shortcuts */
  function onKey(e) {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    filterBar.focusSearch();
  }
  document.addEventListener('keydown', onKey);

  load();

  // Tag choices: the most used tags of all time (the overview endpoint returns the top ten).
  api.get(`/insights/overview?today=${todayString()}&days=3650`, { signal }).then((overview) => {
    if (!disposed) filterBar.setTags((overview.tags || []).map((t) => t.name));
  }).catch(() => { /* the tag filter is optional */ });

  return function cleanup() {
    disposed = true;
    token += 1;
    if (controller) controller.abort();
    document.removeEventListener('keydown', onKey);
    filterBar.destroy();
  };
}
