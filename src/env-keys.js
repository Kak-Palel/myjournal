// Single source of truth for which environment variables can supply a provider API key,
// and for the precedence rule: a key saved in Settings wins, the environment fills the gap.
// Shared by src/settings.js (masking for the UI) and src/providers/config.js (actual requests).

export const ENV_KEY_NAMES = Object.freeze({
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  local: ['LOCAL_LLM_API_KEY'],
});

/**
 * Resolve the API key actually used for a provider.
 * @param {'gemini'|'openai'|'local'} providerId
 * @param {string} savedKey  key stored in settings ('' if none)
 * @param {Record<string,string|undefined>} env
 * @returns {{ key: string, source: 'settings'|'env'|'none' }}
 */
export function effectiveApiKey(providerId, savedKey, env = process.env) {
  const saved = typeof savedKey === 'string' ? savedKey.trim() : '';
  if (saved) return { key: saved, source: 'settings' };
  const name = envKeyVariable(providerId, env);
  return name ? { key: env[name].trim(), source: 'env' } : { key: '', source: 'none' };
}

/**
 * The NAME of the environment variable that supplies a provider's key: the first of ENV_KEY_NAMES[providerId] that is
 * set to something non-blank, else ''. Same order and same "blank is not set" rule as effectiveApiKey, so the name
 * always belongs to the key that is used. Never returns a value.
 * @param {'gemini'|'openai'|'local'} providerId
 * @param {Record<string,string|undefined>} env
 */
export function envKeyVariable(providerId, env = process.env) {
  for (const name of ENV_KEY_NAMES[providerId] || []) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) return name;
  }
  return '';
}

/** "…abcd" style hint (last 4 chars) that is safe to show in the UI; '' when there is no key. */
export function keyHint(key) {
  if (!key || key.length < 8) return key ? '…' : '';
  return `…${key.slice(-4)}`;
}
