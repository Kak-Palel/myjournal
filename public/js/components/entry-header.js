// Entry header: back link, editable title, date, mood, emotion/tag chips and the overflow menu.
// Every edit goes through `onPatch(patch)` (the view serialises PATCH calls); on failure the header
// repaints from the last known entry so the screen never shows something that was not saved.
import { h, mount } from '../lib/dom.js';
import { icon, moodPicker } from '../lib/ui.js';
import { LABEL_LIMITS, addLabel, removeLabel } from './entry-labels.js';
import { committableDate, DATE_SETTLE_MS } from './entry-date.js';
import { createMenu } from './entry-menu.js';

const TITLE_MAX = 120;

/**
 * Chip group with inline add. `read()` returns the current list, `commit(list)` saves it.
 */
function createLabelGroup({ kind, groupLabel, addLabelText, placeholder, prefix, limits, read, commit, notify }) {
  const list = h('ul', { class: 'entry-chips' });
  const el = h('div', { class: ['entry-label-group', `is-${kind}`], role: 'group', 'aria-label': groupLabel }, list);
  /** Commits the chip being typed (null when none is open). */
  let finishOpen = null;

  function startAdd(slot, addBtn) {
    const input = h('input', {
      type: 'text', class: 'entry-chip-input', maxlength: limits.maxLen + 8, placeholder,
      'aria-label': addLabelText, autocomplete: 'off', enterkeyhint: 'done',
    });
    let finished = false;
    function finish(save) {
      if (finished) return;
      finished = true;
      finishOpen = null;
      const raw = input.value;
      slot.replaceChildren(addBtn);
      if (!save || !raw.trim()) { addBtn.focus({ preventScroll: true }); return; }
      const res = addLabel(read(), raw, limits);
      if (res.reason === 'duplicate') notify(`“${raw.trim()}” is already there.`);
      else if (res.reason === 'full') notify(`You can add up to ${limits.max} ${groupLabel.toLowerCase()}. Remove one first.`);
      else if (res.added) commit(res.list);
      addBtn.focus({ preventScroll: true });
    }
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    finishOpen = () => finish(true);
    slot.replaceChildren(input);
    input.focus();
  }

  function paint() {
    const items = read();
    const nodes = items.map((label) => h('li', { class: ['entry-chip', `is-${kind}`] },
      h('span', { class: 'entry-chip-text', dir: 'auto' }, prefix + label),
      h('button', {
        type: 'button', class: 'entry-chip-x', 'aria-label': `Remove ${kind === 'emotion' ? 'feeling' : 'tag'} ${label}`,
        onClick: () => commit(removeLabel(read(), label)),
      }, icon('x', { size: 12 }))));
    if (items.length < limits.max) {
      const slot = h('li', { class: 'entry-chip-slot' });
      const addBtn = h('button', { type: 'button', class: 'entry-chip-add', onClick: () => startAdd(slot, addBtn) }, icon('plus', { size: 14 }), h('span', null, addLabelText));
      slot.append(addBtn);
      nodes.push(slot);
    }
    list.replaceChildren(...nodes);
  }

  return { el, paint, flush() { if (finishOpen) finishOpen(); } };
}

/**
 * @param {object} opts
 * @param {object} opts.entry initial entry
 * @param {(patch: object, opts?: { detached: boolean }) => Promise<object>} opts.onPatch PATCH /entries/:id; rejects on failure.
 *   `detached: true` = the view is going away, so the request must outlive its abort signal.
 * @param {() => void} opts.onExport
 * @param {() => void} opts.onDelete
 * @param {(message: string) => void} opts.notify toast-like message for small problems
 * @returns {{ el: HTMLElement, update(entry: object): void, flush(): void, destroy(): void }}
 *   flush() saves an edit that is still pending (title being typed, chip being typed, date waiting to settle).
 */
