// The friendly text printed when the server starts: where to open it, where the data lives, which AI is
// configured and how to configure one.

import { isLoopbackHost } from '../config.js';
import { PROVIDER_IDS, isProviderConfigured } from '../settings.js';

const LABELS = Object.freeze({ gemini: 'Gemini', openai: 'OpenAI-compatible API', local: 'Local model' });

/**
 * One-line description of the AI situation for the banner.
 * @param {object} settings internal settings (env seeds applied)
 * @param {Record<string,string|undefined>} env
 * @returns {{ state: 'ready'|'off'|'needs_setup'|'none', text: string }}
 */
export function describeAi(settings, env) {
  const { enabled, provider, providers } = settings.ai;
  if (!enabled) return { state: 'off', text: 'switched off in Settings (plain journal)' };
  if (!PROVIDER_IDS.includes(provider)) {
    const keys = [env.GEMINI_API_KEY || env.GOOGLE_API_KEY ? 'Gemini' : '', env.OPENAI_API_KEY ? 'OpenAI' : ''].filter(Boolean);
    const found = keys.length > 0 ? ` (found a ${keys.join(' and ')} key in the environment: pick it in Settings)` : '';
    return { state: 'none', text: `not chosen yet${found}` };
  }
  const label = LABELS[provider];
  const model = providers[provider].model;
  if (isProviderConfigured(settings, env)) return { state: 'ready', text: `${label}, model ${model}` };
  return { state: 'needs_setup', text: `${label} chosen but not ready (add the missing key or address in Settings)` };
}

/**
 * @param {{ config: object, url: string, settings: object }} args
 * @returns {string} multi-line text, ready to print
 */
export function formatBanner({ config, url, settings }) {
  const env = config.env || process.env;
  const ai = describeAi(settings, env);
  const lines = [
    '',
    `  MyJournal ${config.version}  -  your private, AI-guided journal`,
    '',
    `  Open        ${url}`,
    `  Your data   ${config.dbFile}   (stays on this computer)`,
    `  AI          ${ai.text}`,
  ];
  if (config.password) lines.push('  Password    required (set with JOURNAL_PASSWORD)');
  if (ai.state !== 'ready' && ai.state !== 'off') {
    lines.push(
      '',
      '  Add an AI companion any time, in the app under Settings, or with environment variables:',
      '    - free Gemini key        GEMINI_API_KEY=...    (https://aistudio.google.com/apikey)',
      '    - OpenAI-compatible API  OPENAI_API_KEY=...  [OPENAI_BASE_URL=https://openrouter.ai/api/v1]',
      '    - local model (Ollama)   ollama pull llama3.2:3b, then pick "Local model" in Settings',
      '    The journal works fine without any of them.',
    );
  }
  lines.push('', '  No key at hand? Try everything with a pretend model:  npm run demo');
  if (!isLoopbackHost(config.host)) {
    lines.push('');
    if (config.password) {
      lines.push(`  Listening on ${config.host}: other computers can reach this journal. The password travels unencrypted over`, '  plain HTTP, so put it behind HTTPS (a reverse proxy) before using it outside a trusted network.');
      if (config.password.length < 10) lines.push('  Your password is short: use a long passphrase.');
    } else {
      lines.push(`  WARNING: listening on ${config.host} WITHOUT a password (JOURNAL_INSECURE_ALLOW_NO_AUTH is set). Anyone who can`, '  reach this computer can read your journal.');
    }
  }
  lines.push('', '  Stop with Ctrl+C.', '');
  return lines.join('\n');
}
