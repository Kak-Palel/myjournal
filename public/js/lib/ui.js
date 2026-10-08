// Shared UI helpers: toasts, dialogs, icons, mood metadata, formatting.
import { h, s, clear } from './dom.js';

/* ------------------------------------------------------------------ icons */
// Each icon is a list of [tag, ...args] shapes in a 24x24 viewBox, stroked with currentColor.
const P = (d) => ['path', d];
const C = (cx, cy, r) => ['circle', cx, cy, r];
const R = (x, y, w, hgt, rx = 0) => ['rect', x, y, w, hgt, rx];

const ICONS = {
  home: [P('M3 11l9-8 9 8'), P('M5 10v10h14V10'), P('M10 20v-6h4v6')],
  book: [P('M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3V4z'), P('M4 17a3 3 0 0 1 3-3h12')],
  chart: [P('M4 20V10'), P('M10 20V4'), P('M16 20v-7'), P('M22 20H2')],
  bookmark: [P('M6 3h12v18l-6-4-6 4z')],
  sliders: [P('M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6')],
  send: [P('M22 2L11 13'), P('M22 2l-7 20-4-9-9-4 20-7z')],
  stop: [R(6, 6, 12, 12, 2)],
  mic: [R(9, 2, 6, 12, 3), P('M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8')],
  plus: [P('M12 5v14M5 12h14')],
  trash: [P('M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6')],
  edit: [P('M12 20h9'), P('M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z')],
  check: [P('M20 6L9 17l-5-5')],
  x: [P('M18 6L6 18M6 6l12 12')],
  sprout: [P('M12 22V11'), P('M12 11C12 7 9 4 4 4c0 4 2.5 7 8 7'), P('M12 14c0-3.5 2.5-6 8-6 0 4-2.5 6.5-8 6.5')],
  lock: [R(4, 11, 16, 10, 2), P('M8 11V7a4 4 0 0 1 8 0v4')],
  search: [C(11, 11, 7), P('M21 21l-4.3-4.3')],
  download: [P('M12 3v12M7 10l5 5 5-5M4 21h16')],
  upload: [P('M12 15V3M7 8l5-5 5 5M4 21h16')],
  sparkles: [P('M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z'), P('M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z')],
  sun: [C(12, 12, 4), P('M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4')],
  moon: [P('M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z')],
  pin: [P('M12 17v5M9 3h6l-1 7 3 3H7l3-3z')],
  'chevron-right': [P('M9 18l6-6-6-6')],
  'chevron-down': [P('M6 9l6 6 6-6')],
  'chevron-left': [P('M15 18l-6-6 6-6')],
  more: [C(5, 12, 1.2), C(12, 12, 1.2), C(19, 12, 1.2)],
  refresh: [P('M21 12a9 9 0 1 1-3-6.7L21 8'), P('M21 3v5h-5')],
  copy: [R(9, 9, 11, 11, 2), P('M5 15V6a2 2 0 0 1 2-2h9')],
  alert: [P('M12 3L2 21h20z'), P('M12 10v5M12 18v.01')],
  info: [C(12, 12, 9), P('M12 16v-4M12 8h.01')],
  heart: [P('M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 22l8.8-8.6a5.5 5.5 0 0 0 0-7.8z')],
  flame: [P('M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-4 3-6 1 1 1 2 1 3 2-2 2-6 2-9z')],
  calendar: [R(3, 5, 18, 16, 2), P('M16 3v4M8 3v4M3 11h18')],
  target: [C(12, 12, 9), C(12, 12, 5), C(12, 12, 1)],
  cloud: [P('M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19.5 11 3.5 3.5 0 0 1 18 18z')],
  leaf: [P('M5 19C5 9 11 4 20 4c0 9-5 15-15 15z'), P('M5 19l8-8')],
  users: [C(9, 8, 3.5), P('M2 20c0-3.5 3-6 7-6s7 2.5 7 6'), C(17.5, 9, 2.5), P('M17 14c3 0 5 1.8 5 4.5')],
  pen: [P('M12 20h9'), P('M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z')],
  star: [P('M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z')],
  compass: [C(12, 12, 9), P('M15.5 8.5l-2 5-5 2 2-5z')],
  shield: [P('M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z')],
  smile: [C(12, 12, 9), P('M8 14s1.5 2 4 2 4-2 4-2M9 9.5v.01M15 9.5v.01')],
  lightbulb: [P('M9 18h6M10 21h4'), P('M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z')],
  wind: [P('M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8')],
  flower: [C(12, 6, 3), C(12, 18, 3), C(6, 12, 3), C(18, 12, 3), C(12, 12, 1.5)],
  eye: [P('M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z'), C(12, 12, 3)],
  clock: [C(12, 12, 9), P('M12 7v5l3 2')],
  globe: [C(12, 12, 9), P('M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18')],
  server: [R(3, 4, 18, 7, 2), R(3, 13, 18, 7, 2), P('M7 7.5v.01M7 16.5v.01')],
  key: [C(8, 15, 4), P('M10.8 12.2L20 3M17 6l3 3M14 9l2 2')],
};

