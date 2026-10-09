// Pure-logic tests for the Today / Entry / History views (frontend-A). No DOM.
// The file is named after lib/voice.js, the first module covered; the other suites below cover the
// view helpers that live in public/js/components/ (draft keys, labels, errors, streaming maths,
// month grouping, highlighting, filters, Today logic).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSupported, insertAtCaret, normalizeTranscript, collectResults, describeError, createDictation, PRIVACY_HINT,
} from '../../public/js/lib/voice.js';
import { draftKey, readDraft, writeDraft, removeDraft, createDraftSaver } from '../../public/js/components/entry-draft.js';
import { normalizeLabel, addLabel, removeLabel, LABEL_LIMITS } from '../../public/js/components/entry-labels.js';
import { describeProblem, settingsLink, MAX_MESSAGE_CHARS } from '../../public/js/components/entry-errors.js';
import {
  splitChunk, createRevealer, distanceFromBottom, isNearBottom, announcementExcerpt,
} from '../../public/js/components/entry-stream.js';
import {
  entryTitle, cardTexts, previewText, monthKey, monthStart, placeInMonths, searchTerms, highlightSegments, parseFilters, filtersToParams, hasActiveFilters, listPath,
} from '../../public/js/components/history-format.js';
import {
  groupTemplates, streakInfo, weekEntryCount, nudgeState, newEntryBody,
} from '../../public/js/components/today-logic.js';
import { committableDate } from '../../public/js/components/entry-date.js';
import { isSafetyMessage, trailingMessage } from '../../public/js/components/entry-thread.js';
import { remainderAfterSend } from '../../public/js/components/entry-text.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until `fn()` is truthy (generous timeout, so a loaded machine cannot make the tests flaky). */
async function until(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('until() timed out');
    await sleep(5);
  }
}

/* ================================================================== voice */
describe('voice: feature detection', () => {
  test('unsupported without a SpeechRecognition constructor', () => {
    assert.equal(isSupported({}), false);
    assert.equal(isSupported(null), false);
    assert.equal(isSupported(), false); // Node has none
  });
  test('supported with the standard or the webkit constructor', () => {
    assert.equal(isSupported({ SpeechRecognition: function SR() {} }), true);
    assert.equal(isSupported({ webkitSpeechRecognition: function SR() {} }), true);
    assert.equal(isSupported({ SpeechRecognition: 'nope' }), false);
  });
  test('privacy hint names the speech service', () => {
    assert.match(PRIVACY_HINT, /speech service/);
    assert.match(PRIVACY_HINT, /Google/);
  });
});

describe('voice: insertAtCaret', () => {
  test('inserts into empty text and capitalises the sentence start', () => {
    assert.deepEqual(insertAtCaret('', 0, 0, 'hello there'), { value: 'Hello there', caret: 11 });
  });
  test('adds a separating space after existing text', () => {
    const r = insertAtCaret('I walked home.', 14, 14, 'it was cold');
    assert.equal(r.value, 'I walked home. It was cold');
    assert.equal(r.caret, r.value.length);
  });
  test('does not capitalise mid-sentence', () => {
    assert.equal(insertAtCaret('I was', 5, 5, 'really tired').value, 'I was really tired');
  });
  test('inserts at the caret in the middle and keeps both sides spaced', () => {
    const r = insertAtCaret('before after', 6, 6, 'middle');
    assert.equal(r.value, 'before middle after');
    assert.equal(r.caret, 'before middle'.length, 'caret sits right after the dictated text');
  });
  test('does not add a space before closing punctuation', () => {
    assert.equal(insertAtCaret('Hello', 5, 5, ', world').value, 'Hello, world');
    assert.equal(insertAtCaret('Hello world', 5, 5, 'there').value, 'Hello there world');
    assert.equal(insertAtCaret('a b', 1, 1, 'x').value, 'a x b');
    assert.equal(insertAtCaret('hi there', 2, 2, 'x').value, 'hi x there');
    assert.equal(insertAtCaret('hi', 2, 2, '.').value, 'hi.');
  });
  test('replaces the selection', () => {
    assert.equal(insertAtCaret('keep DROP keep', 5, 9, 'new').value, 'keep new keep');
  });
  test('swapped or out-of-range selection is clamped', () => {
    assert.equal(insertAtCaret('abc', 99, -4, 'x').value, 'X', 'selection is the whole text; it starts a sentence');
    assert.equal(insertAtCaret('abc', NaN, NaN, 'x').value, 'abc x');
    assert.equal(insertAtCaret('abc', 3, 1, 'x').value, 'a x');
  });
  test('empty or whitespace transcript changes nothing', () => {
    assert.deepEqual(insertAtCaret('abc', 1, 2, '   \n '), { value: 'abc', caret: 2 });
    assert.deepEqual(insertAtCaret('abc', 3, 3, null), { value: 'abc', caret: 3 });
  });
  test('newline counts as a sentence start; collapses internal whitespace', () => {
    assert.equal(insertAtCaret('line one\n', 9, 9, 'second\n line').value, 'line one\nSecond line');
  });
  test('emoji and non-Latin transcripts survive; capitalising never splits a surrogate pair', () => {
    assert.equal(insertAtCaret('', 0, 0, '😀 great day').value, '😀 great day');
    assert.equal(insertAtCaret('', 0, 0, 'שלום עולם').value, 'שלום עולם');
    assert.equal(insertAtCaret('', 0, 0, '𝒶bc').value, '𝒶bc'.replace('𝒶', '𝒶'));
  });
  test('hostile text is inserted verbatim as text', () => {
    assert.equal(insertAtCaret('', 0, 0, '<img src=x onerror=alert(1)>').value, '<img src=x onerror=alert(1)>');
  });
  test('normalizeTranscript', () => {
    assert.equal(normalizeTranscript('  a \n\t b  '), 'a b');
    assert.equal(normalizeTranscript(undefined), '');
  });
});

