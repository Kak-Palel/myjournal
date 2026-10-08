// Microphone button for a textarea. Returns null when the browser has no speech recognition, so
// callers simply do not render it.
import { h } from '../lib/dom.js';
import { icon } from '../lib/ui.js';
import { isSupported, createDictation, insertAtCaret, PRIVACY_HINT } from '../lib/voice.js';

/**
 * @param {object} opts
 * @param {HTMLTextAreaElement} opts.textarea where dictated text goes (at the caret)
 * @param {(message: string) => void} opts.notify show a problem to the user
 * @param {(interim: string) => void} [opts.onInterim] live guess (display only)
 * @param {(listening: boolean) => void} [opts.onState]
 * @returns {{ el: HTMLButtonElement, stop(): void, destroy(): void, readonly listening: boolean } | null}
 */
export function createVoiceButton({ textarea, notify, onInterim, onState }) {
  if (!isSupported()) return null;

  const btn = h('button', {
    type: 'button',
    class: 'btn btn-ghost btn-icon entry-mic',
    'aria-label': 'Dictate',
    'aria-pressed': 'false',
    title: `Dictate. ${PRIVACY_HINT}.`,
  }, icon('mic'));

  const dictation = createDictation({
    onFinal(text) {
      const { value, caret } = insertAtCaret(textarea.value, textarea.selectionStart, textarea.selectionEnd, text);
      textarea.value = value;
      textarea.setSelectionRange(caret, caret);
      textarea.dispatchEvent(new Event('input', { bubbles: true })); // autosize + draft save
    },
    onInterim,
    onState(state) {
      const on = state === 'listening';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('is-listening', on);
      btn.title = on ? `Stop dictation. ${PRIVACY_HINT}.` : `Dictate. ${PRIVACY_HINT}.`;
      if (onState) onState(on);
    },
    onError: notify,
  });

  btn.addEventListener('click', () => dictation.toggle());

  return {
    el: btn,
    stop: () => dictation.stop(),
    destroy: () => dictation.destroy(),
    get listening() { return dictation.listening; },
  };
}
