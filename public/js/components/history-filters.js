// Search box + filter chips for the History view. Typing is debounced (Enter searches at once);
// mood / pinned / tag changes apply immediately. The component owns no data: it reports the next
// Filters object through onChange and the view does the fetching.
import { h } from '../lib/dom.js';
import { icon, MOODS, debounce } from '../lib/ui.js';
import { hasActiveFilters } from './history-format.js';

const SEARCH_DELAY_MS = 300;

/**
 * @param {object} opts
 * @param {import('./history-format.js').Filters} opts.filters initial filters
 * @param {(next: import('./history-format.js').Filters) => void} opts.onChange
 * @returns {{ el: HTMLElement, set(filters: object): void, setTags(tags: string[]): void, focusSearch(): void, destroy(): void }}
 */
export function createFilters({ filters, onChange }) {
  let current = { ...filters };
  let tagOptions = [];

  const input = h('input', {
    type: 'search', class: 'hist-search-input', id: 'hist-search', placeholder: 'Search your entries', autocomplete: 'off',
    enterkeyhint: 'search', spellcheck: 'false', 'aria-label': 'Search your entries', dir: 'auto', maxlength: 200,
  });
  input.value = current.q;
  const clearBtn = h('button', { type: 'button', class: 'hist-search-clear', 'aria-label': 'Clear search', hidden: true, onClick: () => { input.value = ''; apply({ q: '' }); input.focus(); } }, icon('x', { size: 16 }));
  const form = h('form', { class: 'hist-search', role: 'search', onSubmit: (e) => { e.preventDefault(); debouncedSearch.cancel(); apply({ q: input.value }); } },
    h('span', { class: 'hist-search-icon', 'aria-hidden': 'true' }, icon('search', { size: 18 })), input, clearBtn);

  const debouncedSearch = debounce(() => apply({ q: input.value }), SEARCH_DELAY_MS);
  input.addEventListener('input', () => { clearBtn.hidden = !input.value; debouncedSearch(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; debouncedSearch.cancel(); apply({ q: '' }); clearBtn.hidden = true; }
  });

  const moodButtons = MOODS.map((m) => h('button', {
    type: 'button', class: 'hist-chip hist-mood', 'aria-pressed': 'false', title: `${m.label} mood`, dataset: { mood: m.value },
    onClick: () => apply({ mood: current.mood === m.value ? null : m.value }),
  }, h('span', { 'aria-hidden': 'true' }, m.emoji), h('span', { class: 'sr-only' }, `${m.label} mood`)));

  const pinned = h('button', { type: 'button', class: 'hist-chip hist-pinned', 'aria-pressed': 'false', onClick: () => apply({ pinned: !current.pinned }) }, icon('pin', { size: 14 }), 'Pinned');

  const tagSelect = h('select', { class: 'hist-tag-select', 'aria-label': 'Filter by tag', onChange: () => apply({ tag: tagSelect.value }) });
  const clearAll = h('button', { type: 'button', class: 'hist-clear', hidden: true, onClick: () => { debouncedSearch.cancel(); input.value = ''; apply({ q: '', mood: null, tag: '', pinned: false }); } }, 'Clear filters');

  const chips = h('div', { class: 'hist-filters', role: 'group', 'aria-label': 'Filters' },
    h('div', { class: 'hist-moods', role: 'group', 'aria-label': 'Mood' }, moodButtons),
    pinned,
    tagSelect,
    clearAll);
  const el = h('div', { class: 'hist-controls' }, form, chips);

  function apply(patch) {
    current = { ...current, ...patch };
    paint();
    onChange({ ...current });
  }

  function paintTags() {
    const names = [...new Set([...(current.tag ? [current.tag] : []), ...tagOptions])];
    tagSelect.replaceChildren(
      h('option', { value: '' }, 'Any tag'),
      ...names.map((t) => h('option', { value: t }, `#${t}`)));
    tagSelect.value = current.tag || '';
    tagSelect.hidden = names.length === 0;
  }

  function paint() {
    moodButtons.forEach((b, i) => {
      const on = MOODS[i].value === current.mood;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('is-on', on);
    });
    pinned.setAttribute('aria-pressed', current.pinned ? 'true' : 'false');
    pinned.classList.toggle('is-on', current.pinned);
    clearBtn.hidden = !input.value;
    clearAll.hidden = !hasActiveFilters(current) && !input.value;
    paintTags();
  }

  paint();
  return {
    el,
    set(next) { current = { ...next }; input.value = current.q; paint(); },
    setTags(tags) { tagOptions = tags; paintTags(); },
    focusSearch() { input.focus(); input.select(); },
    destroy() { debouncedSearch.cancel(); },
  };
}
