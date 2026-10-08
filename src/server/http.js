// Small HTTP toolkit: error type, JSON helpers, body reader with a size cap, the route table and the
// Server-Sent-Events writer. No dependencies, no global state.

import { Buffer } from 'node:buffer';

// ---------------------------------------------------------------------------------------------
// Errors

/** An error that maps to an HTTP response `{ error: { code, message, hint?, fields? } }`. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code snake_case code from the API contract
   * @param {string} message human readable
   * @param {{ hint?: string, fields?: Record<string,string>, headers?: Record<string,string>, cause?: unknown }} [opts]
   */
  constructor(status, code, message, { hint, fields, headers, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (hint) this.hint = hint;
    if (fields) this.fields = fields;
    if (headers) this.headers = headers;
  }
}

/** @param {string} message @param {{hint?: string, fields?: Record<string,string>}} [opts] */
export const badRequest = (message, opts) => new HttpError(400, 'bad_request', message, opts);
/** @param {string} [message] @param {{hint?: string}} [opts] */
export const notFound = (message = 'Not found.', opts) => new HttpError(404, 'not_found', message, opts);
/** @param {string} code @param {string} message @param {{hint?: string}} [opts] */
export const conflict = (code, message, opts) => new HttpError(409, code, message, opts);

/** The JSON body of an error response. */
export function errorBody(err) {
  const error = { code: err.code, message: err.message };
  if (err.hint) error.hint = err.hint;
  if (err.fields) error.fields = err.fields;
  return { error };
}

// ---------------------------------------------------------------------------------------------
// Responses

/**
 * Send a JSON response. Does nothing when the response was already started.
 * @returns {boolean} whether it was sent
 */
export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent || res.writableEnded) return false;
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, ...headers });
  res.end(data);
  return true;
}

/** Send an error response in the contract shape. */
export function sendError(res, err) {
  return sendJson(res, err.status, errorBody(err), err.headers);
}

/** 204 without a body. */
export function sendNoContent(res) {
  if (res.headersSent || res.writableEnded) return false;
  res.writeHead(204);
  res.end();
  return true;
}

/** Send text (or a Buffer) with an explicit content type. */
export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', headers = {}) {
  if (res.headersSent || res.writableEnded) return false;
  const data = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': data.length, ...headers });
  res.end(data);
  return true;
}

/**
 * `Content-Disposition: attachment` value with an ASCII fallback and an RFC 5987 UTF-8 name.
 * @param {string} filename
 */
export function attachmentHeader(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\;]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---------------------------------------------------------------------------------------------
// Request bodies

const payloadTooLarge = (limit) => new HttpError(413, 'payload_too_large', `The request is larger than ${formatBytes(limit)}.`, {
  hint: limit > 5 * 1024 * 1024 ? 'Split the file into smaller parts.' : 'Send less text at once.',
  headers: { Connection: 'close' },
});