describe('voice: collectResults', () => {
  const res = (transcript, isFinal) => Object.assign([{ transcript }], { isFinal });

  test('separates final and interim text', () => {
    const out = collectResults([res('hello', true), res(' wor', false)], 0, 0);
    assert.equal(out.final, 'hello');
    assert.equal(out.interim, ' wor');
    assert.equal(out.nextConsumed, 1);
  });
  test('starts at resultIndex', () => {
    const out = collectResults([res('old', true), res('new', true)], 1, 1);
    assert.equal(out.final, 'new');
    assert.equal(out.nextConsumed, 2);
  });
  test('never re-delivers a final that was already consumed', () => {
    const out = collectResults([res('again', true)], 0, 1);
    assert.equal(out.final, '');
    assert.equal(out.nextConsumed, 1);
  });
  test('joins several finals and tolerates malformed entries', () => {
    const out = collectResults([res('a', true), null, [], res('b', true), { 0: { transcript: 5 } }], 0, 0);
    assert.equal(out.final, 'a b');
    assert.equal(collectResults(null).final, '');
  });
});

describe('voice: describeError', () => {
  test('permission problems explain how to fix it', () => {
    assert.match(describeError('not-allowed').message, /Microphone access is blocked/);
    assert.equal(describeError('service-not-allowed').fatal, true);
  });
  test('each known code has its own wording', () => {
    const msgs = ['no-speech', 'audio-capture', 'network', 'language-not-supported'].map((c) => describeError(c).message);
    assert.equal(new Set(msgs).size, 4);
    assert.match(describeError('network').message, /internet/);
    assert.match(describeError('no-speech').message, /didn't hear/i);
  });
  test('aborted is silent; unknown codes are reported', () => {
    assert.equal(describeError('aborted').message, '');
    assert.match(describeError('weird').message, /\(weird\)/);
    assert.match(describeError(undefined).message, /unexpectedly/);
  });
});

describe('voice: createDictation', () => {
  function fakeScope() {
    const instances = [];
    class FakeRecognition {
      constructor() { this.started = 0; this.stopped = 0; this.aborted = 0; instances.push(this); }
      start() { if (this.throwOnStart) throw Object.assign(new Error('x'), { name: 'InvalidStateError' }); this.started += 1; queueMicrotask(() => this.onstart && this.onstart()); }
      stop() { this.stopped += 1; queueMicrotask(() => this.onend && this.onend()); }
      abort() { this.aborted += 1; }
    }
    return { scope: { SpeechRecognition: FakeRecognition, navigator: { language: 'de-DE' } }, instances, FakeRecognition };
  }
  const result = (transcript, isFinal) => Object.assign([{ transcript }], { isFinal });
  const tick = () => sleep(5);

  test('reports unsupported browsers without throwing', () => {
    const errors = [];
    const d = createDictation({ onFinal() {}, onError: (m) => errors.push(m), scope: {} });
    assert.equal(d.supported, false);
    d.start();
    assert.match(errors[0], /isn't supported/);
  });

  test('starts, delivers final text once, shows interim text, stops cleanly', async () => {
    const { scope, instances } = fakeScope();
    const finals = [];
    const interims = [];
    const states = [];
    const d = createDictation({ onFinal: (t) => finals.push(t), onInterim: (t) => interims.push(t), onState: (s) => states.push(s), scope });
    d.start();
    await tick();
    assert.equal(instances[0].continuous, true);
    assert.equal(instances[0].interimResults, true);
    assert.equal(instances[0].lang, 'de-DE');
    assert.equal(d.listening, true);

    instances[0].onresult({ resultIndex: 0, results: [result('hel', false)] });
    instances[0].onresult({ resultIndex: 0, results: [result('hello', true)] });
    instances[0].onresult({ resultIndex: 0, results: [result('hello', true)] }); // re-delivery
    assert.deepEqual(finals, ['hello']);
    assert.equal(interims[0], 'hel');

    d.stop();
    await tick();
    assert.equal(instances[0].stopped, 1);
    assert.equal(d.listening, false);
    assert.deepEqual(states, ['listening', 'idle']);
    assert.equal(instances.length, 1);
  });

  test('restarts after the engine ends on its own while the user still wants to dictate', async () => {
    const { scope, instances } = fakeScope();
    const d = createDictation({ onFinal() {}, scope });
    d.start();
    await tick();
    await sleep(1250); // pretend the first session lasted a while (avoids the quick-end guard)
    instances[0].onend();
    await until(() => instances.length === 2);
    await until(() => instances[1].started === 1);
    d.destroy();
    assert.equal(instances[1].aborted, 1);
  });

  test('gives up when sessions keep dying immediately', async () => {
    const { scope, instances } = fakeScope();
    const errors = [];
    const d = createDictation({ onFinal() {}, onError: (m) => errors.push(m), scope });
    d.start();
    for (let i = 0; i < 3; i += 1) {
      await until(() => instances.length === i + 1 && typeof instances[i].onend === 'function');
      instances[i].onend();
      if (i < 2) await until(() => instances.length === i + 2); // the controller restarted
    }
    await until(() => errors.length > 0);
    assert.ok(errors.some((m) => /keeps stopping/.test(m)), `errors: ${errors}`);
    assert.equal(d.listening, false);
    d.destroy();
  });

  test('a permission error stops dictation and explains it', async () => {
    const { scope, instances } = fakeScope();
    const errors = [];
    const d = createDictation({ onFinal() {}, onError: (m) => errors.push(m), scope });
    d.start();
    await tick();
    instances[0].onerror({ error: 'not-allowed' });
    instances[0].onend();
    await sleep(300);
    assert.match(errors[0], /Microphone access is blocked/);
    assert.equal(d.listening, false);
    assert.equal(instances.length, 1, 'must not restart after a fatal error');
  });

  test('an aborted error is silent', async () => {
    const { scope, instances } = fakeScope();
    const errors = [];
    const d = createDictation({ onFinal() {}, onError: (m) => errors.push(m), scope });
    d.start();
    await tick();
    instances[0].onerror({ error: 'aborted' });
    assert.deepEqual(errors, []);
  });

  test('start() failure is reported, not thrown', () => {
    const { scope, FakeRecognition } = fakeScope();
    FakeRecognition.prototype.throwOnStart = true;
    const errors = [];
    const d = createDictation({ onFinal() {}, onError: (m) => errors.push(m), scope });
    d.start();
    assert.match(errors[0], /InvalidStateError/);
    assert.equal(d.listening, false);
  });

  test('destroy() silences every later callback', async () => {
    const { scope, instances } = fakeScope();
    const calls = [];
    const d = createDictation({ onFinal: (t) => calls.push(t), onState: (s) => calls.push(s), onError: (m) => calls.push(m), scope });
    d.start();
    await tick();
    const rec = instances[0];
    d.destroy();
    calls.length = 0;
    assert.equal(rec.aborted, 1);
    assert.equal(rec.onresult, null);
    d.start(); // no-op after destroy
    assert.equal(instances.length, 1);
    assert.deepEqual(calls, []);
  });

  test('toggle starts then stops', async () => {
    const { scope, instances } = fakeScope();
    const d = createDictation({ onFinal() {}, scope });
    d.toggle();
    await tick();
    d.toggle();
    await tick();
    assert.equal(instances[0].stopped, 1);
    assert.equal(d.listening, false);
  });

  // Chrome fires `end` a few hundred ms after stop(); the fake lets the test decide when.
  function slowStopScope() {
    const made = fakeScope();
    made.FakeRecognition.prototype.stop = function stop() { this.stopped += 1; };
    return made;
  }

  test('toggling off and on before the old engine ends keeps the new engine attached', async () => {
    const { scope, instances } = slowStopScope();
    const finals = [];
    const states = [];
    const errors = [];
    const d = createDictation({ onFinal: (t) => finals.push(t), onState: (st) => states.push(st), onError: (m) => errors.push(m), scope });
    d.start();
    await tick();
    const [first] = instances;
    d.stop();
    d.start(); // the old engine has not fired `end` yet
    await tick();
    assert.equal(instances.length, 2);
    const second = instances[1];
    assert.equal(second.started, 1);

    first.onend(); // the old engine finally ends
    first.onerror && first.onerror({ error: 'aborted' }); // ...and may report 'aborted' (handlers are stripped by then)
    await sleep(400); // longer than the restart delay: a wrongly scheduled restart would have created a third engine
    assert.equal(instances.length, 2, 'a stale end must not start another engine');
    assert.equal(typeof second.onresult, 'function', 'the new engine must keep its handlers');
    assert.equal(typeof second.onend, 'function');
    assert.equal(d.listening, true);

    second.onresult({ resultIndex: 0, results: [result('still works', true)] });
    assert.deepEqual(finals, ['still works']);
    assert.deepEqual(errors, []);

    d.stop();
    second.onend();
    assert.equal(d.listening, false);
    assert.deepEqual(states, ['listening', 'idle'], 'no idle flicker while the old engine wound down');
  });

  test('a superseded engine neither cancels the new session nor loses its last words', async () => {
    const { scope, instances } = slowStopScope();
    const finals = [];
    const errors = [];
    const d = createDictation({ onFinal: (t) => finals.push(t), onError: (m) => errors.push(m), scope });
    d.start();
    await tick();
    const [first] = instances;
    d.stop();
    d.start();
    await tick();
    const second = instances[1];

    first.onresult({ resultIndex: 0, results: [result('spoken before stop', true)] }); // final words that arrive late
    first.onerror({ error: 'aborted' }); // would flip `wanted` off if it were treated as the current engine
    first.onend();
    second.onend(); // the new engine ends on its own while the user still wants dictation
    assert.deepEqual(finals, ['spoken before stop']);
    await until(() => instances.length === 3); // so it must have kept wanting to listen: auto-restart still works
    assert.deepEqual(errors, []);
    d.destroy();
  });
});

/* ================================================================== drafts */
describe('entry-draft', () => {
  const fakeStorage = (initial = {}) => {
    const data = { ...initial };
    return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; } };
  };

  test('draftKey is stable per entry and has a fallback', () => {
    assert.equal(draftKey('abc'), 'mj-draft:abc');
    assert.equal(draftKey(''), 'mj-draft:new');
    assert.equal(draftKey(undefined), 'mj-draft:new');
    assert.notEqual(draftKey('a'), draftKey('b'));
  });
  test('write/read/remove round trip, whitespace-only removes', () => {
    const s = fakeStorage();
    assert.equal(writeDraft('k', 'hello 😀', s), true);
    assert.equal(readDraft('k', s), 'hello 😀');
    assert.equal(writeDraft('k', '   \n', s), true);
    assert.equal(readDraft('k', s), '');
    writeDraft('k', 'x', s);
    removeDraft('k', s);
    assert.equal('k' in s.data, false);
  });
  test('missing or throwing storage never throws', () => {
    assert.equal(readDraft('k', null), '');
    assert.equal(writeDraft('k', 'x', null), false);
    const boom = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('blocked'); } };
    assert.equal(readDraft('k', boom), '');
    assert.equal(writeDraft('k', 'x', boom), false);
    assert.doesNotThrow(() => removeDraft('k', boom));
  });
  test('absurdly large drafts are skipped instead of filling storage', () => {
    const s = fakeStorage();
    assert.equal(writeDraft('k', 'x'.repeat(600_000), s), false);
    assert.equal(readDraft('k', s), '');
  });
  test('saver debounces, flushes and clears', async () => {
    const s = fakeStorage();
    const saver = createDraftSaver({ key: 'k', storage: s, delay: 20 });
    saver.save('a');
    saver.save('ab');
    saver.save('abc');
    assert.equal(readDraft('k', s), '', 'nothing written before the delay');
    await until(() => readDraft('k', s) === 'abc');
    saver.save('abcd');
    saver.flush();
    assert.equal(readDraft('k', s), 'abcd', 'flush writes immediately');
    saver.save('pending');
    saver.clear();
    await sleep(50);
    assert.equal(readDraft('k', s), '', 'clear cancels the pending write and deletes');
  });
});

