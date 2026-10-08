// Memory: the short facts your companion keeps about you. Explains how they are used, holds the three master
// switches, and lets you add, pin, edit and delete them.
import { h, mount } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { icon, skeleton, showError, toast, confirmDialog } from '../lib/ui.js';
import { createMemoryList } from '../components/memory-list.js';
import { MAX_MEMORY_CHARS, countLabel, validateMemoryText, switchState } from '../components/memory-logic.js';
import { fieldRow, switchControl, textareaWithCounter, notice, withBusy } from '../components/settings-ui.js';

const isAbort = (err) => Boolean(err) && err.name === 'AbortError';

export default async function memoryView(ctx) {
  const { root, signal, app } = ctx;

  mount(root, h('div', { class: 'page memory-page' },
    h('header', { class: 'page-header' }, h('div', null, h('h1', null, 'Memory'))),
    skeleton(5)));

  let memories;
  try {
    const [res] = await Promise.all([api.get('/memories', { signal }), app.settings ? null : app.refreshSettings()]);
    memories = (res && res.memories) || [];
  } catch (err) {
    if (isAbort(err)) return undefined;
    const holder = h('div', { class: 'page memory-page' });
    mount(root, holder);
    showError(holder, err, { onRetry: () => app.navigate(location.hash.slice(1) || '/memory') });
    return undefined;
  }
  if (signal.aborted) return undefined;

  /* -------------------------------------------------------------- switches */
  const mem = () => app.settings.memory;
  const statusEl = h('span', { class: 'chip memory-count', role: 'status' });
  const offBanner = h('div', { class: 'memory-off', hidden: true });
  let saving = false;

  function makeSwitch(key, label, hint) {
    const sw = switchControl({
      label, hint, checked: Boolean(mem()[key]),
      onChange: async (value) => {
        if (saving) { sw.set(mem()[key]); return; }
        saving = true;
        paintSwitches();
        try {
          await app.saveSettings({ memory: { [key]: value } });
        } catch (err) {
          sw.set(mem()[key]);
          toast(err.message || 'Could not save that setting', { kind: 'error' });
        } finally {
          saving = false;
          paintSwitches();
        }
      },
    });
    return sw;
  }

  const switches = {
    enabled: makeSwitch('enabled', 'Remember things about me', 'Turn off to stop saving and using memories. Existing ones are kept, just not used.'),
    autoExtract: makeSwitch('autoExtract', 'Suggest memories when I wrap up an entry', 'After you wrap up, your companion may save up to three short facts. You can delete any of them below.'),
    useRelatedEntries: makeSwitch('useRelatedEntries', 'Recall related past entries', 'When replying, your companion may look up a few older entries on the same topic so it can follow your thread.'),
  };

  function paintSwitches() {
    const state = switchState(mem());
    for (const [key, sw] of Object.entries(switches)) {
      sw.set(Boolean(mem()[key]));
      sw.setDisabled(saving || !state[key]);
    }
    const off = !mem().enabled;
    offBanner.hidden = !off;
    mount(offBanner, off ? notice({
      tone: 'warn', role: 'status',
      children: [h('strong', null, 'Memory is off.'), h('p', null, 'Nothing new is remembered and your memories are not sent to the AI. The ones below are kept until you delete them.')],
    }) : null);
  }

  /* -------------------------------------------------------------- add form */
  const addField = textareaWithCounter({
    max: MAX_MEMORY_CHARS, rows: 2, placeholder: 'For example: Prefers short walks to the gym',
    onInput: () => addRow.setError(''),
  });
  const addRow = fieldRow({ label: 'Add a memory', input: addField.textarea, control: addField.el, hint: 'One short fact about you, in your own words.' });
  const addBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('plus', { size: 16 }), 'Add memory');
  addField.textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addForm.requestSubmit(); }
  });
  const addForm = h('form', {
    class: 'memory-add stack-sm', novalidate: true,
    onSubmit: (e) => { e.preventDefault(); withBusy(addBtn, addMemory); },
  }, addRow.el, h('div', { class: 'row' }, addBtn, h('span', { class: 'muted small' }, 'Ctrl+Enter also adds')));

  async function addMemory() {
    const check = validateMemoryText(addField.textarea.value);
    if (!check.ok) { addRow.setError(check.problem); addField.textarea.focus(); return; }
    try {
      const res = await api.post('/memories', { text: check.text }, { signal });
      list.add(res.memory);
      addField.set('');
      addRow.setError('');
      updateCount();
      toast('Remembered', { kind: 'success', timeout: 1800 });
      addField.textarea.focus();
    } catch (err) {
      if (isAbort(err)) return;
      addRow.setError((err instanceof ApiError && err.fields && err.fields.text) || err.message || 'Could not save that memory');
      addField.textarea.focus();
    }
  }

  /* ------------------------------------------------------------------ list */
  const clearBtn = h('button', { type: 'button', class: 'btn btn-sm btn-outline-danger', onClick: () => clearAll() }, icon('trash', { size: 14 }), 'Clear all');
  const list = createMemoryList({
    signal,
    focusAdd: () => addField.textarea.focus(),
    onChange: () => updateCount(),
  });
  list.set(memories);

  function updateCount() {
    const n = list.all().length;
    statusEl.textContent = countLabel(n);
    clearBtn.hidden = n === 0;
  }

  async function clearAll() {
    const n = list.all().length;
    const ok = await confirmDialog({
      title: 'Forget everything?',
      body: `This deletes all ${n} ${n === 1 ? 'memory' : 'memories'}. Your entries are not touched, and your companion will start fresh.`,
      confirmLabel: 'Forget everything',
      danger: true,
    });
    if (!ok) return;
    await withBusy(clearBtn, async () => {
      try {
        const res = await api.post('/memories/clear', undefined, { signal });
        list.set([]);
        updateCount();
        toast(`Forgot ${res && Number.isFinite(res.removed) ? res.removed : n} ${n === 1 ? 'memory' : 'memories'}`, { timeout: 2200 });
        addField.textarea.focus();
      } catch (err) {
        if (!isAbort(err)) toast(err.message || 'Could not clear your memories', { kind: 'error' });
      }
    });
  }

  /* --------------------------------------------------------------- the page */
  const point = (iconName, title, text) => h('li', { class: 'memory-point' },
    h('span', { class: 'memory-point-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 20 })),
    h('div', null, h('strong', null, title), h('p', { class: 'muted' }, text)));

  mount(root, h('div', { class: 'page memory-page' },
    h('header', { class: 'page-header' },
      h('div', null, h('h1', null, 'Memory'), h('p', { class: 'page-sub' }, 'The short facts your companion remembers about you.')),
      statusEl),
    h('section', { class: 'card memory-explainer', 'aria-labelledby': 'memory-explainer-title' },
      h('h2', { class: 'memory-card-title', id: 'memory-explainer-title' }, 'How memory works'),
      h('ul', { class: 'memory-points' },
        point('bookmark', 'A few words each', 'Things like "Has a younger sister called Maya" or "Works night shifts". Never whole entries.'),
        point('sparkles', 'Used when your companion replies', 'The relevant ones are added to the message sent to your AI model, so it can be personal. Nothing else is stored anywhere but this computer.'),
        point('lock', 'Private entries are never used', 'If you mark an entry private, it is left out of memory, recall and weekly reflections.'),
        point('shield', 'You are in charge', 'Edit, pin, or delete any memory at any time. Pinned ones are always at the top.'))),
    h('section', { class: 'card memory-switches', 'aria-labelledby': 'memory-switches-title' },
      h('h2', { class: 'memory-card-title', id: 'memory-switches-title' }, 'Settings'),
      offBanner,
      h('div', { class: 'stack' }, switches.enabled.el, switches.autoExtract.el, switches.useRelatedEntries.el)),
    h('section', { class: 'card memory-add-card' }, addForm),
    h('section', { class: 'card memory-list-card', 'aria-labelledby': 'memory-list-title' },
      h('div', { class: 'memory-list-head' },
        h('h2', { class: 'memory-card-title', id: 'memory-list-title' }, 'What I remember'),
        clearBtn),
      list.el)));

  paintSwitches();
  updateCount();
  const off = app.on('settings', () => { if (!saving) paintSwitches(); });
  return () => off();
}
