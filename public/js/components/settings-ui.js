// Small UI building blocks shared by the Settings, Memory, Insights, Onboarding and Login views:
// labelled fields with inline errors, switches, textareas with counters, copy-able commands, notices and a
// "busy" wrapper for async buttons. All text goes through h() (text nodes); nothing here builds markup.
import { h, mount } from '../lib/dom.js';
import { icon, copyText, toast, inlineCode } from '../lib/ui.js';

let seq = 0;
/** Unique DOM id with a readable prefix. */
export function uid(prefix = 'mj') {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** Cap text that comes from outside (error messages, model names) so a runaway string cannot flood the page. */
export function clip(text, max = 600) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Label + control + hint + inline error. The labelled element must be `input` (it gets the id wiring).
 * @param {{ label: string, input: HTMLElement, control?: Node, hint?: string|Node, optional?: boolean, className?: string }} opts
 * @returns {{ el: HTMLElement, input: HTMLElement, setError(message?: string): void, setHint(text: string): void }}
 */
export function fieldRow({ label, input, control = input, hint = '', optional = false, className = '' }) {
  if (!input.id) input.id = uid('field');
  const hintEl = h('p', { class: 'field-hint', id: `${input.id}-hint`, hidden: !hint }, hint);
  const errorEl = h('p', { class: 'field-error', id: `${input.id}-error`, role: 'alert', hidden: true });
  const el = h('div', { class: ['field', className] },
    h('label', { class: 'field-label', for: input.id }, label, optional ? h('span', { class: 'settings-optional' }, ' (optional)') : null),
    control,
    hintEl,
    errorEl,
  );
  const describe = () => {
    const ids = [];
    if (!hintEl.hidden) ids.push(hintEl.id);
    if (!errorEl.hidden) ids.push(errorEl.id);
    if (ids.length) input.setAttribute('aria-describedby', ids.join(' ')); else input.removeAttribute('aria-describedby');
  };
  describe();
  return {
    el,
    input,
    setError(message = '') {
      errorEl.textContent = message;
      errorEl.hidden = !message;
      if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
      describe();
    },
    setHint(text) {
      mount(hintEl, text);
      hintEl.hidden = !text;
      describe();
    },
  };
}

/**
 * Accessible on/off switch (a real checkbox with role="switch").
 * @returns {{ el: HTMLElement, input: HTMLInputElement, set(value: boolean): void, setDisabled(value: boolean): void }}
 */
export function switchControl({ label, hint = '', checked = false, disabled = false, onChange }) {
  const id = uid('switch');
  const hintEl = hint ? h('span', { class: 'settings-switch-hint', id: `${id}-hint` }, hint) : null;
  const input = h('input', {
    type: 'checkbox', role: 'switch', id, class: 'settings-switch-input', checked, disabled,
    'aria-describedby': hintEl ? hintEl.id : null,
    onChange: () => { if (onChange) onChange(input.checked); },
  });
  const el = h('label', { class: ['settings-switch', disabled ? 'is-disabled' : ''], for: id },
    input,
    h('span', { class: 'settings-switch-track', 'aria-hidden': 'true' }, h('span', { class: 'settings-switch-thumb' })),
    h('span', { class: 'settings-switch-text' }, h('span', { class: 'settings-switch-label' }, label), hintEl),
  );
  return {
    el,
    input,
    set(value) { input.checked = Boolean(value); },
    setDisabled(value) { input.disabled = Boolean(value); el.classList.toggle('is-disabled', Boolean(value)); },
  };
}

/**
 * Textarea with a live "n / max" counter. `maxlength` counts UTF-16 units, which is never more permissive than
 * the server's limit, so what the browser accepts the server accepts.
 */
export function textareaWithCounter({ value = '', max, rows = 4, placeholder = '', onInput, className = '' }) {
  const textarea = h('textarea', {
    class: ['textarea', className], rows, maxlength: max, placeholder, value, spellcheck: 'true',
    onInput: () => { paint(); if (onInput) onInput(textarea.value); },
  });
  const counter = h('span', { class: 'settings-counter', 'aria-hidden': 'true' });
  function paint() {
    const n = textarea.value.length;
    counter.textContent = `${n} / ${max}`;
    counter.classList.toggle('is-near', n >= max * 0.9);
    counter.classList.toggle('is-full', n >= max);
  }
  paint();
  const el = h('div', { class: 'settings-counter-wrap' }, textarea, counter);
  return { el, textarea, counter, set(v) { textarea.value = v; paint(); } };
}

/** Notice box using the shared .notice styles. tone: info | warn | error | success. */
export function notice({ tone = 'info', iconName, role, children = [] }) {
  const name = iconName || (tone === 'error' ? 'alert' : tone === 'warn' ? 'alert' : tone === 'success' ? 'check' : 'info');
  return h('div', { class: ['notice', tone === 'info' ? '' : `notice-${tone}`], role: role || null },
    icon(name),
    h('div', { class: 'notice-body' }, children));
}

/** Error notice for an ApiError / SSE error payload: message, hint and (optionally) a retry button. */
export function errorNotice(err, { fallback = 'Something went wrong', onRetry } = {}) {
  const message = clip((err && err.message) || fallback);
  const hint = err && err.hint ? clip(err.hint) : '';
  return notice({
    tone: 'error',
    role: 'alert',
    children: [
      h('strong', null, inlineCode(message)),
      hint ? h('p', { class: 'muted' }, inlineCode(hint)) : null,
      onRetry ? h('button', { type: 'button', class: 'btn btn-sm', 'data-auto-retry': '', onClick: onRetry }, 'Try again') : null,
    ],
  });
}

/** A shell command (or any literal) with a Copy button. */
export function commandBlock(command, { label = 'command' } = {}) {
  const btn = h('button', {
    type: 'button', class: 'btn btn-sm settings-copy', 'aria-label': `Copy ${label}: ${command}`,
    onClick: async () => {
      const ok = await copyText(command);
      if (!ok) { toast('Could not copy - select the text and copy it by hand.', { kind: 'error' }); return; }
      mount(btn, icon('check', { size: 14 }), 'Copied');
      clearTimeout(btn._reset);
      btn._reset = setTimeout(() => mount(btn, icon('copy', { size: 14 }), 'Copy'), 1600);
    },
  }, icon('copy', { size: 14 }), 'Copy');
  return h('div', { class: 'settings-command' }, h('code', { class: 'settings-command-text' }, command), btn);
}

/**
 * Run `fn` while `button` shows a spinner and ignores further clicks. Focus stays on the button
 * (it is not `disabled`), and a second call while busy is a no-op.
 */
export async function withBusy(button, fn) {
  if (button.dataset.busy === '1') return undefined;
  button.dataset.busy = '1';
  button.classList.add('is-loading');
  button.setAttribute('aria-busy', 'true');
  const sp = h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' });
  button.prepend(sp);
  try {
    return await fn();
  } finally {
    sp.remove();
    button.classList.remove('is-loading');
    button.removeAttribute('aria-busy');
    delete button.dataset.busy;
  }
}

/**
 * If `from` has keyboard focus, hand it to `to`. Call it right before `from` is hidden or disabled so keyboard and
 * screen-reader users keep their place instead of being dropped on <body>.
 */
export function handFocus(from, to) {
  if (from && to && document.activeElement === from) to.focus();
}

/**
 * Dim a button that has nothing to do right now without disabling it: a disabled button that has focus loses it,
 * which strands keyboard users. The click handler must still ignore the press.
 */
export function setActionable(button, actionable) {
  if (actionable) button.removeAttribute('aria-disabled'); else button.setAttribute('aria-disabled', 'true');
}

/** Card section with a heading. */
export function section({ title, description, children = [], className = '', headingLevel = 2, id }) {
  return h('section', { class: ['card', 'settings-section', className], id: id || null, 'aria-labelledby': id ? `${id}-title` : null },
    title ? h(`h${headingLevel}`, { class: 'settings-section-title', id: id ? `${id}-title` : null }, title) : null,
    description ? h('p', { class: 'settings-section-desc muted' }, description) : null,
    children);
}

/**
 * Link that opens in a new tab without leaking the referrer or window handle. Only http(s) addresses become links;
 * anything else (a javascript: URL smuggled into catalog data, say) is shown as plain text.
 */
export function externalLink(href, text) {
  let safe = false;
  try { safe = ['https:', 'http:'].includes(new URL(String(href)).protocol); } catch { safe = false; }
  if (!safe) return h('span', null, text);
  return h('a', { href: String(href), target: '_blank', rel: 'noopener noreferrer' }, text);
}

/** Move focus to the first element in `root` that is marked invalid, if any. */
export function focusFirstInvalid(root) {
  const bad = root.querySelector('[aria-invalid="true"]');
  if (bad) { bad.focus(); return true; }
  return false;
}