/* ================================================================== labels */
describe('entry-labels', () => {
  test('normalizeLabel lowercases, strips #, collapses space, caps length', () => {
    assert.equal(normalizeLabel('  #Work  Stress '), 'work stress');
    assert.equal(normalizeLabel('x'.repeat(40)).length, 24);
    assert.equal(normalizeLabel('😀'.repeat(30), 24), '😀'.repeat(24));
    assert.equal(normalizeLabel('\u0000\u0007'), '');
    assert.equal(normalizeLabel(null), '');
  });
  test('addLabel enforces duplicates and limits', () => {
    const lim = LABEL_LIMITS.emotions;
    let list = [];
    for (const w of ['calm', 'Calm', 'happy', '', 'tired', 'anxious', 'hopeful', 'extra']) list = addLabel(list, w, lim).list;
    assert.deepEqual(list, ['calm', 'happy', 'tired', 'anxious', 'hopeful']);
    assert.equal(addLabel(list, 'x', lim).reason, 'full');
    assert.equal(addLabel(['calm'], 'CALM', lim).reason, 'duplicate');
    assert.equal(addLabel([], '  ', lim).reason, 'empty');
    assert.equal(addLabel([], 'ok', lim).added, 'ok');
  });
  test('addLabel does not mutate its input; removeLabel works', () => {
    const list = ['a'];
    addLabel(list, 'b', LABEL_LIMITS.tags);
    assert.deepEqual(list, ['a']);
    assert.deepEqual(removeLabel(['a', 'b'], 'a'), ['b']);
  });
  test('limits match the architecture', () => {
    assert.deepEqual({ ...LABEL_LIMITS.emotions }, { max: 5, maxLen: 24 });
    assert.deepEqual({ ...LABEL_LIMITS.tags }, { max: 8, maxLen: 24 });
  });
});

