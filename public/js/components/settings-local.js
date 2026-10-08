// Extras for the "Local model" tab: Ollama quick start with copy-able commands, a small-model picker with
// size and quality notes, and "Download model" (POST /providers/local/pull, server-sent events) with a
// progress bar that can be cancelled.
import { h, mount } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { icon, toast, inlineCode } from '../lib/ui.js';
import { ollamaCommands, describeSmallModel, pullProgress, describePullFailure } from './settings-logic.js';
import { commandBlock, externalLink, notice, uid, handFocus } from './settings-ui.js';

/**
 * Build the three extra blocks of the Local tab and attach them to the provider form's slots.
 * @param {{ form: object, info: object, signal: AbortSignal }} opts `form` is the object returned by createProviderForm
 */
export function attachLocalExtras({ form, info, signal }) {
  form.slots.intro.append(buildQuickStart(form));
  form.slots.afterModel.append(buildPicker(form, info), buildDownload(form, signal));
}

/* ------------------------------------------------------------ quick start */
function buildQuickStart(form) {
  const pullSlot = h('div', { class: 'settings-quick-pull' });
  const paintPull = () => mount(pullSlot, commandBlock(ollamaCommands(form.getValues().model).pull, { label: 'download command' }));
  paintPull();
  form.onValues(paintPull);
  const cmds = ollamaCommands('');

  return h('details', { class: 'settings-quick', open: true },
    h('summary', null, icon('sparkles', { size: 16 }), 'Quick start with Ollama'),
    h('div', { class: 'settings-quick-body stack' },
      h('ol', { class: 'settings-steps' },
        h('li', null, 'Install Ollama from ', externalLink('https://ollama.com/download', 'ollama.com/download'), '. It is free and runs on Mac, Windows and Linux.'),
        h('li', null, 'Start it. Most installs start it for you; otherwise run:', commandBlock(cmds.serve, { label: 'start command' })),
        h('li', null, 'Download the model you picked below:', pullSlot),
        h('li', null, 'Press ', h('strong', null, 'Test connection'), ' at the bottom of this page.')),
      h('div', { class: 'settings-tip' },
        h('strong', null, 'Tip for longer conversations. '),
        'Ollama starts with a small memory window (about 2-4k tokens), so long entries may get cut off. Give it more before you start it:',
        commandBlock(cmds.context, { label: 'context length command' }),
        h('details', { class: 'settings-subdetails' },
          h('summary', null, 'On Windows (PowerShell)'),
          commandBlock(cmds.contextWindows, { label: 'PowerShell command' }))),
      h('p', { class: 'muted small' },
        'Using llama.cpp or LM Studio instead? Start its server, press its preset under Base URL, then Load models. ',
        'Downloading models from here only works with Ollama.')));
}

/* ----------------------------------------------------------- small models */
function buildPicker(form, info) {
  const groupName = uid('small-model');
  const models = info.suggestedModels || [];
  const cards = h('div', { class: 'settings-model-cards', role: 'radiogroup', 'aria-label': 'Small models to try' });
  const radios = new Map();
  const badges = new Map();

  for (const m of models) {
    const d = describeSmallModel(m);
    const radio = h('input', {
      type: 'radio', name: groupName, value: m.id, class: 'settings-model-radio',
      onChange: () => { if (radio.checked) form.setModel(m.id); },
    });
    const installed = h('span', { class: 'chip chip-primary settings-installed', hidden: true }, icon('check', { size: 12 }), 'Installed');
    radios.set(m.id, radio);
    badges.set(m.id, installed);
    cards.append(h('label', { class: 'settings-model-card' },
      radio,
      h('span', { class: 'settings-model-card-body' },
        h('span', { class: 'settings-model-card-head' },
          h('span', { class: 'settings-model-card-name' }, m.label || m.id),
          d.tier ? h('span', { class: 'badge' }, d.tier) : null,
          installed),
        h('span', { class: 'settings-model-card-id' }, m.id, d.size ? ` - ${d.size}` : ''),
        d.blurb ? h('span', { class: 'settings-model-card-note muted' }, d.blurb) : null)));
  }

  function paint() {
    const current = form.getValues().model.trim();
    const installed = new Set(form.getLoaded().map((x) => x.id));
    for (const [id, radio] of radios) radio.checked = id === current;
    for (const [id, badge] of badges) badge.hidden = !installed.has(id);
  }
  form.onValues(paint);
  form.onLoaded(paint);
  paint();

  return h('div', { class: 'settings-picker stack-sm' },
    h('h3', { class: 'settings-subtitle' }, 'Pick a small model'),
    h('p', { class: 'muted small' },
      '1B models are for testing the plumbing: they connect and reply, but the conversation stays basic. 3B and up feel noticeably more thoughtful. Bigger models need more memory.'),
    cards);
}