/** Inline SVG icon. Unknown names fall back to "sparkles". */
export function icon(name, { size = 20, class: cls = '', title = '' } = {}) {
  const shapes = ICONS[name] || ICONS.sparkles;
  const svg = s('svg', {
    class: ['icon', cls],
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.8,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': title ? null : 'true',
    role: title ? 'img' : null,
    focusable: 'false',
  });
  if (title) svg.appendChild(s('title', null, title));
  for (const [tag, ...a] of shapes) {
    if (tag === 'path') svg.appendChild(s('path', { d: a[0] }));
    else if (tag === 'circle') svg.appendChild(s('circle', { cx: a[0], cy: a[1], r: a[2] }));
    else if (tag === 'rect') svg.appendChild(s('rect', { x: a[0], y: a[1], width: a[2], height: a[3], rx: a[4] }));
  }
  return svg;
}

export const ICON_NAMES = Object.keys(ICONS);

/* ------------------------------------------------------------------- mood */
export const MOODS = [
  { value: 1, label: 'Awful', emoji: '😞', color: 'var(--mood-1)' },
  { value: 2, label: 'Low', emoji: '😕', color: 'var(--mood-2)' },
  { value: 3, label: 'Okay', emoji: '😐', color: 'var(--mood-3)' },
  { value: 4, label: 'Good', emoji: '🙂', color: 'var(--mood-4)' },
  { value: 5, label: 'Great', emoji: '😄', color: 'var(--mood-5)' },
];

/** Small emoji badge for a mood value (1..5); returns an empty span for null. */
export function moodFace(value, { label = false } = {}) {
  const m = MOODS.find((x) => x.value === Math.round(value));
  if (!m) return h('span', { class: 'mood-face mood-none', 'aria-hidden': 'true' });
  return h('span', { class: 'mood-face', title: m.label, role: 'img', 'aria-label': `Mood: ${m.label}` }, m.emoji, label ? h('span', { class: 'mood-label' }, m.label) : null);
}

/**
 * Row of 5 mood buttons (radio-group semantics). Returns { el, set(value) }.
 * onChange(value|null) fires when the user picks; clicking the active mood clears it.
 */
export function moodPicker({ value = null, onChange, size = 'md' } = {}) {
  let current = value;
  // Radio-group keyboard model: the group is ONE Tab stop (the chosen mood, or the first when none is chosen), and the
  // arrow keys move the choice (Home / End jump). Space or Enter on the chosen mood clears it, as a click does.
  const choose = (i) => { current = MOODS[i].value; paint(); buttons[i].focus(); if (onChange) onChange(current); };
  const onKey = (e, i) => {
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % MOODS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + MOODS.length) % MOODS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = MOODS.length - 1;
    if (next === -1) return;
    e.preventDefault();
    choose(next);
  };
  const buttons = MOODS.map((m, i) => h('button', {
    type: 'button', class: ['mood-btn', `mood-${size}`], role: 'radio', 'aria-checked': 'false', 'aria-label': m.label, title: m.label,
    dataset: { value: m.value },
    onClick: () => { current = current === m.value ? null : m.value; paint(); if (onChange) onChange(current); },
    onKeydown: (e) => onKey(e, i),
  }, h('span', { class: 'mood-emoji', 'aria-hidden': 'true' }, m.emoji)));
  const el = h('div', { class: 'mood-picker', role: 'radiogroup', 'aria-label': 'How are you feeling?' }, buttons);
  function paint() {
    const stop = Math.max(0, MOODS.findIndex((m) => m.value === current)); // nothing chosen: the first button is the stop
    buttons.forEach((b, i) => {
      const on = MOODS[i].value === current;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('is-active', on);
      b.tabIndex = i === stop ? 0 : -1;
    });
  }
  paint();
  return { el, get value() { return current; }, set(v) { current = v; paint(); } };
}

/* ----------------------------------------------------------------- toasts */
let toastHost = null;
function getToastHost() {
  if (toastHost && document.body.contains(toastHost)) return toastHost;
  toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  document.body.appendChild(toastHost);
  return toastHost;
}