/* ================================================================== date field */
describe('entry-date', () => {
  test('committableDate accepts real dates the server accepts', () => {
    assert.equal(committableDate('2025-09-15'), '2025-09-15');
    assert.equal(committableDate('2024-02-29'), '2024-02-29');
    assert.equal(committableDate('1000-01-01'), '1000-01-01');
    assert.equal(committableDate('9999-12-31'), '9999-12-31');
  });
  test('the keystrokes on the way to a four digit year are never committed', () => {
    // Chromium reports a value after every digit typed into the year segment: 0002, 0020, 0202, then 2025.
    for (const partial of ['0002-09-15', '0020-09-15', '0202-09-15', '0999-09-15']) assert.equal(committableDate(partial), null, partial);
    assert.equal(committableDate('2025-09-15'), '2025-09-15');
  });
  test('rejects empty, malformed and impossible dates', () => {
    for (const bad of ['', null, undefined, 20250915, '2025-9-15', '2025-13-01', '2025-02-30', '2023-02-29', '12025-01-01', '2025-09-15 ', 'abcd-ef-gh', '2025-00-10']) {
      assert.equal(committableDate(bad), null, String(bad));
    }
  });
});

/* ================================================================== thread shape */
describe('entry-thread', () => {
  const user = { id: 'u', role: 'user', content: 'x' };
  const reply = { id: 'r', role: 'assistant', content: 'y', meta: { kind: 'reply' } };
  const safety = { id: 's', role: 'assistant', content: 'z', meta: { kind: 'safety' } };

  test('isSafetyMessage only matches assistant safety cards', () => {
    assert.equal(isSafetyMessage(safety), true);
    assert.equal(isSafetyMessage(reply), false);
    assert.equal(isSafetyMessage(user), false);
    assert.equal(isSafetyMessage({ role: 'user', meta: { kind: 'safety' } }), false);
    assert.equal(isSafetyMessage(null), false);
    assert.equal(isSafetyMessage({ role: 'assistant' }), false);
  });
  test('trailingMessage skips safety cards, so a user message followed by one still needs a reply', () => {
    assert.equal(trailingMessage([user, safety]), user);
    assert.equal(trailingMessage([reply, user, safety, safety]), user);
    assert.equal(trailingMessage([user, safety, reply]), reply);
    assert.equal(trailingMessage([user]), user);
  });
  test('trailingMessage copes with empty and odd input', () => {
    assert.equal(trailingMessage([]), null);
    assert.equal(trailingMessage([safety]), null);
    assert.equal(trailingMessage(null), null);
    assert.equal(trailingMessage(undefined), null);
  });
});

/* ================================================================== text kept after send */
describe('entry-text: remainderAfterSend', () => {
  test('nothing stays when the box still holds exactly what was sent', () => {
    assert.equal(remainderAfterSend('Sent text.', 'Sent text.'), '');
    assert.equal(remainderAfterSend('  Sent text.\n', 'Sent text.'), '');
    assert.equal(remainderAfterSend('', 'x'), '');
  });
  test('words typed while the request was in flight stay', () => {
    assert.equal(remainderAfterSend('Sent text. MORE typed', 'Sent text.'), 'MORE typed');
    assert.equal(remainderAfterSend('Sent text.\n\nNext thought', 'Sent text.'), 'Next thought');
  });
  test('a trailing space the writer just typed is kept, so the next word does not glue on', () => {
    assert.equal(remainderAfterSend('Sent text. and then ', 'Sent text.'), 'and then ');
  });
  test('text typed before the sent text stays too', () => {
    assert.equal(remainderAfterSend('Intro: Sent text.', 'Sent text.'), 'Intro:');
  });
  test('if the sent text itself was edited nothing is dropped', () => {
    assert.equal(remainderAfterSend('Sent TEXT edited', 'Sent text.'), 'Sent TEXT edited');
  });
  test('unicode and odd input', () => {
    assert.equal(remainderAfterSend('Café ☕ 😀 plus', 'Café ☕ 😀'), 'plus');
    assert.equal(remainderAfterSend(null, 'x'), '');
    assert.equal(remainderAfterSend('keep', undefined), 'keep');
  });
});

