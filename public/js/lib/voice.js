// Voice dictation through the browser's Web Speech API (SpeechRecognition / webkitSpeechRecognition).
//
// Privacy: the browser, not MyJournal, does the recognition. In Chrome the audio is sent to Google's
// speech service; Firefox has no support at all. That is why the UI only offers the button when
// isSupported() is true and why PRIVACY_HINT goes into the button's title.
//
// Everything that can be decided without a browser (transcript insertion, result collection, error
// wording) is a pure exported function so it is unit-tested in Node. Nothing here touches `document`
// or `window` at import time.

export const PRIVACY_HINT = "Uses your browser's speech service; in Chrome audio is sent to Google";

const RESTART_DELAY_MS = 250;
const QUICK_END_MS = 1200; // a session that dies this fast after start() is not "silence", it is a failure
const MAX_QUICK_ENDS = 3;

/** @param {object} [scope] global object to inspect (injectable for tests) */
function recognitionCtor(scope = globalThis) {
  return (scope && (scope.SpeechRecognition || scope.webkitSpeechRecognition)) || null;
}

/** True when this browser can do speech recognition. */
export function isSupported(scope = globalThis) {
  return typeof recognitionCtor(scope) === 'function';
}

/* ------------------------------------------------------------------ pure helpers */
/** Collapse whitespace runs (browsers sometimes return a leading space or newlines) and trim. */
export function normalizeTranscript(transcript) {
  return String(transcript ?? '').replace(/\s+/g, ' ').trim();
}

const SENTENCE_END = /(?:^|[.!?…]\s*|\n\s*)$/;
const CLOSING_PUNCT = /^[.,!?;:)\]}%…]/;

function capitalizeFirst(text) {
  const first = String.fromCodePoint(text.codePointAt(0));
  return first.toLocaleUpperCase() + text.slice(first.length);
}

/**
 * Insert dictated text into `value` at the selection [selStart, selEnd), adding a space on either
 * side when needed and capitalising when the text starts a sentence.
 * @param {string} value current textarea value
 * @param {number} selStart selection start (UTF-16 index)
 * @param {number} selEnd selection end
 * @param {string} transcript recognised speech
 * @returns {{ value: string, caret: number }} new value and where the caret goes
 */
export function insertAtCaret(value, selStart, selEnd, transcript) {
  const text = String(value ?? '');
  const clamp = (n) => Math.max(0, Math.min(text.length, Number.isFinite(n) ? n : text.length));
  const a = clamp(Math.min(selStart, selEnd));
  const b = clamp(Math.max(selStart, selEnd));
  const spoken = normalizeTranscript(transcript);
  if (!spoken) return { value: text, caret: b };

  const before = text.slice(0, a);
  const after = text.slice(b);
  const body = SENTENCE_END.test(before) ? capitalizeFirst(spoken) : spoken;
  const lead = before.length > 0 && !/\s$/.test(before) && !CLOSING_PUNCT.test(body) ? ' ' : '';
  const trail = after.length > 0 && !/^\s/.test(after) && !CLOSING_PUNCT.test(after) ? ' ' : '';
  const inserted = lead + body + trail;
  return { value: before + inserted + after, caret: a + inserted.length };
}

/**
 * Split a SpeechRecognitionResultList into text that is final and not yet consumed, and the current
 * interim guess. `consumed` guards against engines (Chrome on Android) that re-deliver old finals.
 * @param {ArrayLike<any>} results
 * @param {number} resultIndex event.resultIndex
 * @param {number} [consumed] index up to which finals were already handled
 * @returns {{ final: string, interim: string, nextConsumed: number }}
 */
export function collectResults(results, resultIndex = 0, consumed = 0) {
  let final = '';
  let interim = '';
  let nextConsumed = consumed;
  const list = results || [];
  for (let i = Math.max(0, resultIndex); i < list.length; i += 1) {
    const result = list[i];
    const best = result && result[0];
    if (!best || typeof best.transcript !== 'string') continue;
    if (result.isFinal) {
      if (i >= nextConsumed) {
        final += (final ? ' ' : '') + best.transcript;
        nextConsumed = i + 1;
      }
    } else {
      interim += best.transcript;
    }
  }
  return { final, interim, nextConsumed };
}

/**
 * Human wording for a SpeechRecognition error code.
 * @param {string} code event.error
 * @returns {{ message: string, fatal: boolean }} fatal = do not auto-restart; message '' = say nothing
 */
export function describeError(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return { fatal: true, message: 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.' };
    case 'audio-capture':
      return { fatal: true, message: 'No microphone was found. Plug one in or check your system sound settings.' };
    case 'network':
      return { fatal: true, message: "Your browser's speech service could not be reached. Dictation needs an internet connection in this browser; typing still works." };
    case 'no-speech':
      return { fatal: true, message: "I didn't hear anything. Click the microphone and try again." };
    case 'language-not-supported':
      return { fatal: true, message: "Dictation isn't available for your language in this browser." };
    case 'aborted':
      return { fatal: true, message: '' };
    default:
      return { fatal: true, message: `Dictation stopped unexpectedly${code ? ` (${code})` : ''}.` };
  }
}

