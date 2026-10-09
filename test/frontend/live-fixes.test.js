// Pure-logic tests for the fixes that followed the live verification rounds (real Gemini, real Ollama / llama.cpp, browser
// audit): request bodies with the browser's date, where to return after signing in, the on-screen keyboard inset, the
// "key found in the environment" welcome badges, installed-model detection and the privacy wording. No DOM.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { replyBody, wrapUpBody } from '../../public/js/components/entry-request.js';
import { returnAddress, postLoginHash } from '../../public/js/lib/return-to.js';
import { MIN_KEYBOARD_PX, occludedInset, watchKeyboardInset } from '../../public/js/lib/keyboard-inset.js';
import { envKeyBadgeText, envKeysFound, isModelInstalled, setupSteps } from '../../public/js/components/settings-logic.js';
import {
  DATA_SENT_WITH_A_REPLY, PRIVATE_FLAG_TITLE, PRIVATE_MEMORY_TEXT, PRIVATE_MENU_DESCRIPTION, PRIVATE_STILL_SENT,
} from '../../public/js/components/privacy-copy.js';

/* ============================================================ "today" in reply and wrap-up requests */
describe('entry requests carry the browser date', () => {
  // 2026-10-08 23:30 local time: a server in UTC could already be on the 9th (or still on the 7th), the browser knows better.
  const lateEvening = new Date(2026, 9, 8, 23, 30);
  test('reply: regenerate flag and today', () => {
    assert.deepEqual(replyBody(false, lateEvening), { regenerate: false, today: '2026-10-08' });
    assert.deepEqual(replyBody(true, lateEvening), { regenerate: true, today: '2026-10-08' });
    assert.deepEqual(replyBody(undefined, lateEvening), { regenerate: false, today: '2026-10-08' });
  });
  test('wrap-up: today', () => {
    assert.deepEqual(wrapUpBody(lateEvening), { today: '2026-10-08' });
  });
  test('local calendar date, zero padded, also on the first and last days of a year', () => {
    assert.equal(wrapUpBody(new Date(2027, 0, 1, 0, 5)).today, '2027-01-01');
    assert.equal(wrapUpBody(new Date(2026, 11, 31, 23, 59)).today, '2026-12-31');
  });
  test('without an argument it is today', () => {
    assert.match(wrapUpBody().today, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(replyBody(true).today, /^\d{4}-\d{2}-\d{2}$/);
  });
});

/* ============================================================ coming back after the sign-in page */
describe('return to the page that was asked for', () => {
  test('returnAddress remembers real pages and never the sign-in page or nothing', () => {
    assert.equal(returnAddress('#/history?mood=4'), '#/history?mood=4');
    assert.equal(returnAddress('#/entry/abc-123?reply=1'), '#/entry/abc-123?reply=1');
    assert.equal(returnAddress('#/settings?tab=data'), '#/settings?tab=data');
    assert.equal(returnAddress('#/'), '#/');
    assert.equal(returnAddress('#/login'), '');
    assert.equal(returnAddress('#/login?x=1'), '');
    assert.equal(returnAddress('#'), '');
    assert.equal(returnAddress(''), '');
    assert.equal(returnAddress(undefined), '');
    assert.equal(returnAddress(null), '');
  });

  test('after the sign-in page the person lands on the remembered page', () => {
    assert.equal(postLoginHash({ current: '#/login', intended: '#/history?mood=4', onboarded: true }), '#/history?mood=4');
    assert.equal(postLoginHash({ current: '#/login', intended: '#/entry/abc', onboarded: true }), '#/entry/abc');
  });
  test('nothing remembered (or only the sign-in page itself): Today', () => {
    assert.equal(postLoginHash({ current: '#/login', intended: '', onboarded: true }), '#/');
    assert.equal(postLoginHash({ current: '#/login', intended: '#/login', onboarded: true }), '#/');
    assert.equal(postLoginHash({ current: '#/login', intended: undefined, onboarded: true }), '#/');
  });
  test('a journal nobody has set up yet still starts with the welcome screen when the target would be Today', () => {
    assert.equal(postLoginHash({ current: '#/login', intended: '', onboarded: false }), '#/welcome');
    assert.equal(postLoginHash({ current: '#/login', intended: '#/', onboarded: false }), '#/welcome');
    // a deep link is respected even then
    assert.equal(postLoginHash({ current: '#/login', intended: '#/settings?tab=local', onboarded: false }), '#/settings?tab=local');
  });
  test('already on another page (signed in at boot): keep the address, except for the welcome rule', () => {
    assert.equal(postLoginHash({ current: '#/history', intended: '', onboarded: true }), null);
    assert.equal(postLoginHash({ current: '#/entry/abc', intended: '#/memory', onboarded: true }), null, 'the remembered page only matters after the sign-in page');
    assert.equal(postLoginHash({ current: '', intended: '', onboarded: false }), '#/welcome');
    assert.equal(postLoginHash({ current: '#/', intended: '', onboarded: false }), '#/welcome');
    assert.equal(postLoginHash({ current: '#/history', intended: '', onboarded: false }), null);
  });
});

/* ============================================================ on-screen keyboard */
describe('keyboard inset: occludedInset', () => {
  test('no keyboard: the visual viewport is the layout viewport', () => {
    assert.equal(occludedInset({ layoutHeight: 844, viewportHeight: 844, offsetTop: 0, scale: 1 }), 0);
    assert.equal(occludedInset({ layoutHeight: 844, viewportHeight: 843.5, offsetTop: 0, scale: 1 }), 0, 'rounding noise is not a keyboard');
  });
  test('an iOS-style keyboard covers the bottom of the layout viewport', () => {
    assert.equal(occludedInset({ layoutHeight: 844, viewportHeight: 508, offsetTop: 0, scale: 1 }), 336);
  });
  test('the visual viewport scrolled inside the layout viewport: only what is below it counts', () => {
    assert.equal(occludedInset({ layoutHeight: 844, viewportHeight: 508, offsetTop: 120, scale: 1 }), 216);
    assert.equal(occludedInset({ layoutHeight: 844, viewportHeight: 508, offsetTop: 336, scale: 1 }), 0, 'scrolled all the way down: nothing covers the bottom');
    assert.equal(occludedInset({ layoutHeight: 844, viewportHeight: 508, offsetTop: -30, scale: 1 }), 336, 'a negative offset (rubber banding) is treated as 0');
  });
  test('small differences are toolbars, not keyboards', () => {
    assert.equal(occludedInset({ layoutHeight: 844, viewportHeight: 844 - (MIN_KEYBOARD_PX - 1) }), 0);
    assert.equal(occludedInset({ layoutHeight: 844, viewportHeight: 844 - MIN_KEYBOARD_PX }), MIN_KEYBOARD_PX);
    assert.equal(occludedInset({ layoutHeight: 844, viewportHeight: 760 }, { min: 50 }), 84);
  });
  test('a pinch-zoomed page shrinks the visual viewport but nothing covers it', () => {
    assert.equal(occludedInset({ layoutHeight: 844, viewportHeight: 422, offsetTop: 0, scale: 2 }), 0);
    assert.equal(occludedInset({ layoutHeight: 844, viewportHeight: 508, offsetTop: 0, scale: 1.01 }), 336, 'a hair above 1 still counts as unzoomed');
  });
  test('garbage in, zero out', () => {
    assert.equal(occludedInset(), 0);
    assert.equal(occludedInset(null), 0);
    assert.equal(occludedInset({}), 0);
    assert.equal(occludedInset({ layoutHeight: NaN, viewportHeight: 100 }), 0);
    assert.equal(occludedInset({ layoutHeight: 800, viewportHeight: 'x' }), 0);
    assert.equal(occludedInset({ layoutHeight: 800, viewportHeight: 400, scale: NaN }), 0);
    assert.equal(occludedInset({ layoutHeight: Infinity, viewportHeight: 400 }), 0);
  });
});

/** A visualViewport, a window and a document that are just enough for watchKeyboardInset. */
function fakeBrowser({ layoutHeight = 844, vv = { height: 844, offsetTop: 0, scale: 1 }, withViewport = true } = {}) {
  const listeners = { vv: new Map(), win: new Map() };
  const addTo = (bucket) => (type, fn) => { bucket.set(type, new Set([...(bucket.get(type) || []), fn])); };
  const removeFrom = (bucket) => (type, fn) => { const set = bucket.get(type); if (set) set.delete(fn); };
  const visualViewport = withViewport ? { ...vv, addEventListener: addTo(listeners.vv), removeEventListener: removeFrom(listeners.vv) } : undefined;
  const props = new Map();
  const frames = [];
  const root = { clientHeight: layoutHeight, style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k), getPropertyValue: (k) => props.get(k) || '' } };
  const win = {
    visualViewport,
    addEventListener: addTo(listeners.win),
    removeEventListener: removeFrom(listeners.win),
  };
  return {
    win, doc: { documentElement: root }, root, vv: visualViewport, props, frames,
    raf: (fn) => { frames.push(fn); return frames.length; },
    caf: (id) => { frames[id - 1] = null; },
    flush() { const pending = frames.splice(0); for (const fn of pending) if (fn) fn(); },
    fire(target, type) { for (const fn of listeners[target].get(type) || []) fn(); },
    count(target) { return [...listeners[target].values()].reduce((n, set) => n + set.size, 0); },
  };
}

