// Settings: where the three model options live (Gemini, OpenAI-compatible, local) plus General and Data.
// Tabs are deep-linkable (#/settings?tab=local). Each panel is built the first time it is shown and then kept
// (hidden) so unsaved edits survive until the user decides what to do with them.
import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { replaceHash } from '../lib/router.js';
import { icon, skeleton, showError, openModal } from '../lib/ui.js';
import { createTabs, tabButtonId, tabPanelId } from '../components/settings-tabs.js';
import { createProviderForm } from '../components/settings-provider-form.js';
import { attachLocalExtras } from '../components/settings-local.js';
import { createGeneralPanel } from '../components/settings-general.js';
import { createDataPanel } from '../components/settings-data.js';
import { notice } from '../components/settings-ui.js';
import { SETTINGS_TABS, PROVIDER_IDS, PROVIDER_NAMES, resolveTab, tabHash, setupSteps } from '../components/settings-logic.js';

/** Three-way question when leaving a tab with unsaved edits. Resolves 'save' | 'discard' | 'stay'. */
function askUnsaved(tabLabel) {
  return new Promise((resolve) => {
    const choose = (value) => modal.close(value);
    const keep = h('button', { type: 'button', class: 'btn', onClick: () => choose('stay') }, 'Keep editing');
    const content = h('div', { class: 'stack' },
      h('p', null, `You have unsaved changes on the ${tabLabel} tab.`),
      h('div', { class: 'row row-end settings-dialog-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => choose('discard') }, 'Discard changes'),
        keep,
        h('button', { type: 'button', class: 'btn btn-primary', onClick: () => choose('save') }, 'Save and continue')));
    const modal = openModal(content, { title: 'Unsaved changes', onClose: (r) => resolve(r || 'stay') });
    keep.focus();
  });
}

export default async function settingsView(ctx) {
  const { root, query, signal, app } = ctx;
  const setup = query.get('setup') === '1';

  mount(root, h('div', { class: 'page settings-page' },
    h('header', { class: 'page-header' }, h('div', null, h('h1', null, 'Settings'))),
    skeleton(5)));

  let providerList;
  try {
    const [catalog] = await Promise.all([api.get('/providers', { signal }), app.refreshSettings()]);
    providerList = (catalog && catalog.providers) || [];
  } catch (err) {
    if (err && err.name === 'AbortError') return undefined;
    const holder = h('div', { class: 'page settings-page' });
    mount(root, holder);
    showError(holder, err, { onRetry: () => app.navigate(location.hash.slice(1) || '/settings') });
    return undefined;
  }
  if (signal.aborted) return undefined;

  const startTab = resolveTab(query.get('tab'), app.settings.ai.provider);
  const panels = new Map();
  let setupSaved = false;
  /** The provider the first-run banner is about (the tab in the address, else the one that is in use). */
  const setupProvider = () => (PROVIDER_IDS.includes(query.get('tab')) ? query.get('tab') : app.settings.ai.provider);
  /** Does the server use a key from its environment for this provider (and none saved in Settings)? */
  const keyFromEnv = (id) => id !== 'local' && Boolean(app.settings.ai.providers[id]) && app.settings.ai.providers[id].apiKeySource === 'env';

  /* ----------------------------------------------------------- the parts */
  const statusEl = h('div', { class: 'settings-status', role: 'status' });
  const bannerEl = h('div', { class: 'settings-banner', hidden: !setup });
  const panelHost = h('div', { class: 'settings-panels' });

  const tabs = createTabs({
    tabs: SETTINGS_TABS,
    active: startTab,
    label: 'Settings sections',
    onSelect: gate,
  });

  /* ------------------------------------------------------------- panels */
  function buildPanel(id) {
    if (PROVIDER_IDS.includes(id)) {
      const info = providerList.find((p) => p.id === id);
      if (!info) {
        return { id, el: notice({ tone: 'warn', children: [h('strong', null, 'This provider is not available on this server.')] }), isDirty: () => false, save: async () => true, reset() {}, sync() {}, shown() {} };
      }
      const form = createProviderForm({
        info, app, signal,
        onChange: paintMarkers,
        onSaved: () => { setupSaved = true; paintBanner(); },
        // First run with a key the server found in its environment: nothing needs saving, so a connection test that works
        // for what is saved is the last step (the same "You are all set" as after Save).
        onTested: ({ dirty }) => {
          if (setup && id === setupProvider() && keyFromEnv(id) && !dirty) { setupSaved = true; form.emphasizeTest(false); paintBanner(); }
        },
      });
      if (id === 'local') attachLocalExtras({ form, info, signal });
      if (setup && id === setupProvider() && keyFromEnv(id)) form.emphasizeTest(true);
      return form;
    }
    if (id === 'general') return createGeneralPanel({ app, signal, onChange: paintMarkers });
    return createDataPanel({ app, signal });
  }

  function ensurePanel(id) {
    let entry = panels.get(id);
    if (!entry) {
      const comp = buildPanel(id);
      const wrap = h('div', { class: 'settings-panel', role: 'tabpanel', id: tabPanelId(id), 'aria-labelledby': tabButtonId(id), hidden: true }, comp.el);
      panelHost.append(wrap);
      entry = { comp, wrap };
      panels.set(id, entry);
    }
    return entry;
  }

  let shownId = null;
  function show(id) {
    for (const [other, e] of panels) e.wrap.hidden = other !== id;
    const entry = ensurePanel(id);
    entry.wrap.hidden = false;
    shownId = id;
    entry.comp.shown();
    replaceHash(tabHash(id, { setup }));
    paintBanner();
    paintStatus(); // "go to its tab" is only offered while another tab is open
  }

  /**
   * Ask what to do with every panel that has unsaved edits (in practice only the visible one can have any).
   * Resolves true when nothing is left unsaved and the caller may carry on, false when the person wants to keep editing
   * or a save failed.
   */
  let asking = false;
  async function settleUnsaved() {
    if (asking) return false;
    asking = true;
    try {
      // A panel counts as unsaved until the server has answered its Save: leaving right after pressing Save waits for
      // that answer instead of asking about changes that are already being saved.
      if (app.savesInFlight()) {
        await app.savesSettled();
        await new Promise((resolve) => setTimeout(resolve, 0)); // let each panel finish showing what was saved
      }
      for (const [id, { comp }] of panels) {
        if (!comp.isDirty()) continue;
        const label = (SETTINGS_TABS.find((t) => t.id === id) || {}).label || 'current';
        const choice = await askUnsaved(label);
        if (choice === 'stay') return false;
        if (choice === 'save') {
          if (!(await comp.save())) return false;
        } else {
          comp.reset();
        }
      }
      return true;
    } finally {
      asking = false;
    }
  }

  async function gate(nextId) {
    if (!(await settleUnsaved())) return false;
    show(nextId);
    return true;
  }

  /* ------------------------------------------------ leaving the page with unsaved edits */
  // beforeunload only covers reloads and closing the tab. Moving to another page inside the app (a sidebar link, the
  // Back button) would otherwise tear this view down and silently drop a freshly pasted API key.
  const anyDirty = () => [...panels.values()].some((e) => e.comp.isDirty());

  /** Capture phase, so the router never sees the click until the person has decided. */
  function onLinkClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
    const href = link.getAttribute('href');
    if (!href.startsWith('#/') || !anyDirty()) return;
    e.preventDefault();
    settleUnsaved().then((ok) => { if (ok) location.hash = href; });
  }

  /** Back / Forward, the address bar and app.navigate(), where the browser has the Navigation API. */
  function onNavigate(e) {
    if (!e.cancelable || !e.destination.sameDocument || !['push', 'traverse'].includes(e.navigationType) || !anyDirty()) return;
    e.preventDefault();
    const { url, key } = e.destination;
    settleUnsaved().then((ok) => {
      if (!ok) return;
      if (e.navigationType !== 'traverse') { location.hash = new URL(url).hash; return; }
      try { window.navigation.traverseTo(key); } catch { history.back(); }
    });
  }
  document.addEventListener('click', onLinkClick, true);
  if (window.navigation) window.navigation.addEventListener('navigate', onNavigate);

  /* -------------------------------------------------------------- status */
  function paintMarkers() {
    const active = app.settings.ai.enabled ? app.settings.ai.provider : '';
    for (const id of PROVIDER_IDS) {
      const entry = panels.get(id);
      tabs.setMarker(id, entry && entry.comp.isDirty() ? 'Unsaved' : id === active ? 'In use' : '');
    }
    for (const id of ['general', 'data']) {
      const entry = panels.get(id);
      tabs.setMarker(id, entry && entry.comp.isDirty() ? 'Unsaved' : '');
    }
    window.removeEventListener('beforeunload', warnUnload);
    if ([...panels.values()].some((e) => e.comp.isDirty())) window.addEventListener('beforeunload', warnUnload);
  }

  function warnUnload(e) {
    e.preventDefault();
    e.returnValue = '';
  }

  function paintStatus() {
    const ai = app.settings.ai;
    const goto = (id) => h('button', { type: 'button', class: 'link-btn', onClick: async () => { if (await gate(id)) tabs.select(id, { focus: true }); } }, id === 'general' ? 'General settings' : 'open its tab');
    let body;
    if (!ai.enabled) {
      body = shownId === 'general'
        ? [h('strong', null, 'AI companion is off.'), ' MyJournal works as a plain private journal. Turn it on with the switch below.']
        : [h('strong', null, 'AI companion is off.'), ' MyJournal works as a plain private journal. Turn it on in ', goto('general'), '.'];
    } else if (!ai.provider) {
      body = [h('strong', null, 'No AI provider chosen yet.'), ' Pick a tab below to set one up, or keep journaling without AI.'];
    } else {
      const p = ai.providers[ai.provider];
      const ready = app.aiReady();
      body = [
        h('strong', null, `Using ${PROVIDER_NAMES[ai.provider]}`), p && p.model ? h('span', { class: 'settings-status-model' }, ` - ${p.model}`) : null,
        ready ? h('span', { class: 'chip chip-primary' }, icon('check', { size: 14 }), 'Ready') : h('span', { class: 'chip chip-warn' }, ai.provider === 'local' ? 'Choose a model' : 'Needs a key'),
        shownId === ai.provider ? null : [' ', goto(ai.provider)],
      ];
    }
    statusEl.className = `settings-status${ai.enabled && ai.provider && app.aiReady() ? ' is-ready' : ''}`;
    mount(statusEl, icon(ai.enabled ? 'sparkles' : 'lock', { size: 18 }), h('div', { class: 'grow' }, body));
  }

  function paintBanner() {
    if (!setup) return;
    const provider = setupProvider();
    const ready = setupSaved && app.aiReady() && app.settings.ai.enabled;
    if (ready) {
      mount(bannerEl, notice({
        tone: 'success', role: 'status',
        children: [
          h('strong', null, 'You are all set'),
          h('p', null, `Your companion will use ${PROVIDER_NAMES[app.settings.ai.provider]} from now on. You can change this any time.`),
          h('a', { class: 'btn btn-primary btn-sm', href: '#/' }, 'Start journaling'),
        ],
      }));
      return;
    }
    const fromEnv = keyFromEnv(provider);
    const steps = setupSteps(provider, { keyFromEnv: fromEnv });
    mount(bannerEl, notice({
      tone: 'info',
      children: [
        h('strong', null, fromEnv ? 'Almost there - one quick step' : 'Almost there - two quick steps'),
        steps.length === 1 ? h('p', { class: 'settings-banner-step' }, steps[0]) : h('ol', { class: 'settings-steps settings-banner-steps' }, steps.map((t) => h('li', null, t))),
        h('p', { class: 'muted small' }, 'You can also skip this and journal without AI.'),
      ],
    }));
  }

  /* --------------------------------------------------------------- wiring */
  const off = app.on('settings', () => {
    paintStatus();
    paintMarkers();
    paintBanner();
    for (const { comp } of panels.values()) comp.sync();
  });

  mount(root, h('div', { class: 'page settings-page' },
    h('header', { class: 'page-header' },
      h('div', null,
        h('h1', null, 'Settings'),
        h('p', { class: 'page-sub' }, 'Choose how your companion thinks. Your journal itself always stays on this computer.'))),
    bannerEl,
    statusEl,
    tabs.el,
    panelHost));

  paintStatus();
  paintBanner();
  show(startTab);
  paintMarkers();

  return () => {
    off();
    window.removeEventListener('beforeunload', warnUnload);
    document.removeEventListener('click', onLinkClick, true);
    if (window.navigation) window.navigation.removeEventListener('navigate', onNavigate);
  };
}
