// Pure helpers for showing a streamed reply: a frame-batched text revealer and scroll-pinning maths.
// No DOM access here (the caller supplies `append`), so it can be unit-tested in Node.

/** Below this many pending characters everything is shown at once; above it the backlog drains smoothly. */
const SHOW_ALL_BELOW = 48;
const DRAIN_DIVISOR = 8;

/**
 * How many characters to reveal this frame. Providers such as Gemini deliver a whole paragraph in one
 * chunk; draining a fixed fraction of the backlog per frame turns that into a quick, soft reveal
 * (a few hundred milliseconds) while token-sized chunks appear instantly.
 */
export function nextRevealSize(backlogLength) {
  if (backlogLength <= SHOW_ALL_BELOW) return backlogLength;
  return Math.ceil(backlogLength / DRAIN_DIVISOR);
}

/** Split `text` after about `size` UTF-16 units without cutting a surrogate pair in half. */
export function splitChunk(text, size) {
  if (size >= text.length) return [text, ''];
  let cut = Math.max(0, size);
  const code = text.charCodeAt(cut - 1);
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut += 1; // high surrogate: keep its partner
  return [text.slice(0, cut), text.slice(cut)];
}

/**
 * Batch streamed text into animation frames.
 * @param {object} opts
 * @param {(chunk: string) => void} opts.append writes text to the page (e.g. textNode.appendData)
 * @param {(fn: () => void) => any} [opts.schedule] defaults to requestAnimationFrame
 * @param {(handle: any) => void} [opts.cancel] defaults to cancelAnimationFrame
 * @param {boolean} [opts.smooth] false = reveal the whole backlog each frame (reduced motion)
 * @param {() => void} [opts.onFrame] called after each frame that appended text
 */
export function createRevealer({ append, schedule, cancel, smooth = true, onFrame }) {
  const raf = schedule || ((fn) => globalThis.requestAnimationFrame(fn));
  const caf = cancel || ((handle) => globalThis.cancelAnimationFrame(handle));
  let backlog = '';
  let handle = null;

  function tick() {
    handle = null;
    if (!backlog) return;
    const [chunk, rest] = smooth ? splitChunk(backlog, nextRevealSize(backlog.length)) : [backlog, ''];
    backlog = rest;
    append(chunk);
    if (onFrame) onFrame();
    if (backlog) handle = raf(tick);
  }

  return {
    /** Queue text; it is written on the next frame. */
    push(text) {
      if (!text) return;
      backlog += text;
      if (handle === null) handle = raf(tick);
    },
    /** Write everything that is still queued right now. */
    flush() {
      if (handle !== null) { caf(handle); handle = null; }
      if (backlog) { const rest = backlog; backlog = ''; append(rest); if (onFrame) onFrame(); }
    },
    /** Drop the queue without writing it. */
    cancel() {
      if (handle !== null) { caf(handle); handle = null; }
      backlog = '';
    },
    pending() { return backlog.length; },
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
