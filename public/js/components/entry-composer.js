// The writing box at the bottom of an entry: autosizing textarea, draft autosave, Send / Save / Stop /
// Wrap up, voice dictation and the Ctrl/Cmd+Enter shortcut.
//
// The component never clears the text itself after a send: the view calls clear() once the server has
// answered 201, so a failed request leaves everything exactly as typed.
import { h } from '../lib/dom.js';
import { icon, autosize, viewportShare } from '../lib/ui.js';
import { draftKey, readDraft, createDraftSaver } from './entry-draft.js';
import { createVoiceButton } from './entry-voice.js';
import { MAX_MESSAGE_CHARS } from './entry-errors.js';
import { remainderAfterSend } from './entry-text.js';

const COUNTER_FROM = Math.floor(MAX_MESSAGE_CHARS * 0.8);
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export const SHORTCUT_LABEL = IS_MAC ? '⌘ Enter' : 'Ctrl Enter';

/**
 * @typedef {'idle'|'posting'|'replying'|'wrapping'|'stopping'} Busy
 *
 * @param {object} opts
 * @param {string} opts.entryId
 * @param {boolean} opts.aiReady
 * @param {boolean} opts.hasMessages
 * @param {{ send(): void, save(): void, stop(): void, wrapUp(): void, notify(message: string): void }} opts.handlers
 */
