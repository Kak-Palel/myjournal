// The streaming reveal (public/js/components/entry-stream.js), tested against a virtual clock and virtual animation
// frames: a few big Gemini-style frames must be typed out word by word within a bounded time, token-sized streams
// from local models must show up with no added lag, and Stop / errors must show everything at once.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REVEAL_DEFAULTS, createRevealer, wordCut, wordEnds, requiredRate, splitChunk,
} from '../../public/js/components/entry-stream.js';

const FRAME_MS = 1000 / 60;

/**
 * Run a revealer against a timeline. `arrivals` = [{ at, text }] in ms; `finishAt` calls finish(); `flushAt` calls flush().
 * Returns what was shown when, so tests can assert on lag, pacing and word boundaries.
 */
async function simulate({ arrivals, finishAt = null, flushAt = null, smooth = true, tuning, until = 20_000 }) {
  let t = 0;
  const callbacks = [];
  const timers = [];
  const shown = []; // { t, chunk, total }
  let total = '';
  const r = createRevealer({
    append: (chunk) => { total += chunk; shown.push({ t, chunk, total: total.length }); },
    schedule: (fn) => { callbacks.push(fn); return callbacks.length; },
    cancel: (id) => { callbacks[id - 1] = null; },
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ at: t + ms, fn, live: true }); return timers.length; },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
    smooth,
    tuning,
  });
  const pending = [...arrivals].sort((a, b) => a.at - b.at);
  const arrivedChars = []; // { at, upTo }
  let received = 0;
  let finished = null;
  let finishCalled = false;
  let flushCalled = false;
  for (let frame = 1; frame * FRAME_MS <= until; frame += 1) {
    const f = frame * FRAME_MS;
    while (pending.length && pending[0].at <= f) {
      const a = pending.shift();
      t = a.at;
      r.push(a.text);
      received += a.text.length;
      arrivedChars.push({ at: a.at, upTo: received });
    }
    t = f;
    if (flushAt !== null && !flushCalled && t >= flushAt) { flushCalled = true; r.flush(); }
    if (finishAt !== null && !finishCalled && t >= finishAt) { finishCalled = true; r.finish().then(() => { finished = t; }); }
    for (const tm of timers) if (tm.live && tm.at <= t) { tm.live = false; tm.fn(); }
    const run = callbacks.splice(0);
    for (const fn of run) if (fn) fn(t);
    await Promise.resolve(); // let promise continuations (finish().then) run at this virtual time
    await Promise.resolve();
    if (!pending.length && r.pending() === 0 && (finishAt === null || finished !== null || !finishCalled)) {
      if (finishAt === null || finishCalled) break;
    }
  }
  return { shown, total, received, arrivedChars, finished, revealer: r, endTime: t };
}

/** Largest delay between a character arriving and being shown (ms). */
function maxLag({ shown, arrivedChars }) {
  let worst = 0;
  for (const s of shown) {
    // every character up to s.total was shown at s.t; the newest of them arrived at the first arrival whose upTo >= its index
    let prevShown = shown[shown.indexOf(s) - 1];
    const from = prevShown ? prevShown.total : 0;
    for (const a of arrivedChars) {
      if (a.upTo > from) { worst = Math.max(worst, s.t - a.at); break; } // the oldest newly shown character
    }
  }
  return worst;
}

const bigReply = [
  'That sounds like a heavy night, with your mind running through every what-if. ',
  'Which one of those worries feels the loudest right now? Take your time with it, ',
  'and write whatever comes up, even if it does not make sense yet.',
];