describe('keyboard inset: watchKeyboardInset', () => {
  test('without visualViewport it does nothing and returns a harmless stop function', () => {
    const b = fakeBrowser({ withViewport: false });
    const stop = watchKeyboardInset({ win: b.win, doc: b.doc, raf: b.raf, caf: b.caf });
    assert.equal(typeof stop, 'function');
    assert.equal(b.frames.length, 0);
    stop();
    assert.doesNotThrow(() => watchKeyboardInset({ win: {}, doc: {} }));
    assert.doesNotThrow(() => watchKeyboardInset({ win: undefined, doc: undefined })); // Node: no window at all
    assert.doesNotThrow(() => watchKeyboardInset());
  });

  test('desktop / nothing covered: the property is never set', () => {
    const b = fakeBrowser();
    watchKeyboardInset({ win: b.win, doc: b.doc, raf: b.raf, caf: b.caf });
    b.flush();
    b.fire('vv', 'resize'); b.fire('vv', 'scroll'); b.fire('win', 'resize');
    b.flush();
    assert.equal(b.props.size, 0);
    assert.equal(b.root.style.getPropertyValue('--kb-inset'), '');
  });

  test('keyboard opens, scrolls and closes', () => {
    const b = fakeBrowser();
    const stop = watchKeyboardInset({ win: b.win, doc: b.doc, raf: b.raf, caf: b.caf });
    b.flush();
    assert.equal(b.props.size, 0);

    b.vv.height = 508; // the keyboard slides in: many events, one measurement
    b.fire('vv', 'resize'); b.fire('vv', 'resize'); b.fire('vv', 'scroll');
    assert.equal(b.frames.length, 1, 'events within a frame are coalesced');
    b.flush();
    assert.equal(b.props.get('--kb-inset'), '336px');

    b.vv.offsetTop = 100; // iOS pans the visual viewport to keep the caret visible
    b.fire('vv', 'scroll');
    b.flush();
    assert.equal(b.props.get('--kb-inset'), '236px');

    b.vv.height = 844; b.vv.offsetTop = 0; // keyboard dismissed
    b.fire('vv', 'resize');
    b.flush();
    assert.equal(b.props.has('--kb-inset'), false, 'removed, not left at 0px');

    stop();
  });

  test('rotation: the layout viewport changes and the window resize event re-measures', () => {
    const b = fakeBrowser({ layoutHeight: 844, vv: { height: 500, offsetTop: 0, scale: 1 } });
    watchKeyboardInset({ win: b.win, doc: b.doc, raf: b.raf, caf: b.caf });
    b.flush();
    assert.equal(b.props.get('--kb-inset'), '344px');
    b.root.clientHeight = 390; b.vv.height = 390; // landscape, keyboard gone
    b.fire('win', 'resize');
    b.flush();
    assert.equal(b.props.has('--kb-inset'), false);
  });

  test('pinch zoom is not a keyboard', () => {
    const b = fakeBrowser({ vv: { height: 422, offsetTop: 0, scale: 2 } });
    watchKeyboardInset({ win: b.win, doc: b.doc, raf: b.raf, caf: b.caf });
    b.flush();
    assert.equal(b.props.size, 0);
  });

  test('stop removes the listeners, cancels a pending measurement and clears the property', () => {
    const b = fakeBrowser({ vv: { height: 500, offsetTop: 0, scale: 1 } });
    const stop = watchKeyboardInset({ win: b.win, doc: b.doc, raf: b.raf, caf: b.caf });
    b.flush();
    assert.equal(b.props.get('--kb-inset'), '344px');
    assert.equal(b.count('vv'), 2);
    assert.equal(b.count('win'), 1);
    b.vv.height = 844;
    b.fire('vv', 'resize'); // a measurement is pending ...
    stop(); // ... when the app lets go
    b.flush();
    assert.equal(b.count('vv'), 0);
    assert.equal(b.count('win'), 0);
    assert.equal(b.props.has('--kb-inset'), false);
  });
});