/* ================================================================== errors */
describe('entry-errors', () => {
  test('ai_not_configured: saved, no retry, link to #/settings', () => {
    const p = describeProblem({ code: 'ai_not_configured', message: 'x' });
    assert.equal(p.retry, false);
    assert.equal(p.settings.href, '#/settings');
    assert.match(p.message, /Saved/);
  });
  test('ai_disabled links to the general tab', () => {
    const p = describeProblem({ code: 'ai_disabled' });
    assert.equal(p.settings.href, '#/settings?tab=general');
    assert.equal(p.retry, false);
  });
  test('generation_in_progress can be retried', () => {
    const p = describeProblem({ code: 'generation_in_progress' });
    assert.equal(p.retry, true);
    assert.equal(p.tone, 'warn');
  });
  test('auth and model errors offer settings on the active provider tab, plus retry', () => {
    for (const code of ['auth', 'model_not_found', 'bad_base_url']) {
      const p = describeProblem({ code, message: 'm', hint: 'h' }, { providerId: 'gemini', source: 'stream' });
      assert.equal(p.settings.href, '#/settings?tab=gemini', code);
      assert.equal(p.retry, true, code);
      assert.equal(p.message, 'm');
      assert.equal(p.hint, 'h');
    }
    assert.equal(describeProblem({ code: 'auth' }, { providerId: 'nonsense' }).settings.href, '#/settings?tab=general');
  });
  test('a plain rate limit or an unknown failure retries without settings', () => {
    for (const code of ['rate_limit', 'unknown']) {
      const p = describeProblem({ code, message: 'm' }, { source: 'stream' });
      assert.equal(p.settings, null, code);
      assert.equal(p.retry, true, code);
    }
  });
  test('overloaded, timeout and server errors offer Try again AND the way into Settings (on the active provider tab)', () => {
    for (const code of ['overloaded', 'timeout', 'server']) {
      const p = describeProblem({ code, message: 'm', hint: 'switch model in Settings' }, { providerId: 'gemini', source: 'stream' });
      assert.equal(p.retry, true, code);
      assert.deepEqual(p.settings, { href: '#/settings?tab=gemini', label: 'Open settings' }, code);
      assert.equal(p.hint, 'switch model in Settings', code);
      assert.equal(describeProblem({ code }, { providerId: 'local' }).settings.href, '#/settings?tab=local', code);
      assert.equal(describeProblem({ code }).settings.href, '#/settings?tab=general', code);
    }
    assert.equal(describeProblem({ code: 'overloaded' }).tone, 'warn');
    assert.equal(describeProblem({ code: 'server' }).tone, 'error');
  });
  test('the browser being unable to reach our own server still offers no settings link', () => {
    for (const code of ['network']) assert.equal(describeProblem({ code, status: 0 }, { source: 'http' }).settings, null);
  });
  test('our own server being unreachable differs from the provider being unreachable', () => {
    const own = describeProblem({ code: 'network', status: 0, message: 'Could not reach the MyJournal server.', hint: 'Is it running?' });
    assert.equal(own.settings, null);
    assert.equal(own.retry, true);
    const provider = describeProblem({ code: 'network', message: 'Cannot reach Ollama', hint: 'Run ollama serve' }, { providerId: 'local', source: 'stream' });
    assert.equal(provider.settings.href, '#/settings?tab=local');
  });
  test('too-large messages keep the text and say why', () => {
    const p = describeProblem({ code: 'payload_too_large' });
    assert.equal(p.retry, false);
    assert.match(p.hint, /20,000/);
    assert.equal(MAX_MESSAGE_CHARS, 20000);
  });
  test('garbage input still yields a usable problem', () => {
    for (const bad of [undefined, null, {}, 'str', 42]) {
      const p = describeProblem(bad);
      assert.ok(p.message.length > 0);
      assert.ok(['error', 'warn', 'info'].includes(p.tone));
    }
  });
  test('settingsLink', () => {
    assert.equal(settingsLink('ai_not_configured').href, '#/settings');
    assert.equal(settingsLink('auth', 'openai').href, '#/settings?tab=openai');
  });
});

/* ================================================================== streaming maths */
describe('entry-stream', () => {
  test('splitChunk never cuts a surrogate pair', () => {
    assert.deepEqual(splitChunk('abcdef', 3), ['abc', 'def']);
    assert.deepEqual(splitChunk('abc', 10), ['abc', '']);
    const text = 'ab😀cd';
    const [head, rest] = splitChunk(text, 3); // index 2 is the high surrogate
    assert.equal(head + rest, text);
    assert.ok(!/[\ud800-\udbff]$/.test(head), 'head must not end with a lone high surrogate');
    assert.ok(!/^[\udc00-\udfff]/.test(rest), 'rest must not start with a lone low surrogate');
  });

  /** Fake animation frames plus a clock that only moves when the test says so. */
  function fakeFrames() {
    const queue = [];
    const clock = { t: 0 };
    return {
      clock,
      now: () => clock.t,
      schedule: (fn) => { queue.push(fn); return queue.length; },
      cancel: (id) => { queue[id - 1] = null; },
      /** Advance one 60 Hz frame and run what was scheduled. */
      run(ms = 16) { clock.t += ms; const fns = queue.splice(0); for (const fn of fns) if (fn) fn(clock.t); return fns.filter(Boolean).length; },
      get queued() { return queue.filter(Boolean).length; },
    };
  }

  test('revealer batches many pushes into one frame', () => {
    const frames = fakeFrames();
    const out = [];
    const r = createRevealer({ append: (t) => out.push(t), schedule: frames.schedule, cancel: frames.cancel, now: frames.now });
    r.push('Hel'); r.push('lo '); r.push('world');
    assert.deepEqual(out, [], 'nothing is written synchronously');
    assert.equal(frames.queued, 1, 'one frame requested for three pushes');
    frames.run();
    assert.deepEqual(out, ['Hello world']);
    assert.equal(frames.queued, 0);
  });
  test('a big chunk is typed out over several frames and loses no text', () => {
    const frames = fakeFrames();
    let written = '';
    let frameCount = 0;
    const text = 'lorem ipsum 😀 '.repeat(120);
    const r = createRevealer({ append: (t) => { written += t; }, schedule: frames.schedule, cancel: frames.cancel, now: frames.now, onFrame: () => { frameCount += 1; } });
    r.push(text);
    let guard = 0;
    while (frames.run() && guard < 600) guard += 1;
    assert.equal(written, text);
    assert.ok(frameCount > 10, `frames: ${frameCount}`);
    assert.ok(frames.clock.t <= 1300, `finished after ${frames.clock.t} ms`);
    assert.equal(r.pending(), 0);
  });
  test('smooth=false writes the whole backlog in one frame', () => {
    const frames = fakeFrames();
    let written = '';
    const r = createRevealer({ append: (t) => { written += t; }, schedule: frames.schedule, cancel: frames.cancel, now: frames.now, smooth: false });
    r.push('x'.repeat(5000));
    frames.run();
    assert.equal(written.length, 5000);
  });
  test('flush writes the rest immediately; cancel drops it', () => {
    const frames = fakeFrames();
    let written = '';
    const r = createRevealer({ append: (t) => { written += t; }, schedule: frames.schedule, cancel: frames.cancel, now: frames.now });
    r.push('word '.repeat(100));
    frames.run();
    const before = written.length;
    assert.ok(before < 500);
    r.flush();
    assert.equal(written.length, 500);
    assert.equal(frames.run(), 0, 'cancelled frame must not fire');
    r.push('dropped');
    r.cancel();
    frames.run();
    assert.equal(written.length, 500);
    r.push('');
    assert.equal(frames.queued, 0);
  });

  test('scroll maths', () => {
    assert.equal(distanceFromBottom({ scrollHeight: 2000, scrollTop: 1000, clientHeight: 800 }), 200);
    assert.equal(distanceFromBottom({ scrollHeight: 500, scrollTop: 0, clientHeight: 800 }), 0);
    assert.equal(isNearBottom({ scrollHeight: 2000, scrollTop: 1100, clientHeight: 800 }), true);
    assert.equal(isNearBottom({ scrollHeight: 2000, scrollTop: 500, clientHeight: 800 }), false);
    assert.equal(isNearBottom({ scrollHeight: 2000, scrollTop: 1000, clientHeight: 800 }, 300), true);
  });
  test('announcementExcerpt flattens and truncates on a word', () => {
    assert.equal(announcementExcerpt('  a\n\nb   c '), 'a b c');
    const out = announcementExcerpt('word '.repeat(200), 50);
    assert.ok(out.endsWith('…'));
    assert.ok(out.length <= 52);
    assert.equal(announcementExcerpt(null), '');
  });
});

