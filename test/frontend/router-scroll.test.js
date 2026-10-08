// Back / Forward scroll restoration helpers of the router (public/js/lib/router.js), run against tiny fakes of the
// browser globals they use.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceHash, restoreScroll, stampEntry } from '../../public/js/lib/router.js';

const saved = {};
const KEYS = ['window', 'document', 'history', 'requestAnimationFrame', 'performance'];
let frames;
let listeners;
let clock;
let scrolledTo;
let page;

function install() {
  for (const k of KEYS) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  frames = [];
  listeners = new Map();
  clock = 0;
  scrolledTo = [];
  page = { scrollHeight: 800, innerHeight: 600, state: null, url: 'http://x/#/history', replaced: [] };
  const define = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  define('window', {
    get innerHeight() { return page.innerHeight; },
    location: { get href() { return page.url; } },
    scrollTo: (x, y) => scrolledTo.push(y),
    addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener: (type, fn) => { listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn)); },
  });
  define('document', { documentElement: { get scrollHeight() { return page.scrollHeight; } } });
  define('history', {
    get state() { return page.state; },
    replaceState: (state, _title, url) => { page.state = state; page.replaced.push(url); },
  });
  define('requestAnimationFrame', (fn) => { frames.push(fn); return frames.length; });
  define('performance', { now: () => clock });
}
function restore() {
  for (const k of KEYS) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k];
  }
}
const runFrame = (advance = 16) => { clock += advance; const fns = frames.splice(0); for (const fn of fns) fn(clock); };

describe('history entry keys', () => {
  beforeEach(install);
  afterEach(restore);

  test('an entry without a key gets one; the same entry keeps it', () => {
    const first = stampEntry(1);
    assert.equal(first.fresh, true);
    assert.match(first.key, /^e/);
    assert.equal(page.state.mjKey, first.key);
    const again = stampEntry(2);
    assert.deepEqual(again, { key: first.key, fresh: false });
  });
  test('stamping keeps other state that was already there', () => {
    page.state = { other: 1 };
    const { key } = stampEntry(3);
    assert.deepEqual(page.state, { other: 1, mjKey: key });
  });
  test('two different entries get different keys', () => {
    const a = stampEntry(1).key;
    page.state = null;
    const b = stampEntry(2).key;
    assert.notEqual(a, b);
  });
  test('replaceHash tidies the address but keeps the key', () => {
    const { key } = stampEntry(1);
    replaceHash('#/history?q=run');
    assert.equal(page.state.mjKey, key);
    assert.equal(page.replaced.at(-1), '#/history?q=run');
  });
});

describe('restoreScroll', () => {
  beforeEach(install);
  afterEach(restore);

  test('waits until the page is tall enough, then jumps to the saved position', () => {
    page.scrollHeight = 700; // room = 100
    restoreScroll(1500, () => true);
    runFrame();
    runFrame();
    assert.deepEqual(scrolledTo, [], 'not yet: the list is still loading');
    page.scrollHeight = 2300; // room = 1700
    runFrame();
    assert.deepEqual(scrolledTo, [1500]);
    assert.equal(frames.length, 0, 'it stops asking for frames');
    assert.equal((listeners.get('wheel') || []).length, 0, 'its input listeners are gone');
  });
  test('gives up after the time limit and goes as far as it can', () => {
    page.scrollHeight = 1000; // room = 400, target far beyond
    restoreScroll(5000, () => true, 1500);
    for (let i = 0; i < 80 && frames.length; i += 1) runFrame(40);
    assert.deepEqual(scrolledTo, [400]);
  });
  test('leaves the page alone once the person scrolls, types or touches it', () => {
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
      scrolledTo.length = 0;
      page.scrollHeight = 700;
      restoreScroll(900, () => true);
      runFrame();
      for (const fn of listeners.get(type) || []) fn();
      page.scrollHeight = 5000;
      runFrame();
      runFrame();
      assert.deepEqual(scrolledTo, [], `${type} cancels the restore`);
    }
  });
  test('does nothing when another navigation has already replaced this one', () => {
    let current = true;
    page.scrollHeight = 700;
    restoreScroll(900, () => current);
    runFrame();
    current = false;
    page.scrollHeight = 5000;
    runFrame();
    assert.deepEqual(scrolledTo, []);
  });
});
