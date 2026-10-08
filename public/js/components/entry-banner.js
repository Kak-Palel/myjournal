// Inline banner above the composer: what went wrong, what to do next. Wording comes from
// entry-errors.js (describeProblem); this file only builds the DOM.
import { h } from '../lib/dom.js';
import { icon, inlineCode } from '../lib/ui.js';

const TONE_ICON = { error: 'alert', warn: 'alert', info: 'info' };

/**
 * @param {import('./entry-errors.js').Problem} problem
 * @param {{ onRetry?: () => (void|Promise<void>), onDismiss: () => void }} actions
 * @returns {HTMLElement}
 */
export function renderBanner(problem, { onRetry, onDismiss }) {
  const buttons = h('div', { class: 'entry-banner-actions' });

  if (problem.retry && onRetry) {
    const retry = h('button', { type: 'button', class: 'btn btn-sm btn-primary entry-retry' }, 'Try again');
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      retry.textContent = 'Trying…';
      try { await onRetry(); } finally { if (retry.isConnected) { retry.disabled = false; retry.textContent = 'Try again'; } }
    });
    buttons.append(retry);
  }
  if (problem.settings) {
    buttons.append(h('a', { class: ['btn', 'btn-sm', problem.retry ? '' : 'btn-primary'], href: problem.settings.href }, problem.settings.label));
  }
  // The close button sits in the corner so the message and its one or two actions get the whole width (and the
  // floating banner stays short on a phone).
  const dismiss = h('button', { type: 'button', class: 'btn btn-sm btn-ghost btn-icon entry-dismiss', 'aria-label': 'Dismiss', title: 'Dismiss', onClick: onDismiss }, icon('x', { size: 16 }));

  return h('div', {
    class: ['notice', `notice-${problem.tone === 'info' ? 'info' : problem.tone === 'warn' ? 'warn' : 'error'}`, 'entry-banner'],
    role: problem.tone === 'error' ? 'alert' : 'status',
    dataset: { code: problem.code },
  },
  icon(TONE_ICON[problem.tone] || 'alert'),
  h('div', { class: 'notice-body' },
    h('strong', null, inlineCode(problem.message)),
    problem.hint ? h('p', { class: 'muted' }, inlineCode(problem.hint)) : null,
    buttons.childElementCount ? buttons : null),
  dismiss);
}