describe('stream reveal: three big frames (Gemini-style)', () => {
  const arrivals = [{ at: 1000, text: bigReply[0] }, { at: 1150, text: bigReply[1] }, { at: 1290, text: bigReply[2] }];
  const fullText = bigReply.join('');

  test('is typed out progressively, word by word, and nothing is lost', async () => {
    const sim = await simulate({ arrivals, finishAt: 1295 });
    assert.equal(sim.total === undefined ? '' : sim.shown.map((s) => s.chunk).join(''), fullText);
    assert.ok(sim.shown.length >= 25, `only ${sim.shown.length} steps: not progressive`);
    // word-wise: every step except the last ends at a word boundary (a space or punctuation follows or ends it)
    let prefix = '';
    for (const s of sim.shown.slice(0, -1)) {
      prefix += s.chunk;
      assert.ok(/[\s,.?!-]$/.test(prefix) || /^[\s,.?!]/.test(fullText.slice(prefix.length)), `step cut inside a word: "...${prefix.slice(-12)}|${fullText.slice(prefix.length, prefix.length + 6)}"`);
    }
  });

  test('adds at most the 1.2 s bound: every character is shown within maxLagMs (+1 frame) of arriving', async () => {
    const sim = await simulate({ arrivals, finishAt: 1295 });
    const lag = maxLag(sim);
    assert.ok(lag <= REVEAL_DEFAULTS.maxLagMs + FRAME_MS + 1, `worst lag ${lag.toFixed(0)} ms`);
    assert.ok(lag > 300, `the reveal should actually take a visible while, got ${lag.toFixed(0)} ms`);
  });

  test('finish() resolves after the typing ends, never later than maxLagMs after the last arrival', async () => {
    const sim = await simulate({ arrivals, finishAt: 1295 });
    assert.ok(sim.finished !== null, 'finish() must resolve');
    assert.ok(sim.finished <= 1290 + REVEAL_DEFAULTS.maxLagMs + FRAME_MS + 1, `finished at ${sim.finished}`);
    assert.equal(sim.revealer.pending(), 0);
  });

  test('never slower than the data arrival: what is shown keeps up with a steady stream of big frames', async () => {
    // 45 frames of ~110 characters, 90 ms apart (the live 900-word answer)
    const words = 'word '.repeat(3000);
    const steady = Array.from({ length: 45 }, (_, i) => ({ at: 500 + i * 90, text: words.slice(i * 110, (i + 1) * 110) }));
    const sim = await simulate({ arrivals: steady, finishAt: 500 + 44 * 90 + 5 });
    const lag = maxLag(sim);
    assert.ok(lag <= REVEAL_DEFAULTS.maxLagMs + FRAME_MS + 1, `worst lag ${lag.toFixed(0)} ms`);
    assert.equal(sim.shown.map((s) => s.chunk).join(''), words.slice(0, 45 * 110));
    assert.ok(sim.finished <= 500 + 44 * 90 + REVEAL_DEFAULTS.maxLagMs + 2 * FRAME_MS, `finished at ${sim.finished}`);
  });

  test('flush shows everything immediately (Stop, error)', async () => {
    const sim = await simulate({ arrivals, flushAt: 1300 });
    const last = sim.shown[sim.shown.length - 1];
    assert.equal(sim.shown.map((s) => s.chunk).join(''), fullText);
    assert.ok(last.t <= 1300 + FRAME_MS, `the rest appeared at ${last.t}`);
  });

  test('flush resolves a pending finish() at once', async () => {
    const sim = await simulate({ arrivals, finishAt: 1295, flushAt: 1310 });
    assert.ok(sim.finished !== null && sim.finished <= 1310 + FRAME_MS, `finished at ${sim.finished}`);
  });

  test('finish() has a timer fallback for tabs that never run animation frames', async () => {
    let t = 0;
    const timers = [];
    let shown = '';
    const r = createRevealer({
      append: (c) => { shown += c; },
      schedule: () => 1, // frames never fire (hidden tab)
      cancel: () => {},
      now: () => t,
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: () => {},
    });
    r.push(fullText);
    let done = false;
    const p = r.finish().then(() => { done = true; });
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, REVEAL_DEFAULTS.maxLagMs + REVEAL_DEFAULTS.safetyMs);
    timers[0].fn();
    await p;
    assert.ok(done);
    assert.equal(shown, fullText);
  });

  test('cancel drops the queue and resolves finish()', async () => {
    let shown = '';
        const r = createRevealer({ append: (c) => { shown += c; }, schedule: () => 1, cancel: () => {}, now: () => 0, setTimer: () => 1, clearTimer: () => {} });
    r.push('hello there, this is a long enough backlog to be typed out slowly by the revealer.');
    const p = r.finish();
    r.cancel();
    await p;
    assert.equal(shown, '');
    assert.equal(r.pending(), 0);
  });
});