export function createHeader({ entry, onPatch, onExport, onDelete, notify }) {
  let current = entry;
  let closing = false;

  async function patch(p) {
    try {
      await onPatch(p, { detached: closing });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      notify(err && err.message ? `Could not save that change. ${err.message}` : 'Could not save that change.');
      paint('date' in p);
    }
  }

  const title = h('input', {
    type: 'text', class: 'entry-title', maxlength: TITLE_MAX, placeholder: 'Untitled entry', 'aria-label': 'Entry title',
    autocomplete: 'off', dir: 'auto', enterkeyhint: 'done',
  });
  // `change` never fires when the field is removed while focused (Back, a link, a swipe), so a typed
  // title is also saved by flush(). `titleDirty` keeps flush() from writing a stale value over a newer
  // server-side title (the wrap-up sets one) when the writer did not touch the field.
  let titleDirty = false;
  function commitTitle() {
    titleDirty = false;
    const next = title.value.trim();
    if (next === (current.title || '')) { title.value = next; return; }
    patch({ title: next });
  }
  title.addEventListener('input', () => { titleDirty = true; });
  title.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
    else if (e.key === 'Escape') { titleDirty = false; title.value = current.title || ''; title.blur(); }
  });
  title.addEventListener('change', commitTitle);

  // A date input fires `change` for every keystroke that forms a valid date (typing 2025 passes through
  // 0002, 0020, 0202), so a date is saved once the field has sat still, on Enter, or on blur, and never
  // while it is not a date the server accepts. The field is also never repainted under the writer's fingers.
  const date = h('input', { type: 'date', class: 'entry-date', 'aria-label': 'Entry date', min: '1000-01-01', max: '9999-12-31' });
  let dateTimer = null;
  const stopDateTimer = () => { if (dateTimer !== null) { clearTimeout(dateTimer); dateTimer = null; } };
  function commitDate() {
    stopDateTimer();
    const next = committableDate(date.value);
    if (next === null) { date.value = current.date || ''; return; }
    if (next !== current.date) patch({ date: next });
  }
  date.addEventListener('change', () => {
    stopDateTimer();
    if (committableDate(date.value) !== null) dateTimer = setTimeout(commitDate, DATE_SETTLE_MS);
  });
  date.addEventListener('blur', commitDate);
  date.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitDate(); }
    else if (e.key === 'Escape') { stopDateTimer(); date.value = current.date || ''; }
  });

  const mood = moodPicker({ value: entry.mood, size: 'sm', onChange: (v) => patch({ mood: v }) });
  const flags = h('span', { class: 'entry-flags' });

  const emotions = createLabelGroup({
    kind: 'emotion', groupLabel: 'Feelings', addLabelText: 'Add feeling', placeholder: 'e.g. calm', prefix: '', limits: LABEL_LIMITS.emotions,
    read: () => current.emotions || [], commit: (list) => patch({ emotions: list }), notify,
  });
  const tags = createLabelGroup({
    kind: 'tag', groupLabel: 'Tags', addLabelText: 'Add tag', placeholder: 'e.g. work', prefix: '#', limits: LABEL_LIMITS.tags,
    read: () => current.tags || [], commit: (list) => patch({ tags: list }), notify,
  });

  const menuItems = () => [
    {
      id: 'private', label: 'Private entry', description: 'Keeps it out of memory, recall and weekly reflections.', icon: 'lock',
      checkbox: true, checked: Boolean(current.private), onSelect: () => patch({ private: !current.private }),
    },
    { id: 'pin', label: current.pinned ? 'Unpin entry' : 'Pin entry', icon: 'pin', onSelect: () => patch({ pinned: !current.pinned }) },
    { id: 'export', label: 'Export as Markdown', icon: 'download', onSelect: onExport },
    { id: 'delete', label: 'Delete entry…', icon: 'trash', danger: true, separatorBefore: true, onSelect: onDelete },
  ];
  const menu = createMenu({ label: 'Entry options', items: menuItems() });

  const el = h('header', { class: 'entry-head' },
    h('div', { class: 'entry-head-top' },
      h('a', { class: 'entry-back', href: '#/history' }, icon('chevron-left', { size: 18 }), h('span', null, 'History')),
      flags,
      menu.el),
    title,
    h('div', { class: 'entry-meta' },
      h('label', { class: 'entry-date-wrap' }, icon('calendar', { size: 16 }), date),
      mood.el),
    h('div', { class: 'entry-labels' }, emotions.el, tags.el));

  /** @param {boolean} [forceDate] also reset the date field while it has focus (a failed date change) */
  function paint(forceDate = false) {
    if (document.activeElement !== title) { title.value = current.title || ''; titleDirty = false; }
    if (forceDate) { stopDateTimer(); date.value = current.date || ''; }
    else if (document.activeElement !== date && dateTimer === null) date.value = current.date || '';
    mood.set(current.mood ?? null);
    mount(flags,
      current.private ? h('span', { class: 'entry-flag', title: 'Private: kept out of memory and weekly reflections' }, icon('lock', { size: 14 }), 'Private') : null,
      current.pinned ? h('span', { class: 'entry-flag', title: 'Pinned' }, icon('pin', { size: 14 }), 'Pinned') : null);
    emotions.paint();
    tags.paint();
    menu.setItems(menuItems());
  }

  function flush() {
    if (dateTimer !== null) commitDate();
    if (titleDirty) commitTitle();
    emotions.flush();
    tags.flush();
  }

  paint();
  return {
    el,
    update(next) { current = next; paint(); },
    flush,
    destroy() {
      closing = true; // the view's signal is already aborted: these last saves must not be tied to it
      flush();
      stopDateTimer();
      menu.destroy();
    },
  };
}
