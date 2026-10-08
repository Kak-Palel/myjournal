// "Cannot reach MyJournal" handling. The API client reports failed requests; this module confirms with a tiny health
// check (so one dropped request never flashes a banner), shows a banner while the server is away, keeps trying with a
// growing pause, and tells the app when the server is back so views that failed to load can try again by themselves.
//
// The state machine takes its clock and its probe as arguments, so it can be tested without a browser.
import { h } from '../lib/dom.js';
import { icon } from '../lib/ui.js';

/** Pause before each re-check while the server is away (ms); the last value repeats. */
export const PROBE_DELAYS = Object.freeze([2000, 3000, 5000, 8000, 12000]);

/** How long to wait before the `attempt`-th re-check (0 = the first). */
export function probeDelay(attempt) {
  return PROBE_DELAYS[Math.min(Math.max(0, attempt), PROBE_DELAYS.length - 1)];
}

/**
 * @typedef {object} ConnectionState
 * @property {'online'|'checking'|'offline'} status
 * @property {number} attempt how many re-checks have failed since the server went away
 * @property {number} nextCheckAt epoch ms of the next automatic re-check (0 when not offline)
 */

/**
 * @param {object} opts
 * @param {() => Promise<boolean>} opts.probe resolves true when the server answers (never rejects)
 * @param {(state: ConnectionState) => void} opts.onChange called whenever the state changes
 * @param {() => void} [opts.onRecovered] called once each time the server comes back after having been away
 * @param {(fn: () => void, ms: number) => any} [opts.setTimer]
 * @param {(handle: any) => void} [opts.clearTimer]
 * @param {() => number} [opts.now]
 */
export function createConnectionMonitor({ probe, onChange, onRecovered, setTimer, clearTimer, now }) {
  const setT = setTimer || ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT = clearTimer || ((handle) => globalThis.clearTimeout(handle));
  const clock = now || (() => Date.now());
  /** @type {ConnectionState} */
  let state = { status: 'online', attempt: 0, nextCheckAt: 0 };
  let timer = null;
  let probing = false;
  let destroyed = false;
  let generation = 0; // bumped when the server is known to be back, so a probe that was already in flight cannot say otherwise

  function set(next) {
    state = next;
    onChange({ ...state });
  }

  function cancelTimer() {
    if (timer !== null) { clearT(timer); timer = null; }
  }

  function recovered() {
    generation += 1;
    cancelTimer();
    const wasAway = state.status !== 'online';
    set({ status: 'online', attempt: 0, nextCheckAt: 0 });
    if (wasAway && onRecovered) onRecovered();
  }

  function scheduleNext() {
    cancelTimer();
    if (destroyed) return;
    const wait = probeDelay(state.attempt);
    set({ status: 'offline', attempt: state.attempt, nextCheckAt: clock() + wait });
    timer = setT(() => { timer = null; check(); }, wait);
  }

  /** Ask the server now. Safe to call at any time; overlapping calls are merged. */
  async function check() {
    if (destroyed || probing) return;
    probing = true;
    cancelTimer();
    if (state.status === 'offline') set({ ...state, status: 'checking', nextCheckAt: 0 });
    const started = generation;
    let ok = false;
    try { ok = Boolean(await probe()); } catch { ok = false; }
    probing = false;
    if (destroyed || started !== generation) return;
    if (ok) { recovered(); return; }
    // A failed first check means the server really is away; failed re-checks lengthen the pause.
    state = { ...state, attempt: state.status === 'online' ? 0 : state.attempt + 1 };
    scheduleNext();
  }

  return {
    /** A request failed to reach the server: confirm before bothering the person. No-op while already away. */
    suspect() {
      if (state.status === 'online') check();
    },
    /** Something succeeded: the server is there. */
    reachable() {
      if (state.status !== 'online') recovered();
    },
    /** "Try now" button, or the tab became visible again. */
    checkNow() {
      if (state.status !== 'online') check();
    },
    state: () => ({ ...state }),
    destroy() {
      destroyed = true;
      cancelTimer();
    },
  };
}

/**
 * The banner shown while the server is away. It is built once (a screen reader announces it once) and then updated in
 * place, so neither the announcement nor keyboard focus on "Try now" is disturbed by the re-checks.
 * @param {{ onRetry: () => void }} actions `onRetry` re-checks right now
 * @returns {{ el: HTMLElement, update(state: ConnectionState): void }}
 */
export function createConnectionBanner({ onRetry }) {
  const stateText = h('span', { class: 'conn-banner-state' }, 'Trying again in a moment.');
  const button = h('button', { type: 'button', class: 'btn btn-sm', onClick: onRetry }, 'Try now');
  const el = h('div', { class: 'conn-banner', role: 'alert' },
    icon('alert', { size: 18 }),
    h('div', { class: 'conn-banner-text' },
      h('strong', null, 'Cannot reach MyJournal.'),
      ' Is it still running? What you have typed stays in this window. ',
      stateText),
    button);
  return {
    el,
    update(state) {
      const checking = state.status === 'checking';
      stateText.textContent = checking ? 'Checking…' : 'Trying again in a moment.';
      button.textContent = checking ? 'Checking…' : 'Try now';
      button.setAttribute('aria-busy', checking ? 'true' : 'false');
    },
  };
}

/** One quiet request to the health endpoint: true when the server answers at all. */
export async function probeHealth(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl('/api/health', { cache: 'no-store', credentials: 'same-origin', signal: globalThis.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined });
    return res.status < 500;
  } catch {
    return false;
  }
}
