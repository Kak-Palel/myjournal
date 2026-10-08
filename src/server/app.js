// The HTTP application: wires security, auth, routes, static files and the lifecycle (docs/ARCHITECTURE.md §10).
//
//   const app = createApp({ config, db });
//   const { url } = await app.listen();
//   ...
//   await app.close();          // stops accepting, aborts running generations, drops connections. Does NOT close db.
//
// No global state: every call builds an independent instance, so tests run many of them on port 0.

import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { Buffer } from 'node:buffer';
import { assertSafeToStart, withConfigDefaults } from '../config.js';
import { DbError } from '../db/index.js';
import { createAiService } from './ai-service.js';
import { createAuth } from './auth.js';
import { createGenerationManager, createGenerationService } from './generation.js';
import {
  HttpError, attachmentHeader, badRequest, createRouter, errorBody, notFound, readJson, sendError, sendJson, sendNoContent, sendText,
} from './http.js';
import { createLogger } from './logger.js';
import { createSecurity, applySecurityHeaders, securityHeaderLines } from './security.js';
import { createStatic } from './static.js';
import { register as registerAuth } from './routes/auth.js';
import { register as registerCatalog } from './routes/catalog.js';
import { register as registerData } from './routes/data.js';
import { register as registerEntries } from './routes/entries.js';
import { register as registerInsights } from './routes/insights.js';
import { register as registerMemories } from './routes/memories.js';
import { register as registerProviders } from './routes/providers.js';
import { register as registerSettings } from './routes/settings.js';

const REGISTRARS = [registerAuth, registerSettings, registerProviders, registerCatalog, registerEntries, registerMemories, registerInsights, registerData];

/** Failure to start listening, with wording meant for the person who started the server. */
export class ListenError extends Error {
  constructor(message, hint, code) {
    super(message);
    this.name = 'ListenError';
    this.code = code;
    if (hint) this.hint = hint;
  }
}

function describeListenError(err, config) {
  if (err && err.code === 'EADDRINUSE') {
    const next = Number(config.port) > 0 && Number(config.port) < 65535 ? Number(config.port) + 1 : 3211;
    return new ListenError(
      `Port ${config.port} is already in use.`,
      `Is MyJournal already running? Use another port, for example: PORT=${next} npm start`,
      err.code,
    );
  }
  if (err && err.code === 'EACCES') {
    return new ListenError(`Not allowed to listen on port ${config.port}.`, 'Ports below 1024 need administrator rights. Try PORT=3210.', err.code);
  }
  if (err && (err.code === 'EADDRNOTAVAIL' || err.code === 'ENOTFOUND')) {
    return new ListenError(`The address ${config.host} is not available on this computer.`, 'Use HOST=127.0.0.1 or HOST=0.0.0.0.', err.code);
  }
  return err;
}

/** Map anything thrown by a route to the HttpError that is sent. Unknown errors are logged and become a generic 500. */
function toHttpError(err, log) {
  if (err instanceof HttpError) return err;
  if (err instanceof DbError) {
    switch (err.code) {
      case 'invalid':
        return badRequest(err.message, err.field ? { fields: { [err.field]: err.message } } : undefined);
      case 'invalid_import':
        return badRequest(err.message, { hint: 'Use a file made by "Export JSON" in Settings > Data.' });
      case 'not_found':
        return notFound('Not found.');
      case 'conflict':
        return new HttpError(409, 'conflict', err.message);
      default:
        break;
    }
  }
  log.error('Unhandled error while serving a request', err);
  return new HttpError(500, 'internal_error', 'Something went wrong on the server.', {
    hint: 'Your journal is safe. Check the terminal where MyJournal is running for details.',
  });
}

function parseTarget(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 8192 || !rawUrl.startsWith('/')) throw badRequest('That is not a valid address.');
  const hash = rawUrl.indexOf('#');
  const noHash = hash === -1 ? rawUrl : rawUrl.slice(0, hash);
  const q = noHash.indexOf('?');
  return {
    rawPath: q === -1 ? noHash : noHash.slice(0, q),
    query: new URLSearchParams(q === -1 ? '' : noHash.slice(q + 1)),
  };
}

/** The decoded path segments below /api ("/api/entries/x" -> ["entries", "x"]). */
function apiSegments(rawPath) {
  const out = [];
  for (const part of rawPath.slice(4).split('/')) {
    if (part === '') continue;
    try {
      out.push(decodeURIComponent(part));
    } catch {
      throw badRequest('That is not a valid address.');
    }
  }
  return out;
}

const isApiPath = (rawPath) => rawPath === '/api' || rawPath.startsWith('/api/');

/**
 * @param {{ config: object, db: object, fetch?: typeof fetch }} deps
 *   `fetch` is handed to the AI providers (tests inject a double; default is the global fetch)
 */
