// Error type shared by every provider adapter. See docs/ARCHITECTURE.md §9.
//
// Two rules matter more than anything else in this file:
//   1. A caller abort is NEVER a ProviderError: it is a plain DOMException named 'AbortError'.
//   2. An API key must never survive into an error (message, hint, detail, cause, JSON, stack).

export const ERROR_CODES = Object.freeze([
  'auth', 'rate_limit', 'quota', 'model_not_found', 'bad_base_url', 'network', 'timeout',
  'blocked', 'context_too_long', 'bad_request', 'server', 'overloaded', 'region', 'empty', 'unknown',
]);

const REDACTED = '[redacted]';

// Secrets shorter than this are only scrubbed from text that came from a remote server (where an echo is
// plausible). Our own static messages mention things like `ollama serve`, and "ollama" is a very common
// dummy key for local servers, so scrubbing short secrets everywhere would garble our own hints.
const MIN_GUARD_LENGTH = 8;
const MIN_UPSTREAM_LENGTH = 4;

/**
 * Replace every occurrence of any secret (raw and URL-encoded) with "[redacted]".
 * @param {unknown} text
 * @param {Array<string|undefined|null>} secrets
 * @param {number} [minLength] ignore secrets shorter than this
 * @returns {unknown} the scrubbed string (non-strings are returned unchanged)
 */
export function redactSecrets(text, secrets, minLength = MIN_UPSTREAM_LENGTH) {
  if (typeof text !== 'string' || !text || !secrets || !secrets.length) return text;
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < minLength) continue;
    out = out.split(secret).join(REDACTED);
    let encoded = secret;
    try { encoded = encodeURIComponent(secret); } catch { /* lone surrogate: skip */ }
    if (encoded !== secret) out = out.split(encoded).join(REDACTED);
  }
  return out;
}

/**
 * Reduce an arbitrary thrown value to a small, JSON-safe, secret-free description. Only name, message and
 * the error `code` survive, so request headers or bodies attached to a library error can never leak.
 * @param {unknown} cause
 * @param {string[]} secrets
 * @param {number} [depth]
 * @returns {{name: string, message: string, code?: string, cause?: object}|undefined}
 */
export function sanitizeCause(cause, secrets, depth = 0) {
  if (cause === undefined || cause === null) return undefined;
  const clean = (v) => redactSecrets(String(v), secrets, MIN_UPSTREAM_LENGTH);
  if (typeof cause !== 'object') return { name: 'Error', message: clean(cause).slice(0, 300) };
  const out = {
    name: clean(cause.name || 'Error'),
    message: clean(cause.message ?? '').slice(0, 300),
  };
  if (typeof cause.code === 'string' || typeof cause.code === 'number') out.code = clean(cause.code);
  if (depth < 2 && cause.cause) out.cause = sanitizeCause(cause.cause, secrets, depth + 1);
  return out;
}

/** Normalised error thrown by every adapter. `message` is user-facing; `hint` says what to try next. */
export class ProviderError extends Error {
  /**
   * @param {string} code one of ERROR_CODES (anything else becomes 'unknown')
   * @param {string} message user-friendly, actionable, never contains the API key
   * @param {object} [opts]
   * @param {string} [opts.hint] what the user can do about it
   * @param {number} [opts.status] upstream HTTP status
   * @param {number} [opts.retryAfterMs] when the upstream said to retry
   * @param {string} [opts.provider] 'gemini' | 'openai' | 'local'
   * @param {string} [opts.detail] the upstream's own words (already one-line and short)
   * @param {unknown} [opts.cause] underlying error; stored as a sanitised plain object
   * @param {string[]} [opts.secrets] strings to scrub (the API key) from everything stored here
   */
  constructor(code, message, opts = {}) {
    const secrets = opts.secrets || [];
    const guard = (v) => redactSecrets(v, secrets, MIN_GUARD_LENGTH);
    super(guard(String(message ?? '')));
    this.name = 'ProviderError';
    this.code = ERROR_CODES.includes(code) ? code : 'unknown';
    if (opts.hint) this.hint = guard(String(opts.hint));
    if (Number.isFinite(opts.status)) this.status = opts.status;
    if (Number.isFinite(opts.retryAfterMs)) this.retryAfterMs = Math.max(0, Math.round(opts.retryAfterMs));
    if (opts.provider) this.provider = opts.provider;
    if (opts.detail) this.detail = redactSecrets(String(opts.detail), secrets, MIN_UPSTREAM_LENGTH);
    const cause = sanitizeCause(opts.cause, secrets);
    if (cause) this.cause = cause;
  }

  /** JSON.stringify(err) is useful (Error#message is not enumerable) and safe to log. */
  toJSON() {
    const out = { name: this.name, code: this.code, message: this.message };
    for (const key of ['hint', 'status', 'retryAfterMs', 'provider', 'detail', 'cause']) {
      if (this[key] !== undefined) out[key] = this[key];
    }
    return out;
  }
}

/**
 * Build a `fail(code, message, opts)` helper that stamps provider id and secrets on every error.
 * @param {string} provider
 * @param {string[]} secrets
 * @returns {(code: string, message: string, opts?: object) => ProviderError}
 */
export function errorFactory(provider, secrets) {
  return (code, message, opts = {}) => new ProviderError(code, message, { provider, secrets, ...opts });
}

/** The standard error for "the caller cancelled". Deliberately not a ProviderError. */
export function abortError(message = 'The operation was aborted.') {
  return new DOMException(message, 'AbortError');
}

/** @param {unknown} err */
export function isAbortError(err) {
  return Boolean(err) && typeof err === 'object' && err.name === 'AbortError';
}

/**
 * The `{ code, message, hint? }` shape used in SSE `error` events and `/api/providers/*` bodies.
 * Anything that is not a ProviderError becomes a generic, non-leaky `unknown`.
 * @param {unknown} err
 * @returns {{code: string, message: string, hint?: string}}
 */
export function errorPayload(err) {
  if (err instanceof ProviderError) {
    const out = { code: err.code, message: err.message };
    if (err.hint) out.hint = err.hint;
    return out;
  }
  return { code: 'unknown', message: 'Something went wrong while talking to the AI model.' };
}
