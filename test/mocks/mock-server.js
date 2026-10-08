// Shared plumbing for the mock LLM servers: a loopback HTTP server that records every request,
// tracks in-flight responses, supports delays/hangs/socket resets that are cleaned up on close(),
// and can write bytes in awkward slices (including inside multi-byte UTF-8 characters).

import http from 'node:http';

/**
 * @typedef {object} RecordedRequest
 * @property {number} id
 * @property {string} method
 * @property {string} path      URL pathname, e.g. /v1/chat/completions
 * @property {Record<string,string>} query
 * @property {Record<string,string>} headers  lower-cased names
 * @property {any} body         parsed JSON body (null if there was none or it was not JSON)
 * @property {string} rawBody
 * @property {number|null} status  status code written (null while pending / when hung)
 * @property {boolean} finished    the response completed
 * @property {boolean} aborted     the client went away before the response completed
 */

/**
 * Deterministic pseudo-random cut points (byte offsets, strictly inside the buffer) used to slice one write
 * into 2-3 TCP segments. Pure, so tests can check that some cuts land inside multi-byte characters.
 * @param {number} length
 * @param {number} seed
 * @returns {number[]} ascending, unique offsets in (0, length); empty for tiny buffers
 */
export function sliceOffsets(length, seed = 0) {
  if (length < 6) return [];
  const cuts = new Set();
  let x = (Math.imul(seed, 2654435761) + 12345) >>> 0;
  const pieces = 2 + (seed % 2);
  for (let i = 0; i < pieces - 1; i += 1) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    cuts.add(1 + (x % (length - 1)));
  }
  return [...cuts].sort((a, b) => a - b);
}

/** Per-response helper: cancellable waits, guarded writes, hang and reset. */
function createConn(req, res) {
  const timers = new Set();
  const waiters = new Set();
  let closed = false;
  const stop = () => {
    closed = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const w of waiters) w(false);
    waiters.clear();
  };
  // 'close' fires when the response completes or the connection dies; no socket listener is needed (and
  // adding one per request would pile up on a keep-alive connection).
  res.on('close', stop);

  const conn = {
    get closed() { return closed || res.destroyed; },
    /** Resolves true after `ms`, or false right away if the client has gone. */
    wait(ms) {
      return new Promise((resolve) => {
        if (conn.closed) return resolve(false);
        if (!(ms > 0)) return setImmediate(() => resolve(!conn.closed));
        const t = setTimeout(() => {
          timers.delete(t);
          waiters.delete(resolve);
          resolve(!conn.closed);
        }, ms);
        timers.add(t);
        waiters.add(resolve);
        return undefined;
      });
    },
    /** @returns {boolean} false when the client is gone */
    write(data) {
      if (conn.closed) return false;
      res.write(data);
      return true;
    },
    /**
     * Write `data` in slices cut at deterministic pseudo-random byte offsets (so some land inside a multi-byte
     * UTF-8 sequence or between CR and LF), pausing briefly so the slices tend to arrive as separate reads.
     */
    async writeSliced(data, seed = 0) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      let from = 0;
      for (const cut of sliceOffsets(buf.length, seed).concat(buf.length)) {
        if (!conn.write(buf.subarray(from, cut))) return false;
        from = cut;
        if (from < buf.length && !(await conn.wait(1))) return false;
      }
      return true;
    },
    /** Never resolves until the client disconnects (or the mock closes). */
    hang() {
      return new Promise((resolve) => {
        if (conn.closed) return resolve();
        waiters.add(resolve);
        return undefined;
      });
    },
    /** Abruptly kill the TCP connection (ECONNRESET / "terminated" on the client). */
    reset() {
      if (req.socket) req.socket.destroy();
    },
  };
  return conn;
}

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Start a mock server.
 * @param {object} p
 * @param {string} p.name for error messages
 * @param {number} [p.port] 0 = pick a free port
 * @param {string} [p.host]
 * @param {(ctx: {req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *   conn: ReturnType<typeof createConn>, record: RecordedRequest, url: URL, body: any, rawBody: string}) => Promise<void>} p.handle
 */
export async function startMockServer({ name, port = 0, host = '127.0.0.1', handle }) {
  /** @type {RecordedRequest[]} */
  const requests = [];
  const sockets = new Set();
  let inflight = 0;
  let nextId = 1;
  let closing = null;

  const server = http.createServer(async (req, res) => {
    let record;
    try {
      const rawBody = await readBody(req);
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      let body = null;
      if (rawBody.trim().startsWith('{') || rawBody.trim().startsWith('[')) {
        try { body = JSON.parse(rawBody); } catch { body = null; }
      }
      record = {
        id: nextId++,
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: { ...req.headers },
        body,
        rawBody,
        status: null,
        finished: false,
        aborted: false,
      };
      requests.push(record);
      inflight += 1;
      res.on('finish', () => { record.finished = true; });
      res.on('close', () => {
        inflight -= 1;
        record.status = record.status ?? (res.headersSent ? res.statusCode : null);
        if (!record.finished) record.aborted = true;
      });
      const origWriteHead = res.writeHead.bind(res);
      res.writeHead = (status, ...rest) => {
        record.status = status;
        return origWriteHead(status, ...rest);
      };
      const conn = createConn(req, res);
      await handle({ req, res, conn, record, url, body, rawBody });
    } catch (err) {
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, { error: { message: `${name} mock crashed: ${err && err.message}`, type: 'mock_error' } });
      } else if (!res.destroyed) {
        res.destroy();
      }
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  const hostForUrl = host.includes(':') ? `[${host}]` : host;

  return {
    server,
    host,
    port: actualPort,
    /** Origin, e.g. http://127.0.0.1:41234 (no path). */
    url: `http://${hostForUrl}:${actualPort}`,
    requests,
    /** Responses currently being served (0 once every client has finished or aborted). */
    get inflight() { return inflight; },
    /** Wait until `count` requests matching `filter` were recorded. */
    async waitForRequests(count = 1, { filter = () => true, timeoutMs = 5000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (requests.filter(filter).length < count) {
        if (Date.now() > deadline) throw new Error(`${name} mock: timed out waiting for ${count} request(s)`);
        await new Promise((r) => setTimeout(r, 5));
      }
      return requests.filter(filter);
    },
    /** Wait until no response is in flight (e.g. after the client aborted). */
    async waitForIdle(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (inflight > 0) {
        if (Date.now() > deadline) throw new Error(`${name} mock: ${inflight} response(s) still in flight`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    close() {
      if (!closing) {
        closing = new Promise((resolve) => {
          server.close(() => resolve());
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          for (const s of sockets) s.destroy();
        });
      }
      return closing;
    },
  };
}

/** Pause until the event loop has turned (lets the socket flush a write). */
export const tick = () => new Promise((resolve) => setImmediate(resolve));
