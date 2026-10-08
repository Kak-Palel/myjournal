// Persistence for the single settings document (settings table, key 'app').
// Validation and defaults live in src/settings.js; this file only reads and writes.

import { PROVIDER_IDS, normalizeSettings } from '../settings.js';

const KEY = 'app';

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {ReturnType<import('./context.js').createContext>} ctx
 */
export function createSettingsStore(ctx) {
  function readRaw() {
    const row = ctx.one('SELECT value FROM settings WHERE key = :key', { key: KEY });
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined; // a corrupt document must not brick the app: fall back to defaults
    }
  }

  /**
   * Has a settings document been saved yet? False on a fresh install (and again after "delete everything" with
   * settings included, or when the stored document is unreadable), true from the first save on. The server uses it
   * to let the environment's URL/model seeds (OPENAI_BASE_URL, LOCAL_LLM_*) start a fresh install only.
   * @returns {boolean}
   */
  function exists() {
    return isObject(readRaw());
  }

  /**
   * The internal settings (raw API keys included; never send these to a client): stored document
   * normalised and merged over the defaults. Returns a fresh object each time.
   */
  function get() {
    return normalizeSettings(readRaw());
  }

  /**
   * Replace the settings document. The value is normalised first, so invalid fields fall back to
   * defaults; use mergeSettings() from src/settings.js to validate a user patch and report errors.
   * Safety net: a provider without an own `apiKey` property (for instance public settings passed
   * back by mistake, or a partial object) keeps the saved key instead of erasing it; pass
   * `apiKey: ''` to clear it.
   * @param {object} settings
   * @returns {object} what was stored
   */
  function set(settings) {
    const next = normalizeSettings(settings);
    const stored = normalizeSettings(readRaw());
    for (const id of PROVIDER_IDS) {
      const given = isObject(settings) && isObject(settings.ai) && isObject(settings.ai.providers) ? settings.ai.providers[id] : undefined;
      if (!isObject(given) || !Object.hasOwn(given, 'apiKey')) next.ai.providers[id].apiKey = stored.ai.providers[id].apiKey;
    }
    ctx.run('INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', {
      key: KEY,
      value: JSON.stringify(next),
    });
    return next;
  }

  return { get, set, exists };
}
