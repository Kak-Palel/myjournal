// "General" tab: who you are, the companion's style, AI on/off and tuning, and the theme.
// Saved through app.saveSettings(patch); server field errors (ApiError.fields) are shown next to the field.
import { h, mount } from '../lib/dom.js';
import { ApiError } from '../lib/api.js';
import { icon, toast, skeleton, inlineCode } from '../lib/ui.js';
import { setTheme, getTheme } from '../app.js';
import {
  LIMITS, TEMPERATURE_STEP, clampNumber, buildGeneralPatch, mapGeneralErrors, temperatureWord, personaChoices,
} from './settings-logic.js';
import {
  fieldRow, switchControl, textareaWithCounter, notice, section, uid, withBusy, focusFirstInvalid, handFocus, setActionable,
} from './settings-ui.js';

const THEME_CHOICES = [
  { id: 'auto', label: 'Match my device', icon: 'sparkles' },
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
];

/**
 * @param {{ app: object, signal: AbortSignal, onChange?: () => void }} opts
 */
export function createGeneralPanel({ app, signal, onChange }) {
  const S = () => app.settings;

  /* ------------------------------------------------------------- profile */
  const nameInput = h('input', {
    type: 'text', class: 'input', id: uid('name'), maxlength: LIMITS.nameMax, autocomplete: 'given-name', placeholder: 'What should your companion call you?',
    onInput: touched,
  });
  const nameRow = fieldRow({ label: 'Your name', input: nameInput, hint: 'Used in greetings and by your companion. Optional.' });

  const about = textareaWithCounter({
    max: LIMITS.aboutMax, rows: 4, onInput: touched,
    placeholder: 'For example: I am a nurse working night shifts. I am trying to sleep better and be kinder to myself.',
  });
  const aboutRow = fieldRow({ label: 'About you', input: about.textarea, control: about.el, hint: 'Things your companion should know. It reads this before every reply.' });

  /* ------------------------------------------------------------- persona */
  const personaGroup = h('div', { class: 'settings-persona-cards', role: 'radiogroup', 'aria-label': 'Companion style' }, skeleton(3));
  const personaName = uid('persona');
  const personaRadios = new Map();
  const custom = textareaWithCounter({
    max: LIMITS.customMax, rows: 5, onInput: touched,
    placeholder: 'For example: Speak like a calm old friend. Be brief, ask about feelings before facts, and never rush to fix things.',
  });
  const customRow = fieldRow({
    label: 'Your own style', input: custom.textarea, control: custom.el,
    hint: 'Leave empty to use the default Companion voice. Safety rules and short replies still apply.',
    className: 'settings-custom-persona',
  });
  customRow.el.hidden = true;
  const personaError = h('p', { class: 'field-error', role: 'alert', hidden: true });

  function renderPersonas(personas) {
    const choices = personaChoices(personas);
    personaRadios.clear();
    mount(personaGroup, ...choices.map((p) => {
      const radio = h('input', {
        type: 'radio', name: personaName, value: p.id, class: 'settings-persona-radio',
        onChange: () => { if (radio.checked) { currentPersona = p.id; paintPersona(); touched(); } },
      });
      personaRadios.set(p.id, radio);
      return h('label', { class: 'settings-persona-card' }, radio,
        h('span', { class: 'settings-persona-body' },
          h('span', { class: 'settings-persona-name' }, p.name),
          h('span', { class: 'settings-persona-desc muted' }, p.description)));
    }));
    paintPersona();
  }

  let currentPersona = 'companion';
  function paintPersona() {
    for (const [id, radio] of personaRadios) radio.checked = id === currentPersona;
    customRow.el.hidden = currentPersona !== 'custom';
  }

  /* ------------------------------------------------------------------ AI */
  const enabledSwitch = switchControl({
    label: 'Use the AI companion', hint: 'Turn off for a plain, private journal with no AI at all.', onChange: () => touched(),
  });

  const tempInput = h('input', {
    type: 'range', class: 'range', id: uid('temp'), min: LIMITS.temperature.min, max: LIMITS.temperature.max, step: TEMPERATURE_STEP,
    onInput: () => { paintTemp(); touched(); },
  });
  const tempOut = h('output', { class: 'settings-temp-out', for: tempInput.id });
  const tempRow = fieldRow({
    label: 'Creativity',
    input: tempInput,
    control: h('div', { class: 'settings-range' },
      h('div', { class: 'settings-range-line' }, h('span', { class: 'muted small' }, 'Focused'), tempInput, h('span', { class: 'muted small' }, 'Creative')),
      tempOut),
    hint: 'Lower is steadier and more predictable. Higher is more surprising. 0.7 suits most people.',
  });
  function paintTemp() {
    const v = Number(tempInput.value);
    tempOut.textContent = `${v.toFixed(2)} - ${temperatureWord(v)}`;
    tempInput.setAttribute('aria-valuetext', `${v.toFixed(2)}, ${temperatureWord(v)}`);
  }

  const numberInput = (limits, step) => h('input', {
    type: 'number', class: 'input', id: uid('num'), min: limits.min, max: limits.max, step, inputmode: 'numeric', onInput: touched,
  });
  const tokensInput = numberInput(LIMITS.maxTokens, 50);
  const ctxInput = numberInput(LIMITS.contextBudgetTokens, 250);
  const timeoutInput = numberInput(LIMITS.timeoutSec, 5);
  const tokensRow = fieldRow({
    label: 'Longest reply (tokens)', input: tokensInput,
    hint: `Caps how long one reply can be. A token is about three quarters of a word. ${LIMITS.maxTokens.min} to ${LIMITS.maxTokens.max}.`,
  });
  const ctxRow = fieldRow({
    label: 'Context budget (tokens)', input: ctxInput,
    hint: 'How much of your conversation and memories is sent with each message. Small local models often only have a 2,000 to 4,000 token window in total, so keep this around 1,500 to 2,500 for them. Cloud models can take 8,000 or more.',
  });
  const timeoutRow = fieldRow({
    label: 'Wait for the first word (seconds)', input: timeoutInput,
    hint: 'How long to wait before giving up. Local models are slow on the very first request while they load, so give them a minute or two.',
  });
  const baseHints = new Map([[tokensRow, tokensRow.input], [ctxRow, ctxRow.input], [timeoutRow, timeoutRow.input]]);
  const tuning = h('details', { class: 'settings-advanced' },
    h('summary', null, 'Reply length, context and timeout'),
    h('div', { class: 'stack' }, tokensRow.el, ctxRow.el, timeoutRow.el));

  /* --------------------------------------------------------------- theme */
  const themeName = uid('theme');
  const themeRadios = new Map();
  const themeGroup = h('div', { class: 'settings-theme', role: 'radiogroup', 'aria-label': 'Theme' },
    THEME_CHOICES.map((t) => {
      const radio = h('input', {
        type: 'radio', name: themeName, value: t.id, class: 'settings-theme-radio',
        onChange: () => { if (radio.checked) setTheme(t.id); },
      });
      themeRadios.set(t.id, radio);
      return h('label', { class: 'settings-theme-option' }, radio, h('span', { class: 'settings-theme-face' }, icon(t.icon, { size: 18 }), t.label));
    }));

  /* ---------------------------------------------------------------- foot */
  const summaryEl = h('div', { class: 'settings-summary', hidden: true });
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save changes');
  const revertBtn = h('button', { type: 'button', class: 'btn btn-ghost', hidden: true, onClick: () => reset() }, 'Revert');
  const dirtyEl = h('span', { class: 'settings-dirty', role: 'status', hidden: true }, h('span', { class: 'settings-dirty-dot', 'aria-hidden': 'true' }), 'Unsaved changes');

  const form = h('form', {
    class: 'stack settings-general', novalidate: true,
    onSubmit: (e) => { e.preventDefault(); if (isDirty()) withBusy(saveBtn, () => save()); },
  },
  section({
    title: 'About you', description: 'Your companion uses this to feel like it knows you. It stays on this computer; only the AI provider you pick ever sees it.',
    children: [h('div', { class: 'stack' }, nameRow.el, aboutRow.el)],
  }),
  section({
    title: 'Companion style', description: 'How your companion talks to you. You can change it any time.',
    children: [h('div', { class: 'stack' }, personaGroup, personaError, customRow.el)],
  }),
  section({
    title: 'AI', children: [h('div', { class: 'stack' }, enabledSwitch.el, tempRow.el, tuning)],
  }),
  section({
    title: 'Appearance', description: 'Applies right away. It is remembered on this device only.', children: [themeGroup],
  }),
  summaryEl,
  h('div', { class: 'settings-actions settings-actions-sticky' },
    h('div', { class: 'row' }, saveBtn, revertBtn),
    h('div', { class: 'row settings-actions-state' }, dirtyEl)));

  /* ------------------------------------------------------------ behaviour */
  const numberOf = (input, limits, integer, fallback) => {
    const r = clampNumber(input.value, limits, { integer });
    return r ? r.value : fallback;
  };

  function values() {
    const s = S();
    return {
      name: nameInput.value,
      about: about.textarea.value,
      persona: currentPersona,
      custom: custom.textarea.value,
      enabled: enabledSwitch.input.checked,
      temperature: numberOf(tempInput, LIMITS.temperature, false, s.ai.temperature),
      maxTokens: numberOf(tokensInput, LIMITS.maxTokens, true, s.ai.maxTokens),
      contextBudgetTokens: numberOf(ctxInput, LIMITS.contextBudgetTokens, true, s.ai.contextBudgetTokens),
      timeoutSec: numberOf(timeoutInput, LIMITS.timeoutSec, true, s.ai.timeoutSec),
    };
  }

  // The three typed-in numbers. A box that was emptied (or holds no number) is an unsaved edit too: Save must be
  // pressable so that it can say what is wrong, instead of sitting dimmed while the field looks changed.
  const numberChecks = () => [
    [tokensInput, tokensRow, LIMITS.maxTokens, true, 'longest reply'],
    [ctxInput, ctxRow, LIMITS.contextBudgetTokens, true, 'context budget'],
    [timeoutInput, timeoutRow, LIMITS.timeoutSec, true, 'wait time'],
  ];
  const hasBadNumber = () => numberChecks().some(([input, , limits, integer]) => !clampNumber(input.value, limits, { integer }));
  const isDirty = () => buildGeneralPatch(values(), S()) !== null || hasBadNumber();

  /** The controls exactly as they are right now (strings for typed fields), to tell later whether a field was touched. */
  const snapshot = () => ({
    name: nameInput.value,
    about: about.textarea.value,
    persona: currentPersona,
    custom: custom.textarea.value,
    enabled: enabledSwitch.input.checked,
    temperature: tempInput.value,
    maxTokens: tokensInput.value,
    contextBudgetTokens: ctxInput.value,
    timeoutSec: timeoutInput.value,
  });

  let lastDirty = null;
  function paintDirty() {
    const dirty = isDirty();
    // Dimmed rather than disabled so that pressing Save does not strand keyboard focus (see setActionable).
    setActionable(saveBtn, dirty);
    dirtyEl.hidden = !dirty;
    if (!dirty) handFocus(revertBtn, saveBtn);
    revertBtn.hidden = !dirty;
    if (lastDirty !== dirty) { lastDirty = dirty; if (onChange) onChange(); }
  }

  function touched() {
    for (const [row] of baseHints) row.setError('');
    paintDirty();
  }

  /**
   * Show the saved settings. After a save, `sent` is the snapshot taken when it was submitted: a control that differs
   * from it was edited while the request was in flight, so it is newer than the saved value and stays as typed
   * (it then shows as an unsaved change).
   */
  function applySaved(sent) {
    const s = S();
    const now = sent ? snapshot() : null;
    const untouched = (key) => !sent || now[key] === sent[key];
    if (untouched('name')) nameInput.value = s.profile.name;
    if (untouched('about')) about.set(s.profile.about);
    if (untouched('persona')) currentPersona = s.persona.id;
    if (untouched('custom')) custom.set(s.persona.custom);
    paintPersona();
    if (untouched('enabled')) enabledSwitch.set(s.ai.enabled);
    if (untouched('temperature')) tempInput.value = s.ai.temperature;
    paintTemp();
    if (untouched('maxTokens')) tokensInput.value = s.ai.maxTokens;
    if (untouched('contextBudgetTokens')) ctxInput.value = s.ai.contextBudgetTokens;
    if (untouched('timeoutSec')) timeoutInput.value = s.ai.timeoutSec;
    const theme = getTheme();
    for (const [id, radio] of themeRadios) radio.checked = id === theme;
    paintDirty();
  }

  function clearErrors() {
    for (const row of [nameRow, aboutRow, customRow, tempRow, tokensRow, ctxRow, timeoutRow]) row.setError('');
    personaError.hidden = true;
    summaryEl.hidden = true;
    mount(summaryEl);
  }

  function reset() {
    clearErrors();
    applySaved();
  }

  /** Numbers that were typed out of range snap into range; empty / non-numeric ones are reported. */
  function normalizeNumbers() {
    let ok = true;
    for (const [input, row, limits, integer, name] of numberChecks()) {
      const r = clampNumber(input.value, limits, { integer });
      if (!r) {
        row.setError(`Enter a number between ${limits.min} and ${limits.max} for the ${name}.`);
        ok = false;
      } else if (r.clamped) {
        input.value = r.value;
      }
    }
    return ok;
  }

  function showErrors(err) {
    const m = mapGeneralErrors(err.fields);
    nameRow.setError(m.name || '');
    aboutRow.setError(m.about || '');
    customRow.setError(m.custom || '');
    tempRow.setError(m.temperature || '');
    tokensRow.setError(m.maxTokens || '');
    ctxRow.setError(m.contextBudgetTokens || '');
    timeoutRow.setError(m.timeoutSec || '');
    if (m.persona) { personaError.textContent = m.persona; personaError.hidden = false; }
    if (m.maxTokens || m.contextBudgetTokens || m.timeoutSec) tuning.open = true;
    const extra = [...m.other];
    summaryEl.hidden = false;
    mount(summaryEl, notice({
      tone: 'error', role: 'alert',
      children: [h('strong', null, err.message || 'Some settings need another look'), err.hint ? h('p', { class: 'muted' }, inlineCode(err.hint)) : null,
        extra.length ? h('ul', { class: 'settings-error-list' }, extra.map((t) => h('li', null, t))) : null],
    }));
    if (!focusFirstInvalid(form)) summaryEl.scrollIntoView({ block: 'nearest' });
  }

  async function save() {
    clearErrors();
    if (!normalizeNumbers()) { focusFirstInvalid(form); return false; }
    const sent = snapshot();
    const patch = buildGeneralPatch(values(), S());
    if (!patch) return true;
    try {
      await app.saveSettings(patch);
    } catch (err) {
      if (err instanceof ApiError && err.fields) showErrors(err);
      else {
        summaryEl.hidden = false;
        mount(summaryEl, notice({ tone: 'error', role: 'alert', children: [h('strong', null, err.message || 'Could not save'), err.hint ? h('p', { class: 'muted' }, inlineCode(err.hint)) : null] }));
      }
      return false;
    }
    applySaved(sent);
    toast('Saved', { kind: 'success', timeout: 2200 });
    return true;
  }

  /* personas load lazily and independently so the rest of the tab is usable immediately */
  function loadPersonas() {
    app.catalog().then((catalog) => {
      if (signal.aborted) return;
      renderPersonas(catalog && catalog.personas);
    }).catch((err) => {
      if (signal.aborted) return;
      mount(personaGroup, notice({
        tone: 'warn', role: 'status',
        children: [h('strong', null, 'Could not load the companion styles'), h('p', { class: 'muted' }, (err && err.message) || ''),
          h('button', { type: 'button', class: 'btn btn-sm', 'data-auto-retry': '', onClick: () => { mount(personaGroup, skeleton(3)); loadPersonas(); } }, 'Try again')],
      }));
    });
  }

  applySaved();
  loadPersonas();

  return {
    id: 'general',
    el: form,
    isDirty,
    save,
    reset,
    sync() { if (!isDirty()) applySaved(); },
    shown() {},
  };
}
