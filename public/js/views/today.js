// Today view: greeting + streak, a big composer, prompt of the day, guided journals, pinned/recent
// entries and the weekly-reflection nudge. Every section loads on its own, so a slow or failing
// request never blocks writing.
import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { icon, greeting, todayString, parseDate } from '../lib/ui.js';
import { createTodayComposer } from '../components/today-composer.js';
import {
  renderPromptCard, renderGuidedGrid, renderNudge, renderEntrySection, sectionError, sectionSkeleton, emptyRecent,
} from '../components/today-cards.js';
import {
  groupTemplates, streakInfo, nudgeState, newEntryBody, NUDGE_DISMISS_KEY,
} from '../components/today-logic.js';
import { defaultStorage } from '../components/entry-draft.js';

const RECENT_COUNT = 5;

function nudgeDismissedToday(today) {
  try { return (defaultStorage() && defaultStorage().getItem(NUDGE_DISMISS_KEY)) === today; } catch { return false; }
}
function dismissNudge(today) {
  try { if (defaultStorage()) defaultStorage().setItem(NUDGE_DISMISS_KEY, today); } catch { /* storage unavailable: the nudge just returns next visit */ }
}

export default async function todayView(ctx) {
  const { root, query, signal, app } = ctx;
  const today = todayString();
  const aborted = (err) => signal.aborted || (err && err.name === 'AbortError');
  let disposed = false;
  let creating = false;
  let catalog = null;

  /* ------------------------------------------------------------------ shell */
  const longDate = parseDate(today).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const streakHost = h('div', { class: 'today-streak-host' });
  const hero = h('header', { class: 'today-hero' },
    h('div', null,
      h('h1', { class: 'today-greeting' }, greeting((app.settings && app.settings.profile && app.settings.profile.name) || '')),
      h('p', { class: 'today-date' }, longDate)),
    streakHost);

  const nudgeHost = h('div', { class: 'today-nudge-host' });
  const promptHost = h('div', { class: 'today-prompt-host' });
  const pinnedHost = h('div', { class: 'today-pinned-host' });
  const recentHost = h('div', { class: 'today-recent-host' }, sectionSkeleton(4));
  const guidedHost = h('div', { class: 'today-guided-host' }, sectionSkeleton(4));

  const composer = createTodayComposer({
    aiReady: app.aiReady(),
    notify: (message) => app.toast(message, { kind: 'error' }),
    onSubmit: startJournaling,
  });

  mount(root, h('div', { class: 'page page-wide today-page' },
    hero,
    composer.el,
    nudgeHost,
    promptHost,
    h('aside', { class: 'today-aside', 'aria-label': 'Your entries' }, pinnedHost, recentHost),
    guidedHost));

  /* ---------------------------------------------------------------- actions */
  // The entry's date is read when the writer submits, not when the view opened: a tab left open past
  // midnight must not stamp the new day's entry with yesterday's date.
  async function startJournaling({ text, mood, prompt }) {
    const res = await api.post('/entries', newEntryBody({ text, mood, prompt, date: todayString() }), { signal });
    app.navigate(`/entry/${encodeURIComponent(res.entry.id)}${app.aiReady() ? '?reply=1' : ''}`);
  }

  async function pickTemplate(template) {
    if (creating) return;
    creating = true;
    const buttons = guidedHost.querySelectorAll('.today-guide');
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const res = await api.post('/entries', { templateId: template.id, date: todayString() }, { signal });
      app.navigate(`/entry/${encodeURIComponent(res.entry.id)}`);
    } catch (err) {
      if (aborted(err)) return;
      creating = false;
      buttons.forEach((b) => { b.disabled = false; });
      app.toast(err && err.message ? err.message : 'Could not start that journal.', { kind: 'error' });
    }
  }

  function usePrompt(prompt) {
    composer.setPrompt(prompt.text);
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    composer.el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  }

  /* ---------------------------------------------------------------- sections */
  function paintCatalog() {
    if (!catalog || disposed) return;
    promptHost.replaceChildren(...(catalog.promptOfTheDay && catalog.promptOfTheDay.text
      ? [renderPromptCard(catalog.promptOfTheDay, { onUse: usePrompt })] : []));
    guidedHost.replaceChildren(renderGuidedGrid(groupTemplates(catalog.templates), { onPick: pickTemplate, aiReady: app.aiReady() }));
  }

  async function loadCatalog() {
    guidedHost.replaceChildren(sectionSkeleton(4));
    try {
      catalog = await app.catalog();
      if (!disposed) paintCatalog();
    } catch (err) {
      if (aborted(err)) return;
      guidedHost.replaceChildren(sectionError(err && err.message ? `Could not load the guided journals. ${err.message}` : 'Could not load the guided journals.', loadCatalog));
    }
  }

  async function loadEntries() {
    recentHost.replaceChildren(sectionSkeleton(4));
    const [recentRes, pinnedRes] = await Promise.allSettled([
      api.get(`/entries?limit=${RECENT_COUNT + 6}`, { signal }),
      api.get('/entries?pinned=1&limit=10', { signal }),
    ]);
    if (disposed || signal.aborted) return;

    const pinned = pinnedRes.status === 'fulfilled' ? pinnedRes.value.entries || [] : [];
    pinnedHost.replaceChildren(...(pinned.length
      ? [renderEntrySection({ id: 'today-pinned-h', title: 'Pinned', iconName: 'pin', entries: pinned })] : []));

    if (recentRes.status === 'rejected') {
      recentHost.replaceChildren(sectionError('Could not load your recent entries.', loadEntries));
      return;
    }
    const pinnedIds = new Set(pinned.map((e) => e.id));
    const all = recentRes.value.entries || [];
    const recent = all.filter((e) => !pinnedIds.has(e.id)).slice(0, RECENT_COUNT);
    if (all.length === 0 && pinned.length === 0) {
      recentHost.replaceChildren(emptyRecent());
    } else if (recent.length) {
      recentHost.replaceChildren(renderEntrySection({
        id: 'today-recent-h', title: 'Recent entries', entries: recent,
        action: h('a', { class: 'today-viewall', href: '#/history' }, 'View all', icon('chevron-right', { size: 16 })),
      }));
    } else {
      recentHost.replaceChildren();
    }
  }

  async function loadOverview() {
    let overview;
    try {
      overview = await api.get(`/insights/overview?today=${today}&days=7`, { signal });
    } catch { return; } // streak and nudge are extras: stay quiet
    if (disposed || signal.aborted) return;

    const info = streakInfo(overview.streak, today);
    if (info) {
      streakHost.replaceChildren(h('span', { class: ['today-streak', info.atRisk ? 'is-risk' : ''], title: info.hint },
        icon('flame', { size: 16 }), info.label, h('span', { class: 'sr-only' }, `. ${info.hint}`)));
    }

    if (nudgeDismissedToday(today)) return;
    const calendar = overview.calendar || [];
    if (nudgeState({ calendar, reports: [], today }).count < 3) return; // cheap check before asking for reports
    let reports = [];
    try { reports = (await api.get('/insights/reports', { signal })).reports || []; } catch { return; }
    if (disposed || signal.aborted) return;
    const state = nudgeState({ calendar, reports, today });
    if (!state.show) return;
    const paint = () => nudgeHost.replaceChildren(renderNudge({
      count: state.count,
      aiReady: app.aiReady(),
      onDismiss: () => { dismissNudge(today); nudgeHost.replaceChildren(); },
    }));
    paint();
    nudgeRepaint = paint;
  }

  let nudgeRepaint = null;
  const unsubscribe = app.on('settings', () => {
    composer.setAiReady(app.aiReady());
    paintCatalog();
    if (nudgeRepaint && nudgeHost.firstChild) nudgeRepaint();
  });

  loadCatalog();
  loadEntries();
  loadOverview();

  if (query.get('focus') === '1') {
    requestAnimationFrame(() => { if (!disposed) composer.focus({ preventScroll: false }); });
  }

  return function cleanup() {
    disposed = true;
    unsubscribe();
    composer.destroy();
  };
}