/* ---------------------------------------------------------------- download */
function buildDownload(form, signal) {
  let controller = null;
  const title = h('h3', { class: 'settings-subtitle' }, 'Download a model');
  const intro = h('p', { class: 'muted small' }, 'Fetches the model through your Ollama server. Models are 1 to 2 GB, so it can take a few minutes. Keep this page open while it downloads.');
  const dlBtn = h('button', { type: 'button', class: 'btn', onClick: () => start() });
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost', hidden: true, onClick: () => { if (controller) controller.abort(); } }, 'Cancel');
  const bar = h('progress', { class: 'settings-progress', max: 100, 'aria-label': 'Download progress' });
  const statusLine = h('p', { class: 'settings-progress-label' });
  const detailLine = h('p', { class: 'muted small settings-progress-detail' });
  const progressBox = h('div', { class: 'settings-progress-box', hidden: true }, statusLine, bar, detailLine);
  const outcome = h('div', { class: 'settings-download-outcome', 'aria-live': 'polite' });

  const modelName = () => form.getValues().model.trim();
  function paintButton() {
    const m = modelName();
    mount(dlBtn, icon('download', { size: 16 }), m ? `Download ${m}` : 'Download model');
    dlBtn.disabled = !m || Boolean(controller);
  }
  form.onValues(paintButton);
  paintButton();
  signal.addEventListener('abort', () => { if (controller) controller.abort(); }, { once: true });

  let frame = 0;
  let latest = null;
  function paintProgress() {
    frame = 0;
    if (!latest) return;
    const p = pullProgress(latest);
    statusLine.textContent = p.percent === null ? p.label : `${p.label} - ${Math.round(p.percent)}%`;
    detailLine.textContent = p.detail;
    if (p.percent === null) bar.removeAttribute('value'); else bar.value = p.percent;
  }

  function showFailure(err) {
    const f = describePullFailure(err);
    mount(outcome, notice({
      tone: err && err.code === 'not_ollama' ? 'warn' : 'error', role: 'alert',
      children: [h('strong', null, inlineCode(f.message)), h('p', { class: 'muted' }, inlineCode(f.hint))],
    }));
  }

  async function start() {
    const model = modelName();
    if (!model || controller) return;
    controller = new AbortController();
    latest = null;
    mount(outcome);
    cancelBtn.hidden = false;
    progressBox.hidden = false;
    statusLine.textContent = 'Starting the download';
    detailLine.textContent = '';
    bar.removeAttribute('value');
    handFocus(dlBtn, cancelBtn); // the Download button is about to be disabled
    paintButton();
    let done = false;
    let failed = false;
    try {
      const res = await api.stream('/providers/local/pull', { model, config: { baseUrl: form.getValues().baseUrl.trim() } }, {
        signal: controller.signal,
        onEvent(name, data) {
          if (name === 'progress') {
            latest = data;
            if (!frame) frame = requestAnimationFrame(paintProgress);
          } else if (name === 'done') {
            done = true;
          } else if (name === 'error') {
            failed = true;
            showFailure(data && data.error ? data.error : data);
          }
        },
      });
      if (res.aborted) {
        if (!signal.aborted) {
          mount(outcome, notice({ tone: 'info', role: 'status', children: [h('strong', null, 'Download cancelled'), h('p', { class: 'muted' }, 'Ollama keeps what it already fetched, so pressing Download again carries on from there.')] }));
        }
      } else if (done) {
        mount(outcome, notice({ tone: 'success', role: 'status', children: [h('strong', null, `${model} is ready`), h('p', { class: 'muted' }, 'Press Test connection to check it, then Use this provider.')] }));
        toast(`${model} downloaded`, { kind: 'success' });
        form.setModel(model);
        form.loadModels({ silent: true });
      } else if (!failed) {
        showFailure({ message: 'The download stopped before it finished.', hint: 'Check that Ollama is still running, then press Download to continue.' });
      }
    } catch (err) {
      showFailure(err instanceof ApiError ? err : { message: 'The download failed.', hint: '' });
    } finally {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      controller = null;
      paintButton();
      handFocus(cancelBtn, dlBtn); // Cancel is about to be hidden
      cancelBtn.hidden = true;
      progressBox.hidden = true;
    }
  }

  return h('div', { class: 'settings-download stack-sm' }, title, intro, h('div', { class: 'row' }, dlBtn, cancelBtn), progressBox, outcome);
}
