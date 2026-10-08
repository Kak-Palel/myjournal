// Optional password protection (docs/ARCHITECTURE.md section 10).
//
// - The password is compared as SHA-256 digests with crypto.timingSafeEqual, so neither content nor
//   length leaks through timing.
// - A session is 32 random bytes held in memory (only a hash of the token is kept); it lives for 30
//   days or until the server restarts.
// - Login failures are limited per IP address: 5 failures per minute, then 429 until the minute is up.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'mj_session';
// Node refuses request headers beyond 16 KiB by itself; this only keeps a hand-built request in bounds.
const MAX_COOKIE_HEADER_CHARS = 64 * 1024;
const MAX_SESSIONS = 1000;
const MAX_TRACKED_IPS = 10_000;
const MAX_PASSWORD_CHARS = 4096;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest();
const tokenKey = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Name of the session cookie for the port a request arrived on: `mj_session_3210`. Browsers share cookies
 * between ports of the same host name, so two journals on `localhost:3210` and `localhost:3211` would overwrite
 * each other's cookie (and sign each other out) if both used the plain name. The port is the one the server
 * itself listens on, so it stays the same behind a reverse proxy.
 * @param {{ socket?: { localPort?: number } }} [req]
 */
export function sessionCookieName(req) {
  const port = req && req.socket ? req.socket.localPort : undefined;
  return Number.isInteger(port) && port > 0 ? `${SESSION_COOKIE}_${port}` : SESSION_COOKIE;
}

/** `::ffff:1.2.3.4` and `1.2.3.4` are the same client. */
export function normalizeIp(address) {
  const text = String(address ?? '').toLowerCase();
  return text.startsWith('::ffff:') && text.includes('.') ? text.slice(7) : text || 'unknown';
}

/**
 * Sliding-window limiter for failed logins.
 * @param {{ max: number, windowMs: number, now?: () => number }} opts
 */
export function createLoginLimiter({ max, windowMs, now = Date.now }) {
  /** @type {Map<string, number[]>} ip -> timestamps of recent failures */
  const failures = new Map();

  function recent(ip) {
    const cutoff = now() - windowMs;
    const list = (failures.get(ip) || []).filter((t) => t > cutoff);
    if (list.length > 0) failures.set(ip, list);
    else failures.delete(ip);
    return list;
  }

  return {
    /** @returns {number} 0 when the attempt may go ahead, else the seconds until it may */
    retryAfterSeconds(ip) {
      const list = recent(ip);
      if (list.length < max) return 0;
      return Math.max(1, Math.ceil((list[list.length - max] + windowMs - now()) / 1000));
    },
    fail(ip) {
      const list = recent(ip);
      list.push(now());
      failures.set(ip, list);
      if (failures.size > MAX_TRACKED_IPS) {
        // Drop the oldest-seen addresses: a flood of distinct IPs must not grow the table without bound.
        for (const key of failures.keys()) {
          if (failures.size <= MAX_TRACKED_IPS / 2) break;
          failures.delete(key);
        }
      }
    },
    reset(ip) {
      failures.delete(ip);
    },
    /** Addresses currently tracked (tests: the table must stay bounded). */
    get size() {
      return failures.size;
    },
  };
}

/**
 * @param {{ password?: string, sessionTtlMs?: number, loginMaxFailures?: number, loginWindowMs?: number }} config
 * @param {{ now?: () => number }} [opts] clock injection for tests
 */
export function createAuth(config, { now = Date.now } = {}) {
  const password = typeof config.password === 'string' ? config.password : '';
  const passwordDigest = sha256(password);
  const ttlMs = config.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000;
  /** @type {Map<string, number>} token hash -> expiry */
  const sessions = new Map();
  const limiter = createLoginLimiter({ max: config.loginMaxFailures ?? 5, windowMs: config.loginWindowMs ?? 60_000, now });

  function pruneSessions() {
    const t = now();
    for (const [key, expires] of sessions) if (expires <= t) sessions.delete(key);
    // Oldest first (Map keeps insertion order): never let a flood of logins grow the table without bound.
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  /** Value of this server's session cookie, or ''. The whole header is read: other apps on localhost add cookies of their own. */
  function tokenFromRequest(req) {
    const header = req.headers.cookie;
    if (typeof header !== 'string' || header.length > MAX_COOKIE_HEADER_CHARS) return '';
    const name = sessionCookieName(req);
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return '';
  }

  const api = {
    /** Whether a password is set. Without one every API call is allowed. */
    required: password !== '',
    limiter,

    /** @param {unknown} candidate @returns {boolean} */
    verifyPassword(candidate) {
      if (typeof candidate !== 'string' || candidate.length > MAX_PASSWORD_CHARS || !api.required) return false;
      return timingSafeEqual(sha256(candidate), passwordDigest);
    },

    /** Create a session and return its token. */
    createSession() {
      pruneSessions();
      const token = randomBytes(32).toString('base64url');
      sessions.set(tokenKey(token), now() + ttlMs);
      return token;
    },

    /** @param {string} token */
    hasSession(token) {
      if (!token || token.length > 200) return false;
      const key = tokenKey(token);
      const expires = sessions.get(key);
      if (expires === undefined) return false;
      if (expires <= now()) {
        sessions.delete(key);
        return false;
      }
      return true;
    },

    destroySession(token) {
      if (token) sessions.delete(tokenKey(token));
    },

    tokenFromRequest,

    /** Is this request allowed to use the API? Always true when no password is set. */
    isAuthenticated(req) {
      return !api.required || api.hasSession(tokenFromRequest(req));
    },

    /**
     * `Set-Cookie` value for a new session. `Secure` only when the request arrived over HTTPS (behind a
     * proxy that says so with X-Forwarded-Proto), because a Secure cookie would never come back over plain HTTP.
     * @param {string} token
     * @param {{ secure?: boolean, name?: string }} [opts] `name`: see sessionCookieName()
     */
    sessionCookie(token, { secure = false, name = SESSION_COOKIE } = {}) {
      const maxAge = Math.floor(ttlMs / 1000);
      return `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    },

    clearCookie({ secure = false, name = SESSION_COOKIE } = {}) {
      return `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
    },

    /** Number of live sessions (tests). */
    get sessionCount() {
      return sessions.size;
    },
  };
  return api;
}

/** Did the request reach a TLS-terminating proxy? Only then is the Secure cookie flag useful. */
export function isHttpsRequest(req) {
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https';
}