/** Show a transient message. kind: 'info' | 'success' | 'error'. Errors stay longer. */
export function toast(message, { kind = 'info', timeout, action } = {}) {
  const host = getToastHost();
  const ms = timeout ?? (kind === 'error' ? 7000 : 3500);
  const node = h('div', { class: ['toast', `toast-${kind}`] },
    h('span', { class: 'toast-msg' }, message),
    action ? h('button', { type: 'button', class: 'toast-action', onClick: () => { action.onClick(); remove(); } }, action.label) : null,
    h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', onClick: () => remove() }, icon('x', { size: 14 })),
  );
  function remove() { node.classList.add('is-leaving'); setTimeout(() => node.remove(), 180); }
  host.appendChild(node);
  if (ms > 0) setTimeout(remove, ms);
  return { dismiss: remove };
}

/* ---------------------------------------------------------------- dialogs */
/**
 * Open a modal <dialog> with arbitrary content. Returns { el, close(result) , closed: Promise }.
 */
export function openModal(content, { title = '', wide = false, label, onClose } = {}) {
  const dlg = h('dialog', { class: ['modal', wide ? 'modal-wide' : ''], 'aria-label': label || title || 'Dialog' });
  const header = title ? h('header', { class: 'modal-header' },
    h('h2', { class: 'modal-title' }, title),
    h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': 'Close', onClick: () => close(null) }, icon('x')),
  ) : null;
  const body = h('div', { class: 'modal-body' }, content);
  dlg.append(...[header, body].filter(Boolean));
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  let result = null;
  function close(value = null) { result = value; if (dlg.open) dlg.close(); else finish(); }
  function finish() {
    dlg.remove();
    resolveClosed(result);
    if (onClose) onClose(result);
  }
  dlg.addEventListener('close', finish, { once: true });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(null); }); // backdrop click
  document.body.appendChild(dlg);
  dlg.showModal();
  return { el: dlg, close, closed };
}

/**
 * Promise<boolean> confirmation dialog. `requireText` makes the user type a word (e.g. "DELETE").
 */
export function confirmDialog({ title = 'Are you sure?', body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, requireText = '' } = {}) {
  return new Promise((resolve) => {
    let input = null;
    const confirmBtn = h('button', { type: 'button', class: ['btn', danger ? 'btn-danger' : 'btn-primary'], disabled: Boolean(requireText), onClick: () => modal.close(true) }, confirmLabel);
    if (requireText) {
      input = h('input', {
        type: 'text', class: 'input', autocomplete: 'off', 'aria-label': `Type ${requireText} to confirm`, placeholder: requireText,
        onInput: () => { confirmBtn.disabled = input.value.trim() !== requireText; },
        onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!confirmBtn.disabled) modal.close(true); } }, // preventDefault: the key press must not also land on the button focus returns to
      });
    }
    const content = h('div', { class: 'stack' },
      typeof body === 'string' ? h('p', null, body) : body,
      requireText ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, `Type ${requireText} to confirm`), input) : null,
      h('div', { class: 'row row-end' },
        h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => modal.close(false) }, cancelLabel),
        confirmBtn),
    );
    const modal = openModal(content, { title, label: title, onClose: (r) => resolve(r === true) });
    if (input) input.focus(); else confirmBtn.focus();
  });
}

/* -------------------------------------------------------------- fragments */
export function spinner({ label = 'Loading' } = {}) {
  return h('span', { class: 'spinner', role: 'status', 'aria-label': label });
}

export function emptyState({ icon: iconName = 'sprout', title = '', body = '', action = null, level = 3 } = {}) {
  // `level` is the heading level of the title (1-6): pick the one that follows the page's own headings.
  const tag = `h${Math.min(6, Math.max(1, Math.round(level) || 3))}`;
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconName, { size: 28 })),
    title ? h(tag, { class: 'empty-title' }, title) : null,
    body ? h('p', { class: 'muted' }, body) : null,
    action,
  );
}

/** Placeholder lines while loading. */
export function skeleton(lines = 3) {
  return h('div', { class: 'skeleton-block', 'aria-hidden': 'true' }, Array.from({ length: lines }, (_, i) => h('div', { class: 'skeleton', style: { width: `${90 - i * 12}%` } })));
}

