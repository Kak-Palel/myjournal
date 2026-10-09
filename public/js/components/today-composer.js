// The "What's on your mind?" box on the Today page. Like the entry composer it never loses text: the
// draft is autosaved and the box is only cleared after the entry was created successfully.
import { h } from '../lib/dom.js';
import { icon, autosize, moodPicker, viewportShare, stripCode } from '../lib/ui.js';
import { draftKey, readDraft, createDraftSaver, NEW_DRAFT_ID } from './entry-draft.js';
import { createVoiceButton } from './entry-voice.js';
import { SHORTCUT_LABEL } from './entry-composer.js';
import { MAX_MESSAGE_CHARS } from './entry-errors.js';

/**
 * @param {object} opts
 * @param {boolean} opts.aiReady
 * @param {(input: { text: string, mood: number|null, prompt: string, reply: boolean }) => Promise<void>} opts.onSubmit
 *   creates the entry (`reply: false` for "Save without reply": nothing is sent to the AI provider); reject with an Error
 *   (message shown inline) to keep the text.
 * @param {(message: string) => void} opts.notify
 */
export function createTodayComposer({ aiReady, onSubmit, notify }) {
  const key = draftKey(NEW_DRAFT_ID);
  const saver = createDraftSaver({ key });
  let promptText = '';
  let busy = false;
  let ready = aiReady;

  const textarea = h('textarea', {
    class: 'today-input', id: 'today-input', rows: 4, dir: 'auto', placeholder: 'What is on your mind?',
    'aria-label': 'Write a new journal entry', autocapitalize: 'sentences', spellcheck: 'true',
  });
  const fit = autosize(textarea, { maxHeight: viewportShare(0.5, { min: 140, max: 420, shortShare: 0.4 }) });
  const interim = h('p', { class: 'today-interim', 'aria-hidden': 'true', hidden: true });
  const error = h('p', { class: 'today-error', role: 'alert', hidden: true });
  const promptEl = h('div', { class: 'today-prompt-ctx', hidden: true });

  const mood = moodPicker({ value: null, size: 'md' });
  const start = h('button', { type: 'submit', class: 'btn btn-primary today-start' }, icon('pen', { size: 18 }), h('span', null, 'Start journaling'));
  // With an AI on, "Start journaling" sends the first message to the provider at once. This is the way to write without that,
  // the same choice the entry page offers (it is only shown while there is an AI; without one, Start journaling already is it).
  const saveOnly = h('button', { type: 'button', class: 'btn today-save-only', hidden: !ready, onClick: () => submit({ reply: false }) }, h('span', null, 'Save without reply'));

  const voice = createVoiceButton({
    textarea,
    notify,
    onInterim: (text) => { interim.textContent = text ? `${text}…` : ''; interim.hidden = !text; },
    onState: (on) => { if (!on) { interim.textContent = ''; interim.hidden = true; } },
  });

  const hint = h('p', { class: 'today-hint' },
    h('kbd', { class: 'kbd' }, SHORTCUT_LABEL), ' to start');

  const el = h('form', { class: 'today-composer card', 'aria-label': 'New entry', novalidate: true, onSubmit: (e) => { e.preventDefault(); submit(); } },
    promptEl,
    textarea,
    interim,
    error,
    h('div', { class: 'today-mood' },
      h('span', { class: 'today-mood-label', id: 'today-mood-label' }, 'How are you feeling?'),
      mood.el),
    h('div', { class: 'today-composer-bar' },
      hint,
      h('div', { class: 'today-composer-actions' }, voice ? voice.el : null, saveOnly, start)));

  const draft = readDraft(key);
  if (draft) { textarea.value = draft; fit(); }

  function paintPrompt() {
    promptEl.replaceChildren();
    promptEl.hidden = !promptText;
    if (!promptText) { textarea.placeholder = 'What is on your mind?'; return; }
    textarea.placeholder = 'Write your answer…';
    promptEl.append(
      icon('sparkles', { size: 16 }),
      h('span', { class: 'today-prompt-ctx-text', dir: 'auto' }, promptText),
      h('button', {
        type: 'button', class: 'today-prompt-ctx-x', 'aria-label': 'Remove the prompt',
        onClick: () => { promptText = ''; paintPrompt(); textarea.focus(); },
      }, icon('x', { size: 14 })));
  }

  function showError(message) { error.textContent = message; error.hidden = !message; }

  async function submit({ reply = true } = {}) {
    if (busy) return;
    const text = textarea.value.trim();
    if (!text) {
      showError(promptText ? 'Write a few words to answer the prompt.' : 'Write a few words to begin, or pick a guided journal below.');
      textarea.focus();
      return;
    }
    if (textarea.value.length > MAX_MESSAGE_CHARS) {
      showError(`That is longer than ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters. Split it into two entries; your text is still here.`);
      return;
    }
    if (voice) voice.stop();
    showError('');
    busy = true;
    start.disabled = true;
    saveOnly.disabled = true;
    const pressed = reply ? start : saveOnly;
    pressed.querySelector('span').textContent = reply ? 'Starting…' : 'Saving…';
    try {
      await onSubmit({ text, mood: mood.value, prompt: promptText, reply });
      saver.clear();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      showError(stripCode(`${err && err.message ? err.message : 'Could not save your entry.'}${err && err.hint ? ` ${err.hint}` : ''} Your text is still here.`));
    } finally {
      busy = false;
      start.disabled = false;
      saveOnly.disabled = false;
      start.querySelector('span').textContent = 'Start journaling';
      saveOnly.querySelector('span').textContent = 'Save without reply';
    }
  }

  textarea.addEventListener('input', () => { saver.save(textarea.value); if (!error.hidden) showError(''); });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); submit(); }
  });

  paintPrompt();
  return {
    el,
    textarea,
    focus(opts) { textarea.focus(opts); },
    /** Answer a prompt: shows it above the box and focuses the textarea. */
    setPrompt(text) { promptText = String(text || ''); paintPrompt(); textarea.focus(); },
    setAiReady(next) { ready = next; saveOnly.hidden = !ready; return ready; },
    flushDraft: () => saver.flush(),
    destroy() { saver.flush(); if (voice) voice.destroy(); },
  };
}
