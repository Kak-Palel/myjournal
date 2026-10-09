// Provider ids, built-in defaults and the settings -> request config resolver.
// Takes the INTERNAL settings shape of docs/ARCHITECTURE.md §5 (never the masked public one).

import { effectiveApiKey } from '../env-keys.js';
import { DEFAULT_TIMEOUT_SEC } from '../settings.js';
import { ProviderError } from './errors.js';

// One number for every provider (settings `ai.timeoutSec`); the per-provider copies below only matter to callers that
// hand over settings without it. A local model's first request loads the model from disk, which is the slowest case.
const DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_SEC * 1000;

export const PROVIDER_IDS = Object.freeze(['gemini', 'openai', 'local']);

export const PROVIDER_DEFAULTS = Object.freeze({
  gemini: Object.freeze({
    baseUrl: 'https://generativelanguage.googleapis.com',
    // Flash-Lite: ~1 s to the first byte and the best free quota (gemini-flash-latest was 16-23 s and often "busy").
    model: 'gemini-flash-lite-latest',
    thinking: 'auto',
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }),
  openai: Object.freeze({
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }),
  local: Object.freeze({
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2:3b',
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }),
});

// Env values only fill gaps. A fresh database is seeded from them by settings.js; this is the safety net
// for callers that hand us partial settings.
const ENV_FALLBACKS = Object.freeze({
  gemini: {},
  openai: { baseUrl: 'OPENAI_BASE_URL' },
  local: { baseUrl: 'LOCAL_LLM_BASE_URL', model: 'LOCAL_LLM_MODEL' },
});

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000; // Node's fetch stops waiting for response headers after 300 s (SETTINGS_LIMITS.timeoutSec.max)

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Fill a possibly partial resolved config with the built-in defaults (used by createProvider so tests and
 * scripts can pass just `{ baseUrl, model }`).
 * @param {string} id
 * @param {object} [cfg]
 */
export function withProviderDefaults(id, cfg = {}) {
  const d = PROVIDER_DEFAULTS[id] || {};
  return {
    ...cfg,
    id,
    baseUrl: text(cfg.baseUrl) || d.baseUrl || '',
    model: text(cfg.model) || d.model || '',
    apiKey: text(cfg.apiKey),
    thinking: id === 'gemini' ? (cfg.thinking === 'low' ? 'low' : 'auto') : undefined,
    timeoutMs: finite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : d.timeoutMs,
  };
}

/**
 * Turn saved settings + environment into the config an adapter needs.
 * @param {'gemini'|'openai'|'local'} id
 * @param {object} settings internal settings (settings.ai.providers[id], settings.ai.temperature, ...)
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ id: string, baseUrl: string, model: string, apiKey: string, keySource: 'settings'|'env'|'none',
 *             thinking?: 'auto'|'low', timeoutMs: number, temperature?: number, maxTokens?: number }}
 * @throws {ProviderError} bad_request for an unknown provider id
 */
export function resolveProviderConfig(id, settings, env = process.env) {
  if (!PROVIDER_IDS.includes(id)) {
    throw new ProviderError('bad_request', `Unknown AI provider "${String(id).slice(0, 40)}".`, {
      hint: `Choose one of: ${PROVIDER_IDS.join(', ')}.`,
    });
  }
  const ai = (settings && settings.ai) || {};
  const saved = (ai.providers && ai.providers[id]) || {};
  const defaults = PROVIDER_DEFAULTS[id];
  const fallbacks = ENV_FALLBACKS[id];
  const { key, source } = effectiveApiKey(id, saved.apiKey, env || {});

  const cfg = {
    id,
    baseUrl: text(saved.baseUrl) || (fallbacks.baseUrl && text(env && env[fallbacks.baseUrl])) || defaults.baseUrl,
    model: text(saved.model) || (fallbacks.model && text(env && env[fallbacks.model])) || defaults.model,
    apiKey: key,
    keySource: source,
    timeoutMs: finite(ai.timeoutSec) && ai.timeoutSec > 0
      ? clamp(Math.round(ai.timeoutSec * 1000), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
      : defaults.timeoutMs,
  };
  if (id === 'gemini') cfg.thinking = saved.thinking === 'low' ? 'low' : 'auto';
  if (finite(ai.temperature)) cfg.temperature = clamp(ai.temperature, 0, 2);
  if (finite(ai.maxTokens) && ai.maxTokens > 0) cfg.maxTokens = clamp(Math.round(ai.maxTokens), 1, 200_000);
  return cfg;
}