describe('stream reveal: many tiny frames (local model)', () => {
  const text = 'It sounds like that evening gave you both something you do not get often. What would you like to do next? '.repeat(4);
  const tokens = text.match(/.{1,4}/gs);

  test('every token is shown on the very next frame: no added lag at all', async () => {
    const arrivals = tokens.map((chunk, i) => ({ at: 300 + i * 18, text: chunk }));
    const sim = await simulate({ arrivals, finishAt: 300 + tokens.length * 18 + 5 });
    assert.equal(sim.shown.map((s) => s.chunk).join(''), text);
    const lag = maxLag(sim);
    assert.ok(lag <= FRAME_MS + 1, `worst lag ${lag.toFixed(1)} ms (one frame is ${FRAME_MS.toFixed(1)})`);
    assert.ok(sim.finished - (300 + (tokens.length - 1) * 18) <= 2 * FRAME_MS + 5, 'finish() must not add a tail');
  });

  test('200 tiny frames arriving in one network read are still shown within a frame or two', async () => {
    const arrivals = Array.from({ length: 200 }, (_, i) => ({ at: 1000 + i * 3, text: 'tok ' }));
    const sim = await simulate({ arrivals, finishAt: 1000 + 200 * 3 + 5 });
    assert.equal(sim.total === undefined ? '' : sim.shown.map((s) => s.chunk).join(''), 'tok '.repeat(200));
    assert.ok(maxLag(sim) <= REVEAL_DEFAULTS.maxLagMs + FRAME_MS + 1);
  });

  test('one token per 50 ms (slow local model) is never delayed', async () => {
    const arrivals = Array.from({ length: 40 }, (_, i) => ({ at: 200 + i * 50, text: i % 2 ? 'x ' : 'abc' }));
    const sim = await simulate({ arrivals, finishAt: 200 + 40 * 50 });
    assert.ok(maxLag(sim) <= FRAME_MS + 1, `worst lag ${maxLag(sim).toFixed(1)} ms`);
  });

  test('a small leftover at the end of a big reveal is not dumped at once', async () => {
    const sim = await simulate({ arrivals: [{ at: 0, text: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu' }], finishAt: 10 });
    const steps = sim.shown.map((s) => s.chunk.length);
    assert.ok(Math.max(...steps) <= 20, `largest step ${Math.max(...steps)} chars: ${JSON.stringify(steps)}`);
  });
});

describe('stream reveal: reduced motion and odd text', () => {
  test('smooth=false: each frame shows the whole backlog, finish() resolves right away', async () => {
    const sim = await simulate({ arrivals: [{ at: 0, text: 'word '.repeat(300) }], finishAt: 5, smooth: false });
    assert.equal(sim.shown.length, 1);
    assert.equal(sim.shown[0].chunk.length, 1500);
    assert.ok(sim.finished <= 40);
  });

  test('a 100-character word cannot stall the reveal and is shown in pieces', async () => {
    const word = 'Supercalifragilistic'.repeat(5);
    const arrivals = [{ at: 0, text: `${word} ${word} end` }];
    const sim = await simulate({ arrivals, finishAt: 5 });
    assert.equal(sim.shown.map((s) => s.chunk).join(''), `${word} ${word} end`);
    assert.ok(sim.finished <= REVEAL_DEFAULTS.maxLagMs + 2 * FRAME_MS, `finished at ${sim.finished}`);
    assert.ok(Math.max(...sim.shown.map((s) => s.chunk.length)) <= REVEAL_DEFAULTS.maxWordChars + 4);
  });

  test('CJK text without spaces and emoji are typed out without breaking characters', async () => {
    const text = '今天是漫长的一天，但是我很高兴完成了很多事情。和家人在一起的时间让我感到非常平静，也想起了小时候。 😀👨‍👩‍👧‍👦🎉 '.repeat(3);
    const sim = await simulate({ arrivals: [{ at: 0, text }], finishAt: 5 });
    assert.equal(sim.shown.map((s) => s.chunk).join(''), text);
    assert.ok(sim.shown.length > 8, `only ${sim.shown.length} steps`);
    for (const s of sim.shown) {
      assert.ok(!/[\ud800-\udbff]$/.test(s.chunk), 'a step must not end with a lone high surrogate');
      assert.ok(!/^[\udc00-\udfff]/.test(s.chunk), 'a step must not start with a lone low surrogate');
    }
  });

  test('right-to-left text is revealed completely', async () => {
    const text = 'اليوم كان يوما طويلا ولكنني سعيد جدا بما أنجزته مع العائلة والأصدقاء في هذا الأسبوع الجميل. ';
    const sim = await simulate({ arrivals: [{ at: 0, text }], finishAt: 5 });
    assert.equal(sim.shown.map((s) => s.chunk).join(''), text);
  });

  test('a half word at the end of a big chunk waits for its second half', async () => {
    const first = 'One two three four five six seven eight nine ten eleven twelve thirt';
    const sim = await simulate({ arrivals: [{ at: 0, text: first }, { at: 60, text: 'een fourteen.' }], finishAt: 70 });
    const joined = sim.shown.map((s) => s.chunk).join('');
    assert.equal(joined, `${first}een fourteen.`);
    assert.ok(!sim.shown.some((s) => s.chunk.endsWith('thirt')), 'the unfinished word must not be shown on its own');
  });
});

describe('stream reveal: helpers', () => {
  test('wordEnds gives word-with-trailing-space tokens', async () => {
    const ends = wordEnds('Hello, brave new world.');
    assert.deepEqual(ends.map((e, i) => 'Hello, brave new world.'.slice(i ? ends[i - 1] : 0, e)), ['Hello, ', 'brave ', 'new ', 'world.']);
    assert.deepEqual(wordEnds(''), []);
  });

  test('wordCut takes whole words that fit the allowance', async () => {
    const text = 'alpha beta gamma delta';
    assert.equal(wordCut(text, 0), 0);
    assert.equal(wordCut(text, 3), 0, 'a word that does not fit yet waits');
    assert.equal(wordCut(text, 6), 6);
    assert.equal(wordCut(text, 14), 11);
    assert.equal(wordCut(text, 100), text.length);
    assert.equal(wordCut(text, 21, { holdTail: true }), 17, 'the unfinished last word is held back');
    assert.equal(wordCut('alpha beta ', 100, { holdTail: true }), 11, 'a finished word is not held');
    assert.equal(wordCut('alpha.', 100, { holdTail: true }), 6);
  });

  test('wordCut shows a piece of an over-long word and never splits a surrogate pair', async () => {
    const long = 'x'.repeat(100);
    const cut = wordCut(long, 10);
    assert.ok(cut > 0 && cut <= 10);
    const emoji = '😀'.repeat(40);
    const c2 = wordCut(emoji, 9);
    assert.ok(c2 % 2 === 0, `cut ${c2} splits a pair`);
    assert.deepEqual(splitChunk(emoji, 3).map((p) => p.length), [4, 76]);
  });

  test('requiredRate is the speed needed to meet the oldest deadline', async () => {
    const now = 1000;
    assert.equal(requiredRate([], now), 0);
    const r1 = requiredRate([{ text: 'x'.repeat(120), at: 1000 }], now, 1200);
    assert.ok(Math.abs(r1 - 0.1) < 1e-9, `got ${r1}`);
    const overdue = requiredRate([{ text: 'x'.repeat(100), at: -500 }], now, 1200);
    assert.ok(overdue >= 100 / 16 - 1e-9, 'an overdue segment must be shown within about one frame');
    const cumulative = requiredRate([{ text: 'x'.repeat(100), at: 0 }, { text: 'y'.repeat(100), at: 900 }], 1000, 1200);
    assert.ok(cumulative >= 200 / 1100 - 1e-9);
  });

  test('the default bound is the documented 1.2 s', async () => {
    assert.equal(REVEAL_DEFAULTS.maxLagMs, 1200);
  });
});

describe('stream reveal: the real Gemini fixture', () => {
  test('the live short reply (2 frames) is shown in full and quickly', async () => {
    const raw = readFileSync(new URL('../fixtures/gemini-live/stream-success.body', import.meta.url), 'utf8');
    const parts = [...raw.matchAll(/"text": "((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).filter(Boolean);
    assert.ok(parts.length >= 2);
    const sim = await simulate({ arrivals: parts.map((text, i) => ({ at: 800 + i * 40, text })), finishAt: 900 });
    assert.equal(sim.shown.map((s) => s.chunk).join(''), parts.join(''));
    assert.ok(maxLag(sim) <= 2 * FRAME_MS + 1, 'a short reply is token-sized and must not be delayed');
  });
});
