// Settings: defaults, validation, deep-merge of partial updates, and masking of secrets.
// Pure functions only (no I/O) so the server, the provider layer and the tests share one definition.
// The internal shape (with raw API keys) never leaves the server; publicSettings() is the only
// shape the HTTP layer may return.

import { effectiveApiKey, keyHint } from './env-keys.js';

/** Provider ids, in the order the UI shows them. */
export const PROVIDER_IDS = Object.freeze(['gemini', 'openai', 'local']);
/** Persona ids accepted in `persona.id`. */
export const PERSONA_IDS = Object.freeze(['companion', 'coach', 'cbt', 'stoic', 'friend', 'custom']);
/** Gemini thinking modes accepted in `ai.providers.gemini.thinking`. */
export const THINKING_MODES = Object.freeze(['fast', 'default']);

/** Hard limits, exported so the UI and the docs can quote the same numbers. */
export const SETTINGS_LIMITS = Object.freeze({
  nameMax: 80,
  aboutMax: 1000,
  customMax: 1500,
  modelMax: 200,
  apiKeyMax: 512,
  baseUrlMax: 2048,
  temperature: Object.freeze({ min: 0, max: 2 }),
  maxTokens: Object.freeze({ min: 64, max: 8192 }),
  contextBudgetTokens: Object.freeze({ min: 500, max: 32000 }),
  timeoutSec: Object.freeze({ min: 5, max: 600 }),
});

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Internal defaults (ARCHITECTURE section 5). Frozen: use defaultSettings() for a mutable copy. */
export const DEFAULT_SETTINGS = deepFreeze({
  onboarded: false,
  profile: { name: '', about: '' },
  persona: { id: 'companion', custom: '' },
  memory: { enabled: true, autoExtract: true, useRelatedEntries: true },
  ai: {
    enabled: true,
    provider: '',
    temperature: 0.7,
    maxTokens: 700,
    contextBudgetTokens: 3000,
    timeoutSec: 120,
    providers: {
      gemini: {
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-flash-latest',
        thinking: 'fast',
        apiKey: '',
      },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
      local: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2:3b', apiKey: '' },
    },
  },
});

/** @returns {typeof DEFAULT_SETTINGS} a fresh, mutable deep copy of the defaults */
export function defaultSettings() {
  return structuredClone(DEFAULT_SETTINGS);
}

// ---------------------------------------------------------------------------------------------
// Field parsers. Each returns { value } or { error }. `lenient` is used when normalising a stored
// document (never fail, truncate instead); strict mode is used for user patches (report instead).

const ok = (value) => ({ value });
const fail = (error) => ({ error });

function codePointLength(text) {
  let n = 0;
  for (const _ of text) n++; // eslint-disable-line no-unused-vars
  return n;
}

function truncateCodePoints(text, max) {
  return Array.from(text).slice(0, max).join('');
}

// Control characters (except \n and \t for multi-line prose) have no business in settings and can
// smuggle odd behaviour into prompts or headers.
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

function cleanText(value, singleLine) {
  let s = value.replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_NEWLINE, '');
  if (singleLine) s = s.replace(/\s+/g, ' ');
  return s.trim();
}

function boolField() {
  return (value) => (typeof value === 'boolean' ? ok(value) : fail('must be true or false'));
}

function enumField(values) {
  const shown = values.map((v) => (v === '' ? '""' : v)).join(', ');
  return (value) => (typeof value === 'string' && values.includes(value) ? ok(value) : fail(`must be one of: ${shown}`));
}

function numberField({ min, max, integer, decimals = 2 }) {
  return (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fail('must be a number');
    const clamped = Math.min(max, Math.max(min, value));
    if (integer) return ok(Math.round(clamped));
    const factor = 10 ** decimals;
    return ok(Math.round(clamped * factor) / factor);
  };
}

function textField({ max, singleLine = false, emptyMeansDefault = false }) {
  return (value, { lenient, defaultValue }) => {
    if (typeof value !== 'string') return fail('must be text');
    let s = cleanText(value, singleLine);
    if (s === '' && emptyMeansDefault) return ok(defaultValue);
    if (codePointLength(s) > max) {
      if (!lenient) return fail(`must be at most ${max} characters`);
      s = truncateCodePoints(s, max).trim();
    }
    return ok(s);
  };
}

// eslint-disable-next-line no-control-regex
const URL_FORBIDDEN_CHARS = /[\u0000- \u007f-\u009f]/;

