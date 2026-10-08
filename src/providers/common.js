// Logic shared by the OpenAI-compatible and Gemini adapters: request validation, the
// retry/self-healing request loop, usage normalisation and the chat() drain.

import { ProviderError } from './errors.js';
import {
  DEFAULT_RETRY_WAIT_MS, MAX_AUTO_RETRY_WAIT_MS, MAX_JSON_BODY_BYTES, autoRetryDelay, describeUrl, readChunks, readErrorBody,
  scopedFetch,
} from './http.js';
import { SseOverflowError, createSseParser, decodeChunks } from './sse.js';

/** Refuse absurdly large prompts locally instead of uploading megabytes to find out. */
export const MAX_REQUEST_CHARS = 1_000_000;
/** Hard stop for a runaway server that never stops talking. */
export const MAX_OUTPUT_CHARS = 1_000_000;
export const MAX_ADAPTATIONS = 2;

const ROLES = new Set(['system', 'user', 'assistant']);

/**
 * Validate and clean `req.messages`: roles are checked, messages with no text are dropped (servers reject
 * empty content), and there must be at least one user/assistant turn.
 * @param {unknown} messages
 * @param {(code: string, message: string, opts?: object) => Error} fail
 * @returns {{role: 'system'|'user'|'assistant', content: string}[]}
 */
export function prepareMessages(messages, fail) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw fail('bad_request', 'There is nothing to send to the model.');
  }
  const out = [];
  let chars = 0;
  for (const m of messages) {
    if (!m || !ROLES.has(m.role) || typeof m.content !== 'string') {
      throw fail('bad_request', 'A message sent to the model was malformed.');
    }
    if (!m.content.trim()) continue;
    chars += m.content.length;
    out.push({ role: m.role, content: m.content });
  }
  if (!out.some((m) => m.role !== 'system')) {
    throw fail('bad_request', 'There is nothing to send to the model.');
  }
  if (chars > MAX_REQUEST_CHARS) {
    throw fail('context_too_long', 'This conversation is too long to send to the model.', {
      hint: 'Shorten the entry, or lower the context budget in Settings.',
    });
  }
  return out;
}

/** @returns {{promptTokens?: number, completionTokens?: number, totalTokens?: number}|undefined} */
export function normalizeUsage(prompt, completion, total) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
  const usage = { promptTokens: num(prompt), completionTokens: num(completion), totalTokens: num(total) };
  if (usage.totalTokens === undefined && usage.promptTokens !== undefined && usage.completionTokens !== undefined) {
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
  }
  for (const key of Object.keys(usage)) if (usage[key] === undefined) delete usage[key];
  return Object.keys(usage).length ? usage : undefined;
}

/**
 * Send a request with the adapters' shared failure policy:
 *  - a 2xx response is returned as is;
 *  - `adapt(status, bodyText, error)` may rewrite the request after a 400 (self-healing), at most
 *    MAX_ADAPTATIONS times; it must return true only if it actually changed something;
 *  - one automatic retry for a short 429 / any 503, after the wait the server asked for, but only when the failed
 *    attempt itself was quick (at most MAX_AUTO_RETRY_WAIT_MS): a 503 that took 15 s to arrive (verified live on
 *    gemini-flash-latest under load) would otherwise double the wait before the person sees the error, and the
 *    retry never succeeded in the 3 pairs observed;
 *  - everything else throws the mapped ProviderError.
 * The caller must not have emitted anything yet, which is why this only covers the part before the body.
 *
 * @param {object} p
 * @param {typeof fetch} p.fetchFn
 * @param {string} p.url
 * @param {() => RequestInit} p.buildInit builds the request from the CURRENT state (called per attempt)
 * @param {ReturnType<import('./http.js').createScope>} p.scope
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} p.sleepFn
 * @param {number} [p.retryFallbackMs]
 * @param {(response: Response, bodyText: string) => Error} p.mapError
 * @param {(status: number, bodyText: string, err: Error) => boolean} [p.adapt]
 * @param {number} [p.maxAdaptations]
 * @param {() => number} [p.now] clock in milliseconds (tests)
 * @returns {Promise<{response: Response, adaptations: number}>}
 */
