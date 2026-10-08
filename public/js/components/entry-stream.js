// Pure helpers for showing a streamed reply: a time-bounded, word-wise text revealer and the scroll-pinning
// maths. No DOM access here (the caller supplies `append`), so everything can be unit-tested in Node.
//
// Why a revealer at all: providers deliver text in very different shapes.
//   * Local models (Ollama, llama.cpp) send many tiny tokens. Those must appear at once, with no added lag.
//   * Gemini sends a whole short reply in 2-3 big frames within a few hundred milliseconds (see
//     test/fixtures/gemini-live). Pasting a paragraph into the page at once feels abrupt, so large backlogs are
//     typed out word by word.
// Hard bounds: no character is shown later than `maxLagMs` (1.2 s) after it arrived, the reveal never falls behind
// the arrival rate, and Stop / errors / leaving the page show everything immediately (`flush`, `cancel`).

/** Tuning knobs. All times are milliseconds; "cps" is characters per second. */
export const REVEAL_DEFAULTS = Object.freeze({
  /** A backlog this small is shown at once: it is token-sized (local model) and a delay would only add lag. */
  instantBelow: 40,
  /** Gentle floor for the typing speed of a big chunk (about 18 words per second). */
  baseCps: 110,
  /** No character may be shown later than this after it arrived: the bound on the added delay of a whole reply. */
  maxLagMs: 1200,
  /** A long pause between frames (a busy or hidden tab) never counts as more than this much time. */
  maxFrameMs: 100,
  /** Text that arrived this recently may still be the start of a longer word ("Hel" + "lo"): its last word waits briefly. */
  holdTailMs: 120,
  /** A "word" longer than this (a URL, CJK text without spaces) is cut into pieces of at most this size. */
  maxWordChars: 24,
  /** finish() waits this much longer than `maxLagMs` before it gives up on animation frames (a hidden tab pauses them). */
  safetyMs: 250,
});

/** Split `text` after about `size` UTF-16 units without cutting a surrogate pair in half. */
export function splitChunk(text, size) {
  if (size >= text.length) return [text, ''];
  let cut = Math.max(0, size);
  const code = text.charCodeAt(cut - 1);
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut += 1; // high surrogate: keep its partner
  return [text.slice(0, cut), text.slice(cut)];
}

let segmenter; // undefined = not looked up yet, null = unavailable
function wordSegmenter() {
  if (segmenter === undefined) {
    try { segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null; } catch { segmenter = null; }
  }
  return segmenter;
}

/**
 * End offsets of the "words" in `text`. A word is a word-like run plus the spaces and punctuation that follow it, so
 * a comma never shows up a frame after the word it belongs to. Falls back to whitespace splitting without Intl.Segmenter.
 * @param {string} text
 * @returns {number[]} strictly increasing end offsets, the last one equal to text.length
 */
export function wordEnds(text) {
  const ends = [];
  const seg = wordSegmenter();
  if (seg) {
    let sawWord = false;
    for (const part of seg.segment(text)) {
      if (part.isWordLike && sawWord) ends.push(part.index); // the previous word ends where this one starts
      if (part.isWordLike) sawWord = true;
    }
    if (text.length) ends.push(text.length);
    return ends;
  }
  const re = /\S+\s*|\s+/g;
  let m;
  while ((m = re.exec(text)) !== null) ends.push(m.index + m[0].length);
  return ends;
}

/**
 * How much of `text` to show when `allowance` characters may be revealed: whole words only, never past the allowance,
 * never inside a surrogate pair. A single word longer than `maxWordChars` is cut where the allowance falls so that
 * it cannot stall the reveal. With `holdTail` an unfinished last word (no space after it yet) is kept back.
 * @param {string} text
 * @param {number} allowance
 * @param {{ maxWordChars?: number, holdTail?: boolean }} [opts]
 * @returns {number} number of UTF-16 units to show (0 = wait for more credit)
 */
export function wordCut(text, allowance, { maxWordChars = REVEAL_DEFAULTS.maxWordChars, holdTail = false } = {}) {
  const limit = Math.floor(allowance);
  if (limit <= 0 || !text) return 0;
  if (limit >= text.length) {
    if (!holdTail || /[\s.,;:!?)\]"'”’…]$/.test(text)) return text.length;
    const ends = wordEnds(text);
    return ends.length > 1 ? ends[ends.length - 2] : text.length; // keep the unfinished word back
  }
  const ends = wordEnds(text.slice(0, limit + maxWordChars + 2));
  let cut = 0;
  for (const end of ends) {
    if (end > limit) break;
    cut = end;
  }
  if (cut === 0) {
    const first = ends[0] || 0;
    if (first <= maxWordChars) return 0; // a normal word that does not fit yet: wait for more credit
    return splitChunk(text, Math.min(limit, maxWordChars))[0].length; // a very long "word": show a piece of it
  }
  return cut;
}

/**
 * Characters per millisecond needed so that every queued character is shown within `maxLagMs` of its arrival.
 * @param {{ text: string, at: number }[]} queue pending text with arrival times, oldest first
 * @param {number} now
 * @param {number} [maxLagMs]
 * @param {number} [minWindowMs] an overdue segment is given this long (about one frame) instead of a negative time
 */
export function requiredRate(queue, now, maxLagMs = REVEAL_DEFAULTS.maxLagMs, minWindowMs = 16) {
  let cumulative = 0;
  let need = 0;
  for (const seg of queue) {
    cumulative += seg.text.length;
    const left = Math.max(seg.at + maxLagMs - now, minWindowMs);
    need = Math.max(need, cumulative / left);
  }
  return need;
}

