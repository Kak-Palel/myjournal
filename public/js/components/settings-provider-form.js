// One provider's settings form (Gemini, OpenAI-compatible or Local): API key, base URL, model, test,
// save. The same component renders all three tabs; copy and extras differ by provider id.
//
// Rules this component keeps:
//   * the saved API key is never prefilled or shown - only "Saved key ending ...abcd" from apiKeyHint;
//   * apiKey is sent only when the user typed one; "Remove saved key" sends null;
//   * "Test connection" and "Load models" send the *unsaved* form as an overlay so people can try first.
import { h, mount } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { icon, toast, confirmDialog, inlineCode, stripCode } from '../lib/ui.js';
import {
  buildProviderPatch, providerChanges, overlayConfig, connectionKey, mapProviderErrors, keyStatus, filterModels, mergeModelOptions,
  matchPreset, PRESET_HINTS, FALLBACK_PRESETS, nextSteps, hostKind, formatLatency, PROVIDER_NAMES,
} from './settings-logic.js';
import {
  fieldRow, withBusy, notice, commandBlock, externalLink, uid, focusFirstInvalid, clip, handFocus, setActionable,
} from './settings-ui.js';

const HERO_ICONS = { gemini: 'sparkles', openai: 'cloud', local: 'server' };
const PRIVACY_TONE = { gemini: 'warn', openai: 'info', local: 'success' };

const isAbort = (err) => Boolean(err) && err.name === 'AbortError';

/**
 * @param {object} opts
 * @param {object} opts.info provider row from GET /providers
 * @param {object} opts.app the app object from the view context
 * @param {AbortSignal} opts.signal aborts in-flight requests when the user leaves Settings
 * @param {() => void} [opts.onChange] called whenever dirty state changes
 * @param {(o: {activate: boolean}) => void} [opts.onSaved] called after a successful save (the setup banner listens)
 */