/* ================================================================== history */
describe('history-format: titles and months', () => {
  test('entryTitle falls back to the preview, then a placeholder', () => {
    assert.equal(entryTitle({ title: '  My day ' }), 'My day');
    assert.equal(entryTitle({ title: '', preview: 'Woke up late and\nmissed the bus' }), 'Woke up late and missed the bus');
    assert.match(entryTitle({ title: '', preview: 'word '.repeat(40) }), /…$/);
    assert.equal(entryTitle({ title: '', preview: '' }), 'Untitled entry');
    assert.equal(entryTitle(null), 'Untitled entry');
  });
  test('cardTexts: an untitled entry does not say the same words twice', () => {
    // short entry: the title shows all of it, so there is no second line
    assert.deepEqual(cardTexts({ title: '', preview: 'Garage day. My back hurts but I found my old guitar.' }), { title: 'Garage day. My back hurts but I found my old guitar.', excerpt: '' });
    // longer: the title stops at a word and the second line carries on from there
    const preview = 'Woke up late and missed the bus because my alarm did not go off, so I walked to work in the rain and thought about moving.';
    const { title, excerpt } = cardTexts({ title: '', preview });
    assert.match(title, /^Woke up late and missed the bus because my alarm [a-z ]+…$/);
    assert.ok(title.length <= 60);
    assert.equal(`${title.slice(0, -1)} ${excerpt}`, preview);
    // a titled entry keeps title and preview as they are
    assert.deepEqual(cardTexts({ title: 'Rainy walk', preview: 'Went out in the rain.' }), { title: 'Rainy walk', excerpt: 'Went out in the rain.' });
    // a search excerpt that is only the start of the title is not shown again; one from further in is
    assert.equal(cardTexts({ title: '', preview, snippet: 'Woke up late and missed' }).excerpt, '');
    assert.equal(cardTexts({ title: '', preview, snippet: '…thought about moving.' }).excerpt, '…thought about moving.');
    assert.deepEqual(cardTexts({ title: '', preview: '' }), { title: 'Untitled entry', excerpt: '' });
    assert.deepEqual(cardTexts(null), { title: 'Untitled entry', excerpt: '' });
  });
  test('previewText marks a cut preview, leaves short ones and snippets alone', () => {
    assert.equal(previewText({ preview: 'Short note.' }), 'Short note.');
    assert.equal(previewText({ preview: 'x'.repeat(160) }), `${'x'.repeat(160)}…`);
    assert.equal(previewText({ preview: `${'x'.repeat(160)}.` }), `${'x'.repeat(160)}.`);
    assert.equal(previewText({ preview: 'a\n\n b', snippet: '…match here…' }), '…match here…');
    assert.equal(previewText({ preview: '' }), '');
    assert.equal(previewText(null), '');
  });
  test('monthKey prefers entry.date, falls back to createdAt', () => {
    assert.equal(monthKey({ date: '2026-10-08' }), '2026-10');
    assert.equal(monthKey({ date: 'garbage', createdAt: new Date(2026, 2, 5).getTime() }), '2026-03');
    assert.equal(monthKey({ date: '2026-08-15', createdAt: new Date(2026, 9, 9, 12).getTime() }), '2026-08', 'a backdated entry belongs to the month it is dated in');
    assert.equal(monthKey({}), 'unknown');
    assert.equal(monthStart('2026-10'), '2026-10-01');
    assert.equal(monthStart('unknown'), '');
  });
  /** Feed entries to placeInMonths in the given order; returns [[key, [ids]], ...]. */
  const placed = (entries) => {
    const months = [];
    for (const e of entries) placeInMonths(months, e);
    return months.map((m) => [m.key, m.entries.map((x) => x.id)]);
  };
  test('placeInMonths: entries written on their own day just join the end of their month, as before', () => {
    const e = (id, date) => ({ id, date, createdAt: Date.parse(`${date}T12:00:00Z`) });
    assert.deepEqual(placed([e(1, '2026-10-08'), e(2, '2026-10-02'), e(3, '2026-09-30'), e(4, '2026-09-01')]), [['2026-10', [1, 2]], ['2026-09', [3, 4]]]);
  });
  test('placeInMonths: a backdated entry joins its own month, so no month gets two headings', () => {
    const at = (month, day, hour = 12) => new Date(2026, month - 1, day, hour).getTime();
    const entries = [
      { id: 'T2', date: '2026-10-09', createdAt: at(10, 9, 15) },
      { id: 'Backdated', date: '2026-08-15', createdAt: at(10, 9, 14) }, // written today, dated in August
      { id: 'T1', date: '2026-10-09', createdAt: at(10, 9, 13) },
      { id: 'Sept', date: '2026-09-02', createdAt: at(9, 2) },
      { id: 'Aug', date: '2026-08-20', createdAt: at(8, 20) },
    ];
    assert.deepEqual(placed(entries), [['2026-10', ['T2', 'T1']], ['2026-09', ['Sept']], ['2026-08', ['Aug', 'Backdated']]]);
  });
  test('placeInMonths: the result does not depend on the order the pages arrive in; "unknown" goes last; ties are stable', () => {
    const e = (id, date, createdAt = 0) => ({ id, date, createdAt });
    const list = [e('a', '2026-10-09', 5), e('b', '2026-10-09', 5), e('c', '2026-09-01', 1), { id: 'd', date: 'x' }, e('f', '2026-10-01', 2)];
    const want = [['2026-10', ['b', 'a', 'f']], ['2026-09', ['c']], ['unknown', ['d']]];
    assert.deepEqual(placed(list), want);
    assert.deepEqual(placed([...list].reverse()), want);
    assert.deepEqual(placed([list[2], list[4], list[0], list[3], list[1]]), want);
  });
  test('placeInMonths reports where the card went', () => {
    const months = [];
    assert.deepEqual(placeInMonths(months, { id: 1, date: '2026-10-05', createdAt: 5 }), { monthIndex: 0, entryIndex: 0, newMonth: true });
    assert.deepEqual(placeInMonths(months, { id: 2, date: '2026-10-04', createdAt: 4 }), { monthIndex: 0, entryIndex: 1, newMonth: false });
    assert.deepEqual(placeInMonths(months, { id: 3, date: '2026-10-06', createdAt: 6 }), { monthIndex: 0, entryIndex: 0, newMonth: false });
    assert.deepEqual(placeInMonths(months, { id: 4, date: '2026-11-01', createdAt: 7 }), { monthIndex: 0, entryIndex: 0, newMonth: true });
    assert.deepEqual(placeInMonths(months, { id: 5, date: '2026-09-01', createdAt: 1 }), { monthIndex: 2, entryIndex: 0, newMonth: true });
  });
});