/**
 * Batch streamed text into animation frames and type big backlogs out word by word.
 * @param {object} opts
 * @param {(chunk: string) => void} opts.append writes text to the page (e.g. textNode.appendData)
 * @param {(fn: (ts?: number) => void) => any} [opts.schedule] defaults to requestAnimationFrame
 * @param {(handle: any) => void} [opts.cancel] defaults to cancelAnimationFrame
 * @param {() => number} [opts.now] clock in ms, defaults to performance.now()
 * @param {boolean} [opts.smooth] false = show the whole backlog each frame (prefers-reduced-motion)
 * @param {() => void} [opts.onFrame] called after each frame that appended text
 * @param {(fn: () => void, ms: number) => any} [opts.setTimer] defaults to setTimeout (used by finish())
 * @param {(handle: any) => void} [opts.clearTimer] defaults to clearTimeout
 * @param {Partial<typeof REVEAL_DEFAULTS>} [opts.tuning] overrides for REVEAL_DEFAULTS
 */
export function createRevealer({ append, schedule, cancel, now, smooth = true, onFrame, setTimer, clearTimer, tuning }) {
  const cfg = { ...REVEAL_DEFAULTS, ...(tuning || {}) };
  const raf = schedule || ((fn) => globalThis.requestAnimationFrame(fn));
  const caf = cancel || ((handle) => globalThis.cancelAnimationFrame(handle));
  const clock = now || (() => globalThis.performance.now());
  const setT = setTimer || ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT = clearTimer || ((handle) => globalThis.clearTimeout(handle));

  /** @type {{ text: string, at: number }[]} */
  let queue = [];
  let size = 0;
  let handle = null;
  let last = 0;
  let credit = 0;
  let typing = false; // once a big backlog started typing out, stay in that mode until it is empty (no pop at the end)
  let finishing = false;
  let waiters = [];
  let safety = null;

  function settle() {
    if (safety !== null) { clearT(safety); safety = null; }
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve();
  }

  function consume(n) {
    let out = '';
    while (n > 0 && queue.length) {
      const seg = queue[0];
      if (seg.text.length <= n) { out += seg.text; n -= seg.text.length; queue.shift(); } else { out += seg.text.slice(0, n); seg.text = seg.text.slice(n); n = 0; }
    }
    size -= out.length;
    return out;
  }

  /** The first `n` queued characters without removing them. */
  function peek(n) {
    let out = '';
    for (const seg of queue) {
      out += seg.text;
      if (out.length >= n) break;
    }
    return out;
  }

  function emit(text) {
    if (!text) return;
    append(text);
    if (onFrame) onFrame();
  }

  function tick() {
    handle = null;
    if (size === 0) { typing = false; credit = 0; if (finishing) settle(); return; }
    const t = clock();
    const dt = Math.min(Math.max(t - last, 0), cfg.maxFrameMs);
    last = t;

    if (!smooth || (!typing && size <= cfg.instantBelow)) {
      emit(consume(size));
    } else {
      typing = true;
      credit += Math.max(cfg.baseCps / 1000, requiredRate(queue, t, cfg.maxLagMs)) * dt;
      if (credit > size) credit = size;
      const text = peek(Math.floor(credit) + cfg.maxWordChars + 2);
      const newest = queue[queue.length - 1];
      const cut = wordCut(text, credit, { maxWordChars: cfg.maxWordChars, holdTail: !finishing && t - newest.at < cfg.holdTailMs });
      if (cut > 0) { credit = Math.max(0, credit - cut); emit(consume(cut)); }
    }
    if (size === 0) { typing = false; credit = 0; }
    if (size > 0) handle = raf(tick);
    else if (finishing) settle();
  }

  function flush() {
    if (handle !== null) { caf(handle); handle = null; }
    const rest = consume(size);
    queue = [];
    typing = false;
    credit = 0;
    emit(rest);
    settle();
  }

  return {
    /** Queue text; it is written on a later frame. */
    push(text) {
      if (!text) return;
      const at = clock();
      const tail = queue[queue.length - 1];
      if (tail && at - tail.at < 20) tail.text += text; // one network read can carry several frames: they share a deadline
      else queue.push({ text, at });
      size += text.length;
      if (handle === null) { if (size === text.length) last = at; handle = raf(tick); }
    },
    /** Write everything that is still queued right now (Stop, errors). */
    flush,
    /** Drop the queue without writing it (the view is going away). */
    cancel() {
      if (handle !== null) { caf(handle); handle = null; }
      queue = [];
      size = 0;
      typing = false;
      credit = 0;
      settle();
    },
    /**
     * The stream is over: let what is queued finish typing out (never longer than `maxLagMs` after the last
     * arrival, plus a small safety margin for tabs that do not run animation frames) and resolve afterwards.
     * flush() / cancel() resolve it early.
     * @returns {Promise<void>}
     */
    finish() {
      finishing = true;
      if (size === 0 && handle === null) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.push(resolve);
        if (safety === null) safety = setT(() => { safety = null; flush(); }, cfg.maxLagMs + cfg.safetyMs);
      });
    },
    pending() { return size; },
  };
}

/**
 * Pixels between the viewport bottom and the end of the page.
 * @param {{ scrollHeight: number, scrollTop: number, clientHeight: number }} m
 */
export function distanceFromBottom(m) {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

/** Was the reader already (almost) at the bottom? Only then should new text pull the page down. */
export function isNearBottom(metrics, threshold = 140) {
  return distanceFromBottom(metrics) <= threshold;
}

/** Short plain excerpt for the screen-reader announcement that follows a finished reply. */
export function announcementExcerpt(text, max = 400) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