function formatBytes(n) {
  return n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MB` : `${Math.round(n / 1024)} KB`;
}

/**
 * Read the whole request body, refusing more than `limit` bytes. The declared Content-Length is checked
 * first so an oversized upload is refused without reading it. The stream is not destroyed on overflow:
 * the remaining bytes are discarded so the 413 response can still be delivered.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(payloadTooLarge(limit));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      fn(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        finish(reject, payloadTooLarge(limit));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks, size));
    const onError = () => finish(reject, badRequest('The request was interrupted.'));
    const onClose = () => { if (!req.complete) finish(reject, badRequest('The request was interrupted.')); };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Read and parse a JSON body.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit: number, expect?: 'object'|'any', allowEmpty?: boolean }} opts
 *   `expect: 'object'` (default) refuses arrays and scalars; an empty body counts as `{}` unless `allowEmpty` is false
 * @returns {Promise<any>}
 * @throws {HttpError} 400 bad_request for malformed JSON, 413 payload_too_large
 */
export async function readJson(req, { limit, expect = 'object', allowEmpty = true }) {
  const buffer = await readBody(req, limit);
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === '') {
    if (allowEmpty && expect === 'object') return {};
    throw badRequest('The request needs a JSON body.');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw badRequest('The request body is not valid JSON.', { hint: 'Send a JSON object with Content-Type: application/json.' });
  }
  if (expect === 'object' && !isPlainObject(value)) throw badRequest('The request body must be a JSON object.');
  return value;
}

// ---------------------------------------------------------------------------------------------
// Server-Sent Events

/** @typedef {{ send(event: string, data: unknown): boolean, ping(): boolean, close(): void, readonly isOpen: boolean }} Sse */

// A client that does not read for this long has too much queued; treat it as gone instead of buffering forever.
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

/**
 * Start an SSE response (docs/ARCHITECTURE.md section 7): `event: <name>\ndata: <one line of JSON>\n\n`
 * frames and a `: ping` comment every `pingMs` so proxies keep the connection open.
 * @param {import('node:http').ServerResponse} res
 * @param {{ pingMs?: number }} [opts]
 * @returns {Sse}
 */
export function openSse(res, { pingMs = 15_000 } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);

  let open = true;
  let timer = null;
  const stop = () => {
    open = false;
    if (timer) clearInterval(timer);
    timer = null;
  };
  res.once('close', stop);

  function write(frame) {
    if (!open || res.destroyed || res.writableEnded) return false;
    if (res.writableLength > MAX_QUEUED_BYTES) {
      res.destroy();
      return false;
    }
    res.write(frame);
    return true;
  }

  if (pingMs > 0) {
    timer = setInterval(() => write(': ping\n\n'), pingMs);
    timer.unref();
  }

  return {
    send(event, data) {
      return write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    ping() {
      return write(': ping\n\n');
    },
    close() {
      const wasOpen = open;
      stop();
      if (wasOpen && !res.writableEnded && !res.destroyed) res.end();
    },
    get isOpen() {
      return open && !res.destroyed && !res.writableEnded;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Router

const METHOD_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Tiny pattern router. Patterns look like `/entries/:id/messages/:mid`; a static segment beats a
 * parameter (`/memories/clear` wins over `/memories/:id`). HEAD is served by the GET route.
 */
export function createRouter() {
  const routes = [];

  function compile(pattern) {
    return pattern.split('/').filter(Boolean).map((part) => (part.startsWith(':') ? { param: part.slice(1) } : { value: part }));
  }

  return {
    routes,
    /**
     * @param {string} method
     * @param {string} pattern
     * @param {(ctx: any) => Promise<void>|void} handler
     * @param {{ public?: boolean, bodyLimit?: number }} [options] `public`: reachable without signing in
     */
    add(method, pattern, handler, options = {}) {
      routes.push({ method, pattern, segments: compile(pattern), handler, options });
    },
    /**
     * @param {string} method
     * @param {string[]} segments decoded path segments below /api
     * @returns {null | { route: object, params: Record<string,string>, public: boolean }
     *   | { methodNotAllowed: true, allow: string[], public: boolean }}
     */
    match(method, segments) {
      let best = null;
      let bestScore = -1;
      let top = -1;
      const topRoutes = [];
      for (const route of routes) {
        if (route.segments.length !== segments.length) continue;
        const params = {};
        let score = 0;
        let ok = true;
        for (let i = 0; i < segments.length; i += 1) {
          const seg = route.segments[i];
          if (seg.param) params[seg.param] = segments[i];
          else if (seg.value === segments[i]) score += 1;
          else { ok = false; break; }
        }
        if (!ok) continue;
        if (score > top) { top = score; topRoutes.length = 0; }
        if (score === top) topRoutes.push(route);
        if ((route.method === method || (method === 'HEAD' && route.method === 'GET')) && score > bestScore) {
          best = { route, params };
          bestScore = score;
        }
      }
      if (best) return { ...best, public: Boolean(best.route.options.public) };
      if (topRoutes.length === 0) return null;
      const allow = new Set(topRoutes.map((r) => r.method));
      if (allow.has('GET')) allow.add('HEAD');
      return {
        methodNotAllowed: true,
        allow: METHOD_ORDER.filter((m) => allow.has(m)),
        public: topRoutes.every((r) => r.options.public),
      };
    },
  };
}
