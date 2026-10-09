// The list of memories: pin, inline edit, two-step delete, link to the source entry.
// State lives in `memories`; every change goes to the server first and the list is rebuilt from what the
// server answered, so the screen never claims something the database does not have.
import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { icon, toast, formatDate, emptyState } from '../lib/ui.js';
import { MAX_MEMORY_CHARS, FILTER_THRESHOLD, sortMemories, filterMemories, validateMemoryText, upsertMemory } from './memory-logic.js';
import { textareaWithCounter } from './settings-ui.js';

const isAbort = (err) => Boolean(err) && err.name === 'AbortError';

/**
 * @param {{ signal: AbortSignal, onChange: (memories: object[]) => void, focusAdd: () => void }} opts
 * @returns {{ el: HTMLElement, set(list: object[]): void, add(memory: object): void, all(): object[] }}
 */
export function createMemoryList({ signal, onChange, focusAdd, aiReady = () => true }) {
  let memories = [];
  let query = '';
  let editingId = '';
  let deletingId = '';
  const drafts = new Map(); // id -> text being edited; survives re-renders so typing is never lost
  const busy = new Set();
  let pendingFocus = null; // { id, part } applied after the next render

  const filterInput = h('input', {
    type: 'search', class: 'input memory-filter', placeholder: 'Filter memories', 'aria-label': 'Filter memories', autocomplete: 'off',
    onInput: () => { query = filterInput.value; render(); },
  });
  const filterRow = h('div', { class: 'memory-filter-row', hidden: true }, icon('search', { size: 16 }), filterInput);
  const listEl = h('ul', { class: 'memory-list' });
  const noMatch = h('p', { class: 'muted memory-nomatch', hidden: true });
  // With no AI companion on there is nobody to suggest facts: say what actually happens instead of promising it.
  const emptyBody = () => (aiReady()
    ? 'As you wrap up entries, your companion may suggest short facts to remember, and you decide what stays. You can also add one yourself above.'
    : 'Add a fact about yourself above and it is kept here. It is used once an AI companion is switched on; nothing is suggested until then.');
  const emptyEl = emptyState({ icon: 'bookmark', title: 'Nothing remembered yet', body: emptyBody() });
  const el = h('div', { class: 'memory-list-wrap' }, filterRow, listEl, noMatch, emptyEl);

  /* ------------------------------------------------------------- actions */
  async function togglePin(m) {
    if (busy.has(m.id)) return;
    busy.add(m.id);
    render();
    try {
      const res = await api.patch(`/memories/${encodeURIComponent(m.id)}`, { pinned: !m.pinned }, { signal });
      memories = upsertMemory(memories, res.memory);
      pendingFocus = { id: m.id, part: 'pin' };
      toast(res.memory.pinned ? 'Pinned to the top' : 'Unpinned', { timeout: 1500 });
    } catch (err) {
      if (!isAbort(err)) toast(err.message || 'Could not update that memory', { kind: 'error' });
    } finally {
      busy.delete(m.id);
      if (!pendingFocus) pendingFocus = { id: m.id, part: 'pin' }; // a failed call must not leave focus on <body>
      render();
      onChange(memories);
    }
  }

  async function saveEdit(m, rawText, field) {
    const check = validateMemoryText(rawText);
    if (!check.ok) { field.setError(check.problem); return; }
    if (check.text === m.text) { editingId = ''; drafts.delete(m.id); pendingFocus = { id: m.id, part: 'edit' }; render(); return; }
    busy.add(m.id);
    drafts.set(m.id, rawText);
    field.setError('');
    render();
    try {
      const res = await api.patch(`/memories/${encodeURIComponent(m.id)}`, { text: check.text }, { signal });
      memories = upsertMemory(memories, res.memory);
      editingId = '';
      drafts.delete(m.id);
      pendingFocus = { id: m.id, part: 'edit' };
      toast('Memory updated', { kind: 'success', timeout: 1800 });
    } catch (err) {
      if (isAbort(err)) return;
      editingId = m.id;
      pendingFocus = { id: m.id, part: 'textarea', error: (err.fields && err.fields.text) || err.message || 'Could not save that change' };
    } finally {
      busy.delete(m.id);
      render();
      onChange(memories);
    }
  }

  async function remove(m) {
    if (busy.has(m.id)) return;
    busy.add(m.id);
    render();
    const index = visible().findIndex((x) => x.id === m.id);
    try {
      await api.del(`/memories/${encodeURIComponent(m.id)}`, { signal });
      memories = memories.filter((x) => x.id !== m.id);
      deletingId = '';
      const next = visible()[index] || visible()[index - 1];
      pendingFocus = next ? { id: next.id, part: 'pin' } : { id: '', part: 'add' };
      toast('Forgotten', { timeout: 1800 });
    } catch (err) {
      if (!isAbort(err)) toast(err.message || 'Could not delete that memory', { kind: 'error' });
    } finally {
      busy.delete(m.id);
      if (!pendingFocus) pendingFocus = { id: m.id, part: 'delete' };
      render();
      onChange(memories);
    }
  }

  /* -------------------------------------------------------------- render */
  const visible = () => filterMemories(memories, query);

  function itemMain(m) {
    const meta = [
      m.pinned ? h('span', { class: 'chip chip-primary' }, icon('pin', { size: 12 }), 'Pinned') : null,
      h('span', null, `Saved ${formatDate(Number(m.createdAt) || Date.now(), { weekday: false })}`),
      m.sourceEntryId ? h('a', { class: 'memory-source', href: `#/entry/${encodeURIComponent(m.sourceEntryId)}` }, icon('book', { size: 13 }), 'From an entry') : null,
    ];
    return h('div', { class: 'memory-main' },
      h('p', { class: 'memory-text' }, m.text),
      h('p', { class: 'memory-meta muted' }, meta));
  }

  function editor(m) {
    const field = textareaWithCounter({
      value: drafts.has(m.id) ? drafts.get(m.id) : m.text, max: MAX_MEMORY_CHARS, rows: 3,
      onInput: (value) => drafts.set(m.id, value),
    });
    const errorEl = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const fieldApi = {
      setError(msg) {
        errorEl.textContent = msg || '';
        errorEl.hidden = !msg;
        if (msg) field.textarea.setAttribute('aria-invalid', 'true'); else field.textarea.removeAttribute('aria-invalid');
      },
    };
    field.textarea.setAttribute('aria-label', 'Edit memory');
    field.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(m); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(m, field.textarea.value, fieldApi); }
    });
    const wrap = h('div', { class: 'memory-main memory-editing' },
      field.el, errorEl,
      h('div', { class: 'row memory-edit-actions' },
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { part: 'save' }, onClick: () => saveEdit(m, field.textarea.value, fieldApi) }, 'Save'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => cancelEdit(m) }, 'Cancel'),
        h('span', { class: 'muted small memory-edit-hint' }, 'Ctrl+Enter saves, Esc cancels')));
    return { wrap, field, fieldApi };
  }

  function cancelEdit(m) {
    editingId = '';
    drafts.delete(m.id);
    pendingFocus = { id: m.id, part: 'edit' };
    render();
  }

  function actions(m) {
    const disabled = busy.has(m.id);
    if (deletingId === m.id) {
      return h('div', { class: 'memory-actions memory-confirm', role: 'group', 'aria-label': 'Confirm forgetting this memory' },
        h('span', { class: 'memory-confirm-text' }, 'Forget this?'),
        h('button', { type: 'button', class: 'btn btn-sm btn-danger', disabled, dataset: { part: 'confirm' }, onClick: () => remove(m) }, 'Forget'),
        h('button', { type: 'button', class: 'btn btn-sm', dataset: { part: 'keep' }, onClick: () => { deletingId = ''; pendingFocus = { id: m.id, part: 'delete' }; render(); } }, 'Keep'));
    }
    return h('div', { class: 'memory-actions' },
      h('button', {
        type: 'button', class: ['btn', 'btn-ghost', 'btn-icon', 'memory-icon-btn', m.pinned ? 'is-on' : ''], disabled, dataset: { part: 'pin' },
        'aria-pressed': String(Boolean(m.pinned)), 'aria-label': m.pinned ? 'Unpin this memory' : 'Pin this memory', title: m.pinned ? 'Unpin' : 'Pin to the top',
        onClick: () => togglePin(m),
      }, icon('pin', { size: 18 })),
      h('button', {
        type: 'button', class: 'btn btn-ghost btn-icon memory-icon-btn', disabled, dataset: { part: 'edit' }, 'aria-label': 'Edit this memory', title: 'Edit',
        onClick: () => { editingId = m.id; deletingId = ''; pendingFocus = { id: m.id, part: 'textarea' }; render(); },
      }, icon('edit', { size: 18 })),
      h('button', {
        type: 'button', class: 'btn btn-ghost btn-icon memory-icon-btn memory-delete', disabled, dataset: { part: 'delete' }, 'aria-label': 'Delete this memory', title: 'Delete',
        onClick: () => { deletingId = m.id; editingId = ''; pendingFocus = { id: m.id, part: 'keep' }; render(); },
      }, icon('trash', { size: 18 })));
  }

  function item(m) {
    const editing = editingId === m.id;
    const ed = editing ? editor(m) : null;
    const li = h('li', { class: ['memory-item', m.pinned ? 'is-pinned' : '', busy.has(m.id) ? 'is-busy' : ''], dataset: { id: m.id } },
      ed ? ed.wrap : itemMain(m),
      editing ? null : actions(m));
    if (ed && pendingFocus && pendingFocus.id === m.id && pendingFocus.error) ed.fieldApi.setError(pendingFocus.error);
    return li;
  }

  function render() {
    const all = sortMemories(memories);
    memories = all;
    filterRow.hidden = all.length <= FILTER_THRESHOLD;
    if (all.length <= FILTER_THRESHOLD && query) { query = ''; filterInput.value = ''; }
    const shown = visible();
    mount(listEl, shown.map(item));
    noMatch.hidden = !(all.length > 0 && shown.length === 0);
    noMatch.textContent = noMatch.hidden ? '' : 'No memory matches that filter.';
    listEl.hidden = shown.length === 0;
    emptyEl.hidden = all.length > 0;
    const emptyText = emptyEl.querySelector('p');
    if (emptyText) emptyText.textContent = emptyBody();
    applyFocus();
  }

  function applyFocus() {
    const target = pendingFocus;
    pendingFocus = null;
    if (!target) return;
    if (target.part === 'add') { focusAdd(); return; }
    const li = listEl.querySelector(`[data-id="${CSS.escape(target.id)}"]`);
    if (!li) return;
    const control = target.part === 'textarea' ? li.querySelector('textarea') : li.querySelector(`[data-part="${target.part}"]`);
    if (control) {
      control.focus();
      if (target.part === 'textarea') control.setSelectionRange(control.value.length, control.value.length);
    }
  }

  render();
  return {
    el,
    all: () => memories,
    set(list) { memories = sortMemories(list); editingId = ''; deletingId = ''; drafts.clear(); render(); },
    add(memory) { memories = upsertMemory(memories, memory); render(); },
    /** Repaint (the empty-state text depends on whether an AI companion is on). */
    refresh() { render(); },
  };
}
