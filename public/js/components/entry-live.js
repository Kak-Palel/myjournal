// The in-progress assistant bubble (reply or wrap-up reflection) and the wrap-up phase stepper.
// While streaming we append *plain text* to a single text node (cheap); the bubble is replaced by the
// persisted message, rendered through renderMarkdown, when the server says `done`.
import { h } from '../lib/dom.js';
import { icon } from '../lib/ui.js';

/**
 * @param {{ variant?: 'reply'|'wrapup' }} [opts]
 * @returns {{ el: HTMLElement, append(chunk: string): void, hideDots(): void, setWait(message: string): void, hasText(): boolean }}
 */
export function createLiveBubble({ variant = 'reply' } = {}) {
  const textNode = document.createTextNode('');
  const dots = h('span', { class: 'entry-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  const text = h('div', { class: 'entry-live-text', dir: 'auto' }, textNode);
  const wait = h('p', { class: 'entry-live-wait', hidden: true });
  const isWrap = variant === 'wrapup';
  const head = isWrap ? h('div', { class: 'entry-card-head' }, icon('sparkles', { size: 18 }), h('span', null, 'Reflection')) : null;

  // aria-live is deliberately off: a screen reader would otherwise read every token. The view announces
  // the finished reply once through its own status region.
  const bubble = h('div', { class: 'entry-bubble', 'aria-live': 'off' }, head, dots, text, wait);
  const main = h('div', { class: 'entry-msg-main' }, bubble);
  const avatar = isWrap ? null : h('span', { class: 'entry-avatar', 'aria-hidden': 'true' }, icon('sprout', { size: 16 }));
  const el = h('article', {
    class: ['entry-msg', 'entry-msg-ai', 'is-live', isWrap ? 'is-wrapup' : 'is-reply'],
    'aria-busy': 'true',
    'aria-label': isWrap ? 'Reflection in progress' : 'Reply in progress',
  }, avatar, main);

  let any = false;
  return {
    el,
    append(chunk) {
      if (!chunk) return;
      if (!any) { any = true; dots.hidden = true; wait.hidden = true; el.classList.add('has-text'); }
      textNode.appendData(chunk);
    },
    hideDots() { dots.hidden = true; },
    setWait(message) { if (!any) { wait.textContent = message; wait.hidden = false; } },
    hasText() { return any; },
  };
}

const PHASES = [
  { name: 'reflection', label: 'Writing your reflection' },
  { name: 'metadata', label: 'Finding a title and themes' },
  { name: 'memory', label: 'Noting what to remember' },
];

/**
 * Small progress list for the wrap-up pipeline. Phases appear as the server reports them.
 * @returns {{ el: HTMLElement, set(name: string): void, finish(): void }}
 */
export function createPhaseStepper() {
  const items = new Map();
  const list = h('ol', { class: 'entry-phases' });
  const el = h('div', { class: 'entry-phase-wrap', role: 'status', 'aria-live': 'polite' }, list);
  let current = null;

  function ensure(name) {
    if (items.has(name)) return items.get(name);
    const meta = PHASES.find((p) => p.name === name);
    const li = h('li', { class: 'entry-phase', dataset: { phase: name } },
      h('span', { class: 'entry-phase-mark', 'aria-hidden': 'true' }),
      h('span', null, meta ? meta.label : name));
    items.set(name, li);
    list.append(li);
    return li;
  }

  return {
    el,
    set(name) {
      if (current && current !== name) {
        const prev = items.get(current);
        if (prev) { prev.classList.remove('is-active'); prev.classList.add('is-done'); }
      }
      current = name;
      ensure(name).classList.add('is-active');
    },
    finish() {
      for (const li of items.values()) { li.classList.remove('is-active'); li.classList.add('is-done'); }
    },
  };
}
