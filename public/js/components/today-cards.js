// Cards on the Today page: prompt of the day, guided-journal grid, weekly nudge and entry lists.
import { h } from '../lib/dom.js';
import { icon, emptyState, skeleton } from '../lib/ui.js';
import { renderEntryCard } from './history-card.js';

export function renderPromptCard(prompt, { onUse }) {
  return h('section', { class: 'today-prompt', 'aria-labelledby': 'today-prompt-h' },
    h('div', { class: 'today-prompt-head' }, icon('sparkles', { size: 18 }), h('h2', { id: 'today-prompt-h' }, 'Prompt of the day')),
    h('blockquote', { class: 'today-prompt-text', dir: 'auto' }, prompt.text),
    h('button', { type: 'button', class: 'btn today-prompt-btn', onClick: () => onUse(prompt) }, icon('pen', { size: 16 }), 'Write about this'));
}

/**
 * @param {{ category: string, templates: object[] }[]} groups
 * @param {{ onPick(template: object): void, aiReady: boolean }} opts
 */
export function renderGuidedGrid(groups, { onPick, aiReady }) {
  return h('section', { class: 'today-guided', 'aria-labelledby': 'today-guided-h' },
    h('div', { class: 'today-section-head' },
      h('h2', { id: 'today-guided-h' }, 'Guided journals'),
      h('p', { class: 'muted' }, aiReady
        ? 'Pick one and your companion walks you through it, one question at a time.'
        : h('span', null, 'Each one opens with a question to write about. ', h('a', { href: '#/settings' }, 'Set up AI'), ' and your companion follows up.'))),
    groups.map((group) => h('div', { class: 'today-cat', role: 'group', 'aria-label': `${group.category} journals` },
      h('h3', { class: 'today-cat-title' }, group.category),
      h('ul', { class: 'today-grid' }, group.templates.map((t) => h('li', null,
        h('button', { type: 'button', class: 'today-guide', dataset: { template: t.id }, onClick: (e) => onPick(t, e.currentTarget) },
          h('span', { class: 'today-guide-icon', 'aria-hidden': 'true' }, icon(t.icon || 'sparkles', { size: 22 })),
          h('span', { class: 'today-guide-body' },
            h('span', { class: 'today-guide-title' }, t.title),
            h('span', { class: 'today-guide-desc' }, t.description),
            h('span', { class: 'today-guide-min' }, icon('clock', { size: 13 }), `${t.minutes} min`)))))))));
}

/** Weekly-reflection nudge. */
export function renderNudge({ count, aiReady, onDismiss }) {
  return h('section', { class: 'today-nudge', 'aria-label': 'Weekly reflection' },
    h('span', { class: 'today-nudge-icon', 'aria-hidden': 'true' }, icon('calendar', { size: 22 })),
    h('div', { class: 'today-nudge-body' },
      h('strong', null, `You have written ${count} times this week.`),
      h('p', { class: 'muted' }, aiReady ? 'Want a short reflection on what stood out?' : 'A weekly reflection looks back over your entries. It needs an AI companion.'),
      h('div', { class: 'row' },
        h('a', { class: 'btn btn-sm btn-primary', href: aiReady ? '#/insights' : '#/settings' }, aiReady ? 'See your weekly reflection' : 'Set up AI'),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: onDismiss }, 'Not now'))));
}

/** Titled list of entry cards (Pinned / Recent). */
export function renderEntrySection({ id, title, iconName, entries, action }) {
  return h('section', { class: 'today-list', 'aria-labelledby': id },
    h('div', { class: 'today-list-head' },
      h('h2', { id }, iconName ? icon(iconName, { size: 18 }) : null, title),
      action || null),
    h('ul', { class: 'today-entries' }, entries.map((entry) => renderEntryCard(entry, { compact: true }))));
}

export function sectionError(message, onRetry) {
  return h('div', { class: 'notice notice-warn today-section-error', role: 'status' },
    icon('alert'),
    h('div', { class: 'notice-body' },
      h('strong', null, message),
      onRetry ? h('button', { type: 'button', class: 'btn btn-sm', onClick: onRetry }, 'Try again') : null));
}

export function sectionSkeleton(lines = 3) {
  return h('div', { class: 'today-skeleton' }, skeleton(lines));
}

export function emptyRecent() {
  return emptyState({ icon: 'sprout', title: 'Your journal starts here', body: 'Write a few words above, or open a guided journal.' });
}