export async function sendWithPolicy({
  fetchFn, url, buildInit, scope, sleepFn, retryFallbackMs = DEFAULT_RETRY_WAIT_MS, mapError, adapt,
  maxAdaptations = MAX_ADAPTATIONS, now = Date.now,
}) {
  let adaptations = 0;
  let retried = false;
  for (;;) {
    scope.throwIfAborted();
    const attemptStartedAt = now();
    const response = await scopedFetch(fetchFn, url, buildInit(), scope);
    if (response.ok) return { response, adaptations };

    const bodyText = await readErrorBody(response, scope);
    const err = mapError(response, bodyText);
    if (adapt && adaptations < maxAdaptations && (response.status === 400 || response.status === 422) && adapt(response.status, bodyText, err)) {
      adaptations += 1;
      scope.restart();
      continue;
    }
    const wait = retried ? null : autoRetryDelay(err, retryFallbackMs);
    if (wait === null || now() - attemptStartedAt > MAX_AUTO_RETRY_WAIT_MS) throw err;
    retried = true;
    scope.pause();
    try {
      await sleepFn(wait, scope.signal);
    } catch (sleepErr) {
      throw scope.fail(sleepErr);
    }
    scope.throwIfAborted();
    scope.restart();
  }
}

/**
 * Counters shared between `readJsonEvents` and an adapter's reply reader.
 *  - `malformed`: SSE data lines that were not JSON; `parsed`: JSON events delivered.
 *  - `sawText`: the body contained anything but whitespace; `sawDone`: the OpenAI `[DONE]` marker arrived.
 * Together with the adapter's own "this event has the API's shape" flag they separate a model that said
 * nothing from an address that is not an AI API at all (a web page, plain text, some other JSON service).
 */
export function createReplyStats() {
  return { malformed: 0, parsed: 0, sawText: false, sawDone: false };
}

/**
 * The address answered 2xx, but with something that is not an AI API reply, so the base URL is almost
 * certainly wrong. Shared by both adapters (the hint names the URL, whatever the provider).
 * @param {(code: string, message: string, opts?: object) => ProviderError} fail
 * @param {string} url the address that was called
 * @param {string} expected what a correct address looks like, e.g. "normally ends in /v1"
 */
export function notAnApiError(fail, url, expected) {
  return fail('bad_base_url', 'The address answered, but not like an AI API.', {
    hint: `${describeUrl(url)} returned something that is not a model reply (a web page or other text), so the base URL is probably wrong. ${expected}`,
  });
}

/**
 * Read a streamed answer as parsed JSON objects, whatever the server actually sent:
 *  - Server-Sent Events (`data: {...}`, with or without the space, `[DONE]` ends the stream);
 *  - a single JSON document (or array) although a stream was requested, whether or not the content type
 *    says so (detected by the first non-blank character).
 * Unparseable events are counted in `stats.malformed` and skipped. An SSE `event: error` frame is yielded
 * as `{ error: <payload> }`. Once `isFinished()` is true, a timeout or dropped connection is treated as
 * the normal end of the stream (some servers never close the socket after the last chunk).
 * `stats.sawText` / `stats.sawDone` tell the caller what kind of body this was (see `createReplyStats`). A body
 * that starts with `<` is a web page, never an API reply: reading stops there instead of downloading it all.
 *
 * @param {Response} response
 * @param {ReturnType<import('./http.js').createScope>} scope
 * @param {object} p
 * @param {ReturnType<typeof createReplyStats>} p.stats counters filled in for the caller
 * @param {() => boolean} p.isFinished
 * @param {(code: string, message: string, opts?: object) => ProviderError} p.fail
 * @returns {AsyncGenerator<any>}
 */
