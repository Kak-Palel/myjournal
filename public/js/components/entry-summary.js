// Card shown under the Reflection once an entry has been wrapped up: summary, emotions/tags and any
// memories the companion saved. All text goes through text nodes.
import { h } from '../lib/dom.js';
import { icon } from '../lib/ui.js';

/**
 * @param {{ summary?: string, emotions?: string[], tags?: string[] }} entry
 * @param {{ memories?: { id?: string, text: string }[], justAdded?: boolean }} [opts]
 * @returns {HTMLElement | null} null when there is nothing to show
 */
export function renderSummary(entry, { memories = [], justAdded = false } = {}) {
  const summary = String(entry.summary || '').trim();
  const emotions = Array.isArray(entry.emotions) ? entry.emotions : [];
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  if (!summary && memories.length === 0) return null;

  const chips = emotions.length || tags.length
    ? h('ul', { class: 'entry-summary-chips', 'aria-label': 'Feelings and tags' },
      emotions.map((e) => h('li', { class: 'entry-chip is-emotion' }, e)),
      tags.map((t) => h('li', { class: 'entry-chip is-tag' }, `#${t}`)))
    : null;

  const mem = memories.length
    ? h('div', { class: 'entry-summary-memories' },
      h('h3', { class: 'entry-summary-sub' }, icon('bookmark', { size: 16 }), justAdded ? 'Added to your memory' : 'Remembered from this entry'),
      h('ul', { class: 'entry-summary-list' }, memories.map((m) => h('li', { dir: 'auto' }, m.text))),
      h('a', { class: 'entry-summary-link', href: '#/memory' }, 'See or edit memories'))
    : null;

  return h('section', { class: 'entry-summary', 'aria-label': 'Entry summary' },
    h('h2', { class: 'entry-summary-title' }, 'Summary'),
    summary ? h('p', { class: 'entry-summary-text', dir: 'auto' }, summary) : null,
    chips,
    mem);
}
