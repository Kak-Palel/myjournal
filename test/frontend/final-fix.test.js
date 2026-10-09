// Pure logic added or changed in the last review round (no DOM): what the Settings page may claim about the provider in use,
// the Insights announcement, the draft clean-up and the advice after a failed test.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clearAllDrafts, DRAFT_PREFIX, writeDraft, readDraft } from '../../public/js/components/entry-draft.js';
import { announceOverview } from '../../public/js/components/insights-logic.js';
import { forgetVerified, nextSteps, providerState, rememberVerified, wasVerified } from '../../public/js/components/settings-logic.js';

/** The part of localStorage the app uses. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    keys: () => [...map.keys()],
  };
}

describe('providerState: "Ready" only for what has been seen to work', () => {
  test('nothing set is "needs", a hosted provider with a key is "ready"', () => {
    assert.equal(providerState({ ready: false, providerId: 'gemini' }), 'needs');
    assert.equal(providerState({ ready: false, providerId: 'local', verified: true, installed: true }), 'needs');
    assert.equal(providerState({ ready: true, providerId: 'gemini' }), 'ready');
    assert.equal(providerState({ ready: true, providerId: 'openai' }), 'ready');
  });

  test('a local model name is "unchecked" until a test passes or the server lists the model', () => {
    assert.equal(providerState({ ready: true, providerId: 'local' }), 'unchecked');
    assert.equal(providerState({ ready: true, providerId: 'local', installed: null }), 'unchecked');
    assert.equal(providerState({ ready: true, providerId: 'local', verified: true }), 'ready');
    assert.equal(providerState({ ready: true, providerId: 'local', installed: true }), 'ready');
    assert.equal(providerState({ ready: true, providerId: 'local', installed: false }), 'missing');
    assert.equal(providerState({ ready: true, providerId: 'local', installed: false, verified: true }), 'ready', 'a passing test outranks a stale list');
  });

  test('a passing test is remembered for that address and model only', () => {
    forgetVerified();
    const local = { baseUrl: 'http://localhost:11434/v1/', model: 'llama3.2:3b' };
    assert.equal(wasVerified('local', local), false);
    rememberVerified('local', local);
    assert.equal(wasVerified('local', local), true);
    assert.equal(wasVerified('local', { baseUrl: 'http://localhost:11434/v1', model: ' llama3.2:3b ' }), true, 'slashes and spaces do not matter');
    assert.equal(wasVerified('local', { ...local, model: 'qwen3:1.7b' }), false, 'another model is another claim');
    assert.equal(wasVerified('local', { ...local, baseUrl: 'http://other:11434/v1' }), false);
    assert.equal(wasVerified('openai', local), false);
    assert.equal(wasVerified('local', null), false);
    forgetVerified();
    assert.equal(wasVerified('local', local), false);
  });
});

describe('announceOverview: the sentence a screen reader hears', () => {
  const overview = (entries, daysWritten) => ({ totals: { entries, daysWritten, words: 10, wrapped: 0 } });

  test('uses the singular for one entry and one day (it said "1 entries, 1 days written")', () => {
    assert.equal(announceOverview(overview(1, 1), '90 days'), 'Showing the last 90 days: 1 entry, 1 day written.');
    assert.equal(announceOverview(overview(2, 1), '30 days'), 'Showing the last 30 days: 2 entries, 1 day written.');
    assert.equal(announceOverview(overview(1, 2), 'year'), 'Showing the last year: 1 entry, 2 days written.');
    assert.equal(announceOverview(overview(1200, 300), '90 days'), 'Showing the last 90 days: 1,200 entries, 300 days written.');
  });

  test('says "No entries yet." for an empty or missing overview', () => {
    assert.equal(announceOverview(overview(0, 0), '90 days'), 'No entries yet.');
    assert.equal(announceOverview(null, '90 days'), 'No entries yet.');
    assert.equal(announceOverview({}, '90 days'), 'No entries yet.');
  });
});

describe('clearAllDrafts: Sign out and Delete everything leave no unsent text behind', () => {
  test('removes every draft (Today and each entry) and nothing else', () => {
    const storage = fakeStorage({
      [`${DRAFT_PREFIX}new`]: 'SECRET one',
      [`${DRAFT_PREFIX}6f9619ff-8b86-d011-b42d-00cf4fc964ff`]: 'SECRET two',
      'mj-theme': 'dark',
      'mj-nudge-dismissed': '2026-10-08',
      'mj-draftish': 'not a draft (no colon)',
    });
    assert.equal(clearAllDrafts(storage), 2);
    assert.deepEqual(storage.keys().sort(), ['mj-draftish', 'mj-nudge-dismissed', 'mj-theme']);
    assert.equal(clearAllDrafts(storage), 0, 'nothing more to remove');
  });

  test('works with the real helpers, an empty store, no store and a store that throws', () => {
    const storage = fakeStorage();
    assert.equal(writeDraft(`${DRAFT_PREFIX}new`, 'text', storage), true);
    assert.equal(readDraft(`${DRAFT_PREFIX}new`, storage), 'text');
    assert.equal(clearAllDrafts(storage), 1);
    assert.equal(readDraft(`${DRAFT_PREFIX}new`, storage), '');
    assert.equal(clearAllDrafts(fakeStorage()), 0);
    assert.equal(clearAllDrafts(null), 0);
    const broken = { get length() { throw new Error('blocked'); }, key() { return null; }, removeItem() {} };
    assert.equal(clearAllDrafts(broken), 0);
  });
});

describe('nextSteps after a failed test', () => {
  test('a missing local model: one list that carries the whole advice (the card hides the server hint)', () => {
    const steps = nextSteps('local', 'model_not_found', { model: 'llama3.2:3b' });
    assert.equal(steps.length, 2);
    assert.equal(steps[0].command, 'ollama pull llama3.2:3b');
    assert.match(steps[1].text, /Download model/);
    assert.ok(steps.every((s) => !/in Settings/.test(s.text)), 'and none of it points to Settings, which is where the person is');
  });

  test('network and timeout errors of an OpenAI-compatible service mention the proxy variable, like the Gemini ones do', () => {
    for (const code of ['network', 'timeout']) {
      assert.ok(nextSteps('openai', code).some((s) => /NODE_USE_ENV_PROXY=1/.test(s.text)), code);
      assert.ok(nextSteps('gemini', code).some((s) => /NODE_USE_ENV_PROXY=1/.test(s.text)), code);
    }
  });
});
