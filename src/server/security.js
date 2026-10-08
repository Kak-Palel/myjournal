// Request hardening applied before routing (docs/ARCHITECTURE.md section 10):
//   1. response headers on EVERYTHING (CSP, nosniff, ...), `Cache-Control: no-store` for /api
//   2. Host allow-list (DNS-rebinding defence), enforced while no password protects the journal and, with or
//      without a password, whenever the server only listens on a loopback address
//   3. CSRF defence for state-changing API calls: `X-MyJournal: 1` plus an Origin that matches the Host
// No CORS header is ever sent.

import { isLoopbackHost } from '../config.js';
import { HttpError } from './http.js';

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Headers sent with every response. */
export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'X-Frame-Options': 'DENY',
});

/**
 * Set the security headers on a response (before anything is written).
 * @param {import('node:http').ServerResponse} res
 * @param {{ api?: boolean }} [opts] `api`: also forbid caching
 */
export function applySecurityHeaders(res, { api = false } = {}) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (api) res.setHeader('Cache-Control', 'no-store');
}

/** The same headers as raw HTTP lines, for responses written straight to a socket (malformed requests). */
export function securityHeaderLines() {
  return Object.entries(SECURITY_HEADERS).map(([name, value]) => `${name}: ${value}\r\n`).join('');
}

// ---------------------------------------------------------------------------------------------
// Host header

const HOST_HEADER_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/i;

/**
 * Split a Host header value into a lower-case host name (IPv6 keeps its brackets) and a port.
 * @param {unknown} value
 * @returns {{ hostname: string, port: string }|null} null when it is not a plausible host
 */
export function parseHostHeader(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return null;
  const m = HOST_HEADER_RE.exec(value.trim());
  if (!m) return null;
  return { hostname: m[1].toLowerCase(), port: m[2] ?? '' };
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '']);

/**
 * Build the Host check. Allowed: localhost, 127.0.0.1 and [::1] (any port), JOURNAL_ALLOWED_HOSTS entries
 * (a bare name allows any port, `name:port` only that port) and the address the server was told to bind to.
 * @param {{ host?: string, allowedHosts?: string[] }} config
 * @returns {(hostHeader: unknown) => boolean}
 */
export function createHostMatcher(config) {
  const names = new Set(LOOPBACK_HOSTS);
  const exact = new Set();
  const entries = [...(config.allowedHosts || [])];
  const bound = String(config.host ?? '').toLowerCase();
  if (!WILDCARD_HOSTS.has(bound)) entries.push(bound.includes(':') && !bound.startsWith('[') ? `[${bound}]` : bound);
  for (const entry of entries) {
    const parsed = parseHostHeader(entry);
    if (!parsed) continue;
    if (parsed.port) exact.add(`${parsed.hostname}:${parsed.port}`);
    else names.add(parsed.hostname);
  }
  return (hostHeader) => {
    const parsed = parseHostHeader(hostHeader);
    if (!parsed) return false;
    return names.has(parsed.hostname) || (parsed.port !== '' && exact.has(`${parsed.hostname}:${parsed.port}`));
  };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {(hostHeader: unknown) => boolean} matcher
 * @param {{ passwordHelps?: boolean }} [opts] mention JOURNAL_PASSWORD in the hint (it only lifts the check on non-loopback binds)
 * @throws {HttpError} 403 forbidden_host
 */
export function assertAllowedHost(req, matcher, { passwordHelps = false } = {}) {
  if (matcher(req.headers.host)) return;
  throw new HttpError(403, 'forbidden_host', 'This address is not allowed to open the journal.', {
    hint: `Open it as http://localhost:PORT. To use another name or address (a reverse proxy, for example), add it to JOURNAL_ALLOWED_HOSTS${passwordHelps ? ' (or set JOURNAL_PASSWORD)' : ''}.`,
  });
}

// ---------------------------------------------------------------------------------------------
// CSRF: custom header + Origin check

const defaultPort = (protocol) => (protocol === 'https:' ? '443' : '80');

/**
 * Does an `Origin` header name the same site as the request's Host (or X-Forwarded-Host behind a proxy)?
 * @param {string} origin
 * @param {Record<string, string|string[]|undefined>} headers
 */
export function originMatchesHost(origin, headers) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const originPort = url.port || defaultPort(url.protocol);
  const candidates = [headers.host];
  if (typeof headers['x-forwarded-host'] === 'string') candidates.push(headers['x-forwarded-host'].split(',')[0]);
  return candidates.some((candidate) => {
    const host = parseHostHeader(candidate);
    if (!host) return false;
    const hostname = url.hostname.startsWith('[') || !url.hostname.includes(':') ? url.hostname : `[${url.hostname}]`;
    return host.hostname === hostname.toLowerCase() && (host.port || defaultPort(url.protocol)) === originPort;
  });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuse state-changing API requests that a web page on another site could have caused.
 * @param {import('node:http').IncomingMessage} req
 * @throws {HttpError} 403 forbidden_origin
 */
export function assertSameOriginRequest(req) {
  if (SAFE_METHODS.has(req.method)) return;
  const refuse = (message, hint = 'Use the MyJournal web page, or send the header "X-MyJournal: 1" from your own script.') => new HttpError(
    403,
    'forbidden_origin',
    message,
    { hint },
  );
  if (req.headers['x-myjournal'] !== '1') throw refuse('This request is missing the X-MyJournal header.');
  const origin = req.headers.origin;
  if (origin !== undefined && !originMatchesHost(String(origin), req.headers)) {
    throw refuse(
      'This request comes from a different website.',
      'Open MyJournal directly at its own address. Behind a reverse proxy, make the proxy pass on the original Host header.',
    );
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') throw refuse('This request comes from a different website.');
}

/**
 * Convenience bundle used by the app.
 * @param {{ host?: string, allowedHosts?: string[], password?: string }} config
 */
export function createSecurity(config) {
  const matcher = createHostMatcher(config);
  const loopback = isLoopbackHost(config.host);
  // A journal that listens beyond this computer with a password cannot know which names people reach it by, so
  // the password is its protection. A journal that only listens on loopback always knows its own names: checking
  // them even with a password stops a web page that rebinds its domain to 127.0.0.1 from guessing the login
  // (the user's session cookie is not sent to that domain, so the password would be the only barrier).
  // Behind a reverse proxy on the same machine the public name goes into JOURNAL_ALLOWED_HOSTS.
  const hostCheckEnabled = !config.password || loopback;
  return {
    matcher,
    hostCheckEnabled,
    applyHeaders: applySecurityHeaders,
    assertAllowedHost: (req) => assertAllowedHost(req, matcher, { passwordHelps: !loopback }),
    assertSameOriginRequest,
    isLoopback: loopback,
  };
}
