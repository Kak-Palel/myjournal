// App bootstrap + shell (navigation, settings store, routes).
import { h, mount } from './lib/dom.js';
import { api, ApiError } from './lib/api.js';
import { createRouter, parseHash } from './lib/router.js';
import { icon, toast, spinner, todayString } from './lib/ui.js';

const routes = [
  { path: '/', load: () => import('./views/today.js'), nav: 'today', title: 'Today' },
  { path: '/welcome', load: () => import('./views/onboarding.js'), nav: null, title: 'Welcome', bare: true },
  { path: '/login', load: () => import('./views/login.js'), nav: null, title: 'Sign in', bare: true },
  { path: '/entry/:id', load: () => import('./views/entry.js'), nav: 'today', title: 'Entry' },
  { path: '/history', load: () => import('./views/history.js'), nav: 'history', title: 'History' },
  { path: '/insights', load: () => import('./views/insights.js'), nav: 'insights', title: 'Insights' },
  { path: '/memory', load: () => import('./views/memory.js'), nav: 'memory', title: 'Memory' },
  { path: '/settings', load: () => import('./views/settings.js'), nav: 'settings', title: 'Settings' },
];

const NAV = [
  { id: 'today', label: 'Today', href: '#/', icon: 'home' },
  { id: 'history', label: 'History', href: '#/history', icon: 'book' },
  { id: 'insights', label: 'Insights', href: '#/insights', icon: 'chart' },
  { id: 'memory', label: 'Memory', href: '#/memory', icon: 'bookmark' },
  { id: 'settings', label: 'Settings', href: '#/settings', icon: 'sliders' },
];

const PROVIDER_LABELS = { gemini: 'Gemini', openai: 'OpenAI-compatible', local: 'Local model' };

/* ------------------------------------------------------------------- app */
const listeners = new Map();
let router = null;
let catalogCache = null;

export const app = {
  settings: null,

  /** Subscribe to app events ('settings'). Returns an unsubscribe function. */
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },
  emit(event, payload) {
    for (const fn of listeners.get(event) || []) {
      try { fn(payload); } catch (e) { console.error(e); }
    }
  },

  async refreshSettings() {
    app.settings = await api.get('/settings');
    app.emit('settings', app.settings);
    return app.settings;
  },

  /** Partial update (see ARCHITECTURE §5). Resolves with the new public settings; throws ApiError. */
  async saveSettings(patch) {
    app.settings = await api.put('/settings', patch);
    app.emit('settings', app.settings);
    return app.settings;
  },

  navigate(path, opts) { router.navigate(path, opts); },
  toast,

  /** Templates, personas and today's prompt (cached for the page lifetime; keyed by local date). */
  catalog() {
    const date = todayString();
    if (!catalogCache || catalogCache.date !== date) {
      const promise = api.get(`/catalog?date=${date}`);
      catalogCache = { date, promise };
      promise.catch(() => { catalogCache = null; });
    }
    return catalogCache.promise;
  },

  /** Is an AI provider chosen and enabled? (Key presence is checked by the server on use.) */
  aiReady() {
    const ai = app.settings && app.settings.ai;
    if (!ai || !ai.enabled || !ai.provider) return false;
    const p = ai.providers && ai.providers[ai.provider];
    if (!p) return false;
    return ai.provider === 'local' ? Boolean(p.model) : Boolean(p.apiKeySet);
  },
};

/* ----------------------------------------------------------------- theme */
const THEMES = ['auto', 'light', 'dark'];
function currentTheme() {
  try { return localStorage.getItem('mj-theme') || 'auto'; } catch { return 'auto'; }
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('mj-theme', theme); } catch { /* private mode */ }
}
export function setTheme(theme) { applyTheme(THEMES.includes(theme) ? theme : 'auto'); app.emit('theme', theme); }
export function getTheme() { return currentTheme(); }

