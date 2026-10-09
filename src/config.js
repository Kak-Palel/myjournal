// Environment -> configuration object (docs/ARCHITECTURE.md section 5), the .env loader and the
// startup safety rule. Pure apart from reading package.json and the optional .env file.

import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root (the folder that holds server.js). */
export const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_PORT = 3210;
export const DEFAULT_HOST = '127.0.0.1';
const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A problem with the environment that the person starting the server can fix. `hint` says how. */
export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {string} [hint]
   */
  constructor(message, hint) {
    super(message);
    this.name = 'ConfigError';
    if (hint) this.hint = hint;
  }
}

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const clip = (text, max = 60) => (text.length > max ? `${text.slice(0, max)}...` : text);

function parsePort(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(text) || Number(text) > 65535) {
    throw new ConfigError(`PORT must be a number from 0 to 65535 (got "${clip(text)}").`, `Example: PORT=${DEFAULT_PORT}`);
  }
  return Number(text);
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9._-]{0,251}[a-z0-9])?$/;

function parseHost(raw) {
  const text = String(raw ?? '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (text === '') return DEFAULT_HOST;
  if (isIP(text) || HOSTNAME_RE.test(text)) return text;
  throw new ConfigError(`HOST is not a valid address (got "${clip(text)}").`, 'Use 127.0.0.1 (this computer only), 0.0.0.0 (all interfaces) or a host name.');
}

// One entry of JOURNAL_ALLOWED_HOSTS: "journal.example.com" or "journal.example.com:8443"; a pasted URL is forgiven.
const ALLOWED_HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(:\d{1,5})?$/;

function parseAllowedHosts(raw) {
  const out = [];
  for (const piece of String(raw ?? '').split(',')) {
    const entry = piece.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/.*$/, '');
    if (entry === '') continue;
    if (!ALLOWED_HOST_RE.test(entry)) {
      throw new ConfigError(`JOURNAL_ALLOWED_HOSTS has an entry that is not a host name: "${clip(piece.trim())}".`, 'Use a comma separated list such as: journal.example.com,192.168.1.20');
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

const truthy = (value) => ['1', 'true', 'yes'].includes(String(value ?? '').trim().toLowerCase());

/**
 * Is this a loopback address, i.e. one that only programs on this computer can reach?
 * @param {string} host an IP address or host name, with or without [] around IPv6
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (h === 'localhost' || h === '::1') return true;
  if (isIP(h) === 4) return h.startsWith('127.');
  if (h.startsWith('::ffff:') && isIP(h.slice(7)) === 4) return h.slice(7).startsWith('127.');
  return false;
}

/**
 * Fill every setting the server relies on with its default. loadConfig() uses it, and createApp() applies it to a
 * hand-built config (tests, scripts) so a partial object cannot disable a limit by leaving it out.
 * @param {object} [partial] settings that override the defaults
 * @returns {object} the complete config
 */
export function withConfigDefaults(partial = {}) {
  const dataDir = partial.dataDir ?? resolve('./data');
  return {
    version: readVersion(),
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    dataDir,
    dbFile: partial.dbFile ?? join(dataDir, 'journal.db'),
    publicDir: join(ROOT_DIR, 'public'),
    password: '',
    allowedHosts: [],
    insecureAllowNoAuth: false,
    /** Environment used to resolve provider API keys and URL seeds at request time. */
    env: process.env,
    /** No request log lines (tests). */
    quiet: false,
    maxJsonBytes: 1 * MB,
    maxImportBytes: 50 * MB,
    /** Interval of the `: ping` comment on SSE streams. */
    ssePingMs: 15_000,
    sessionTtlMs: 30 * DAY_MS,
    loginMaxFailures: 5,
    loginWindowMs: 60_000,
    /** How long close() waits for in-flight requests before it drops their connections. */
    shutdownGraceMs: 2_000,
    ...partial,
  };
}

/**
 * Build the server configuration from environment variables.
 * Variables: PORT (3210), HOST (127.0.0.1), JOURNAL_DATA_DIR (./data), JOURNAL_PASSWORD,
 * JOURNAL_ALLOWED_HOSTS, JOURNAL_INSECURE_ALLOW_NO_AUTH=1.
 * @param {Record<string, string|undefined>} [env] defaults to process.env; also used later to resolve provider keys
 * @param {object} [options]
 * @param {string} [options.cwd] folder that a relative JOURNAL_DATA_DIR is resolved against
 * @param {object} [options.overrides] fields that replace the parsed ones (tests, scripts)
 * @returns {object} the config (see withConfigDefaults for the property list)
 * @throws {ConfigError} for malformed values
 */
export function loadConfig(env = process.env, { cwd = process.cwd(), overrides = {} } = {}) {
  const dataDir = resolve(cwd, String(env.JOURNAL_DATA_DIR ?? '').trim() || './data');
  const parsed = {
    port: parsePort(env.PORT),
    host: parseHost(env.HOST),
    dataDir,
    password: String(env.JOURNAL_PASSWORD ?? ''),
    allowedHosts: parseAllowedHosts(env.JOURNAL_ALLOWED_HOSTS),
    insecureAllowNoAuth: truthy(env.JOURNAL_INSECURE_ALLOW_NO_AUTH),
    env,
  };
  const merged = { ...parsed, ...overrides };
  return withConfigDefaults({ ...merged, dbFile: overrides.dbFile ?? join(merged.dataDir, 'journal.db') });
}

/**
 * Enforce the startup safety rule: listening on anything but a loopback address without a password
 * would put the journal in front of everybody on the network.
 * @param {{ host: string, password?: string, insecureAllowNoAuth?: boolean }} config
 * @throws {ConfigError}
 */
export function assertSafeToStart(config) {
  if (isLoopbackHost(config.host) || config.password || config.insecureAllowNoAuth) return;
  throw new ConfigError(
    `Refusing to listen on ${config.host} without a password: everybody who can reach this computer could read your journal.`,
    'Set JOURNAL_PASSWORD to a long passphrase, or use HOST=127.0.0.1 (this computer only). '
    + 'If you really want no password (for example behind your own login proxy) set JOURNAL_INSECURE_ALLOW_NO_AUTH=1.',
  );
}

/**
 * A `JOURNAL_PASSWORD=` line that Node's .env reader cuts short: an unquoted `#` starts a comment there, so
 * `JOURNAL_PASSWORD=correct horse #1 staple` becomes "correct horse" and nobody notices. Returns the sentence
 * to print, or null.
 * @param {string} text contents of a .env file
 * @returns {string|null}
 */
export function dotEnvPasswordWarning(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?JOURNAL_PASSWORD\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1];
    if (/^["'`]/.test(value) || !value.includes('#')) return null;
    const length = value.slice(0, value.indexOf('#')).trim().length;
    return 'the JOURNAL_PASSWORD line of your .env file contains a #. Node ends an unquoted value at a #, so the password is '
      + `only ${length} character${length === 1 ? '' : 's'} long. Put the password in single quotes: JOURNAL_PASSWORD='...'.`;
  }
  return null;
}

/**
 * Load a `.env` file with process.loadEnvFile(). Variables that are already set in the environment win.
 * A missing file is normal; a file that cannot be read is reported, not fatal. `warning` is set when the file's
 * JOURNAL_PASSWORD would be silently shortened (and the real environment does not supply the password itself).
 * @param {{ cwd?: string, file?: string, loader?: (path: string) => void, env?: Record<string,string|undefined> }} [options]
 * @returns {{ loaded: boolean, path: string, error?: string, warning?: string }}
 */
export function loadDotEnv({ cwd = process.cwd(), file = '.env', loader = process.loadEnvFile.bind(process), env = process.env } = {}) {
  const path = resolve(cwd, file);
  if (!existsSync(path)) return { loaded: false, path };
  const passwordFromEnvironment = env.JOURNAL_PASSWORD !== undefined;
  try {
    loader(path);
  } catch (err) {
    return { loaded: false, path, error: err && err.message ? err.message : String(err) };
  }
  const result = { loaded: true, path };
  if (!passwordFromEnvironment) {
    try {
      const warning = dotEnvPasswordWarning(readFileSync(path, 'utf8'));
      if (warning) result.warning = warning;
    } catch { /* the warning is a courtesy */ }
  }
  return result;
}