describe('history-format: highlighting', () => {
  const joined = (segs) => segs.map((s) => s.text).join('');
  const marks = (segs) => segs.filter((s) => s.match).map((s) => s.text);

  test('searchTerms mirrors the server tokenizer', () => {
    assert.deepEqual(searchTerms('Work, STRESS & work!'), ['work', 'stress']);
    assert.deepEqual(searchTerms('   '), []);
    assert.deepEqual(searchTerms('"quoted" (parens) a-b'), ['quoted', 'parens', 'a', 'b']);
    assert.deepEqual(searchTerms('😀'), ['😀']);
    assert.deepEqual(searchTerms('日記'), ['日記']);
    assert.equal(searchTerms('x '.repeat(100).replace(/x/g, () => Math.random().toString(36).slice(2, 8))).length <= 32, true);
  });
  test('highlights case-insensitively at word starts (prefix), never mid-word', () => {
    const segs = highlightSegments('Working at the network, work is hard', ['work']);
    assert.deepEqual(marks(segs), ['Work', 'work']);
    assert.equal(joined(segs), 'Working at the network, work is hard');
  });
  test('ignores accents on both sides', () => {
    assert.deepEqual(marks(highlightSegments('Un café très agréable', ['cafe', 'tres'])), ['café', 'très']);
    assert.deepEqual(marks(highlightSegments('naive and naïve', ['naïve'])), ['naive', 'naïve']);
  });
  test('decomposed accents are kept inside the match', () => {
    const text = 'café time';
    const segs = highlightSegments(text, ['cafe']);
    assert.equal(joined(segs), text);
    assert.deepEqual(marks(segs), ['café']);
  });
  test('overlapping and duplicate terms merge into one mark', () => {
    const segs = highlightSegments('journaling every day', ['jour', 'journal', 'journaling']);
    assert.deepEqual(marks(segs), ['journaling']);
  });
  test('emoji and CJK terms match anywhere', () => {
    assert.deepEqual(marks(highlightSegments('good day 😀 yes', ['😀'])), ['😀']);
    assert.deepEqual(marks(highlightSegments('今日の日記です', ['日記'])), ['日記']);
  });
  test('RTL text is preserved verbatim', () => {
    const text = 'اليوم كان يوماً جميلاً';
    const segs = highlightSegments(text, searchTerms('يوما'));
    assert.equal(joined(segs), text);
  });
  test('no terms, no match, empty text', () => {
    assert.deepEqual(highlightSegments('abc', []), [{ text: 'abc', match: false }]);
    assert.deepEqual(highlightSegments('abc', ['zzz']), [{ text: 'abc', match: false }]);
    assert.deepEqual(highlightSegments('', ['a']), []);
    assert.deepEqual(highlightSegments(null, ['a']), []);
  });
  test('hostile text is returned as data, never interpreted', () => {
    const text = '<img src=x onerror=alert(1)> <script>alert(2)</script> javascript:alert(3)';
    const segs = highlightSegments(text, searchTerms('script img'));
    assert.equal(joined(segs), text);
    assert.deepEqual(marks(segs), ['img', 'script', 'script'], 'both <script> and </script>; not the middle of javascript');
  });
  test('regex metacharacters in the query are harmless', () => {
    const text = 'cost is (5+5)* [ok] \\d.+?';
    assert.doesNotThrow(() => highlightSegments(text, ['(5+5)*', '[ok]', '\\d.+?', '.*']));
    assert.equal(joined(highlightSegments(text, searchTerms('(5+5)* [ok] .*'))), text);
  });
  test('huge input is not scanned', () => {
    const big = 'a '.repeat(10_000);
    assert.deepEqual(highlightSegments(big, ['a']), [{ text: big, match: false }]);
  });
  test('many matches stay bounded and fast', () => {
    const text = 'a '.repeat(1900);
    const t0 = Date.now();
    const segs = highlightSegments(text, ['a']);
    assert.equal(joined(segs), text);
    assert.ok(marks(segs).length <= 200);
    assert.ok(Date.now() - t0 < 500);
  });
});

