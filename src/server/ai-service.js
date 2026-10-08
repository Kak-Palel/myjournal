// Turns saved settings plus the environment into a ready-to-use provider, and explains in HTTP terms
// why that is not possible (ai_disabled / ai_not_configured).

import { createProvider, describeProviders, resolveProviderConfig } from '../providers/index.js';
import { effectiveApiKey } from '../env-keys.js';
import { PROVIDER_IDS, applyEnvSeed, isProviderConfigured, publicSettings } from '../settings.js';
import { HttpError } from './http.js';

const LABELS = Object.freeze({ gemini: 'Gemini', openai: 'The OpenAI-compatible service', local: 'The local model' });

/** The 409 for "AI is switched off in Settings". */
export function aiDisabledError() {
  return new HttpError(409, 'ai_disabled', 'The AI companion is switched off.', {
    hint: 'Turn it on in Settings > General, or keep journaling without it.',
  });
}

/** The 409 for "no usable model yet". */
export function aiNotConfiguredError(providerId) {
  if (PROVIDER_IDS.includes(providerId)) {
    const needsKey = providerId !== 'local';
    return new HttpError(409, 'ai_not_configured', `${LABELS[providerId]} is not fully set up yet.`, {
      hint: needsKey ? 'Open Settings and add your API key for it.' : 'Open Settings and check the address and model name.',
    });
  }
  return new HttpError(409, 'ai_not_configured', 'No AI model is set up yet.', {
    hint: 'Open Settings and choose the free Gemini API, an OpenAI-compatible API or a local model. You can also journal without AI.',
  });
}

/**
 * The active provider for the saved settings.
 * @param {object} settings internal settings (env seeds already applied)
 * @param {Record<string,string|undefined>} env
 * @param {{ fetch?: typeof fetch }} [opts]
 * @returns {{ provider: object, cfg: object }}
 * @throws {HttpError} 409 ai_disabled / ai_not_configured
 */
export function getProvider(settings, env, { fetch: fetchImpl } = {}) {
  if (!settings.ai.enabled) throw aiDisabledError();
  if (!isProviderConfigured(settings, env)) throw aiNotConfiguredError(settings.ai.provider);
  const id = settings.ai.provider;
  const cfg = resolveProviderConfig(id, settings, env);
  return { provider: createProvider(id, cfg, fetchImpl ? { fetch: fetchImpl } : {}), cfg };
}

/**
 * @param {{ db: object, env?: Record<string,string|undefined>, fetch?: typeof fetch }} deps
 */
export function createAiService({ db, env = process.env, fetch: fetchImpl }) {
  const providerOpts = () => (fetchImpl ? { fetch: fetchImpl } : {});

  /** Saved settings with the environment's URL/model seeds applied (raw API keys inside: never send them out). */
  function loadSettings() {
    return applyEnvSeed(db.settings.get(), env);
  }

  return {
    env,
    fetch: fetchImpl,
    loadSettings,

    /** Settings as the client may see them. */
    publicSettings(settings = loadSettings()) {
      return publicSettings(settings, env);
    },

    /** @returns {{ provider: object, cfg: object, settings: object }} @throws {HttpError} */
    getActive(settings = loadSettings()) {
      return { ...getProvider(settings, env, { fetch: fetchImpl }), settings };
    },

    /**
     * Build a provider from the saved settings with `overlay` (baseUrl / model / apiKey typed in the UI but not
     * saved) laid over them. Nothing is persisted.
     * @param {'gemini'|'openai'|'local'} id
     * @param {{ baseUrl?: string, model?: string, apiKey?: string }} [overlay]
     * @param {{ timeoutCapMs?: number }} [opts]
     */
    buildWithOverlay(id, overlay = {}, { timeoutCapMs } = {}) {
      const settings = loadSettings();
      const saved = settings.ai.providers[id];
      if (overlay.baseUrl) saved.baseUrl = overlay.baseUrl;
      if (overlay.model) saved.model = overlay.model;
      if (overlay.apiKey) saved.apiKey = overlay.apiKey;
      const cfg = resolveProviderConfig(id, settings, env);
      if (timeoutCapMs) cfg.timeoutMs = Math.min(cfg.timeoutMs, timeoutCapMs);
      return { provider: createProvider(id, cfg, providerOpts()), cfg, settings };
    },

    /** Rows for GET /api/providers. */
    providerRows(settings = loadSettings()) {
      return describeProviders(env).map((row) => {
        const { source } = effectiveApiKey(row.id, settings.ai.providers[row.id].apiKey, env);
        return { ...row, configured: isProviderConfigured(settings, env, row.id), keySource: source };
      });
    },
  };
}