/* ----------------------------------------------------------------- shell */
function buildShell() {
  const view = h('main', { id: 'view', class: 'view', tabindex: '-1' });
  const pill = h('a', { class: 'ai-pill', href: '#/settings' });
  const themeBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon theme-toggle', 'aria-label': 'Change theme' });
  const links = NAV.map((n) => h('a', { class: 'nav-link', href: n.href, dataset: { nav: n.id } }, icon(n.icon), h('span', null, n.label)));
  const tabs = NAV.map((n) => h('a', { class: 'tab-link', href: n.href, dataset: { nav: n.id }, 'aria-label': n.label }, icon(n.icon), h('span', null, n.label)));

  const sidebar = h('aside', { class: 'sidebar' },
    h('a', { class: 'brand', href: '#/', 'aria-label': 'MyJournal home' }, icon('sprout', { size: 22 }), h('span', null, 'MyJournal')),
    h('a', { class: 'btn btn-primary btn-block write-btn', href: '#/?focus=1' }, icon('pen', { size: 18 }), 'Write'),
    h('nav', { class: 'nav', 'aria-label': 'Main' }, links),
    h('div', { class: 'sidebar-foot' }, pill, themeBtn),
  );
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Main' }, tabs);
  const skip = h('a', { class: 'skip-link', href: '#view', onClick: (e) => { e.preventDefault(); view.focus(); } }, 'Skip to content');
  const shell = h('div', { class: 'shell' }, skip, sidebar, view, tabbar);

  function paintPill() {
    const ai = app.settings && app.settings.ai;
    pill.replaceChildren();
    if (ai && ai.enabled && ai.provider) {
      const p = ai.providers[ai.provider];
      pill.append(icon(ai.provider === 'local' ? 'server' : 'sparkles', { size: 14 }), h('span', null, `${PROVIDER_LABELS[ai.provider]}${p && p.model ? ` · ${p.model}` : ''}`));
      pill.title = app.aiReady() ? 'AI companion is on' : 'Finish setting up this provider';
      pill.classList.toggle('is-warn', !app.aiReady());
    } else {
      pill.append(icon('lock', { size: 14 }), h('span', null, ai && !ai.enabled ? 'AI off' : 'Set up AI'));
      pill.title = 'Journal works without AI. Click to set a model up.';
      pill.classList.add('is-warn');
    }
  }
  function paintTheme() {
    const t = currentTheme();
    themeBtn.replaceChildren(icon(t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'sparkles', { size: 18 }));
    themeBtn.title = `Theme: ${t}`;
  }
  themeBtn.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
    setTheme(next);
    paintTheme();
    toast(`Theme: ${next}`, { timeout: 1500 });
  });
  paintPill();
  paintTheme();
  app.on('settings', paintPill);

  function setActive(navId) {
    for (const el of [...links, ...tabs]) {
      const on = el.dataset.nav === navId;
      el.classList.toggle('is-active', on);
      if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    }
  }
  return { shell, view, setActive };
}

/* ------------------------------------------------------------------ boot */
async function boot() {
  const rootEl = document.getElementById('app');
  mount(rootEl, h('div', { class: 'boot' }, spinner({ label: 'Starting' })));

  let auth = { required: false, authenticated: true };
  try {
    auth = await api.get('/auth/status');
  } catch (err) {
    mount(rootEl, h('div', { class: 'boot' },
      h('div', { class: 'notice notice-error', role: 'alert' },
        icon('alert'),
        h('div', { class: 'notice-body' },
          h('strong', null, err instanceof ApiError ? err.message : 'Could not start'),
          err instanceof ApiError && err.hint ? h('p', { class: 'muted' }, err.hint) : null,
          h('button', { type: 'button', class: 'btn btn-sm', onClick: () => location.reload() }, 'Reload')))));
    return;
  }

  const { shell, view, setActive } = buildShell();

  router = createRouter({
    routes: routes.map(({ path, load }) => ({ path, load })),
    root: view,
    app,
    onRoute(current) {
      const meta = routes.find((r) => r.path === current.route.path) || routes[0];
      shell.classList.toggle('is-bare', Boolean(meta.bare));
      setActive(meta.nav);
      document.title = meta.path === '/' ? 'MyJournal' : `${meta.title} · MyJournal`;
      window.scrollTo(0, 0);
      requestAnimationFrame(() => { if (!meta.bare) view.focus({ preventScroll: true }); });
    },
  });

  window.addEventListener('myjournal:unauthorized', () => {
    if (!location.hash.startsWith('#/login')) router.navigate('/login', { replace: true });
  });

  mount(rootEl, shell);

  if (auth.required && !auth.authenticated) {
    // Show the login view; startAuthenticated() runs once the login view succeeds.
    await router.start();
    if (parseHash().path !== '/login') router.navigate('/login', { replace: true });
    return;
  }
  await startAuthenticated();
}

/** Called at boot (when allowed in) and again by the login view after a successful login. */
export async function startAuthenticated() {
  try {
    await app.refreshSettings();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'unauthorized') return;
    toast(err.message || 'Could not load settings', { kind: 'error' });
  }
  let { path } = parseHash();
  if (path === '/login') path = '/';
  const needsOnboarding = app.settings && !app.settings.onboarded && path === '/';
  if (needsOnboarding) path = '/welcome';
  if (path !== parseHash().path) history.replaceState(null, '', `#${path}`);
  await router.start(); // idempotent: registers the hashchange listener once, then resolves the route
}

boot();
