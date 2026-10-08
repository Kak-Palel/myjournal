// Shared helpers for the provider tests (not a test file itself).

import { getEventListeners } from 'node:events';

/** Drain an async generator into an array. */
export async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Drain a provider stream: { text, deltas, done, events }. */
export async function drain(gen) {
  const events = await collect(gen);
  const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text);
  const done = events.find((e) => e.type === 'done');
  return { text: deltas.join(''), deltas, done, events };
}

/** An async iterable over the given pieces (strings are encoded as UTF-8). */
export async function* chunked(pieces) {
  const enc = new TextEncoder();
  for (const p of pieces) yield typeof p === 'string' ? enc.encode(p) : p;
}

/** Every way to cut `buf` into two pieces, including the empty-prefix and empty-suffix cuts. */
export function* twoWaySplits(buf) {
  for (let i = 0; i <= buf.length; i += 1) yield [buf.subarray(0, i), buf.subarray(i)];
}

/** Cut at every single byte. */
export function byteByByte(buf) {
  return Array.from(buf, (_, i) => buf.subarray(i, i + 1));
}

/** Deterministic pseudo-random multi-way split. */
export function randomSplit(buf, seed, parts = 5) {
  let x = seed >>> 0;
  const cuts = new Set();
  for (let i = 0; i < parts - 1; i += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    cuts.add(x % (buf.length + 1));
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const out = [];
  let from = 0;
  for (const c of [...sorted, buf.length]) {
    out.push(buf.subarray(from, c));
    from = c;
  }
  return out;
}

/**
 * Track timers that were created by code under src/providers/ and have neither fired nor been cleared.
 * Patches the globals, so call restore() in a finally / after hook.
 */
export function trackTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Map();
  globalThis.setTimeout = function patchedSetTimeout(fn, ms, ...args) {
    const stack = new Error().stack || '';
    const mine = stack.includes('/src/providers/');
    let handle = null;
    const wrapped = mine ? (...a) => { live.delete(handle); return fn(...a); } : fn;
    handle = realSet.call(this, wrapped, ms, ...args);
    if (mine) live.set(handle, stack);
    return handle;
  };
  globalThis.clearTimeout = function patchedClearTimeout(handle) {
    live.delete(handle);
    return realClear.call(this, handle);
  };
  return {
    get outstanding() { return live.size; },
    stacks: () => [...live.values()],
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

export const abortListeners = (signal) => getEventListeners(signal, 'abort').length;

/** Run fn with tracked timers and assert that none leak. */
export async function withTimerCheck(assert, fn) {
  const t = trackTimers();
  try {
    await fn();
    // let finally blocks of abandoned generators settle
    await new Promise((r) => setImmediate(r));
    assert.equal(t.outstanding, 0, `leaked timers:\n${t.stacks().join('\n---\n')}`);
  } finally {
    t.restore();
  }
}

/** Resolves when `fn()` is truthy (polling), or throws after timeoutMs. */
export async function until(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('until(): timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** An instant replacement for the retry sleep; records requested waits. */
export function fakeSleep() {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  sleep.waits = waits;
  return sleep;
}

export const USER = (content) => ({ role: 'user', content });
export const SYSTEM = (content) => ({ role: 'system', content });
export const ASSISTANT = (content) => ({ role: 'assistant', content });
export const HELLO = [USER('Hello there, how are you today?')];

/** A fixed-response fake fetch that records calls: fetch(url, init) -> Response. */
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

/** Run `fn(baseUrl, server)` against a throwaway node:http server and always shut it down. */
export async function withServer(handler, fn) {
  const http = await import('node:http');
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, server);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A TCP port that nothing is listening on. */
export async function closedPort() {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