/* ------------------------------------------------------------------ dictation controller */
/**
 * @typedef {object} DictationOptions
 * @property {(text: string) => void} onFinal final transcript chunk, ready to insert at the caret
 * @property {(text: string) => void} [onInterim] live guess for display only ('' when cleared)
 * @property {(state: 'idle'|'listening') => void} [onState]
 * @property {(message: string) => void} [onError] human-readable problem
 * @property {string} [lang] BCP 47 tag; defaults to the browser language
 * @property {object} [scope] global object holding the SpeechRecognition constructor (tests)
 */

/**
 * Create a dictation controller. Chrome ends a "continuous" session after a few seconds of silence,
 * so the controller restarts it while the user still wants to dictate (with a guard against loops).
 * @param {DictationOptions} options
 * @returns {{ supported: boolean, readonly listening: boolean, start(): void, stop(): void, toggle(): void, destroy(): void }}
 */
export function createDictation(options) {
  const { onFinal, onInterim, onState, onError, scope = globalThis } = options;
  const Ctor = recognitionCtor(scope);
  let rec = null;
  let wanted = false; // the user asked for dictation and has not stopped it
  let listening = false;
  let destroyed = false;
  let quickEnds = 0;
  let restartTimer = null;

  const setListening = (on) => {
    if (listening === on) return;
    listening = on;
    if (!destroyed && onState) onState(on ? 'listening' : 'idle');
  };
  const fail = (message) => { if (message && !destroyed && onError) onError(message); };
  const clearInterim = () => { if (onInterim && !destroyed) onInterim(''); };

  /** Strip an engine's handlers; `rec` is only forgotten when it is that same engine. */
  function detach(engine) {
    engine.onstart = engine.onresult = engine.onerror = engine.onend = null;
    if (rec === engine) rec = null;
  }

  function begin() {
    if (destroyed || !wanted) return;
    // stop() leaves the old engine in `rec` until its `end` event, which can take a few hundred ms. If the
    // writer toggles the microphone off and on in that window, two engines briefly coexist. Every handler
    // therefore works on its own `mine` and ignores state changes unless it is still the current engine;
    // otherwise the old engine's `end` would detach and restart the new one.
    const mine = new Ctor();
    rec = mine;
    mine.continuous = true;
    mine.interimResults = true;
    mine.lang = options.lang || (scope.navigator && scope.navigator.language) || 'en-US';
    let consumed = 0; // per engine: result indexes restart at 0 with every new session
    const startedAt = Date.now();
    const current = () => rec === mine;

    mine.onstart = () => { if (current()) setListening(true); };
    mine.onresult = (event) => {
      if (destroyed) return;
      const out = collectResults(event.results, event.resultIndex, consumed);
      consumed = out.nextConsumed;
      if (out.final) onFinal(out.final); // words spoken before stop() still count, even from a superseded engine
      if (current() && onInterim) onInterim(out.interim);
    };
    mine.onerror = (event) => {
      if (!current()) return; // e.g. the 'aborted' that a superseded engine reports must not cancel the new session
      const info = describeError(event && event.error);
      wanted = false;
      fail(info.message);
    };
    mine.onend = () => {
      const wasCurrent = current();
      detach(mine);
      if (!wasCurrent) return;
      clearInterim();
      if (!wanted || destroyed) { setListening(false); return; }
      quickEnds = Date.now() - startedAt < QUICK_END_MS ? quickEnds + 1 : 0;
      if (quickEnds >= MAX_QUICK_ENDS) {
        wanted = false;
        setListening(false);
        fail('Dictation keeps stopping on its own. Try again in a moment, or type instead.');
        return;
      }
      restartTimer = setTimeout(() => { restartTimer = null; begin(); }, RESTART_DELAY_MS);
    };

    try {
      mine.start();
    } catch (err) {
      wanted = false;
      detach(mine);
      setListening(false);
      fail(`Could not start dictation (${err && err.name ? err.name : 'error'}).`);
    }
  }

  return {
    supported: typeof Ctor === 'function',
    get listening() { return listening; },
    start() {
      if (destroyed || wanted) return;
      if (typeof Ctor !== 'function') { fail("Dictation isn't supported in this browser."); return; }
      wanted = true;
      quickEnds = 0;
      begin();
    },
    stop() {
      wanted = false;
      if (restartTimer !== null) { clearTimeout(restartTimer); restartTimer = null; }
      if (rec) { try { rec.stop(); } catch { /* already stopped */ } } else setListening(false);
    },
    toggle() { if (wanted) this.stop(); else this.start(); },
    /** Stop immediately and never call back again (view cleanup). */
    destroy() {
      destroyed = true;
      wanted = false;
      if (restartTimer !== null) { clearTimeout(restartTimer); restartTimer = null; }
      if (rec) { const r = rec; detach(r); try { r.abort(); } catch { /* ignore */ } }
      listening = false;
    },
  };
}
