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
  for (const name of ENV_KEY_NAMES[providerId] || []) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) return { key: value.trim(), source: 'env' };
  }
  return { key: '', source: 'none' };
}

/** "…abcd" style hint (last 4 chars) that is safe to show in the UI; '' when there is no key. */
export function keyHint(key) {
  if (!key || key.length < 8) return key ? '…' : '';
  return `…${key.slice(-4)}`;
}
