// Shared helpers for the server tests (not a test file itself): boot the real app on port 0 with a temp data
// folder and mock LLM servers, talk to it over plain node:http so every header can be controlled, and parse SSE.

import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSseParser } from '../../public/js/lib/api.js';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
import { clearGeminiQuirks } from '../../src/providers/gemini.js';
import { clearOpenAIQuirks } from '../../src/providers/openai.js';
import { createApp } from '../../src/server/app.js';
import { mergeSettings } from '../../src/settings.js';
import { createMockGemini } from '../mocks/mock-gemini.js';
import { createMockOpenAI } from '../mocks/mock-openai.js';

/** Poll until `fn()` is truthy (or return its value); fails with `message` after `timeoutMs`. */
export async function waitFor(fn, { timeoutMs = 5000, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Low-level request with full control over headers. `csrf` adds `X-MyJournal: 1` (default for non-GET).
 * @returns {Promise<{ status: number, headers: Record<string,string|string[]>, text: string, json: any }>}
 */
export function rawRequest(baseUrl, method, path, { body, headers = {}, csrf, rawBody, timeoutMs = 15000 } = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const payload = rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body);
    const h = { Connection: 'close', ...headers };
    const wantCsrf = csrf ?? !['GET', 'HEAD'].includes(method);
    if (wantCsrf && !Object.keys(h).some((k) => k.toLowerCase() === 'x-myjournal')) h['X-MyJournal'] = '1';
    if (payload !== undefined) {
      if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: url.hostname, port: url.port, method, path, headers: h, agent: false, setHost: !Object.keys(h).some((k) => k.toLowerCase() === 'host') }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (String(res.headers['content-type'] || '').includes('json')) {
          try { json = JSON.parse(text); } catch { json = null; }
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out: ${method} ${path}`)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** A TCP port nothing listens on (it was free a moment ago). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Send raw bytes to the server and collect everything it answers until it closes the connection. */
export function rawSocket(baseUrl, text, { timeoutMs = 5000 } = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname);
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); resolve(data); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', (err) => { clearTimeout(timer); if (data) resolve(data); else reject(err); });
    socket.on('close', () => { clearTimeout(timer); resolve(data); });
  });
}

/** Parse a complete `text/event-stream` body into [{ event, data }]. */
export function parseSse(text) {
  const events = [];
  const parser = createSseParser((event, data) => events.push({ event, data }));
  parser.push(text);
  parser.end();
  return events;
}

/**
 * Start an SSE request and keep the connection open: `events` fills as frames arrive, `abort()` drops the
 * connection like a closed browser tab, `finished` resolves when the response ends or the socket closes.
 */
export function openStream(baseUrl, path, body = {}, { headers = {}, method = 'POST' } = {}) {
  const url = new URL(baseUrl);
  const events = [];
  let raw = '';
  let status = 0;
  let responseHeaders = {};
  let errorBody = null;
  const parser = createSseParser((event, data) => events.push({ event, data }));
  const payload = JSON.stringify(body);
  let req;
  const finished = new Promise((resolve) => {
    req = http.request({
      host: url.hostname,
      port: url.port,
      method,
      path,
      agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-MyJournal': '1', Connection: 'close', ...headers },
    }, (res) => {
      status = res.statusCode;
      responseHeaders = res.headers;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        if (String(res.headers['content-type'] || '').includes('event-stream')) parser.push(chunk);
      });
      res.on('end', () => {
        if (status !== 200 || !String(res.headers['content-type'] || '').includes('event-stream')) {
          try { errorBody = JSON.parse(raw); } catch { errorBody = null; }
        } else {
          parser.end();
        }
        resolve();
      });
      res.on('close', resolve);
      res.on('error', resolve);
    });
    req.on('error', resolve);
    req.write(payload);
    req.end();
  });
  return {
    events,
    finished,
    get status() { return status; },
    get headers() { return responseHeaders; },
    get raw() { return raw; },
    /** JSON error body when the server answered with an error instead of a stream. */
    get error() { return errorBody && errorBody.error; },
    names: () => events.map((e) => e.event),
    of: (name) => events.filter((e) => e.event === name).map((e) => e.data),
    text: () => events.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''),
    abort: () => req.destroy(),
    waitForEvent: (name, timeoutMs = 5000) => waitFor(() => events.find((e) => e.event === name), { timeoutMs, message: `SSE event "${name}"` }),
  };
}

/** Run an SSE request to completion. */
export async function sse(baseUrl, path, body = {}, options) {
  const stream = openStream(baseUrl, path, body, options);
  await stream.finished;
  return stream;
}

/** Save a settings patch the way the API would (validated, merged), without going through HTTP. */
export function saveSettings(db, patch) {
  const { settings, errors } = mergeSettings(db.settings.get(), patch);
  if (Object.keys(errors).length > 0) throw new Error(`bad settings patch: ${JSON.stringify(errors)}`);
  return db.settings.set(settings);
}

/**
 * Boot the app.
 * @param {object} [options]
 * @param {'local'|'openai'|'gemini'|false} [options.ai] which mock provider to configure and select ('local' default)
 * @param {object} [options.mock] options for the mock LLM server
 * @param {object} [options.config] overrides for loadConfig
 * @param {object} [options.settings] extra settings patch
 * @param {typeof fetch} [options.fetch] injected into the app
 * @param {Record<string,string>} [options.env] environment given to the app (default: none, so no stray keys leak in)
 */
export async function startApp({ ai = 'local', mock: mockOptions = {}, config: configOverrides = {}, settings = {}, fetch: fetchImpl, env = {} } = {}) {
  clearOpenAIQuirks();
  clearGeminiQuirks();
  const dir = mkdtempSync(join(tmpdir(), 'myjournal-test-'));
  const db = openDb({ file: join(dir, 'journal.db') });
  const config = loadConfig({ ...env, JOURNAL_DATA_DIR: dir }, { overrides: { port: 0, quiet: true, ssePingMs: 15000, shutdownGraceMs: 500, ...configOverrides } });
  let mock = null;
  if (ai === 'gemini') {
    mock = await createMockGemini({ apiKey: ['test-gemini-key'], ...mockOptions });
    saveSettings(db, { onboarded: true, ai: { provider: 'gemini', providers: { gemini: { baseUrl: mock.url, apiKey: 'test-gemini-key' } } } });
  } else if (ai === 'openai') {
    mock = await createMockOpenAI({ apiKey: ['test-openai-key'], ...mockOptions });
    saveSettings(db, { onboarded: true, ai: { provider: 'openai', providers: { openai: { baseUrl: mock.baseUrl, model: 'mock-model', apiKey: 'test-openai-key' } } } });
  } else if (ai === 'local') {
    mock = await createMockOpenAI(mockOptions);
    saveSettings(db, { onboarded: true, ai: { provider: 'local', providers: { local: { baseUrl: mock.baseUrl, model: 'llama3.2:3b' } } } });
  }
  if (Object.keys(settings).length > 0) saveSettings(db, settings); // deep-merged over the provider setup above
  const app = createApp({ config, db, fetch: fetchImpl });
  const listening = await app.listen();
  const url = listening.url;

  const api = (method, path, options) => rawRequest(url, method, path, options);
  let closed = false;
  return {
    app,
    db,
    config,
    mock,
    dir,
    url,
    request: api,
    get: (path, options) => api('GET', path, options),
    post: (path, body, options) => api('POST', path, { body: body ?? {}, ...options }),
    put: (path, body, options) => api('PUT', path, { body, ...options }),
    patch: (path, body, options) => api('PATCH', path, { body, ...options }),
    del: (path, options) => api('DELETE', path, options),
    sse: (path, body, options) => sse(url, path, body, options),
    stream: (path, body, options) => openStream(url, path, body, options),
    /** Create an entry through the API. */
    async entry(fields = {}) {
      const res = await api('POST', '/api/entries', { body: fields });
      if (res.status !== 201) throw new Error(`could not create entry: ${res.status} ${res.text}`);
      return res.json;
    },
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      if (mock) await mock.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run `fn(harness)` with a booted app and always clean up. */
export async function withApp(options, fn) {
  const h = await startApp(options);
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}
