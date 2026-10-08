// Shared HTTP plumbing for the adapters: abort + timeout handling, network-error classification,
// bounded body readers and retry timing. See docs/ARCHITECTURE.md §9 "Shared HTTP behaviour".
//
// Node's global fetch ignores HTTPS_PROXY unless the process runs with NODE_USE_ENV_PROXY=1; we do not
// re-implement proxying. Note also that undici itself gives up on a response whose headers take longer
// than 300 s (UND_ERR_HEADERS_TIMEOUT), so a first-byte timeout above that cannot be honoured.

import { ProviderError, abortError, errorFactory, isAbortError } from './errors.js';

export const DEFAULT_IDLE_MS = 60_000;
export const MAX_ERROR_BODY_BYTES = 64 * 1024;
export const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024;
/** A transient 429/503 is retried once, but only when the server asks for a short wait. */
export const MAX_AUTO_RETRY_WAIT_MS = 8_000;
export const DEFAULT_RETRY_WAIT_MS = 1_000;

/** Names used inside user-facing sentences. */
export const DISPLAY_NAMES = Object.freeze({
  gemini: 'Gemini',
  openai: 'The OpenAI-compatible API',
  local: 'Your local model server',
});

/** The URL as it may safely appear in a message: no credentials, no query string, no fragment. */
export function describeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(invalid address)';
  }
}