describe('history-format: filters', () => {
  test('parseFilters validates input', () => {
    const f = parseFilters(new URLSearchParams('q=hello&mood=4&tag=work&pinned=1'));
    assert.deepEqual(f, { q: 'hello', mood: 4, tag: 'work', pinned: true });
    assert.deepEqual(parseFilters(new URLSearchParams('mood=9&pinned=yes')), { q: '', mood: null, tag: '', pinned: false });
    assert.deepEqual(parseFilters(null), { q: '', mood: null, tag: '', pinned: false });
    assert.equal(parseFilters(new URLSearchParams(`q=${'x'.repeat(500)}`)).q.length, 200);
  });
  test('filtersToParams and hasActiveFilters', () => {
    assert.equal(filtersToParams({ q: '  ', mood: null, tag: '', pinned: false }).toString(), '');
    assert.equal(hasActiveFilters({ q: ' ', mood: null, tag: '', pinned: false }), false);
    const p = filtersToParams({ q: ' a b ', mood: 2, tag: 'x y', pinned: true });
    assert.equal(p.get('q'), 'a b');
    assert.equal(p.get('mood'), '2');
    assert.equal(p.get('tag'), 'x y');
    assert.equal(p.get('pinned'), '1');
    assert.equal(hasActiveFilters({ q: '', mood: 1, tag: '', pinned: false }), true);
  });
  test('listPath builds API paths; search ignores before and caps the page', () => {
    const none = { q: '', mood: null, tag: '', pinned: false };
    assert.equal(listPath(none), '/entries?limit=30');
    assert.equal(listPath(none, { before: 123, limit: 10 }), '/entries?limit=10&before=123');
    const search = { ...none, q: 'a&b=c' };
    const path = listPath(search, { before: 5, limit: 99 });
    assert.ok(path.includes('q=a%26b%3Dc'), path);
    assert.ok(path.includes('limit=50'));
    assert.ok(!path.includes('before'));
    assert.ok(!path.includes('offset'), 'the first page has no offset');
    // a search continues by position, not by date
    const next = listPath(search, { before: 5, offset: 30, limit: 30 });
    assert.ok(next.includes('offset=30') && next.includes('limit=30') && !next.includes('before'), next);
    assert.ok(!listPath(none, { before: 5, offset: 30 }).includes('offset'), 'a plain list never sends an offset');
  });
  test('roundtrip params -> filters', () => {
    const f = { q: 'tea & cake', mood: 3, tag: 'fam', pinned: true };
    assert.deepEqual(parseFilters(filtersToParams(f)), f);
  });
});

/* ================================================================== today */
describe('today-logic', () => {
  test('groupTemplates keeps canonical category order and appends unknown ones', () => {
    const t = (id, category) => ({ id, category });
    const groups = groupTemplates([t(1, 'Creative'), t(2, 'Daily'), t(3, 'Zeta'), t(4, 'Growth'), t(5, 'Daily'), t(6, 'Alpha'), t(7, undefined)]);
    assert.deepEqual(groups.map((g) => g.category), ['Daily', 'Growth', 'Creative', 'Alpha', 'More', 'Zeta']);
    assert.deepEqual(groups[0].templates.map((x) => x.id), [2, 5]);
    assert.deepEqual(groupTemplates(null), []);
  });
  test('streakInfo', () => {
    assert.equal(streakInfo(null, '2026-10-08'), null);
    assert.equal(streakInfo({ current: 0 }, '2026-10-08'), null);
    const today = streakInfo({ current: 3, lastEntryDate: '2026-10-08' }, '2026-10-08');
    assert.equal(today.label, '3 day streak');
    assert.equal(today.atRisk, false);
    const risk = streakInfo({ current: 1, lastEntryDate: '2026-10-07' }, '2026-10-08');
    assert.equal(risk.label, '1 day streak');
    assert.equal(risk.atRisk, true);
  });
  test('weekEntryCount counts the 7 days ending today only', () => {
    const calendar = [
      { date: '2026-10-08', count: 2 }, { date: '2026-10-02', count: 1 }, { date: '2026-10-01', count: 5 }, { date: '2026-10-09', count: 9 }, { date: 'bad', count: 1 }, null,
    ];
    assert.equal(weekEntryCount(calendar, '2026-10-08'), 3);
    assert.equal(weekEntryCount(undefined, '2026-10-08'), 0);
  });
  test('nudgeState: needs 3 entries and no recent report', () => {
    const now = Date.UTC(2026, 9, 8, 12);
    const calendar = [{ date: '2026-10-08', count: 1 }, { date: '2026-10-06', count: 1 }, { date: '2026-10-04', count: 1 }];
    assert.deepEqual(nudgeState({ calendar, reports: [], today: '2026-10-08', now }), { show: true, count: 3 });
    assert.equal(nudgeState({ calendar: calendar.slice(0, 2), reports: [], today: '2026-10-08', now }).show, false);
    assert.equal(nudgeState({ calendar, reports: [{ createdAt: now - 2 * 86_400_000 }], today: '2026-10-08', now }).show, false);
    assert.equal(nudgeState({ calendar, reports: [{ periodEnd: '2026-10-03', createdAt: 0 }], today: '2026-10-08', now }).show, false);
    assert.equal(nudgeState({ calendar, reports: [{ periodEnd: '2026-09-20', createdAt: now - 20 * 86_400_000 }], today: '2026-10-08', now }).show, true);
    assert.equal(nudgeState({ calendar, reports: null, today: '2026-10-08', now }).show, true);
  });
  test('newEntryBody: a plain entry carries only the writer\'s words', () => {
    assert.deepEqual(newEntryBody({ text: '  Not much. ', date: '2026-10-08' }), { content: 'Not much.', date: '2026-10-08' });
    assert.deepEqual(newEntryBody({ text: 'hi', mood: 4, date: '2026-10-08' }), { content: 'hi', date: '2026-10-08', mood: 4 });
    assert.equal(newEntryBody({ text: null, date: 'd' }).content, '');
  });
  test('newEntryBody: answering the prompt of the day keeps the question out of the written text', () => {
    const body = newEntryBody({ text: 'I felt most myself cooking.', prompt: '  Describe a moment\nthis week.  ', date: '2026-10-08' });
    assert.equal(body.content, 'I felt most myself cooking.');
    assert.equal(body.kind, 'guided');
    assert.equal(body.title, 'Describe a moment this week.');
    assert.ok(!body.content.includes('Describe'));
  });
  test('newEntryBody: an over-long prompt is cut to the title limit without splitting an emoji', () => {
    const body = newEntryBody({ text: 'a', prompt: '😀'.repeat(300), date: 'd' });
    assert.equal(Array.from(body.title).length, 120);
    assert.ok(body.title.endsWith('…'));
    assert.ok(!/[\ud800-\udbff]$/.test(body.title.slice(0, -1)));
  });
  test('newEntryBody: a blank prompt does not turn the entry into a guided one', () => {
    const body = newEntryBody({ text: 'x', prompt: '   ', date: 'd' });
    assert.equal(body.kind, undefined);
    assert.equal(body.title, undefined);
  });
});
