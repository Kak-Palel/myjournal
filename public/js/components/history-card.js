// Entry card used by History (full) and Today (compact). Text is rendered as text nodes; search
// highlights are <mark> elements built from highlightSegments(), never from markup strings.
import { h } from '../lib/dom.js';
import { icon, moodFace, formatDate, formatTime, MOODS } from '../lib/ui.js';
import { entryTitle, highlightSegments, previewText } from './history-format.js';
import { wordsLabel } from './entry-text.js';

/** Text and <mark> nodes for `text` with the search terms highlighted. */
export function highlightNodes(text, terms) {
  return highlightSegments(text, terms).map((seg) => (seg.match ? h('mark', { class: 'hcard-mark' }, seg.text) : seg.text));
}

const MAX_CHIPS = 3;

function chips(entry, onTag) {
  const emotions = (entry.emotions || []).slice(0, MAX_CHIPS).map((e) => h('li', { class: 'hcard-chip is-emotion' }, e));
  const tagList = entry.tags || [];
  const tags = tagList.slice(0, MAX_CHIPS).map((t) => h('li', null, onTag
    ? h('button', { type: 'button', class: 'hcard-chip is-tag is-button', title: `Show entries tagged ${t}`, onClick: () => onTag(t) }, `#${t}`)
    : h('span', { class: 'hcard-chip is-tag' }, `#${t}`)));
  const extra = (entry.emotions || []).length - emotions.length + tagList.length - tags.length;
  if (emotions.length + tags.length === 0) return null;
  return h('ul', { class: 'hcard-chips', 'aria-label': 'Feelings and tags' }, emotions, tags, extra > 0 ? h('li', { class: 'hcard-more' }, `+${extra}`) : null);
}

/**
 * @param {object} entry EntrySummary
 * @param {object} [opts]
 * @param {string[]} [opts.terms] search terms to highlight
 * @param {boolean} [opts.compact] Today's slim variant (no chips, one-line preview)
 * @param {(tag: string) => void} [opts.onTag] makes tag chips filter buttons
 * @returns {HTMLLIElement}
 */
export function renderEntryCard(entry, { terms = [], compact = false, onTag } = {}) {
  const mood = MOODS.find((m) => m.value === entry.mood);
  const title = entryTitle(entry);
  const excerpt = previewText(entry);

  const moodEl = h('span', { class: ['hcard-mood', mood ? '' : 'is-none'], style: mood ? { '--history-mood': mood.color } : null }, mood ? moodFace(entry.mood) : icon('pen', { size: 16 }));
  const meta = [
    formatDate(entry.date || entry.createdAt),
    entry.createdAt ? formatTime(entry.createdAt) : '',
    entry.wordCount ? wordsLabel(entry.wordCount) : '',
    entry.kind === 'guided' ? 'Guided' : '',
  ].filter(Boolean).join(' · ');

  const flags = h('span', { class: 'hcard-flags' },
    entry.pinned ? h('span', { class: 'hcard-flag', title: 'Pinned' }, icon('pin', { size: 14 }), h('span', { class: 'sr-only' }, 'Pinned')) : null,
    entry.private ? h('span', { class: 'hcard-flag', title: 'Private' }, icon('lock', { size: 14 }), h('span', { class: 'sr-only' }, 'Private')) : null);

  return h('li', { class: ['hcard', compact ? 'is-compact' : ''], dataset: { id: entry.id } },
    moodEl,
    h('div', { class: 'hcard-body' },
      h('div', { class: 'hcard-top' },
        h('h3', { class: 'hcard-title' }, h('a', { class: 'hcard-link', href: `#/entry/${encodeURIComponent(entry.id)}`, dir: 'auto' }, highlightNodes(title, terms))),
        flags),
      h('p', { class: 'hcard-meta' }, meta),
      excerpt ? h('p', { class: 'hcard-preview', dir: 'auto' }, highlightNodes(excerpt, terms)) : null,
      compact ? null : chips(entry, onTag)));
}