const PRIVATE_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[^/:]+\.local)(?::\d+)?(?:[/?#]|$)/i;
const SCHEMELESS = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(:\d+)?([/?#].*)?$/i;

/**
 * Parse a user-typed server address. A missing scheme is forgiven (http for local/private hosts, https
 * otherwise); credentials, query strings and non-http(s) schemes are rejected with `bad_base_url`.
 * The fragment is dropped silently because it is never sent.
 * @param {string} raw
 * @param {{provider: string, preferHttp?: boolean}} opts
 * @returns {URL}
 * @throws {ProviderError}
 */
export function parseHttpUrl(raw, { provider, preferHttp = false }) {
  const bad = (message, hint) => new ProviderError('bad_base_url', message, { provider, hint });
  let s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw bad('No server address is set.', 'Enter the base URL in Settings, for example http://localhost:11434/v1.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!SCHEMELESS.test(s)) {
      throw bad('That does not look like a web address.', 'Use a full address such as http://localhost:11434/v1.');
    }
    s = `${preferHttp || PRIVATE_HOST.test(s) ? 'http' : 'https'}://${s}`;
  }
  let url;
  try {
    url = new URL(s);
  } catch {
    throw bad('That does not look like a valid web address.', 'Use a full address such as http://localhost:11434/v1.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw bad('Only http:// and https:// addresses are supported.');
  }
  if (url.username || url.password) {
    throw bad('The address must not contain a username or password.', 'Put the API key in the API key field instead.');
  }
  if (url.search) {
    throw bad('The address must not contain a "?" query string.', 'Remove everything from the "?" onwards.');
  }
  return url;
}

/** Collapse whitespace and cap the length, so upstream text fits on one line of a message. */
export function oneLine(text, max = 300) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Seconds ("3", "1.5") or an HTTP date -> milliseconds. Anything else -> undefined.
 * @param {string|number|null|undefined} value
 * @param {number} [now]
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  let ms;
  if (/^\d+(\.\d+)?$/.test(s)) {
    ms = Number(s) * 1000;
  } else {
    const at = Date.parse(s);
    if (!Number.isFinite(at)) return undefined;
    ms = at - now;
  }
  return Math.min(Math.max(Math.round(ms), 0), 24 * 3600 * 1000);
}

/** Reads `retry-after-ms` (non-standard but common) before `retry-after`. */
export function retryAfterFromHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return undefined;
  const ms = headers.get('retry-after-ms');
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.min(Math.round(Number(ms)), 24 * 3600 * 1000);
  return parseRetryAfter(headers.get('retry-after'));
}

/**
 * How long to wait before the single automatic retry, or null when the error is not worth retrying
 * (anything but a short 429 rate limit or a 503).
 * @param {ProviderError} err
 * @param {number} [fallbackMs] used when the server did not say how long to wait
 */
export function autoRetryDelay(err, fallbackMs = DEFAULT_RETRY_WAIT_MS) {
  const transient = (err.code === 'rate_limit' && err.status === 429) || err.status === 503;
  if (!transient) return null;
  const wait = err.retryAfterMs ?? fallbackMs;
  return wait <= MAX_AUTO_RETRY_WAIT_MS ? wait : null;
}

/** Abortable sleep. Its timer is cleared on every exit path. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    let timer = null;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errCode(err) {
  const seen = new Set();
  let cur = err;
  for (let i = 0; cur && typeof cur === 'object' && i < 4 && !seen.has(cur); i += 1) {
    seen.add(cur);
    if (typeof cur.code === 'string') return cur.code;
    cur = cur.cause;
  }
  return '';
}

function errText(err) {
  const parts = [];
  let cur = err;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i += 1) {
    if (typeof cur.message === 'string') parts.push(cur.message);
    cur = cur.cause;
  }
  return parts.join(' ').toLowerCase();
}

/** ", and port 6000 is on it" for a URL with an explicit port, else " (6000 and 10080 are on it)". */
function blockedPortNote(url) {
  try {
    const { port } = new URL(url);
    if (port) return `, and port ${port} is on it`;
  } catch {
    // fall through to the generic wording
  }
  return ' (6000 and 10080 are on it)';
}

const CERT_CODE = /^(CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH)/;

/**
 * Turn whatever fetch() or a body reader threw into a ProviderError. The hint always names the URL that
 * was tried, and for the local provider reminds the user to start their server.
 * @param {unknown} err
 * @param {{provider: string, secrets?: string[], url: string}} ctx
 */
export function networkError(err, ctx) {
  const fail = errorFactory(ctx.provider, ctx.secrets || []);
  const code = errCode(err);
  const text = errText(err);
  const tried = describeUrl(ctx.url);
  const who = DISPLAY_NAMES[ctx.provider] || 'The server';
  const local = ctx.provider === 'local';
  const base = { cause: err };

  if (/invalid header|bytestring|header value/.test(text)) {
    // Undici quotes the offending header value (our Authorization header) in this error, so the cause is dropped.
    return fail('auth', 'The API key contains characters that cannot be sent in a request.', {
      hint: 'Paste the key into Settings again. It should have no line breaks, quotes or fancy symbols.',
    });
  }
  if (/bad port/.test(text)) {
    // fetch() refuses a fixed list of ports (the WHATWG "bad ports": 1, 7, 9, ..., 6000, 6665-6669, 10080, ...) without
    // trying to connect. Verified on Node 22: `fetch('http://127.0.0.1:6000/')` -> TypeError 'fetch failed', cause 'bad port'.
    return fail('bad_base_url', 'That port is blocked.', {
      ...base,
      hint: `Node, like web browsers, refuses to connect to a fixed list of ports${blockedPortNote(ctx.url)}. `
        + 'Start the model server on another port, then change the address in Settings.',
    });
  }
  if (code === 'ERR_INVALID_URL' || /invalid url|unknown scheme|includes credentials|invalid (?:host|port)/.test(text)) {
    return fail('bad_base_url', 'The server address is not valid.', {
      ...base,
      hint: 'Use a full address such as http://localhost:11434/v1 (without a password or query string) in Settings.',
    });
  }
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return fail('timeout', `${who} took too long to answer.`, {
      ...base,
      hint: local
        ? 'The first request after starting a model loads it into memory and can be slow. Try again.'
        : 'Try again in a moment.',
    });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return fail('network', 'Could not find the server.', {
      ...base,
      hint: `Tried ${tried}. Check the address for typos and that you are online.`,
    });
  }
  if (CERT_CODE.test(code)) {
    return fail('network', 'The server\'s security certificate was not accepted.', {
      ...base,
      hint: `Tried ${tried}. For a self-hosted server with a self-signed certificate, use plain http:// on a trusted network or add your CA via NODE_EXTRA_CA_CERTS.`,
    });
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET' || /terminated|other side closed|socket hang up/.test(text)) {
    return fail('network', 'The connection to the server was closed unexpectedly.', {
      ...base,
      hint: local
        ? `Tried ${tried}. The server may have crashed or run out of memory loading the model; check its terminal and try again.`
        : `Tried ${tried}. Try again; if it keeps happening, check the service status.`,
    });
  }
  const advice = local
    ? 'Is Ollama running? Start it with `ollama serve` (or start llama-server / the LM Studio local server), then check the address in Settings.'
    : 'Check the base URL in Settings and your internet connection.';
  return fail('network', `Could not connect to ${local ? 'the local model server' : 'the server'}.`, {
    ...base,
    hint: `Tried ${tried}. ${advice}`,
  });
}

function timeoutError(kind, ctx, ms) {
  const fail = errorFactory(ctx.provider, ctx.secrets || []);
  const who = DISPLAY_NAMES[ctx.provider] || 'The server';
  const secs = Math.max(1, Math.round(ms / 1000));
  const unit = secs === 1 ? 'second' : 'seconds';
  const local = ctx.provider === 'local';
  if (kind === 'idle') {
    return fail('timeout', `${who} stopped responding in the middle of the reply (no data for ${secs} ${unit}).`, {
      hint: local
        ? 'The machine may be overloaded. Try again, or use a smaller model.'
        : 'Try again. If it keeps happening, check the service status.',
    });
  }
  return fail('timeout', `${who} did not answer within ${secs} ${unit}.`, {
    // Verified live (Ollama 0.40.1): when the client gives up while the model is still loading, Ollama cancels the load
    // ("client connection closed before llama-server finished loading, aborting load"), so an immediate retry starts
    // the whole load again. Raising the timeout is the fix, not retrying.
    hint: local
      ? 'The first request after starting a model loads it into memory, which can take a while, and giving up cancels that load. Raise the timeout in Settings (Settings > General), then try again.'
      : 'Try again in a moment, or raise the timeout in Settings.',
  });
}

/**
 * A request scope owns the AbortController for one provider call, chained to the caller's signal, plus the
 * first-byte and idle timers. Always call `close()` (the adapters do it in a `finally`): it clears the timer
 * and removes the listener from the caller's signal.
 *
 * @param {object} opts
 * @param {AbortSignal} [opts.signal] the caller's signal
 * @param {number} opts.firstByteMs time allowed until the first body bytes arrive
 * @param {number} [opts.idleMs] allowed silence between chunks afterwards
 * @param {{provider: string, secrets?: string[], url: string}} opts.ctx used to build errors
 * @throws {DOMException} AbortError when the signal is already aborted
 */
export function createScope({ signal, firstByteMs, idleMs = DEFAULT_IDLE_MS, ctx }) {
  if (signal && signal.aborted) throw abortError();
  const controller = new AbortController();
  let timer = null;
  let expired = null;
  let expiredMs = 0;
  let closed = false;
  let currentIdleMs = idleMs;

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = (ms, kind) => {
    stop();
    if (closed || expired || !Number.isFinite(ms) || ms <= 0) return;
    timer = setTimeout(() => {
      timer = null;
      expired = kind;
      expiredMs = ms;
      controller.abort(new Error(`${kind} timeout`));
    }, Math.min(ms, 2 ** 31 - 1));
  };
  const onCallerAbort = () => {
    stop();
    controller.abort(signal.reason);
  };
  if (signal) signal.addEventListener('abort', onCallerAbort, { once: true });
  arm(firstByteMs, 'first-byte');

  return {
    /** Pass this to fetch(). */
    signal: controller.signal,
    ctx,
    get callerAborted() { return Boolean(signal && signal.aborted); },
    get expired() { return expired; },
    /** Start a fresh first-byte window (a new attempt after a retry). */
    restart() { arm(firstByteMs, 'first-byte'); },
    /** Stop the clock while we are waiting on ourselves (retry sleep, a slow consumer). */
    pause: stop,
    /** Arm the idle timer: call after each chunk has been handed over. */
    touch() { arm(currentIdleMs, 'idle'); },
    /** Change the idle allowance (used for the short grace period after the final chunk). */
    setIdle(ms) { currentIdleMs = ms; },
    /**
     * Settle with `promise`, or reject as soon as this scope is aborted or times out. Real fetch/streams already
     * do that; this also covers fetch doubles that ignore their signal, so a hung double cannot hang us.
     */
    race(promise) {
      if (controller.signal.aborted) {
        Promise.resolve(promise).catch(() => {});
        return Promise.reject(controller.signal.reason || new Error('aborted'));
      }
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(controller.signal.reason || new Error('aborted'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(
          (value) => { controller.signal.removeEventListener('abort', onAbort); resolve(value); },
          (err) => { controller.signal.removeEventListener('abort', onAbort); reject(err); },
        );
      });
    },
    /** Throw the AbortError if the caller has aborted. */
    throwIfAborted() { if (signal && signal.aborted) throw abortError(); },
    /** Map anything thrown by fetch or a body reader to the right error. */
    fail(err) {
      if (signal && signal.aborted) return abortError();
      if (err instanceof ProviderError) return err;
      if (expired) return timeoutError(expired, ctx, expiredMs);
      if (isAbortError(err)) return abortError();
      return networkError(err, ctx);
    },
    /** @param {boolean} [abortUpstream] also cancel the in-flight request */
    close(abortUpstream = false) {
      if (closed) return;
      closed = true;
      stop();
      if (signal) signal.removeEventListener('abort', onCallerAbort);
      if (abortUpstream && !controller.signal.aborted) controller.abort();
    },
  };
}

/**
 * fetch() with the scope's signal. Redirects are not followed: following a POST redirect silently turns
 * it into a GET, and credentials should never be replayed to a host the user did not configure.
 * @returns {Promise<Response>}
 */
export async function scopedFetch(fetchFn, url, init, scope) {
  try {
    return await scope.race(fetchFn(url, { ...init, signal: scope.signal, redirect: 'manual' }));
  } catch (err) {
    throw scope.fail(err);
  }
}

/**
 * Iterate over a response body as byte chunks. While the consumer is busy with a chunk the idle clock is
 * paused (our slowness is not the server's), and the body is cancelled if the consumer stops early.
 * @param {Response} response
 * @param {ReturnType<typeof createScope>} scope
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* readChunks(response, scope) {
  if (!response.body) return;
  const reader = response.body.getReader();
  let finished = false;
  try {
    for (;;) {
      scope.throwIfAborted();
      let step;
      try {
        step = await scope.race(reader.read());
      } catch (err) {
        throw scope.fail(err);
      }
      if (step.done) {
        finished = true;
        return;
      }
      scope.pause();
      yield step.value;
      scope.touch();
    }
  } finally {
    if (!finished) reader.cancel().catch(() => {});
  }
}

/**
 * Read a whole body as text, bounded.
 * @param {Response} response
 * @param {ReturnType<typeof createScope>} scope
 * @param {number} [maxBytes]
 * @param {{truncate?: boolean}} [opts] cut the text at maxBytes instead of failing
 */
export async function readText(response, scope, maxBytes = MAX_JSON_BODY_BYTES, { truncate = false } = {}) {
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for await (const chunk of readChunks(response, scope)) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      if (!truncate) {
        throw errorFactory(scope.ctx.provider, scope.ctx.secrets || [])('server', 'The server\'s answer was far too large to be valid.', {
          hint: 'Check that the base URL points at the model API and not at a web page.',
        });
      }
      text += decoder.decode(chunk.subarray(0, Math.max(0, chunk.byteLength - (bytes - maxBytes))), { stream: true });
      break;
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Best-effort read of an error response body: a failure to read it (other than the caller aborting) just
 * yields '' so the status code alone still produces a useful error.
 */
export async function readErrorBody(response, scope) {
  try {
    return await readText(response, scope, MAX_ERROR_BODY_BYTES, { truncate: true });
  } catch (err) {
    if (isAbortError(err)) throw err;
    return '';
  }
}

/** `{"error":{"message": "...", ...}}` or `{"message": "..."}` -> that object's message, else ''. Used to unwrap nested errors. */
function innerErrorMessage(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const err = obj.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
  return typeof obj.message === 'string' ? obj.message : '';
}

/**
 * Best-effort parse of an error body in any of the shapes seen in the wild.
 *
 * Verified live (Ollama 0.40.1): when its llama.cpp runner rejects a prompt, Ollama wraps the runner's JSON error
 * inside its own `error.message` STRING (`{"error":{"message":"{\"error\":{\"code\":400,\"message\":\"request (6063
 * tokens) exceeds the available context size (4096 tokens)...\",\"n_prompt_tokens\":6063,\"n_ctx\":4096}}"}}`), so a
 * message that is itself a JSON error document is unwrapped. `promptTokens` / `contextTokens` are filled from
 * llama.cpp's `n_prompt_tokens` / `n_ctx` fields when present (0 otherwise).
 * @param {string} text
 * @returns {{json: any, message: string, code: string, type: string, status: string, html: boolean, promptTokens: number, contextTokens: number}}
 */
export function parseErrorBody(text) {
  const raw = String(text ?? '').trim();
  const out = { json: null, message: '', code: '', type: '', status: '', html: false, promptTokens: 0, contextTokens: 0 };
  if (!raw) return out;
  if (/^<(!doctype|html|head|body)/i.test(raw)) {
    out.html = true;
    return out;
  }
  let json = null;
  try { json = JSON.parse(raw); } catch { /* plain text */ }
  if (json === null || typeof json !== 'object') {
    out.message = oneLine(raw);
    return out;
  }
  out.json = json;
  const err = json.error;
  const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  if (typeof err === 'string') {
    out.message = err;
  } else if (err && typeof err === 'object') {
    out.message = typeof err.message === 'string' ? err.message : typeof err.msg === 'string' ? err.msg : '';
    out.code = err.code === undefined || err.code === null ? '' : String(err.code);
    out.type = typeof err.type === 'string' ? err.type : '';
    out.status = typeof err.status === 'string' ? err.status : '';
    out.promptTokens = count(err.n_prompt_tokens);
    out.contextTokens = count(err.n_ctx);
  } else if (typeof json.message === 'string') {
    out.message = json.message;
  } else if (typeof json.detail === 'string') {
    out.message = json.detail;
  } else if (Array.isArray(json.detail) && json.detail[0] && typeof json.detail[0].msg === 'string') {
    out.message = json.detail[0].msg;
  } else if (typeof json.error_description === 'string') {
    out.message = json.error_description;
  }
  // Ollama wraps the runner's JSON error document in its own message string; unwrap one level.
  if (/^\s*\{/.test(out.message)) {
    let nested = null;
    try { nested = JSON.parse(out.message); } catch { /* not JSON after all: keep the text */ }
    const inner = innerErrorMessage(nested);
    if (inner) {
      const e = nested.error && typeof nested.error === 'object' ? nested.error : {};
      out.message = inner;
      out.promptTokens = out.promptTokens || count(e.n_prompt_tokens);
      out.contextTokens = out.contextTokens || count(e.n_ctx);
      if (!out.type && typeof e.type === 'string') out.type = e.type;
      if (!out.code && e.code !== undefined && e.code !== null) out.code = String(e.code);
    }
  }
  out.message = oneLine(out.message);
  return out;
}