/* ============================================================ welcome screen: keys found in the environment */
describe('welcome screen: keys the server found in its environment', () => {
  const rows = [
    { id: 'gemini', needsKey: true, keySource: 'env', configured: true },
    { id: 'openai', needsKey: true, keySource: 'none', configured: false },
    { id: 'local', needsKey: false, keySource: 'env', configured: true },
  ];
  test('names the variable for Gemini and OpenAI only', () => {
    assert.deepEqual(envKeysFound(rows), { gemini: 'GEMINI_API_KEY' });
    assert.deepEqual(envKeysFound([{ id: 'openai', needsKey: true, keySource: 'env' }, { id: 'gemini', needsKey: true, keySource: 'settings' }]), { openai: 'OPENAI_API_KEY' });
    assert.deepEqual(envKeysFound([{ id: 'gemini', needsKey: true, keySource: 'env' }, { id: 'openai', needsKey: true, keySource: 'env' }]), { gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' });
  });
  test('a saved key or no key is not "found in the environment"', () => {
    assert.deepEqual(envKeysFound([{ id: 'gemini', needsKey: true, keySource: 'settings' }, { id: 'openai', keySource: 'none' }]), {});
  });
  test('tolerates anything the answer might look like, and never carries a key', () => {
    for (const bad of [undefined, null, {}, 'x', [], [null], [{}], [{ id: 'nope', keySource: 'env' }]]) assert.deepEqual(envKeysFound(bad), {});
    const secret = 'AIzaSyThisMustNeverShowUp1234567890';
    const out = envKeysFound([{ id: 'gemini', needsKey: true, keySource: 'env', apiKey: secret, key: secret }]);
    assert.ok(!JSON.stringify(out).includes(secret));
  });
  test('the badge text', () => {
    assert.equal(envKeyBadgeText('gemini'), 'Found GEMINI_API_KEY in your environment');
    assert.equal(envKeyBadgeText('openai'), 'Found OPENAI_API_KEY in your environment');
  });
  test('setup banner: one step when the key is there, the usual two otherwise', () => {
    assert.equal(setupSteps('gemini', { keyFromEnv: true }).length, 1);
    assert.match(setupSteps('gemini', { keyFromEnv: true })[0], /GEMINI_API_KEY.*Test connection/);
    assert.match(setupSteps('openai', { keyFromEnv: true })[0], /OPENAI_API_KEY/);
    assert.equal(setupSteps('gemini').length, 2);
    assert.equal(setupSteps('gemini', { keyFromEnv: false }).length, 2);
    assert.equal(setupSteps('local', { keyFromEnv: true }).length, 2, 'the local model never needs a key, so there is no shortcut to show');
  });
});

/* ============================================================ local models: "already installed" */
describe('isModelInstalled', () => {
  const loaded = [{ id: 'llama3.2:3b' }, { id: 'qwen3:1.7b' }, { id: 'mistral:latest' }];
  test('exact names', () => {
    assert.equal(isModelInstalled('llama3.2:3b', loaded), true);
    assert.equal(isModelInstalled('  qwen3:1.7b ', loaded), true);
    assert.equal(isModelInstalled('llama3.2:1b', loaded), false, 'a different tag is a different download');
    assert.equal(isModelInstalled('llama3.2', loaded), false, 'untagged means :latest, which is not installed');
  });
  test('an untagged name means :latest, as it does for ollama pull', () => {
    assert.equal(isModelInstalled('mistral', loaded), true);
    assert.equal(isModelInstalled('mistral:latest', loaded), true);
    assert.equal(isModelInstalled('Mistral', loaded), true, 'model names are not case sensitive for this purpose');
  });
  test('nothing listed, nothing typed, or a bad list', () => {
    assert.equal(isModelInstalled('llama3.2:3b', []), false);
    assert.equal(isModelInstalled('', loaded), false);
    assert.equal(isModelInstalled(undefined, loaded), false);
    assert.equal(isModelInstalled('llama3.2:3b', undefined), false);
    assert.equal(isModelInstalled('llama3.2:3b', [null, {}, { id: 5 }]), false);
  });
});

/* ============================================================ privacy wording */
describe('privacy wording matches what the app really does', () => {
  test('a reply sends everything docs/PRIVACY.md lists, and says nothing else is sent', () => {
    for (const part of ['current conversation', 'today\'s date', 'your name and “About you” text', 'companion\'s style', 'description you wrote', 'memories', 'mood', 'guided session', 'Recall related past entries', 'never private ones', 'nothing else']) {
      assert.ok(DATA_SENT_WITH_A_REPLY.includes(part), `the Data tab says: ${part}`);
    }
    assert.ok(DATA_SENT_WITH_A_REPLY.startsWith('Nothing leaves your computer unless the AI companion is on.'));
  });
  test('every description of Private says the provider still writes the replies, and what keeps text away from it', () => {
    assert.match(PRIVATE_STILL_SENT, /still written by your AI provider/);
    assert.match(PRIVATE_STILL_SENT, /Save without reply/);
    for (const text of [PRIVATE_MENU_DESCRIPTION, PRIVATE_FLAG_TITLE, PRIVATE_MEMORY_TEXT]) {
      assert.ok(text.includes(PRIVATE_STILL_SENT), text);
      assert.match(text, /memory/);
      assert.match(text, /weekly reflections/);
    }
  });
  test('no description still claims private entries are never used', () => {
    for (const text of [PRIVATE_MENU_DESCRIPTION, PRIVATE_FLAG_TITLE, PRIVATE_MEMORY_TEXT]) assert.doesNotMatch(text, /never used/i);
  });
});
