// History view: search, filters, month-grouped list and "Load more".
// Every request gets its own AbortController (a newer search cancels the older one) and results from
// a superseded request are ignored, so fast typing can never show stale results.
import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { replaceHash } from '../lib/router.js';
import { icon, emptyState, skeleton, showError, formatMonth, todayString } from '../lib/ui.js';
import { createFilters } from '../components/history-filters.js';
import { renderEntryCard } from '../components/history-card.js';
import {
  SEARCH_DEPTH, parseFilters, filtersToParams, hasActiveFilters, listPath, placeInMonths, monthStart, searchTerms,
} from '../components/history-format.js';

const PAGE_SIZE = 30;
const MAX_REQUEST = 200; // the server's largest page

/** How many cards were on screen when the person left (and for which filters), so Back can bring them all back. */
let lastDepth = null;

function listSkeleton() {
  return h('div', { class: 'hist-skeleton', 'aria-hidden': 'true' },
    Array.from({ length: 4 }, () => h('div', { class: 'hist-skeleton-card' }, skeleton(3))));
}

export default async function historyView(ctx) {
  const { root, query, signal, app, restoring } = ctx;
  let filters = parseFilters(query);
  let nextBefore = null; // a list continues strictly older than this createdAt
  let nextOffset = null; // a search continues after this many of its best matches
  let token = 0;
  let controller = null;
  let disposed = false;
  let loadedCount = 0;
  let months = []; // the month groups on screen, newest first: { key, entries } (placeInMonths keeps it in order)
  const monthDom = new Map(); // month key -> { section, list }
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
  const hasMore = () => (searching() ? nextOffset !== null : nextBefore !== null);

  function resetList() {
    months = [];
    monthDom.clear();
    flatList = null;
    loadedCount = 0;
  }

  /** Add cards to the list; returns the first new card (so "Load more" can hand keyboard focus to it). */
  function appendCards(entries) {
    const terms = searching() ? searchTerms(filters.q) : [];
    const made = [];
    const card = (e) => { const el = renderEntryCard(e, { terms, onTag: filterByTag }); made.push(el); return el; };

    if (searching()) { // ranked results: month grouping would scramble the ranking
      // The cards' titles are h3 (under a month's h2 in a dated list): ranked results have no month headings, so say what they are
      // (without it the page went from the h1 straight to h3).
      if (!flatList) { flatList = h('ul', { class: 'hist-list' }); resultsEl.replaceChildren(h('h2', { class: 'sr-only' }, 'Search results'), flatList); }
      flatList.append(...entries.map(card));
      return made[0] || null;
    }
    if (resultsEl.querySelector('.hist-skeleton, .empty, .notice')) resultsEl.replaceChildren();
    // Each card goes to the month of its own date, in date order. The pages arrive in the order the entries were written, so an
    // entry that was backdated would otherwise start a second "October" in the middle of the list.
    for (const entry of entries) {
      const el = card(entry);
      const { monthIndex, entryIndex, newMonth } = placeInMonths(months, entry);
      const key = months[monthIndex].key;
      if (newMonth) {
        const heading = monthStart(key) ? formatMonth(monthStart(key)) : 'Undated';
        const list = h('ul', { class: 'hist-list' });
        const section = h('section', { class: 'hist-month', 'aria-label': heading }, h('h2', { class: 'hist-month-title' }, heading), list);
        monthDom.set(key, { section, list });
        resultsEl.insertBefore(section, resultsEl.children[monthIndex] || null);
      }
      const { list } = monthDom.get(key);
      list.insertBefore(el, list.children[entryIndex] || null);
    }
    return made[0] || null;
  }

  function renderEmpty() {
    if (hasActiveFilters(filters)) {
      resultsEl.replaceChildren(emptyState({
        level: 2,
        icon: 'search',
        title: searching() ? `Nothing matches “${filters.q.trim()}”` : 'No entries match these filters',
        body: 'Try different words, or clear the filters to see everything.',
        action: h('button', { type: 'button', class: 'btn', onClick: () => applyFilters({ q: '', mood: null, tag: '', pinned: false }) }, 'Clear search and filters'),
      }));
    } else {
      resultsEl.replaceChildren(emptyState({
        level: 2,
        icon: 'book',
        title: 'Your journal is waiting',
        body: 'Entries you write show up here, grouped by month. Nothing leaves this computer unless you connect an AI.',
        action: h('a', { class: 'btn btn-primary', href: '#/?focus=1' }, icon('pen', { size: 18 }), 'Write your first entry'),
      }));
    }
  }

  let loadingMore = false;
  function paintMore(loading = false) {
    loadingMore = loading;
    const existing = moreWrap.querySelector('.hist-more-btn');
    if (existing && hasMore()) {
      // Same button, new label: it keeps keyboard focus (a disabled or replaced button would drop it).
      existing.textContent = loading ? 'Loading…' : 'Load more';
      existing.classList.toggle('is-loading', loading);
      existing.setAttribute('aria-busy', loading ? 'true' : 'false');
      return;
    }
    moreWrap.replaceChildren(...(hasMore()
      ? [h('button', { type: 'button', class: 'btn hist-more-btn', onClick: () => { if (!loadingMore) load({ append: true }); } }, loading ? 'Loading…' : 'Load more')]
      : []));
  }

  function paintCount() {
    if (searching() && loadedCount > 0) {
      const word = filters.q.trim();
      // Never call a page "30 results" while more are waiting; at the server's depth limit say that the list stops there.
      if (loadedCount >= SEARCH_DEPTH) countEl.textContent = `Showing the best ${loadedCount} matches for “${word}”. Narrow the search to see others.`;
      else if (hasMore()) countEl.textContent = `Showing the best ${loadedCount} matches for “${word}”`;
      else countEl.textContent = `${loadedCount} ${loadedCount === 1 ? 'result' : 'results'} for “${word}”`;
      countEl.hidden = false;
    } else {
      countEl.hidden = true;
    }
  }

  /* --------------------------------------------------------------- loading */
  async function load({ append = false, limit = PAGE_SIZE, quiet = false } = {}) {
    if (controller) controller.abort();
    const ctl = new AbortController();
    controller = ctl;
    const onNav = () => ctl.abort();
    signal.addEventListener('abort', onNav, { once: true });
    const mine = ++token;

    // "Load more" was pressed: once the new cards are in, keyboard focus moves to the first of them instead of being lost.
    const handFocusOn = append && moreWrap.contains(document.activeElement);
    if (append) {
      paintMore(true);
    } else {
      resetList();
      nextBefore = null;
      nextOffset = null;
      resultsEl.replaceChildren(listSkeleton());
      moreWrap.replaceChildren();
      countEl.hidden = true;
    }

    try {
      const res = await api.get(listPath(filters, { before: append ? nextBefore : null, offset: append ? nextOffset ?? 0 : 0, limit }), { signal: ctl.signal });
      if (mine !== token || disposed) return;
      const entries = res.entries || [];
      nextBefore = res.nextBefore ?? null;
      nextOffset = res.nextOffset ?? null;
      if (!append && entries.length === 0) {
        renderEmpty();
        paintMore();
        status.textContent = searching() ? 'No results.' : 'No entries.';
        return;
      }
      const firstNew = appendCards(entries);
      loadedCount += entries.length;
      paintCount();
      paintMore();
      if (handFocusOn && firstNew) {
        const link = firstNew.querySelector('.hcard-link');
        if (link) link.focus({ preventScroll: true });
      }
      if (append && quiet) status.textContent = '';
      else if (append) status.textContent = `Loaded ${entries.length} more ${entries.length === 1 ? 'entry' : 'entries'}.`;
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
    replaceHash(`#/history${qs ? `?${qs}` : ''}`);
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

  const filtersKey = () => filtersToParams(filters).toString();
  /** Back / Forward: bring back as many cards as were on screen before, so the scroll position means the same place. */
  async function loadAsDeepAs(target) {
    while (!disposed && hasMore() && loadedCount < target) {
      const had = loadedCount;
      await load({ append: true, limit: Math.min(MAX_REQUEST, target - loadedCount), quiet: true });
      // A page that failed (the server is down, a 5xx) or that another request replaced adds no cards. Trying again at once
      // would repeat the same request for ever, so stop: "Load more" is still there for the person to press.
      if (loadedCount === had) break;
    }
  }
  const wanted = restoring && lastDepth && lastDepth.key === filtersKey() ? lastDepth.count : 0;
  load({ limit: Math.min(MAX_REQUEST, Math.max(PAGE_SIZE, wanted)) }).then(() => { if (wanted > loadedCount) return loadAsDeepAs(wanted); return undefined; });

  // Tag choices: the most used tags of all time (the overview endpoint returns the top ten).
  api.get(`/insights/overview?today=${todayString()}&days=3650`, { signal }).then((overview) => {
    if (!disposed) filterBar.setTags((overview.tags || []).map((t) => t.name));
  }).catch(() => { /* the tag filter is optional */ });

  return function cleanup() {
    disposed = true;
    lastDepth = { key: filtersKey(), count: loadedCount };
    token += 1;
    if (controller) controller.abort();
    document.removeEventListener('keydown', onKey);
    filterBar.destroy();
  };
}