/* ------------------------------------------------------------- formatting */
const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD. */
export function todayString(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse YYYY-MM-DD as a local date (not UTC). */
export function parseDate(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return todayString(d);
}

/** "Wed, Oct 8" (adds the year when it isn't the current one). Accepts YYYY-MM-DD or epoch ms. */
export function formatDate(value, { weekday = true } = {}) {
  const d = typeof value === 'number' ? new Date(value) : parseDate(value);
  const opts = { month: 'short', day: 'numeric' };
  if (weekday) opts.weekday = 'short';
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

export function formatMonth(dateStr) {
  return parseDate(dateStr).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function formatTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function relativeTime(ms, now = Date.now()) {
  const diff = Math.round((now - ms) / 1000);
  if (diff < 45) return 'just now';
  if (diff < 90) return '1 min ago';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  const days = Math.round(diff / 86400);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return formatDate(ms, { weekday: false });
}

export function greeting(name = '', now = new Date()) {
  const hr = now.getHours();
  const part = hr < 5 ? 'Still up' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

/* ---------------------------------------------------------------- helpers */
export function debounce(fn, ms = 250) {
  let t = null;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  return wrapped;
}

/**
 * Grow a textarea with its content up to maxHeight px. `maxHeight` may be a number or a function returning one; a
 * function is asked again on every measure and whenever the window is resized, so a box that was sized for a tall window
 * shrinks when the on-screen keyboard or a rotation leaves little room. Returns a function to re-measure.
 */
export function autosize(textarea, { maxHeight = 360 } = {}) {
  const limit = () => (typeof maxHeight === 'function' ? maxHeight() : maxHeight);
  const fit = () => {
    const max = limit();
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, max)}px`;
    textarea.style.overflowY = textarea.scrollHeight > max ? 'auto' : 'hidden';
  };
  textarea.addEventListener('input', fit);
  if (typeof maxHeight === 'function') watchResize(textarea, fit);
  requestAnimationFrame(fit);
  return fit;
}

// One shared window listener for every auto-sizing box. Boxes are held weakly (the re-measure functions live in a WeakMap
// keyed by the box), so a view that is gone, and the detached DOM it leaves behind, can be garbage collected without anyone
// having to unregister it; dead entries are swept on the next use.
const resizeFit = new WeakMap();
const resizeRefs = new Set();
function sweepResizeRefs() {
  for (const ref of resizeRefs) { const el = ref.deref(); if (!el || !el.isConnected) resizeRefs.delete(ref); }
}
function watchResize(textarea, fit) {
  sweepResizeRefs();
  if (resizeRefs.size === 0) window.addEventListener('resize', onWindowResize);
  resizeFit.set(textarea, fit);
  resizeRefs.add(new WeakRef(textarea));
}
function onWindowResize() {
  sweepResizeRefs();
  for (const ref of resizeRefs) { const el = ref.deref(); const fit = el && resizeFit.get(el); if (fit) fit(); }
  if (resizeRefs.size === 0) window.removeEventListener('resize', onWindowResize);
}

/**
 * A max-height for a writing box: `share` of the window height (less in a short window, where a keyboard would otherwise
 * leave no room for the conversation), kept between `min` and `max` pixels. Pass it to autosize() as `maxHeight`.
 */
export function viewportShare(share, { min = 120, max = 340, shortShare = share * 0.75, shortBelow = 600 } = {}) {
  return () => {
    const vh = window.innerHeight || 700;
    return Math.round(Math.max(min, Math.min(max, vh * (vh < shortBelow ? shortShare : share))));
  };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

/**
 * Server messages mark commands and addresses with `backticks`. Turn them into <code> nodes (text only, never markup).
 * Returns an array of strings and nodes that h() accepts as children.
 */
export function inlineCode(text) {
  return splitCode(text).map((part) => (part.code ? h('code', { class: 'code' }, part.text) : part.text));
}

/** The pure half of inlineCode(): `a \`b\` c` becomes [{ text: 'a ' }, { text: 'b', code: true }, { text: ' c' }]. */
export function splitCode(text) {
  const parts = String(text ?? '').split(/`([^`\n]+)`/);
  const out = [];
  parts.forEach((part, i) => { if (part !== '') out.push(i % 2 === 1 ? { text: part, code: true } : { text: part }); });
  return out;
}

/** The same text with the backtick markers dropped, for places that can only show a plain string. */
export function stripCode(text) {
  return String(text ?? '').replace(/`([^`\n]+)`/g, '$1');
}

/** Replace a node's children with a labelled error block. */
export function showError(node, error, { onRetry } = {}) {
  clear(node);
  node.appendChild(h('div', { class: 'notice notice-error', role: 'alert' },
    icon('alert'),
    h('div', { class: 'notice-body' },
      h('strong', null, inlineCode(error?.message || 'Something went wrong')),
      error?.hint ? h('p', { class: 'muted' }, inlineCode(error.hint)) : null,
      onRetry ? h('button', { type: 'button', class: 'btn btn-sm', 'data-auto-retry': '', onClick: onRetry }, 'Try again') : null,
    )));
}
