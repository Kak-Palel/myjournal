// Minimal hash router with lazy-loaded views.
//
// A view module's default export is `async function view(ctx)` and may return a cleanup function.
// ctx = { root, params, query, signal, app, restoring, scrollY }. `signal` aborts when the user navigates away, so any
// in-flight fetch/stream started by the view should be given `{ signal }`. `restoring` is true when the person got here
// with Back / Forward and the page is about to be scrolled back to `scrollY`: a view that normally scrolls somewhere
// by itself (e.g. to the end of a conversation) should leave the scroll position alone then.
import { h, clear } from './dom.js';
import { spinner } from './ui.js';
import { reportReachable } from './api.js';

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

/** Did loading a view's file fail because the network (the server) is gone, rather than because the file is broken? */
export function isImportFailure(err) {
  return err instanceof TypeError && /dynamically imported module|Failed to fetch|Load failed|Importing a module script failed/i.test(String(err.message));
}

/**
 * Replace the address without losing the history entry's saved state (the router keeps a scroll-restoration key there).
 * Views use this instead of history.replaceState(null, ...) when they tidy the URL (filters, tabs, one-shot parameters).
 */
export function replaceHash(hash) {
  history.replaceState(history.state, '', hash);
}

/** Give the current history entry a key (kept in history.state) so its scroll position can be found again on Back/Forward. */
export function stampEntry(counter) {
  const state = history.state && typeof history.state === 'object' ? history.state : null;
  if (state && state.mjKey) return { key: state.mjKey, fresh: false };
  const key = `e${Date.now().toString(36)}-${counter.toString(36)}`;
  try { history.replaceState({ ...(state || {}), mjKey: key }, '', window.location.href); } catch { /* sandboxed: no restoration */ }
  return { key, fresh: true };
}

/**
 * Scroll back to `target` once the page is tall enough (views fill in their content asynchronously), giving up after
 * `maxMs`, when the person scrolls or types by themselves, or when `isCurrent()` turns false.
 */
export function restoreScroll(target, isCurrent, maxMs = 1500) {
  const started = performance.now();
  const inputs = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
  let done = false;
  const finish = () => { done = true; for (const t of inputs) window.removeEventListener(t, finish); };
  for (const t of inputs) window.addEventListener(t, finish, { passive: true });
  const step = () => {
    if (done || !isCurrent()) { finish(); return; }
    const room = document.documentElement.scrollHeight - window.innerHeight;
    if (room >= target - 2 || performance.now() - started > maxMs) { window.scrollTo(0, Math.max(0, Math.min(target, room))); finish(); return; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function createRouter({ routes, root, app, onRoute }) {
  const compiled = routes.map((r) => ({ ...r, ...compile(r.path) }));
  let controller = null;
  let cleanup = null;
  let token = 0;
  let current = null;
  const scrollMemo = new Map(); // history-entry key -> scrollY when the person left it
  let leavingKey = null;
  let stamps = 0;
  try { history.scrollRestoration = 'manual'; } catch { /* old browser: the page just starts at the top */ }

  function match(path) {
    for (const r of compiled) {
      const m = r.regex.exec(path);
      if (m) {
        const params = {};
        try {
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        } catch {
          continue; // broken percent-encoding ("%E0%A4%A"): this address matches no page
        }
        return { route: r, params };
      }
    }
    return null;
  }

  async function resolve() {
    const my = ++token;
    if (leavingKey) scrollMemo.set(leavingKey, window.scrollY); // before the old content disappears and the page shrinks
    const stamp = stampEntry(++stamps);
    leavingKey = stamp.key;
    // Back / Forward lands on an entry that has been here before; a link to the same address is a new entry with no key.
    const restoreTo = !stamp.fresh && scrollMemo.has(stamp.key) ? scrollMemo.get(stamp.key) : 0;
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
      const result = await mod.default({ root, params, query, signal: controller.signal, app, restoring: restoreTo > 0, scrollY: restoreTo });
      if (my !== token) { if (typeof result === 'function') result(); return; }
      cleanup = typeof result === 'function' ? result : null;
      if (restoreTo > 0) restoreScroll(restoreTo, () => my === token);
    } catch (err) {
      if (my !== token || (err && err.name === 'AbortError')) return;
      console.error(err);
      clear(root);
      // A view file that cannot be fetched means the server stopped answering. Browsers remember a failed module
      // import, so for that case "Try again" reloads the page (the address, and any saved draft, survive a reload).
      const unreachable = isImportFailure(err);
      if (unreachable) reportReachable(false);
      root.appendChild(h('div', { class: 'page' },
        h('div', { class: 'notice notice-error', role: 'alert' },
          h('div', { class: 'notice-body' },
            h('strong', null, unreachable ? 'MyJournal did not answer' : 'This page failed to load'),
            h('p', { class: 'muted' }, unreachable ? 'Check that it is still running. Anything you wrote is kept in this window.' : (err && err.message ? err.message : 'Unknown error')),
            h('button', { type: 'button', class: 'btn btn-sm', 'data-auto-retry': '', onClick: () => (unreachable ? window.location.reload() : resolve()) }, unreachable ? 'Reload' : 'Try again')))));
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
