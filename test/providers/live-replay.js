// Replays responses captured from REAL servers (test/fixtures/ollama-live, test/fixtures/llamacpp-live) through the
// adapters. Not a test file itself. A capture is `<name>.body` (exact bytes) + `<name>.headers.txt` (status line and
// headers, as curl wrote them).

import fs from 'node:fs';

const ROOTS = {
  ollama: new URL('../fixtures/ollama-live/', import.meta.url),
  llamacpp: new URL('../fixtures/llamacpp-live/', import.meta.url),
};

/** Raw bytes of a capture's body. */
export const readBody = (server, name) => fs.readFileSync(new URL(`${name}.body`, ROOTS[server]));

/** Status and content type from a capture's `.headers.txt` (`HTTP/1.1 200 OK` ... `Content-Type: ...`). */
export function captured(server, name) {
  const headers = fs.readFileSync(new URL(`${name}.headers.txt`, ROOTS[server]), 'utf8');
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/m.exec(headers)[1]);
  const ct = /^content-type: (.+)$/mi.exec(headers);
  const retry = /^retry-after: (.+)$/mi.exec(headers);
  return { status, contentType: ct ? ct[1].trim() : '', retryAfter: retry ? retry[1].trim() : null, body: readBody(server, name) };
}

/**
 * A fetch double that serves one capture for every call (or, with `routes`, a different capture per URL suffix),
 * optionally delivering the body in the given pieces. `fn.calls` records `{ url, init, body }`.
 * @param {'ollama'|'llamacpp'} server
 * @param {string|Record<string,string>} nameOrRoutes
 * @param {{pieces?: Uint8Array[]}} [opts]
 */
export function replayFetch(server, nameOrRoutes, { pieces } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const u = String(url);
    const name = typeof nameOrRoutes === 'string'
      ? nameOrRoutes
      : Object.entries(nameOrRoutes).find(([suffix]) => u.endsWith(suffix))?.[1];
    calls.push({ url: u, init, body: init && typeof init.body === 'string' ? JSON.parse(init.body) : null });
    if (!name) return new Response('404 page not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const { status, contentType, body } = captured(server, name);
    const payload = pieces
      ? new ReadableStream({ start(c) { for (const p of pieces) c.enqueue(p); c.close(); } })
      : body;
    return new Response(payload, { status, headers: contentType ? { 'content-type': contentType } : {} });
  };
  fn.calls = calls;
  return fn;
}

/** Text of every `delta.content` / `delta.reasoning(_content)` in a captured SSE body, for cross-checking the adapter. */
export function sseTexts(server, name) {
  let content = '';
  let reasoning = '';
  let usage = null;
  let finish = null;
  for (const line of readBody(server, name).toString('utf8').split('\n')) {
    if (!line.startsWith('data: {')) continue;
    const obj = JSON.parse(line.slice(6));
    for (const choice of obj.choices || []) {
      const d = choice.delta || {};
      if (typeof d.content === 'string') content += d.content;
      reasoning += d.reasoning || d.reasoning_content || '';
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (obj.usage) usage = obj.usage;
  }
  return { content, reasoning, usage, finish };
}
