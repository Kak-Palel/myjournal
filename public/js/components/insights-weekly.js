// Weekly reflection card: generate a reflection (POST /insights/weekly, server-sent events), show the text as
// it streams, and list / copy / delete past reports. Everything AI-written goes through renderMarkdown().
import { h, mount } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { renderMarkdown } from '../lib/markdown.js';
import { icon, toast, confirmDialog, copyText } from '../lib/ui.js';
import { describeWeeklyFailure, reportMeta, reportPeriod, sortReports } from './insights-logic.js';
import { notice, withBusy } from './settings-ui.js';

const PERIODS = [
  { days: 7, label: 'Last 7 days' },
  { days: 14, label: 'Last 14 days' },
  { days: 30, label: 'Last 30 days' },
];

const isAbort = (err) => Boolean(err) && err.name === 'AbortError';

/**
 * @param {{ app: object, signal: AbortSignal, today: string }} opts
 * @returns {{ el: HTMLElement, load(): Promise<void>, hasReports(): boolean }}
 */
export function createWeeklyCard({ app, signal, today }) {
  let reports = [];
  let controller = null;
  let frame = 0;
  let text = '';

  const periodSelect = h('select', { class: 'select insights-period', id: 'insights-period' },
    PERIODS.map((p) => h('option', { value: p.days }, p.label)));
  const generateBtn = h('button', { type: 'button', class: 'btn btn-primary', onClick: () => start() }, icon('sparkles', { size: 16 }), 'Write my reflection');
  const stopBtn = h('button', { type: 'button', class: 'btn', hidden: true, onClick: () => { if (controller) controller.abort(); } }, icon('stop', { size: 16 }), 'Stop');
  const setupSlot = h('div');
  const controls = h('div', { class: 'insights-weekly-controls' },
    h('label', { class: 'sr-only', for: 'insights-period' }, 'Period to reflect on'), periodSelect, generateBtn, stopBtn);
  const streamStatus = h('p', { class: 'insights-stream-status', role: 'status' });
  const streamText = h('div', { class: 'insights-stream-text md', 'aria-live': 'off' });
  const streamBox = h('div', { class: 'insights-stream', hidden: true }, streamStatus, streamText);
  const failureSlot = h('div', { 'aria-live': 'polite' });
  const listHost = h('div', { class: 'insights-reports' });

  signal.addEventListener('abort', () => { if (controller) controller.abort(); }, { once: true });

  function paintSetup() {
    if (app.aiReady()) { mount(setupSlot); controls.hidden = false; return; }
    const ai = app.settings && app.settings.ai;
    const off = ai && !ai.enabled;
    mount(setupSlot, notice({
      tone: 'info',
      children: [
        h('strong', null, off ? 'The AI companion is switched off' : 'Set up an AI to write reflections'),
        h('p', { class: 'muted' }, 'Reflections are written by the model you choose. Everything else on this page works without AI.'),
        h('a', { class: 'btn btn-sm', href: off ? '#/settings?tab=general' : '#/settings' }, off ? 'Turn AI on' : 'Set up AI'),
      ],
    }));
    controls.hidden = true;
  }

  /* ----------------------------------------------------------------- list */
  function reportCard(report, { open = false } = {}) {
    const body = h('div', { class: 'insights-report-body md' }, renderMarkdown(report.content));
    const copyBtn = h('button', {
      type: 'button', class: 'btn btn-sm',
      onClick: async () => {
        const ok = await copyText(report.content);
        toast(ok ? 'Copied to the clipboard' : 'Could not copy', { kind: ok ? 'success' : 'error', timeout: 1800 });
      },
    }, icon('copy', { size: 14 }), 'Copy');
    const delBtn = h('button', { type: 'button', class: 'btn btn-sm btn-outline-danger', onClick: () => remove(report, delBtn) }, icon('trash', { size: 14 }), 'Delete');
    const meta = reportMeta(report);
    const summary = h('summary', { class: 'insights-report-summary', tabindex: '-1' },
      h('span', { class: 'insights-report-title' }, reportPeriod(report)),
      meta ? h('span', { class: 'insights-report-meta muted' }, meta) : null);
    return h('details', { class: 'insights-report', open, dataset: { id: report.id } },
      summary, body,
      h('div', { class: 'insights-report-actions row' }, copyBtn, delBtn));
  }

  function paintList({ focusId = '' } = {}) {
    if (!reports.length) {
      mount(listHost, h('p', { class: 'muted insights-no-reports' }, 'No reflections yet. Your first one will appear here and stay on this computer.'));
      return;
    }
    mount(listHost,
      h('h3', { class: 'insights-subtitle' }, 'Past reflections'),
      reports.map((r, i) => reportCard(r, { open: r.id === focusId || (!focusId && i === 0) })));
    if (focusId) {
      const el = listHost.querySelector(`[data-id="${CSS.escape(focusId)}"] summary`);
      if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); }
    }
  }

  async function remove(report, button) {
    const ok = await confirmDialog({
      title: 'Delete this reflection?', body: `The reflection for ${reportPeriod(report)} will be removed. Your entries are not touched.`,
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    await withBusy(button, async () => {
      try {
        await api.del(`/insights/reports/${encodeURIComponent(report.id)}`, { signal });
      } catch (err) {
        if (!isAbort(err)) toast(err.message || 'Could not delete it', { kind: 'error' });
        return;
      }
      reports = reports.filter((r) => r.id !== report.id);
      paintList();
      toast('Reflection deleted', { timeout: 2000 });
    });
  }

  /* ----------------------------------------------------------- generating */
  function paintStream() {
    frame = 0;
    mount(streamText, renderMarkdown(text));
  }

  function showFailure(err, { partial }) {
    const providerId = app.settings && app.settings.ai ? app.settings.ai.provider : '';
    const f = describeWeeklyFailure(err, providerId);
    mount(failureSlot, notice({
      tone: f.tone === 'error' ? 'error' : f.tone === 'warn' ? 'warn' : 'info',
      role: f.tone === 'error' ? 'alert' : 'status',
      children: [
        h('strong', null, f.message),
        f.hint ? h('p', { class: 'muted' }, f.hint) : null,
        partial ? h('p', { class: 'muted small' }, 'What was written before it stopped is shown below. It was not saved.') : null,
        h('div', { class: 'row' },
          f.action ? h('a', { class: 'btn btn-sm', href: f.action.href }, f.action.label) : null,
          f.retry ? h('button', { type: 'button', class: 'btn btn-sm', onClick: () => start() }, 'Try again') : null),
      ],
    }));
  }

  async function start() {
    if (controller) return;
    controller = new AbortController();
    text = '';
    mount(failureSlot);
    mount(streamText);
    streamBox.hidden = false;
    streamStatus.textContent = 'Reading your week and writing...';
    streamBox.classList.add('is-live');
    generateBtn.classList.add('is-loading');
    generateBtn.setAttribute('aria-busy', 'true');
    stopBtn.hidden = false;
    periodSelect.disabled = true;
    let report = null;
    let failure = null;
    try {
      const res = await api.stream('/insights/weekly', { today, days: Number(periodSelect.value) }, {
        signal: controller.signal,
        onEvent(name, data) {
          if (name === 'delta' && data && typeof data.text === 'string') {
            text += data.text;
            if (!frame) frame = requestAnimationFrame(paintStream);
          } else if (name === 'done') {
            report = data && data.report;
          } else if (name === 'error') {
            failure = (data && data.error) || { message: 'The reflection could not be written.' };
          } else if (name === 'notice' && data && data.kind === 'warn' && data.text) {
            toast(data.text);
          }
        },
      });
      if (res.aborted && !signal.aborted) failure = { code: 'stopped', message: 'Stopped', hint: 'Nothing was saved. Press the button to write one whenever you like.' };
    } catch (err) {
      if (!isAbort(err)) failure = err instanceof ApiError ? err : { message: 'The reflection could not be written.' };
    } finally {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      controller = null;
      generateBtn.classList.remove('is-loading');
      generateBtn.removeAttribute('aria-busy');
      stopBtn.hidden = true;
      periodSelect.disabled = false;
      streamBox.classList.remove('is-live');
    }
    if (signal.aborted) return;
    if (report && typeof report.id === 'string' && typeof report.content === 'string') {
      streamBox.hidden = true;
      mount(streamText);
      reports = sortReports([report, ...reports.filter((r) => r.id !== report.id)]);
      paintList({ focusId: report.id });
      toast('Your reflection is ready', { kind: 'success', timeout: 2500 });
    } else if (failure && failure.code === 'stopped') {
      streamBox.hidden = !text;
      streamStatus.textContent = 'Stopped. Nothing was saved.';
    } else if (failure) {
      streamBox.hidden = !text;
      streamStatus.textContent = text ? 'Stopped early' : '';
      showFailure(failure, { partial: Boolean(text) });
    } else {
      streamBox.hidden = true;
      showFailure({ code: 'unknown', message: 'The reflection ended before it was finished.', hint: 'Nothing was saved. Try again.' }, { partial: false });
    }
  }

  async function load() {
    try {
      const res = await api.get('/insights/reports', { signal });
      reports = sortReports(res && res.reports);
      paintList();
    } catch (err) {
      if (isAbort(err)) return;
      mount(listHost, notice({ tone: 'error', role: 'alert', children: [h('strong', null, err.message || 'Could not load your reflections'), err.hint ? h('p', { class: 'muted' }, err.hint) : null, h('button', { type: 'button', class: 'btn btn-sm', onClick: () => load() }, 'Try again')] }));
    }
  }

  paintSetup();
  const off = app.on('settings', paintSetup);
  signal.addEventListener('abort', off, { once: true });

  const el = h('section', { class: 'card insights-card insights-weekly', 'aria-labelledby': 'insights-weekly-title' },
    h('h2', { class: 'insights-card-title', id: 'insights-weekly-title' }, icon('sparkles', { size: 20 }), 'Weekly reflection'),
    h('p', { class: 'muted insights-card-sub' }, 'A short, kind look back, written by your AI companion from your recent entries. Private entries are never used.'),
    setupSlot,
    controls,
    failureSlot,
    streamBox,
    listHost);

  return { el, load, hasReports: () => reports.length > 0 };
}