export function createApp({ config: given, db, fetch: fetchImpl } = {}) {
  if (!given || !db) throw new TypeError('createApp({ config, db }) needs both');
  const config = withConfigDefaults(given); // a hand-built config may leave out limits; they must not vanish
  assertSafeToStart(config);

  const log = createLogger(config);
  const security = createSecurity(config);
  const auth = createAuth(config);
  const ai = createAiService({ db, env: config.env || process.env, fetch: fetchImpl });
  const generations = createGenerationManager();
  const gen = createGenerationService({ db, ai, config, generations, log });
  const staticFiles = createStatic({ root: config.publicDir });
  const router = createRouter();
  const deps = { config, db, ai, auth, generations, gen, log };
  for (const register of REGISTRARS) register(router, deps);

  function makeContext(req, res, query, match) {
    let body = null;
    let abort = null;
    return {
      req,
      res,
      query,
      params: match.params,
      config,
      method: req.method,
      json: (data, status = 200, headers) => sendJson(res, status, data, headers),
      noContent: () => sendNoContent(res),
      /** Send text as a download when `filename` is given. */
      text: (text, contentType, filename) => sendText(res, 200, text, contentType, filename ? { 'Content-Disposition': attachmentHeader(filename) } : {}),
      /** Parse the JSON body once (the size cap comes from the route, 1 MB unless it says otherwise). */
      readJson(options = {}) {
        if (!body) body = readJson(req, { limit: match.route.options.bodyLimit ?? config.maxJsonBytes, ...options });
        return body;
      },
      /** Aborts when the client disconnects before the response is complete. */
      get signal() {
        if (!abort) {
          abort = new AbortController();
          if (res.destroyed) abort.abort();
          else res.once('close', () => { if (!res.writableFinished) abort.abort(); });
        }
        return abort.signal;
      },
    };
  }

  async function handleApi(req, res, target) {
    const match = router.match(req.method, apiSegments(target.rawPath));
    if (auth.required && !(match && match.public) && !auth.isAuthenticated(req)) {
      throw new HttpError(401, 'unauthorized', 'Please sign in first.', { hint: 'Open the journal in your browser and enter your password.' });
    }
    if (!match) throw notFound('There is no such API address.');
    if (match.methodNotAllowed) {
      throw new HttpError(405, 'method_not_allowed', 'That method is not allowed here.', { headers: { Allow: match.allow.join(', ') } });
    }
    await match.route.handler(makeContext(req, res, target.query, match));
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      throw new Error(`The handler for ${match.route.method} ${match.route.pattern} did not answer`);
    }
  }

  function respondError(req, res, err) {
    const httpError = toHttpError(err, log);
    if (res.headersSent) {
      if (!res.writableEnded && !res.destroyed) res.end();
      return;
    }
    // A body we did not read must not be streamed into the next request on this connection.
    if (!req.complete) res.setHeader('Connection', 'close');
    sendError(res, httpError);
  }

  async function handle(req, res) {
    const started = performance.now();
    let logPath = '-';
    res.on('error', () => {});
    res.once('close', () => {
      log.request({ method: req.method, path: logPath, status: res.statusCode, ms: performance.now() - started, aborted: !res.writableFinished });
    });
    applySecurityHeaders(res);
    try {
      const target = parseTarget(req.url);
      logPath = target.rawPath;
      const api = isApiPath(target.rawPath);
      if (api) res.setHeader('Cache-Control', 'no-store');
      if (security.hostCheckEnabled) security.assertAllowedHost(req);
      if (api) {
        security.assertSameOriginRequest(req);
        await handleApi(req, res, target);
      } else {
        await staticFiles.serve(req, res, target.rawPath);
      }
    } catch (err) {
      respondError(req, res, err);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error('Request handler crashed', err);
      if (!res.headersSent) respondError(req, res, err);
      else res.destroy();
    });
  });

  // Requests Node rejects before our handler runs (bad syntax, oversized headers, timeouts) still get our headers.
  server.on('clientError', (err, socket) => {
    if (socket.destroyed || !socket.writable) return;
    const status = err && err.code === 'HPE_HEADER_OVERFLOW' ? 431 : err && err.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400;
    const code = status === 408 ? 'request_timeout' : status === 431 ? 'header_too_large' : 'bad_request';
    const text = JSON.stringify(errorBody({ code, message: http.STATUS_CODES[status] }));
    socket.end(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Type: application/json; charset=utf-8\r\n`
      + `Content-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\nCache-Control: no-store\r\n${securityHeaderLines()}\r\n${text}`,
    );
  });

  let closing = null;

  return {
    server,
    auth,
    generations,
    db,

    /** The address the server listens on, as a browsable URL. Only meaningful after listen(). */
    get url() {
      const address = server.address();
      if (!address || typeof address === 'string') return '';
      return `http://${browseHost(config.host)}:${address.port}`;
    },

    get port() {
      const address = server.address();
      return address && typeof address === 'object' ? address.port : 0;
    },

    /**
     * Start listening on config.host:config.port (port 0 picks a free one).
     * @returns {Promise<{ port: number, host: string, url: string }>}
     * @throws {ListenError} with a hint when the port is taken, not allowed, or the address does not exist
     */
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(describeListenError(err, config));
        server.once('error', onError);
        server.listen({ port: config.port, host: config.host }, () => {
          server.off('error', onError);
          const { port } = server.address();
          resolve({ port, host: config.host, url: `http://${browseHost(config.host)}:${port}` });
        });
      });
    },

    /**
     * Stop accepting connections, abort running generations (their partial text is saved) and close every
     * connection after a short grace period. Idempotent. The database stays open: its owner closes it.
     * @returns {Promise<void>}
     */
    close() {
      if (!closing) {
        closing = new Promise((resolve) => {
          generations.abortAll();
          if (!server.listening) {
            resolve();
            return;
          }
          const timer = setTimeout(() => server.closeAllConnections(), config.shutdownGraceMs ?? 2000);
          server.close(() => {
            clearTimeout(timer);
            resolve();
          });
          server.closeIdleConnections();
        });
      }
      return closing;
    },
  };
}

/** The host to put into a URL for a person: wildcard addresses are reached as localhost. */
function browseHost(host) {
  const h = String(host);
  if (h === '0.0.0.0' || h === '::' || h === '') return 'localhost';
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]`;
  return h;
}

