// HTTP client for the MyJournal API. See docs/ARCHITECTURE.md §6–7 for the contract.

export class ApiError extends Error {
  constructor({ status = 0, code = 'unknown', message = 'Something went wrong', hint = '', fields = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.fields = fields;
  }
}

const BASE = '/api';

// Tell the app when the server stops answering (and when it answers again) so it can show one calm banner instead of
// every view failing on its own. Only transitions are reported, never every failed request.
let serverReachable = true;
/** Report that the server did (true) or did not (false) answer. Also used by the router when a view file cannot be fetched. */
export function reportReachable(ok) {
  if (ok === serverReachable) return;
  serverReachable = ok;
  if (typeof window !== 'undefined' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent(ok ? 'myjournal:online' : 'myjournal:offline'));
}

function errorFromBody(status, body) {
  const e = body && body.error ? body.error : {};
  return new ApiError({
    status,
    code: e.code || (status === 401 ? 'unauthorized' : 'unknown'),
    message: e.message || `Request failed (${status})`,
    hint: e.hint || '',
    fields: e.fields || null,
  });
}

async function readError(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const err = errorFromBody(res.status, body);
  if (res.status === 401 && err.code === 'unauthorized') {
    window.dispatchEvent(new CustomEvent('myjournal:unauthorized'));
  }
  return err;
}

async function doFetch(method, path, body, signal, extraHeaders) {
  const headers = { 'X-MyJournal': '1', ...extraHeaders };
  const init = { method, headers, signal, credentials: 'same-origin' };
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(BASE + path, init);
    reportReachable(true);
    return res;
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    reportReachable(false);
    throw new ApiError({
      code: 'network',
      message: 'Could not reach the MyJournal server.',
      hint: 'Is it still running? Check the terminal where you started it.',
    });
  }
}

async function request(method, path, body, { signal } = {}) {
  const res = await doFetch(method, path, body, signal);
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) return res.json();
  return res.text();
}

/**
 * Incremental Server-Sent-Events parser. Feed it text chunks; it calls onEvent(name, data)
 * for each complete frame. Handles \r\n, comments (": ping"), multi-line data and split chunks.
 */
export function createSseParser(onEvent) {
  let buffer = '';
  let eventName = 'message';
  let dataLines = [];

  function dispatch() {
    if (dataLines.length === 0) { eventName = 'message'; return; }
    const raw = dataLines.join('\n');
    let data = raw;
    try { data = JSON.parse(raw); } catch { /* keep raw string */ }
    const name = eventName;
    eventName = 'message';
    dataLines = [];
    onEvent(name, data);
  }

  function processLine(line) {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }

  return {
    push(text) {
      buffer += text;
      let nl;
      while ((nl = buffer.search(/\r\n|\n|\r/)) !== -1) {
        const sep = buffer.startsWith('\r\n', nl) ? 2 : 1;
        // A lone trailing "\r" may be the first half of "\r\n": wait for more data.
        if (buffer[nl] === '\r' && nl === buffer.length - 1) break;
        processLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + sep);
      }
    },
    end() {
      if (buffer) { processLine(buffer); buffer = ''; }
      dispatch();
    },
  };
}

/**
 * POST (or other method) and consume a text/event-stream response.
 * Resolves when the stream ends. Throws ApiError if the server rejected the request before
 * streaming started (JSON error). In-stream `error` events are delivered to onEvent, not thrown.
 * Aborting `signal` stops reading and resolves quietly with { aborted: true }.
 */
async function stream(path, body, { signal, onEvent, method = 'POST' } = {}) {
  let res;
  try {
    res = await doFetch(method, path, body === undefined ? {} : body, signal, { Accept: 'text/event-stream' });
  } catch (err) {
    if (err && err.name === 'AbortError') return { aborted: true };
    throw err;
  }
  if (!res.ok) throw await readError(res);
  if (!res.body) throw new ApiError({ code: 'network', message: 'Streaming is not supported by this browser.' });

  const parser = createSseParser((name, data) => { if (onEvent) onEvent(name, data); });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } catch (err) {
    if (err && err.name === 'AbortError') return { aborted: true };
    reportReachable(false); // may just be a dropped stream: the app confirms with a health check before it says anything
    throw new ApiError({ code: 'network', message: 'The connection was interrupted.', hint: 'Your text is saved. Try again.' });
  }
  return { aborted: false };
}

/** Download a file endpoint through the browser's save dialog. */
async function download(path, fallbackName = 'download') {
  const res = await doFetch('GET', path);
  if (!res.ok) throw await readError(res);
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const name = match ? match[1] : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body === undefined ? {} : body, opts),
  put: (path, body, opts) => request('PUT', path, body, opts),
  patch: (path, body, opts) => request('PATCH', path, body, opts),
  del: (path, opts) => request('DELETE', path, undefined, opts),
  stream,
  download,
};