export async function* readJsonEvents(response, scope, { stats, isFinished, fail }) {
  const type = response.headers.get('content-type') || '';
  let jsonBuffer = /json/i.test(type) && !/ndjson/i.test(type) ? '' : null;
  let parser = null;
  let blank = '';
  let ended = false;

  function* fromEvents(events) {
    for (const ev of events) {
      const data = ev.data.trim();
      if (data === '[DONE]') {
        ended = true;
        stats.sawDone = true;
        return;
      }
      if (!data) continue;
      let obj;
      try {
        obj = JSON.parse(data);
      } catch {
        stats.malformed += 1;
        continue;
      }
      stats.parsed += 1;
      yield ev.event === 'error' && obj && typeof obj === 'object' && !obj.error ? { error: obj } : obj;
    }
  }

  try {
    for await (const text of decodeChunks(readChunks(response, scope))) {
      if (!stats.sawText && /\S/.test(text)) stats.sawText = true;
      if (jsonBuffer !== null) {
        jsonBuffer += text;
        if (jsonBuffer.length > MAX_JSON_BODY_BYTES) {
          throw fail('server', 'The server\'s answer was far too large to be valid.', {
            hint: 'Check that the base URL points at the model API and not at a web page.',
          });
        }
        continue;
      }
      let chunk = text;
      if (!parser) {
        chunk = (blank + text).trimStart();
        if (!chunk) {
          blank += text;
          continue;
        }
        if (chunk[0] === '{' || chunk[0] === '[') {
          jsonBuffer = chunk;
          continue;
        }
        if (chunk[0] === '<') return;
        parser = createSseParser();
      }
      yield* fromEvents(parser.push(chunk));
      if (ended) break;
    }
    if (parser && !ended) yield* fromEvents(parser.end());
  } catch (err) {
    if (err instanceof SseOverflowError) {
      throw fail('server', 'The server sent a line of text that never ended.', {
        hint: 'Check that the base URL points at the model API.',
      });
    }
    const harmless = isFinished() && err instanceof ProviderError && (err.code === 'timeout' || err.code === 'network');
    if (!harmless) throw err;
    return;
  }

  if (jsonBuffer !== null && jsonBuffer.trim()) {
    let doc;
    try {
      doc = JSON.parse(jsonBuffer);
    } catch {
      throw fail('server', 'The server answered with something that is not valid JSON.', {
        hint: 'Check that the base URL points at the model API (OpenAI-compatible servers normally end in /v1).',
      });
    }
    for (const item of Array.isArray(doc) ? doc : [doc]) {
      stats.parsed += 1;
      yield item;
    }
  }
}

/**
 * Build chat() on top of a stream() function.
 * @param {(req: object) => AsyncGenerator} stream
 */
export function chatFromStream(stream) {
  return async function chat(req) {
    let text = '';
    let finishReason = 'stop';
    let usage;
    for await (const ev of stream(req)) {
      if (ev.type === 'delta') {
        text += ev.text;
      } else if (ev.type === 'done') {
        finishReason = ev.finishReason;
        usage = ev.usage;
      }
    }
    const result = { text: text.trim(), finishReason };
    if (usage) result.usage = usage;
    return result;
  };
}

/**
 * Fold what one request learned into the adapter's shared knowledge. Requests heal a private working copy, so
 * concurrent requests cannot disturb each other's decisions; afterwards only the fields THIS request changed are
 * written back (copying the whole copy would undo lessons other requests confirmed meanwhile).
 * @param {object} shared adapter-level knowledge, updated in place
 * @param {object} before the shared knowledge as this request started
 * @param {object} after this request's working copy once it succeeded
 */
export function mergeLearned(shared, before, after) {
  for (const key of Object.keys(after)) {
    if (after[key] !== before[key]) shared[key] = after[key];
  }
}

/** Bounded Map used to remember per-endpoint quirks across short-lived adapter instances. */
export function createQuirkStore(limit = 64) {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > limit) map.delete(map.keys().next().value);
    },
    clear: () => map.clear(),
    get size() { return map.size; },
  };
}