function parseBaseUrl(value, { defaultValue }) {
  if (typeof value !== 'string') return fail('must be a URL such as http://localhost:11434/v1');
  const s = value.trim();
  if (s === '') return ok(defaultValue);
  if (s.length > SETTINGS_LIMITS.baseUrlMax) return fail(`must be at most ${SETTINGS_LIMITS.baseUrlMax} characters`);
  // new URL() silently drops tabs/newlines, so reject them up front instead of storing a surprise.
  if (URL_FORBIDDEN_CHARS.test(s)) return fail('must not contain spaces or control characters');
  let url;
  try {
    url = new URL(s);
  } catch {
    return fail('must be a valid URL such as http://localhost:11434/v1');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('must start with http:// or https://');
  if (!url.hostname) return fail('must include a host name');
  if (url.username || url.password) return fail('must not contain a username or password (use the API key field)');
  // Keys must never travel in URLs, so refuse the usual place people paste them.
  if (url.search || url.hash) return fail('must not contain a ?query or #fragment');
  return ok(s.replace(/\/+$/, ''));
}

function urlField() {
  return (value, ctx) => parseBaseUrl(value, ctx);
}

function modelField() {
  return textField({ max: SETTINGS_LIMITS.modelMax, singleLine: true, emptyMeansDefault: true });
}

// eslint-disable-next-line no-control-regex
const KEY_STRIP = /[\s\u0000-\u001f\u007f-\u009f]/gu;

function apiKeyField() {
  return (value, { lenient }) => {
    if (value === null) return ok(''); // explicit clear
    if (typeof value !== 'string') return fail('must be text, or null to clear the saved key');
    // Pasted keys often carry a trailing newline or stray spaces; none are ever valid in a key.
    let s = value.replace(KEY_STRIP, '');
    if (s.length > SETTINGS_LIMITS.apiKeyMax) {
      if (!lenient) return fail(`must be at most ${SETTINGS_LIMITS.apiKeyMax} characters`);
      s = s.slice(0, SETTINGS_LIMITS.apiKeyMax);
    }
    // A non-ASCII character would make fetch() throw when the key is used as a header value.
    if (!lenient && /[^\x21-\x7e]/.test(s)) return fail('can only contain visible ASCII characters');
    return ok(s);
  };
}

const providerSpec = (extra = {}) => ({
  baseUrl: urlField(),
  model: modelField(),
  ...extra,
  apiKey: apiKeyField(),
});

// The spec tree mirrors DEFAULT_SETTINGS. A function is a leaf parser; an object is a branch.
// Keys that are not in the tree are dropped, which also drops __proto__/constructor tricks.
const SPEC = {
  onboarded: boolField(),
  profile: {
    name: textField({ max: SETTINGS_LIMITS.nameMax, singleLine: true }),
    about: textField({ max: SETTINGS_LIMITS.aboutMax }),
  },
  persona: {
    id: enumField(PERSONA_IDS),
    custom: textField({ max: SETTINGS_LIMITS.customMax }),
  },
  memory: {
    enabled: boolField(),
    autoExtract: boolField(),
    useRelatedEntries: boolField(),
  },
  ai: {
    enabled: boolField(),
    provider: enumField(['', ...PROVIDER_IDS]),
    temperature: numberField({ ...SETTINGS_LIMITS.temperature, decimals: 2 }),
    maxTokens: numberField({ ...SETTINGS_LIMITS.maxTokens, integer: true }),
    contextBudgetTokens: numberField({ ...SETTINGS_LIMITS.contextBudgetTokens, integer: true }),
    timeoutSec: numberField({ ...SETTINGS_LIMITS.timeoutSec, integer: true }),
    providers: {
      gemini: providerSpec({ thinking: enumField(THINKING_MODES) }),
      openai: providerSpec(),
      local: providerSpec(),
    },
  },
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function hasOwnValue(obj, key) {
  return isPlainObject(obj) && Object.hasOwn(obj, key) && obj[key] !== undefined;
}

/**
 * Walk the spec tree and produce a brand-new settings object.
 * `base` supplies values for keys the input does not mention; `defaults` supplies the fallback for
 * invalid values (lenient mode) and for "empty means default" fields.
 */
function build(spec, base, defaults, input, opts, path, errors) {
  const out = {};
  for (const key of Object.keys(spec)) {
    const here = path ? `${path}.${key}` : key;
    const sub = spec[key];
    const provided = hasOwnValue(input, key);
    if (typeof sub === 'function') {
      if (!provided) {
        out[key] = base[key];
        continue;
      }
      const result = sub(input[key], { lenient: opts.lenient, defaultValue: defaults[key] });
      if ('error' in result) {
        if (!opts.lenient) errors[here] = result.error;
        out[key] = opts.lenient ? defaults[key] : base[key];
      } else {
        out[key] = result.value;
      }
    } else {
      let childInput;
      if (provided) {
        if (isPlainObject(input[key])) childInput = input[key];
        else if (!opts.lenient) errors[here] = 'must be an object';
      }
      out[key] = build(sub, base[key], defaults[key], childInput, opts, here, errors);
    }
  }
  return out;
}

/**
 * Turn any input (a stored document, a partial object, garbage) into a complete, valid internal
 * settings object. Never throws, never reports: invalid values fall back to the default, numbers
 * are clamped, strings trimmed and truncated, unknown keys dropped.
 * @param {unknown} input
 * @returns {typeof DEFAULT_SETTINGS} a new object that shares nothing with the input
 */
export function normalizeSettings(input) {
  return build(SPEC, DEFAULT_SETTINGS, DEFAULT_SETTINGS, input, { lenient: true }, '', {});
}

/**
 * Apply a partial update (PUT body) to the current settings.
 *
 * - Only keys present in the patch change; everything else is kept (deep merge).
 * - `apiKey`: a string sets the key, `null` clears the saved key, omitted keeps it.
 *   `apiKeySet` / `apiKeyHint` / `apiKeySource` are read-only output fields and are ignored, so the
 *   client can send public settings back unchanged.
 * - Numbers are clamped silently; wrong types, bad enums, bad URLs and over-long text are errors.
 * - All-or-nothing: if `errors` is not empty, `settings` is just the (normalised) current value.
 *
 * @param {unknown} current internal settings as stored (may be partial; defaults are filled in)
 * @param {unknown} patch
 * @returns {{ settings: typeof DEFAULT_SETTINGS, errors: Record<string,string> }}
 *   `errors` maps a dotted field path (e.g. "ai.providers.openai.baseUrl") to a human message.
 */
export function mergeSettings(current, patch) {
  const base = normalizeSettings(current);
  if (patch === undefined) return { settings: base, errors: {} };
  if (!isPlainObject(patch)) return { settings: base, errors: { settings: 'must be an object' } };
  const errors = {};
  const merged = build(SPEC, base, DEFAULT_SETTINGS, patch, { lenient: false }, '', errors);
  if (Object.keys(errors).length > 0) return { settings: base, errors };
  return { settings: merged, errors };
}

/**
 * The only settings shape that may leave the server: raw `apiKey` is removed from every provider
 * and replaced by `apiKeySet`, `apiKeyHint` ("…abcd", or "" without a key) and `apiKeySource`
 * ("settings" | "env" | "none") reflecting the saved-wins-then-environment rule.
 * @param {unknown} settings internal settings
 * @param {Record<string,string|undefined>} [env]
 */
export function publicSettings(settings, env = process.env) {
  const out = normalizeSettings(settings);
  for (const id of PROVIDER_IDS) {
    const provider = out.ai.providers[id];
    const { key, source } = effectiveApiKey(id, provider.apiKey, env);
    delete provider.apiKey;
    provider.apiKeySet = key !== '';
    provider.apiKeyHint = keyHint(key);
    provider.apiKeySource = source;
  }
  return out;
}

/**
 * Can the provider actually be called? Needs a base URL and model, plus an API key (saved or from
 * the environment) for `gemini` and `openai`; `local` works without one.
 * Says nothing about `ai.enabled`, which the caller checks separately (`ai_disabled`).
 * @param {unknown} settings
 * @param {Record<string,string|undefined>} [env]
 * @param {string} [providerId] defaults to the active provider (`settings.ai.provider`)
 * @returns {boolean} false when no provider is selected or the id is unknown
 */
export function isProviderConfigured(settings, env = process.env, providerId) {
  if (typeof env === 'string') {
    providerId = env;
    env = process.env;
  }
  const s = normalizeSettings(settings);
  const id = providerId === undefined ? s.ai.provider : providerId;
  if (!PROVIDER_IDS.includes(id)) return false;
  const provider = s.ai.providers[id];
  if (!provider.baseUrl || !provider.model) return false;
  if (id === 'local') return true;
  return effectiveApiKey(id, provider.apiKey, env).key !== '';
}

const ENV_SEEDS = [
  { provider: 'openai', field: 'baseUrl', env: 'OPENAI_BASE_URL' },
  { provider: 'local', field: 'baseUrl', env: 'LOCAL_LLM_BASE_URL' },
  { provider: 'local', field: 'model', env: 'LOCAL_LLM_MODEL' },
];

/**
 * Let OPENAI_BASE_URL, LOCAL_LLM_BASE_URL and LOCAL_LLM_MODEL provide the starting values of a
 * fresh install. A value the user has changed (anything but the built-in default) is never touched,
 * and an invalid environment value is ignored. Idempotent. API keys are not handled here: they are
 * resolved at use time by effectiveApiKey().
 * @param {unknown} settings internal settings
 * @param {Record<string,string|undefined>} [env]
 * @returns {typeof DEFAULT_SETTINGS} a new object
 */
export function applyEnvSeed(settings, env = process.env) {
  const out = normalizeSettings(settings);
  for (const seed of ENV_SEEDS) {
    const raw = env[seed.env];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const defaultValue = DEFAULT_SETTINGS.ai.providers[seed.provider][seed.field];
    if (out.ai.providers[seed.provider][seed.field] !== defaultValue) continue;
    const parser = seed.field === 'baseUrl' ? parseBaseUrl : modelField();
    const parsed = parser(raw, { lenient: false, defaultValue });
    if (!('error' in parsed)) out.ai.providers[seed.provider][seed.field] = parsed.value;
  }
  return out;
}
