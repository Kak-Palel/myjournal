// Minimal hash router with lazy-loaded views.
//
// A view module's default export is `async function view(ctx)` and may return a cleanup function.
// ctx = { root, params, query, signal, app }. `signal` aborts when the user navigates away, so any
// in-flight fetch/stream started by the view should be given `{ signal }`.
import { h, clear } from './dom.js';
import { spinner } from './ui.js';

function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), keys };
}

/** Split "#/entry/abc?x=1" into { path, query }. */
export function parseHash(hash = window.location.hash) {
  const raw = hash.replace(/^#/, '') || '/';
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  const query = new URLSearchParams(q === -1 ? '' : raw.slice(q + 1));
  return { path: path.startsWith('/') ? path : `/${path}`, query };
}

export function createRouter({ routes, root, app, onRoute }) {
  const compiled = routes.map((r) => ({ ...r, ...compile(r.path) }));
  let controller = null;
  let cleanup = null;
  let token = 0;
  let current = null;

  function match(path) {
    for (const r of compiled) {
      const m = r.regex.exec(path);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { route: r, params };
      }
    }
    return null;
  }

  async function resolve() {
    const my = ++token;
    if (controller) controller.abort();
    if (cleanup) { try { cleanup(); } catch (e) { console.error('view cleanup failed', e); } cleanup = null; }
    controller = new AbortController();

    const { path, query } = parseHash();
    const found = match(path) || match('/');
    const { route, params } = found;
    current = { path, params, query, route };
    if (onRoute) onRoute(current);

    clear(root);
    root.appendChild(h('div', { class: 'view-loading' }, spinner()));
    try {
      const mod = await route.load();
      if (my !== token) return; // superseded by a newer navigation
      clear(root);
      const result = await mod.default({ root, params, query, signal: controller.signal, app });
      if (my !== token) { if (typeof result === 'function') result(); return; }
      cleanup = typeof result === 'function' ? result : null;
    } catch (err) {
      if (my !== token || (err && err.name === 'AbortError')) return;
      console.error(err);
      clear(root);
      root.appendChild(h('div', { class: 'page' },
        h('div', { class: 'notice notice-error', role: 'alert' },
          h('div', { class: 'notice-body' },
            h('strong', null, 'This page failed to load'),
            h('p', { class: 'muted' }, err && err.message ? err.message : 'Unknown error'),
            h('button', { type: 'button', class: 'btn btn-sm', onClick: () => resolve() }, 'Try again')))));
    }
  }

  function navigate(path, { replace = false } = {}) {
    const target = `#${path.startsWith('/') ? path : `/${path}`}`;
    if (window.location.hash === target) { resolve(); return; }
    if (replace) {
      history.replaceState(null, '', target);
      resolve();
    } else {
      window.location.hash = target; // triggers hashchange → resolve
    }
  }

  let listening = false;
  function start() {
    if (!listening) {
      window.addEventListener('hashchange', resolve);
      listening = true;
    }
    return resolve();
  }

  return { start, navigate, resolve, current: () => current };
}