export function createComposer({ entryId, aiReady, hasMessages, handlers }) {
  const key = draftKey(entryId);
  const saver = createDraftSaver({ key });
  let ready = aiReady;
  let busy = 'idle';
  let canWrap = false;
  let wrapped = false;
  let messagesPresent = hasMessages;

  const textarea = h('textarea', {
    class: 'entry-input', id: `entry-input-${entryId.slice(0, 8)}`, rows: 2, dir: 'auto',
    'aria-label': 'Write in your journal', 'aria-describedby': `entry-hint-${entryId.slice(0, 8)}`,
    autocapitalize: 'sentences', spellcheck: 'true',
  });
  const fit = autosize(textarea, { maxHeight: viewportShare(0.4, { min: 96, max: 340, shortShare: 0.3 }) });
  const interim = h('p', { class: 'entry-interim', 'aria-hidden': 'true', hidden: true });
  const count = h('span', { class: 'entry-count', hidden: true });
  const hint = h('p', { class: 'entry-hint', id: `entry-hint-${entryId.slice(0, 8)}` });

  const stop = h('button', { type: 'button', class: 'btn entry-btn-stop', onClick: () => handlers.stop() }, icon('stop', { size: 18 }), h('span', null, 'Stop'));
  const send = h('button', { type: 'button', class: 'btn btn-primary entry-btn-send', onClick: () => handlers.send() }, icon('send', { size: 18 }), h('span', null, 'Send'));
  const save = h('button', { type: 'button', class: 'btn entry-btn-save', onClick: () => handlers.save() }, h('span', { class: 'entry-long' }, 'Save without reply'), h('span', { class: 'entry-short', 'aria-hidden': 'true' }, 'Save'));
  // "Wrap up again" would not fit next to Save and Send on a phone: the " again" is dropped from the visible label there
  // (CSS), the accessible name keeps it (aria-label), and the label is never cut off with an ellipsis.
  const wrapLabel = h('span', { class: 'entry-wrap-label' }, 'Wrap up');
  const wrapAgain = h('span', { class: 'entry-wrap-again' }, ' again');
  const wrap = h('button', { type: 'button', class: 'btn btn-ghost entry-btn-wrap', onClick: () => handlers.wrapUp(), title: 'Finish this entry: get a closing reflection, a title and a summary' }, icon('sparkles', { size: 18 }), wrapLabel);

  const voice = createVoiceButton({
    textarea,
    notify: (m) => handlers.notify(m),
    onInterim: (text) => { interim.textContent = text ? `${text}…` : ''; interim.hidden = !text; },
    onState: (on) => { if (!on) { interim.textContent = ''; interim.hidden = true; } },
  });

  const left = h('div', { class: 'entry-bar-left' }, voice ? voice.el : null, wrap);
  const right = h('div', { class: 'entry-bar-right' }, count, save, send, stop);
  const box = h('div', { class: 'entry-box' }, textarea, interim, h('div', { class: 'entry-bar' }, left, right));
  const el = h('form', { class: 'entry-composer', 'aria-label': 'Write', novalidate: true, onSubmit: (e) => e.preventDefault() }, box, hint);

  const draft = readDraft(key);
  if (draft) { textarea.value = draft; fit(); }
  let draftRestored = Boolean(draft);

  function overLimit() { return textarea.value.length > MAX_MESSAGE_CHARS; }

  function paintCount() {
    const n = textarea.value.length;
    count.hidden = n < COUNTER_FROM;
    count.textContent = `${n.toLocaleString('en-US')} / ${MAX_MESSAGE_CHARS.toLocaleString('en-US')}`;
    count.classList.toggle('is-over', n > MAX_MESSAGE_CHARS);
    textarea.setAttribute('aria-invalid', n > MAX_MESSAGE_CHARS ? 'true' : 'false');
  }

  function paintHint() {
    hint.replaceChildren();
    const parts = [];
    if (draftRestored) parts.push(h('span', { class: 'entry-hint-item' }, 'Restored your unsent draft.'));
    if (!ready) {
      parts.push(h('span', { class: 'entry-hint-item' }, 'Journal-only mode. ', h('a', { href: '#/settings' }, 'Set up an AI companion'), ' for replies.'));
      // The first message was saved when the entry began; an enabled "Save entry" under an empty box otherwise reads as "not saved yet".
      if (messagesPresent && textarea.value.trim() === '') parts.push(h('span', { class: 'entry-hint-item' }, 'Everything you have written is saved.'));
    } else {
      parts.push(h('span', { class: 'entry-hint-item entry-hint-keys' }, h('kbd', { class: 'kbd' }, SHORTCUT_LABEL), ' to send'));
    }
    hint.append(...parts);
  }

  function paintState() {
    const idle = busy === 'idle';
    const generating = busy === 'replying' || busy === 'wrapping' || busy === 'stopping';
    const over = overLimit();

    send.hidden = generating || !ready;
    stop.hidden = !generating;
    stop.disabled = busy === 'stopping';
    stop.querySelector('span').textContent = busy === 'stopping' ? 'Stopping…' : 'Stop';
    wrap.hidden = !ready;

    // Without an AI the one action is to save, so it becomes the primary button.
    save.hidden = generating && ready;
    save.classList.toggle('btn-primary', !ready && textarea.value.trim() !== ''); // nothing typed: nothing to press it for
    save.querySelector('.entry-long').textContent = ready ? 'Save without reply' : 'Save entry';
    save.querySelector('.entry-short').textContent = 'Save';
    save.setAttribute('aria-label', ready ? 'Save without reply' : 'Save entry');

    save.disabled = !idle || over;
    send.disabled = !idle || over;
    send.classList.toggle('is-loading', busy === 'posting');
    send.querySelector('span').textContent = busy === 'posting' ? 'Sending…' : 'Send';
    wrap.disabled = !canWrap || !idle;
    wrap.classList.toggle('is-loading', busy === 'wrapping');
    const again = wrapped && busy !== 'wrapping';
    wrapLabel.textContent = busy === 'wrapping' ? 'Wrapping up…' : 'Wrap up';
    if (again) { wrapLabel.append(wrapAgain); wrap.setAttribute('aria-label', 'Wrap up again'); } else wrap.removeAttribute('aria-label');
    el.classList.toggle('is-busy', !idle);
    textarea.placeholder = messagesPresent ? 'Keep writing…' : 'What is on your mind?';
  }

  textarea.addEventListener('input', () => {
    draftRestored = false;
    saver.save(textarea.value);
    paintCount();
    paintHint();
    paintState();
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      if (voice) voice.stop();
      if (ready) handlers.send(); else handlers.save();
    }
  });

  paintCount();
  paintHint();
  paintState();

  return {
    el,
    textarea,
    getText: () => textarea.value,
    /**
     * Clear after the server confirmed the text is saved. The box stays editable during the request, so
     * pass the text that was sent: anything typed or dictated since then is kept.
     * @param {string} [sent]
     */
    clear(sent) {
      const rest = sent === undefined ? '' : remainderAfterSend(textarea.value, sent);
      textarea.value = rest;
      if (rest) saver.save(rest); else saver.clear();
      draftRestored = false;
      fit();
      paintCount();
      paintHint();
      paintState();
    },
    focus(opts) { textarea.focus(opts); },
    flushDraft: () => saver.flush(),
    overLimit,
    stopDictation() { if (voice) voice.stop(); },
    setBusy(next) { busy = next; paintState(); },
    setAiReady(next) { ready = next; paintHint(); paintState(); },
    setCanWrap(next, isWrapped = false) { canWrap = next; wrapped = isWrapped; paintState(); },
    setHasMessages(next) { messagesPresent = next; paintHint(); paintState(); },
    destroy() {
      saver.flush();
      if (voice) voice.destroy();
    },
  };
}
