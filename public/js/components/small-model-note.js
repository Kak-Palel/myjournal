// The one-line warning about small local models and memory notes. Shared by the Memory page (next to the switch it
// talks about) and the Local model tab in Settings, so the sentence cannot drift. It is a warning, never a blocker:
// nothing is switched off for the person. Why: llama3.2:1b stored 1 valid fact among 5 even after the parser hardening
// (docs/PROVIDERS.md, "How well small models follow the rules").
import { h } from '../lib/dom.js';
import { isSmallModel } from '../lib/model-size.js';
import { notice } from './settings-ui.js';

/** The exact label of the switch on the Memory page (views/memory.js uses this constant for the switch itself). */
export const AUTO_EXTRACT_LABEL = 'Suggest memories when I wrap up an entry';

/** The warning sentence. */
export const SMALL_MODEL_MEMORY_WARNING = `Small models (under about 3B) often write poor memory notes. Check the list now and then, or switch off "${AUTO_EXTRACT_LABEL}".`;

/**
 * Should the warning show? Only while the AI is on, the active provider is the local one and its model is known to be
 * under about 3B parameters. A name that does not state its size (such as plain "llama3.2") gets no warning on a guess.
 * Its advice is to switch off "Suggest memories when I wrap up an entry": once that switch (or memory altogether) is off the
 * person has done it, and the sentence would nag them for ever under the very switch they just turned off.
 * @param {{ ai?: { enabled?: boolean, provider?: string, providers?: { local?: { model?: string } } }, memory?: { enabled?: boolean, autoExtract?: boolean } } | null | undefined} settings public settings
 */
export function showsSmallModelWarning(settings) {
  const ai = settings && settings.ai;
  if (!ai || ai.enabled === false || ai.provider !== 'local') return false;
  const memory = settings.memory;
  if (memory && (memory.enabled === false || memory.autoExtract === false)) return false;
  return isSmallModel(ai.providers && ai.providers.local && ai.providers.local.model);
}

/**
 * The warning as an element that keeps itself current. `el` is always in the DOM tree you place it in (an empty
 * container when there is nothing to say) so it can appear and disappear when settings change.
 * @param {{ settings: object, on(event: string, fn: () => void): () => void }} app
 * @param {{ signal?: AbortSignal, link?: boolean }} [opts] `link`: add an "Open Memory" link (for places other than the Memory page)
 * @returns {{ el: HTMLElement, sync(): void }}
 */
export function smallModelWarning(app, { signal, link = false } = {}) {
  const el = h('div', { class: 'small-model-warning', 'data-testid': 'small-model-warning' });
  function sync() {
    const show = showsSmallModelWarning(app.settings);
    const open = el.firstChild !== null;
    if (show === open) return;
    el.replaceChildren(...(show ? [notice({
      tone: 'warn',
      children: [h('p', null, SMALL_MODEL_MEMORY_WARNING, link ? [' ', h('a', { href: '#/memory' }, 'Open Memory')] : null)],
    })] : []));
  }
  sync();
  const off = app.on('settings', sync);
  if (signal) signal.addEventListener('abort', off, { once: true });
  return { el, sync };
}
