// "Data" tab: what is stored, export (JSON / Markdown), import, wipe, where data and keys live, sign out.
import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { icon, toast, confirmDialog, skeleton } from '../lib/ui.js';
import { MAX_IMPORT_BYTES, summarizeImport, describeImportResult, formatFileSize, pluralize } from './settings-logic.js';
import { notice, errorNotice, section, withBusy, uid } from './settings-ui.js';
import { DATA_SENT_WITH_A_REPLY, DATA_SENT_WITH_AI_STEPS } from './privacy-copy.js';
import { clearAllDrafts } from './entry-draft.js';

const isAbort = (err) => Boolean(err) && err.name === 'AbortError';
const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : '0');

/** Read a File as text with FileReader (abortable). */
function readText(file, signal) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => reader.abort(), { once: true });
    reader.readAsText(file);
  });
}

/**
 * @param {{ app: object, signal: AbortSignal }} opts
 */
export function createDataPanel({ app, signal }) {
  /* ---------------------------------------------------------------- stats */
  const statsBody = h('div', { class: 'settings-stats-body' }, skeleton(2));
  let statsLoading = false;

  async function loadStats() {
    if (statsLoading) return;
    statsLoading = true;
    try {
      const s = await api.get('/data/stats', { signal });
      mount(statsBody, h('dl', { class: 'settings-stats' },
        stat('Entries', fmt(s.entries)),
        stat('Messages', fmt(s.messages)),
        stat('Memories', fmt(s.memories)),
        stat('Reports', fmt(s.reports)),
        stat('Database size', formatFileSize(s.dbBytes) || '0 B')));
    } catch (err) {
      if (isAbort(err)) return;
      mount(statsBody, errorNotice(err, { fallback: 'Could not load your numbers', onRetry: () => loadStats() }));
    } finally {
      statsLoading = false;
    }
  }
  const stat = (label, value) => h('div', { class: 'settings-stat' }, h('dt', null, label), h('dd', null, value));

  /* --------------------------------------------------------------- export */
  const exportMsg = h('div', { class: 'settings-export-msg', 'aria-live': 'polite' });
  async function doExport(format, fallback, button) {
    mount(exportMsg);
    await withBusy(button, async () => {
      try {
        const name = await api.download(`/data/export?format=${format}`, fallback);
        mount(exportMsg, notice({ tone: 'success', role: 'status', children: [h('strong', null, 'Export ready'), h('p', { class: 'muted' }, `Saved as ${name} in your downloads.`)] }));
      } catch (err) {
        if (isAbort(err)) return;
        mount(exportMsg, errorNotice(err, { fallback: 'The export failed' }));
      }
    });
  }
  const jsonBtn = h('button', { type: 'button', class: 'btn', onClick: () => doExport('json', 'myjournal-export.json', jsonBtn) }, icon('download', { size: 16 }), 'Export JSON');
  const mdBtn = h('button', { type: 'button', class: 'btn', onClick: () => doExport('markdown', 'myjournal-export.md', mdBtn) }, icon('download', { size: 16 }), 'Export Markdown');

  /* --------------------------------------------------------------- import */
  let pendingDoc = null;
  const fileId = uid('import-file');
  const fileInput = h('input', {
    type: 'file', id: fileId, class: 'settings-file', accept: '.json,application/json',
    onChange: () => { const f = fileInput.files && fileInput.files[0]; if (f) onFile(f); },
  });
  const importOut = h('div', { class: 'settings-import-out', 'aria-live': 'polite' });

  function clearImport() {
    pendingDoc = null;
    fileInput.value = '';
    mount(importOut);
  }

  async function onFile(file) {
    pendingDoc = null;
    mount(importOut);
    const problem = (title, body) => mount(importOut, notice({ tone: 'error', role: 'alert', children: [h('strong', null, title), body ? h('p', { class: 'muted' }, body) : null] }));
    if (file.size === 0) return problem('That file is empty', 'Choose a JSON file exported from MyJournal.');
    if (file.size > MAX_IMPORT_BYTES) {
      return problem('That file is too large', `It is ${formatFileSize(file.size)}; the limit is ${formatFileSize(MAX_IMPORT_BYTES).replace('.0', '')}. Split the export or remove old entries first.`);
    }
    mount(importOut, h('p', { class: 'muted', role: 'status' }, h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }), ` Reading ${file.name}...`));
    let doc;
    try {
      const text = await readText(file, signal);
      doc = JSON.parse(text);
    } catch (err) {
      if (isAbort(err)) return undefined;
      return problem('Could not read that file', err instanceof SyntaxError ? 'It is not valid JSON. Use a file made by "Export JSON".' : (err.message || ''));
    }
    const summary = summarizeImport(doc);
    if (!summary.ok) return problem(summary.problem, 'Use a file made by "Export JSON" on this page.');
    pendingDoc = doc;
    const parts = [pluralize(summary.entries, 'entry', 'entries'), pluralize(summary.messages, 'message'), pluralize(summary.memories, 'memory', 'memories'), pluralize(summary.reports, 'report')];
    const importBtn = h('button', { type: 'button', class: 'btn btn-primary', onClick: () => withBusy(importBtn, () => runImport()) }, icon('upload', { size: 16 }), 'Import');
    mount(importOut, notice({
      tone: 'info',
      children: [
        h('strong', null, file.name),
        h('p', null, `Contains ${parts.join(', ')}.`),
        h('p', { class: 'muted' }, 'Anything already in your journal (same id) is skipped, so nothing is overwritten.'),
        h('div', { class: 'row' }, importBtn, h('button', { type: 'button', class: 'btn btn-ghost', onClick: clearImport }, 'Cancel')),
      ],
    }));
    return undefined;
  }

  async function runImport() {
    if (!pendingDoc) return;
    try {
      const result = await api.post('/data/import', pendingDoc, { signal });
      pendingDoc = null;
      fileInput.value = '';
      mount(importOut, notice({ tone: 'success', role: 'status', children: [h('strong', null, 'Import finished'), h('p', null, describeImportResult(result))] }));
      loadStats();
    } catch (err) {
      if (isAbort(err)) return;
      mount(importOut, errorNotice(err, { fallback: 'The import failed' }));
    }
  }

  /* ----------------------------------------------------------------- wipe */
  const alsoSettings = h('input', { type: 'checkbox', id: uid('wipe-settings') });
  const wipeBtn = h('button', { type: 'button', class: 'btn btn-outline-danger', onClick: () => wipe() }, icon('trash', { size: 16 }), 'Delete my journal data...');
  async function wipe() {
    const includeSettings = alsoSettings.checked;
    const ok = await confirmDialog({
      title: 'Delete everything?',
      body: h('div', { class: 'stack-sm' },
        h('p', null, includeSettings
          ? 'This permanently deletes every entry, message, memory and report, plus your settings and saved API keys.'
          : 'This permanently deletes every entry, message, memory and report. Your settings and API keys are kept.'),
        h('p', { class: 'muted' }, 'There is no undo. Export a copy first if you might want it back.')),
      confirmLabel: 'Delete everything',
      danger: true,
      requireText: 'DELETE',
    });
    if (!ok) return;
    await withBusy(wipeBtn, async () => {
      try {
        await api.post('/data/wipe', { confirm: 'DELETE', includeSettings }, { signal });
      } catch (err) {
        if (isAbort(err)) return;
        toast(err.message || 'Could not delete your data', { kind: 'error' });
        return;
      }
      alsoSettings.checked = false;
      clearAllDrafts(); // unsent text kept by this browser is part of "everything"
      clearImport();
      mount(exportMsg);
      toast('Everything was deleted', { kind: 'success' });
      if (includeSettings) {
        try { await app.refreshSettings(); } catch { /* the welcome screen reloads settings anyway */ }
        app.navigate('/welcome');
      } else {
        loadStats();
      }
    });
  }

  /* -------------------------------------------------------------- sign out */
  const accessSlot = h('div');
  api.get('/auth/status', { signal }).then((status) => {
    if (!status || !status.required || !status.authenticated) return;
    const btn = h('button', {
      type: 'button', class: 'btn',
      onClick: () => withBusy(btn, async () => {
        try {
          await api.post('/auth/logout', undefined, { signal });
        } catch (err) {
          if (!isAbort(err)) toast(err.message || 'Could not sign out', { kind: 'error' });
          return;
        }
        clearAllDrafts(); // the next person at this browser must not find unsent text in it
        app.navigate('/login');
      }),
    }, 'Sign out');
    mount(accessSlot, section({
      title: 'Access',
      description: 'This journal is protected by a password. Sign out on a shared computer when you are done. Signing out also removes any unsent draft that this browser keeps.',
      children: [h('div', null, btn)],
    }));
  }).catch(() => { /* optional card: no auth info, no card */ });

  /* ------------------------------------------------------------------- el */
  const el = h('div', { class: 'stack settings-data' },
    section({ title: 'What is stored', description: 'Everything below lives on this computer.', children: [statsBody] }),
    section({
      title: 'Export',
      description: 'Take your journal with you. JSON is complete and can be imported again; Markdown is easy to read anywhere. Settings and API keys are never included.',
      children: [h('div', { class: 'row' }, jsonBtn, mdBtn), exportMsg],
    }),
    section({
      title: 'Import',
      description: 'Restore from a JSON export. Entries, memories and reports are merged in; what you already have is left alone.',
      children: [h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Choose an export file'), fileInput, h('span', { class: 'field-hint' }, 'JSON files made by MyJournal, up to 50 MB.')), importOut],
    }),
    section({
      title: 'Where your data lives',
      children: [h('div', { class: 'stack-sm settings-prose' },
        h('h3', { class: 'settings-subtitle' }, 'Stored'),
        h('p', null, 'Your journal is one file, journal.db, in the data folder of the computer running MyJournal. Back it up by copying that folder while MyJournal is stopped, or use Export above.'),
        h('details', { class: 'settings-subdetails' },
          h('summary', null, 'Technical details'),
          h('p', { class: 'muted' }, 'The file is SQLite. The folder is ', h('code', { class: 'code' }, './data'), ' by default; set ', h('code', { class: 'code' }, 'JOURNAL_DATA_DIR'), ' to move it.')),
        h('h3', { class: 'settings-subtitle' }, 'Sent to the AI'),
        h('p', null, DATA_SENT_WITH_A_REPLY),
        h('p', null, DATA_SENT_WITH_AI_STEPS),
        h('h3', { class: 'settings-subtitle' }, 'API keys'),
        h('p', null, 'A key you paste in Settings is saved in that same file, unencrypted. If that matters to you, leave the key fields empty and start MyJournal with ', h('code', { class: 'code' }, 'GEMINI_API_KEY'), ', ', h('code', { class: 'code' }, 'OPENAI_API_KEY'), ' or ', h('code', { class: 'code' }, 'LOCAL_LLM_API_KEY'), ' set instead.'))],
    }),
    accessSlot,
    section({
      title: 'Delete everything', className: 'settings-danger',
      description: 'Remove all entries, messages, memories and reports from this computer, and any unsent drafts this browser keeps.',
      children: [h('div', { class: 'stack' },
        h('label', { class: 'check' }, alsoSettings, h('span', null, 'Also delete my settings and API keys')),
        h('div', null, wipeBtn))],
    }));

  loadStats();
  return {
    id: 'data',
    el,
    isDirty: () => false,
    save: async () => true,
    reset() {},
    sync() {},
    shown() { loadStats(); },
  };
}