export function createProviderForm({ info, app, signal, onChange, onSaved }) {
  const id = info.id;
  const label = info.label || PROVIDER_NAMES[id] || id;
  const presets = Array.isArray(info.presets) && info.presets.length ? info.presets : (FALLBACK_PRESETS[id] || []);
  const saved = () => app.settings.ai.providers[id];
  const isActive = () => app.settings.ai.provider === id && app.settings.ai.enabled;

  /* in-flight request bookkeeping: everything is aborted when the user leaves the page */
  const pending = new Set();
  const newController = () => {
    const ctl = new AbortController();
    pending.add(ctl);
    return ctl;
  };
  signal.addEventListener('abort', () => pending.forEach((c) => c.abort()), { once: true });

  /* ------------------------------------------------------------ key field */
  const keyInput = h('input', {
    type: 'password', class: 'input settings-key-input', id: uid('key'), autocomplete: 'off', spellcheck: 'false',
    autocapitalize: 'off', 'data-lpignore': 'true', 'data-1p-ignore': 'true', onInput: () => touched(),
  });
  const reveal = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon settings-reveal', 'aria-label': 'Show API key', 'aria-pressed': 'false',
    onClick: () => {
      const show = keyInput.type === 'password';
      keyInput.type = show ? 'text' : 'password';
      reveal.setAttribute('aria-pressed', String(show));
      reveal.setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
      reveal.classList.toggle('is-on', show);
    },
  }, icon('eye', { size: 18 }));
  const keyStatusEl = h('p', { class: 'settings-keystatus', 'aria-live': 'polite' });
  const removeKeyBtn = h('button', { type: 'button', class: 'btn btn-sm btn-outline-danger settings-remove-key', onClick: () => removeSavedKey() }, 'Remove saved key');
  const keyRow = fieldRow({
    label: 'API key',
    optional: !info.needsKey,
    input: keyInput,
    control: h('div', { class: 'stack-sm' },
      h('div', { class: 'settings-key-wrap' }, keyInput, reveal),
      h('div', { class: 'settings-keyline' }, keyStatusEl, removeKeyBtn)),
    hint: 'Kept in your local journal database, unencrypted. Prefer environment variables? Leave this empty.',
  });

  /* ------------------------------------------------------------- base URL */
  const urlInput = h('input', {
    type: 'text', class: 'input', id: uid('url'), inputmode: 'url', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off',
    placeholder: info.defaultBaseUrl || 'https://', onInput: () => touched(),
  });
  const presetBar = presets.length
    ? h('div', { class: 'settings-presets', role: 'group', 'aria-label': 'Base URL presets' },
      presets.map((p) => h('button', {
        type: 'button', class: 'settings-pill', dataset: { preset: p.id }, 'aria-pressed': 'false',
        onClick: () => { urlInput.value = p.baseUrl; touched(); urlInput.focus(); },
      }, p.label)))
    : null;
  const presetNote = h('p', { class: 'field-hint settings-preset-note', hidden: true });
  const urlWarn = h('div', { class: 'settings-urlwarn', role: 'status', hidden: true });
  const defaultUrlBtn = h('button', {
    type: 'button', class: 'link-btn settings-default-link', hidden: true,
    onClick: () => { urlInput.value = info.defaultBaseUrl; touched(); },
  }, 'Use the default address');
  const urlRow = fieldRow({
    label: 'Base URL',
    input: urlInput,
    control: h('div', { class: 'stack-sm' }, presetBar, urlInput, presetNote, urlWarn, defaultUrlBtn),
    hint: id === 'local'
      ? 'Where your model server listens. It must speak the OpenAI API - Ollama, llama.cpp and LM Studio all do.'
      : id === 'openai'
        ? 'Usually ends in /v1. MyJournal adds /chat/completions for you.'
        : 'Only change this if you use a proxy.',
  });

  /* ---------------------------------------------------------------- model */
  const listId = uid('models');
  const datalist = h('datalist', { id: listId });
  const modelInput = h('input', {
    type: 'text', class: 'input', id: uid('model'), list: listId, autocomplete: 'off', spellcheck: 'false',
    autocapitalize: 'off', placeholder: info.defaultModel || '', onInput: () => { touched(); renderModelList(); },
  });
  const loadBtn = h('button', { type: 'button', class: 'btn btn-sm', onClick: () => withBusy(loadBtn, () => loadModels()) }, icon('refresh', { size: 16 }), 'Load models');
  const suggestionBar = info.id === 'local' || !(info.suggestedModels || []).length
    ? null
    : h('div', { class: 'settings-suggest' },
      h('span', { class: 'settings-suggest-label muted small' }, 'Suggested'),
      h('div', { class: 'settings-presets', role: 'group', 'aria-label': 'Suggested models' },
        info.suggestedModels.map((m) => h('button', {
          type: 'button', class: 'settings-pill', dataset: { model: m.id }, 'aria-pressed': 'false',
          title: m.note ? `${m.label || m.id} - ${m.note}` : (m.label || m.id),
          onClick: () => setModel(m.id, { focus: true }),
        }, h('span', { class: 'settings-pill-main' }, m.id), m.note ? h('span', { class: 'settings-pill-note' }, m.note) : null))));
  const loadedBox = h('div', { class: 'settings-models', hidden: true });
  const loadedStatus = h('p', { class: 'field-hint', role: 'status', hidden: true });
  const modelRow = fieldRow({
    label: 'Model',
    input: modelInput,
    control: h('div', { class: 'stack-sm' },
      h('div', { class: 'settings-model-line' }, modelInput, loadBtn),
      suggestionBar, loadedStatus, loadedBox, datalist),
    hint: id === 'gemini' ? 'The default is fast and has the most generous free allowance.'
      : id === 'local' ? 'The exact name your server uses, for example llama3.2:3b.'
        : 'The model name your service uses. Press Load models to see what is available.',
  });

  /* --------------------------------------------------------- gemini extra */
  let thinkingSelect = null;
  let thinkingRow = null;
  if (id === 'gemini') {
    thinkingSelect = h('select', { class: 'select', id: uid('thinking'), onChange: () => touched() },
      h('option', { value: 'auto' }, 'Auto (recommended)'),
      h('option', { value: 'low' }, 'Low - faster replies'));
    thinkingRow = fieldRow({
      label: 'Thinking',
      input: thinkingSelect,
      hint: 'Newer Gemini models can "think" before answering. Low asks them to think less, which makes replies quicker.',
    });
  }

  /* ----------------------------------------------------------- actions/UI */
  const testBtn = h('button', { type: 'button', class: 'btn', onClick: () => withBusy(testBtn, runTest) }, icon('check', { size: 16 }), 'Test connection');
  const saveBtn = h('button', { type: 'submit', class: 'btn' }, 'Save');
  const useBtn = h('button', { type: 'button', class: 'btn btn-primary', onClick: () => withBusy(useBtn, () => save({ activate: true })) }, 'Use this provider');
  const revertBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', hidden: true, onClick: () => reset() }, 'Revert');
  const dirtyEl = h('span', { class: 'settings-dirty', role: 'status', hidden: true }, h('span', { class: 'settings-dirty-dot', 'aria-hidden': 'true' }), 'Unsaved changes');
  const resultEl = h('div', { class: 'settings-result', 'aria-live': 'polite' });
  const summaryEl = h('div', { class: 'settings-summary', hidden: true });
  const chipsEl = h('div', { class: 'settings-hero-chips' });

  /* ------------------------------------------------------------ the layout */
  const slots = {
    intro: h('div', { class: 'stack' }),
    afterModel: h('div', { class: 'stack' }),
  };
  const advanced = id === 'gemini'
    ? h('details', { class: 'settings-advanced' },
      h('summary', null, 'Advanced'),
      h('div', { class: 'stack' }, urlRow.el, thinkingRow.el))
    : null;

  const privacy = notice({
    tone: PRIVACY_TONE[id] || 'info',
    iconName: id === 'local' ? 'lock' : 'shield',
    children: [h('strong', null, 'Privacy'), h('p', null, info.privacyNote || 'Your journal text is sent to this provider when the AI replies.')],
  });
  privacy.classList.add('settings-privacy');

  const keyGuide = info.keyUrl
    ? h('div', { class: 'settings-keyguide' },
      h('h3', { class: 'settings-subtitle' }, 'Get a free key'),
      h('ol', { class: 'settings-steps' },
        h('li', null, 'Open ', externalLink(info.keyUrl, 'Google AI Studio'), ' and sign in with a Google account.'),
        h('li', null, 'Choose ', h('strong', null, 'Create API key'), '.'),
        h('li', null, 'Copy the key and paste it below.')))
    : null;

  const form = h('form', {
    class: 'settings-provider-form stack', novalidate: true, autocomplete: 'off',
    onSubmit: (e) => { e.preventDefault(); if (isDirty()) withBusy(saveBtn, () => save()); },
  },
  h('div', { class: 'settings-hero' },
    h('span', { class: 'settings-hero-icon', 'aria-hidden': 'true' }, icon(HERO_ICONS[id] || 'sparkles', { size: 24 })),
    h('div', { class: 'grow' },
      h('h2', { class: 'settings-hero-title' }, label),
      h('p', { class: 'settings-hero-tagline muted' }, info.tagline || '')),
    chipsEl),
  info.description ? h('p', { class: 'settings-desc' }, info.description) : null,
  privacy,
  keyGuide,
  slots.intro,
  summaryEl,
  h('div', { class: 'settings-fields stack' },
    id === 'local' ? null : keyRow.el,
    advanced ? null : urlRow.el,
    modelRow.el,
    slots.afterModel,
    id === 'local' ? keyRow.el : null,
    advanced),
  h('div', { class: 'settings-actions' },
    h('div', { class: 'row' }, testBtn, saveBtn, useBtn),
    h('div', { class: 'row settings-actions-state' }, dirtyEl, revertBtn)),
  resultEl);

  /* ------------------------------------------------------------- behaviour */
  let loaded = [];
  let loadedAddr = '';
  let triedAutoLoad = false;
  let lastDirty = null;
  const valueListeners = new Set();
  const loadedListeners = new Set();

  const values = () => ({
    baseUrl: urlInput.value,
    model: modelInput.value,
    apiKey: keyInput.value,
    thinking: thinkingSelect ? thinkingSelect.value : undefined,
  });
  const isDirty = () => Object.keys(providerChanges(values(), saved(), id)).length > 0;
  const address = () => urlInput.value.trim().replace(/\/+$/, '');

  /** A model list belongs to the server it came from: once the address is edited it must not linger as if it applied. */
  function dropStaleModels() {
    if (!loaded.length || address() === loadedAddr) return;
    loaded = [];
    loadedStatus.hidden = true;
    renderDatalist();
    renderModelList();
    for (const fn of loadedListeners) fn(loaded);
  }

  function renderDatalist() {
    mount(datalist, ...mergeModelOptions(info.suggestedModels, loaded).map((m) => h('option', { value: m.id }, m.label !== m.id ? m.label : '')));
  }

  function renderModelList() {
    if (!loaded.length) { loadedBox.hidden = true; return; }
    const query = modelInput.value.trim();
    // A complete, exact model name should not hide the alternatives: show everything in that case.
    const exact = loaded.some((m) => m.id === query);
    let view = filterModels(loaded, exact ? '' : query);
    let title = view.shown.length + view.hidden === view.total ? `${view.total} ${view.total === 1 ? 'model' : 'models'} on this server - pick one` : `${view.shown.length + view.hidden} of ${view.total} match what you typed`;
    if (!view.shown.length) {
      view = filterModels(loaded, '');
      title = `No match for "${query.slice(0, 40)}". All ${view.total} models:`;
    }
    loadedBox.hidden = false;
    mount(loadedBox,
      h('p', { class: 'settings-models-title muted small' }, title),
      h('ul', { class: 'settings-models-list' }, view.shown.map((m) => h('li', null, h('button', {
        type: 'button', class: 'settings-model-btn', 'aria-pressed': String(m.id === query),
        onClick: () => setModel(m.id, { focus: false }),
      }, h('span', { class: 'settings-model-id' }, m.id), m.label && m.label !== m.id ? h('span', { class: 'settings-model-label muted' }, m.label) : null)))),
      view.hidden ? h('p', { class: 'muted small' }, `...and ${view.hidden} more. Keep typing to narrow the list.`) : null);
  }

  function paintPills() {
    const model = modelInput.value.trim();
    if (suggestionBar) {
      for (const btn of suggestionBar.querySelectorAll('[data-model]')) btn.setAttribute('aria-pressed', String(btn.dataset.model === model));
    }
    const preset = matchPreset(presets, urlInput.value);
    if (presetBar) {
      for (const btn of presetBar.querySelectorAll('[data-preset]')) {
        const on = Boolean(preset) && btn.dataset.preset === preset.id;
        btn.setAttribute('aria-pressed', String(on));
        btn.classList.toggle('is-active', on);
      }
    }
    const note = preset ? PRESET_HINTS[preset.id] : '';
    presetNote.textContent = note || '';
    presetNote.hidden = !note;
    defaultUrlBtn.hidden = !info.defaultBaseUrl || urlInput.value.trim().replace(/\/+$/, '') === info.defaultBaseUrl.replace(/\/+$/, '');
    if (id === 'local') {
      const kind = hostKind(urlInput.value);
      let message = '';
      if (kind === 'remote') message = `This address is not on your computer. Your journal text will travel over the internet to ${safeHost(urlInput.value)}.`;
      else if (kind === 'private') message = `This address is another device on your network (${safeHost(urlInput.value)}). Your journal text will be sent there.`;
      else if (kind === 'invalid' && urlInput.value.trim()) message = 'This does not look like a web address yet. It should start with http:// or https://.';
      mount(urlWarn, message ? icon('alert', { size: 16 }) : '', message);
      urlWarn.hidden = !message;
    }
  }

  function safeHost(url) {
    try { return new URL(url.trim()).host; } catch { return 'that host'; }
  }

  function paintKeyStatus() {
    const st = keyStatus(saved(), id);
    keyInput.placeholder = st.placeholder;
    mount(keyStatusEl, icon(st.kind === 'saved' ? 'check' : st.kind === 'env' ? 'info' : 'key', { size: 16 }), st.text);
    keyStatusEl.dataset.kind = st.kind;
    if (!st.canRemove) handFocus(removeKeyBtn, keyInput);
    removeKeyBtn.hidden = !st.canRemove;
  }

  function paintChips() {
    const st = keyStatus(saved(), id);
    mount(chipsEl,
      isActive() ? h('span', { class: 'chip chip-primary' }, icon('check', { size: 14 }), 'In use') : null,
      id === 'local' ? h('span', { class: 'chip' }, 'No key needed') : st.kind !== 'none' ? h('span', { class: 'chip' }, st.kind === 'env' ? 'Key from environment' : 'Key saved') : h('span', { class: 'chip chip-warn' }, 'Needs a key'));
  }

  function paintButtons() {
    const dirty = isDirty();
    const active = isActive();
    // Save is dimmed, not disabled: a disabled button would drop the focus of someone who just pressed it.
    setActionable(saveBtn, dirty);
    saveBtn.classList.toggle('btn-primary', active && dirty);
    if (active) handFocus(useBtn, testBtn);
    useBtn.hidden = active;
    dirtyEl.hidden = !dirty;
    if (!dirty) handFocus(revertBtn, saveBtn);
    revertBtn.hidden = !dirty;
    if (lastDirty !== dirty) { lastDirty = dirty; if (onChange) onChange(); }
  }

  function touched() {
    dropStaleModels();
    paintPills();
    paintButtons();
    resultEl.querySelector('.settings-result-card')?.classList.add('is-stale');
    for (const fn of valueListeners) fn(values());
  }

  function setModel(value, { focus = false } = {}) {
    modelInput.value = value;
    modelRow.setError('');
    renderModelList();
    touched();
    if (focus) modelInput.focus();
  }

  /**
   * Show the saved settings in the form. After a save, `submitted` is what was sent: a field the person has changed
   * since then (they kept typing while the request was in flight) is newer than the saved value and is left alone,
   * so it still shows as an unsaved change instead of being silently overwritten.
   */
  function applySaved(submitted) {
    const s = saved();
    const typedSince = (input, key) => Boolean(submitted) && input.value !== submitted[key];
    if (!typedSince(urlInput, 'baseUrl')) urlInput.value = s.baseUrl || '';
    if (!typedSince(modelInput, 'model')) modelInput.value = s.model || '';
    if (!typedSince(keyInput, 'apiKey')) {
      keyInput.value = '';
      keyInput.type = 'password';
      reveal.setAttribute('aria-pressed', 'false');
      reveal.setAttribute('aria-label', 'Show API key');
      reveal.classList.remove('is-on');
    }
    if (thinkingSelect && !typedSince(thinkingSelect, 'thinking')) thinkingSelect.value = s.thinking === 'low' ? 'low' : 'auto';
    dropStaleModels();
    paintKeyStatus();
    paintChips();
    paintPills();
    renderModelList();
    paintButtons();
    for (const fn of valueListeners) fn(values());
  }

  function clearErrors() {
    for (const row of [keyRow, urlRow, modelRow, thinkingRow]) if (row) row.setError('');
    summaryEl.hidden = true;
    mount(summaryEl);
  }

  function reset() {
    clearErrors();
    mount(resultEl);
    applySaved();
  }

  function showSaveErrors(err) {
    const mapped = mapProviderErrors(err.fields, id);
    keyRow.setError(mapped.apiKey || '');
    urlRow.setError(mapped.baseUrl || '');
    modelRow.setError(mapped.model || '');
    if (thinkingRow) thinkingRow.setError(mapped.thinking || '');
    if (advanced && (mapped.baseUrl || mapped.thinking)) advanced.open = true;
    const extra = mapped.other;
    summaryEl.hidden = false;
    mount(summaryEl, notice({
      tone: 'error', role: 'alert',
      children: [h('strong', null, err.message || 'Some settings need another look'), err.hint ? h('p', { class: 'muted' }, inlineCode(err.hint)) : null,
        extra.length ? h('ul', { class: 'settings-error-list' }, extra.map((t) => h('li', null, t))) : null],
    }));
    if (!focusFirstInvalid(form)) summaryEl.scrollIntoView({ block: 'nearest' });
  }

  /** Save the form. With `activate`, also make this the provider the journal uses. Resolves true on success. */
  async function save({ activate = false } = {}) {
    clearErrors();
    const submitted = values();
    const patch = buildProviderPatch(id, submitted, saved(), { activate });
    if (!patch) return true;
    try {
      await app.saveSettings(patch);
    } catch (err) {
      if (isAbort(err)) return false;
      if (err instanceof ApiError && err.fields) showSaveErrors(err);
      else {
        summaryEl.hidden = false;
        mount(summaryEl, notice({ tone: 'error', role: 'alert', children: [h('strong', null, err.message || 'Could not save'), err.hint ? h('p', { class: 'muted' }, inlineCode(err.hint)) : null] }));
      }
      return false;
    }
    applySaved(submitted);
    toast(activate ? `Now using ${PROVIDER_NAMES[id] || label}` : 'Saved', { kind: 'success', timeout: 2200 });
    if (onSaved) onSaved({ activate });
    return true;
  }

  async function removeSavedKey() {
    const ok = await confirmDialog({
      title: 'Remove the saved key?',
      body: `MyJournal will forget the key it stored for ${PROVIDER_NAMES[id] || label}. You can paste it again whenever you like.`,
      confirmLabel: 'Remove key',
      danger: true,
    });
    if (!ok) return;
    await withBusy(removeKeyBtn, async () => {
      try {
        await app.saveSettings({ ai: { providers: { [id]: { apiKey: null } } } });
      } catch (err) {
        toast(err.message || 'Could not remove the key', { kind: 'error' });
        return;
      }
      paintKeyStatus(); // a key the user has typed but not saved stays in the field
      paintChips();
      paintButtons();
      toast('Saved key removed', { kind: 'success', timeout: 2200 });
    });
  }

  async function loadModels({ silent = false } = {}) {
    const ctl = newController();
    const started = connectionKey(values(), { model: false });
    if (!silent) { loadedStatus.hidden = true; loadedStatus.classList.remove('is-error'); }
    try {
      const res = await api.post('/providers/models', { provider: id, config: overlayConfig(values()) }, { signal: ctl.signal });
      if (connectionKey(values(), { model: false }) !== started) {
        // The answer describes the address / key that were on screen when the request started, not these.
        if (!silent) {
          loadedStatus.hidden = false;
          loadedStatus.textContent = 'The address or key changed while the list was loading. Press Load models again.';
        }
        return [];
      }
      if (!res || res.ok === false) {
        if (!silent) showLoadError(res && res.error);
        return [];
      }
      loaded = Array.isArray(res.models) ? res.models.filter((m) => m && typeof m.id === 'string') : [];
      loadedAddr = address();
      renderDatalist();
      renderModelList();
      if (!silent) {
        loadedStatus.hidden = false;
        loadedStatus.textContent = loaded.length ? `Found ${loaded.length} ${loaded.length === 1 ? 'model' : 'models'}.` : 'The server answered but lists no models yet.';
      }
      for (const fn of loadedListeners) fn(loaded);
      return loaded;
    } catch (err) {
      if (isAbort(err)) return [];
      if (!silent && connectionKey(values(), { model: false }) === started) showLoadError(err);
      return [];
    } finally {
      pending.delete(ctl);
    }
  }

  function showLoadError(err) {
    loadedStatus.hidden = false;
    loadedStatus.classList.add('is-error');
    const message = clip((err && err.message) || 'Could not load the model list.');
    mount(loadedStatus, icon('alert', { size: 14 }), ` ${stripCode(message)}`, err && err.hint ? ` ${stripCode(clip(err.hint))}` : '');
  }

  function keyMissing() {
    return info.needsKey && !keyInput.value.trim() && !saved().apiKeySet;
  }

  async function runTest() {
    clearErrors();
    if (keyMissing()) {
      keyRow.setError('Paste your API key first, then test.');
      keyInput.focus();
      return;
    }
    const ctl = newController();
    const started = connectionKey(values());
    mount(resultEl, h('div', { class: 'settings-result-card settings-testing', role: 'status' }, h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }), ' Contacting the model...'));
    try {
      const res = await api.post('/providers/test', { provider: id, config: overlayConfig(values()) }, { signal: ctl.signal });
      renderResult(res, { stale: connectionKey(values()) !== started });
    } catch (err) {
      if (isAbort(err)) return;
      renderResult({ ok: false, error: { code: err.code, message: err.message, hint: err.hint }, fromApp: true }, { stale: connectionKey(values()) !== started });
    } finally {
      pending.delete(ctl);
    }
  }

  /**
   * @param {object} res the /providers/test answer
   * @param {{ stale?: boolean }} [opts] `stale`: the connection fields were edited while the request was running, so the
   *   answer is about settings that are no longer on screen. It is shown dimmed, without any "looks good" advice.
   */
  function renderResult(res, { stale = false } = {}) {
    const card = (body) => h('div', { class: ['settings-result-card', stale ? 'is-stale' : ''] }, body);
    const staleNote = stale ? h('p', { class: 'muted settings-stale-note' }, 'You changed these settings while the test was running. Test again to check the new ones.') : null;
    if (res && res.ok) {
      const meta = [res.model, formatLatency(res.latencyMs)].filter(Boolean).join(' - ');
      const follow = stale ? '' : isDirty() ? 'Looks good. Press Save to keep these settings.' : isActive() ? '' : 'Looks good. Press "Use this provider" to start journaling with it.';
      mount(resultEl, card(notice({
        tone: 'success', role: 'status',
        children: [
          h('strong', null, 'Connected'),
          meta ? h('p', { class: 'settings-result-meta' }, meta) : null,
          res.sample ? h('blockquote', { class: 'settings-sample' }, res.sample) : h('p', { class: 'muted' }, 'The model answered with an empty message, which can be normal for reasoning models.'),
          follow ? h('p', { class: 'muted' }, follow) : null,
        ],
      })), staleNote);
      return;
    }
    const err = (res && res.error) || {};
    const steps = res && res.fromApp ? [] : nextSteps(id, err.code, { model: modelInput.value });
    mount(resultEl, card(notice({
      tone: 'error', role: 'alert',
      children: [
        h('strong', null, inlineCode(clip(err.message) || 'The connection test failed')),
        err.hint ? h('p', null, inlineCode(clip(err.hint))) : null,
        steps.length
          ? h('div', { class: 'settings-steps-box' },
            h('p', { class: 'settings-steps-title' }, 'Things to try'),
            h('ul', { class: 'settings-tryList' }, steps.map((st) => h('li', null, st.text, st.command ? commandBlock(st.command) : null))))
          : null,
        err.code ? h('p', { class: 'small muted' }, 'Error code: ', h('span', { class: 'badge' }, err.code)) : null,
      ],
    })), staleNote);
  }

  /* ------------------------------------------------------------ public api */
  applySaved();
  renderDatalist();

  return {
    id,
    el: form,
    slots,
    isDirty,
    save,
    reset,
    loadModels,
    getValues: values,
    getLoaded: () => loaded,
    setModel,
    onValues(fn) { valueListeners.add(fn); },
    onLoaded(fn) { loadedListeners.add(fn); },
    /** App settings changed elsewhere: refresh status text; refresh inputs too unless the user is mid-edit. */
    sync() {
      paintKeyStatus();
      paintChips();
      if (!isDirty()) applySaved(); else paintButtons();
    },
    /** The tab became visible. The local tab quietly looks for installed models once. */
    shown() {
      if (id === 'local' && !triedAutoLoad) {
        triedAutoLoad = true;
        loadModels({ silent: true });
      }
    },
    focusFirst() { (id === 'local' ? modelInput : keyInput).focus(); },
  };
}
