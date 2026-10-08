// Turns an API / SSE failure into what the banner shows: wording, tone and which actions make sense.
// Pure (no DOM): the banner component and the unit tests both use it.

/** Provider error codes (ARCHITECTURE §9) where changing the settings is the likely fix. */
const SETTINGS_CODES = new Set(['auth', 'model_not_found', 'bad_base_url', 'quota', 'region', 'context_too_long', 'network', 'blocked', 'empty']);
/** Codes where asking again right away cannot work. */
const NO_RETRY = new Set(['ai_not_configured', 'ai_disabled', 'nothing_to_reply_to', 'not_found', 'payload_too_large']);

/** Longest message the server accepts (ARCHITECTURE §6). */
export const MAX_MESSAGE_CHARS = 20_000;

/**
 * @typedef {object} Problem
 * @property {'error'|'warn'|'info'} tone
 * @property {string} message headline
 * @property {string} hint one line on what to do next ('' if none)
 * @property {boolean} retry offer a Retry button
 * @property {{ href: string, label: string } | null} settings offer a link into Settings
 * @property {string} code
 */

/** Settings link for an error: the active provider's tab for provider problems, General otherwise. */
export function settingsLink(code, providerId = '') {
  if (code === 'ai_not_configured') return { href: '#/settings', label: 'Set up AI' };
  if (code === 'ai_disabled') return { href: '#/settings?tab=general', label: 'Open settings' };
  const tab = ['gemini', 'openai', 'local'].includes(providerId) ? providerId : 'general';
  return { href: `#/settings?tab=${tab}`, label: 'Open settings' };
}

/**
 * Describe a failure for the banner.
 * @param {{ code?: string, message?: string, hint?: string, status?: number }} err ApiError or SSE error payload
 * @param {{ providerId?: string, source?: 'http'|'stream' }} [ctx] source 'stream' = the AI provider failed after streaming began
 * @returns {Problem}
 */
export function describeProblem(err, { providerId = '', source = 'http' } = {}) {
  const code = (err && err.code) || 'unknown';
  const serverMessage = (err && err.message) || '';
  const serverHint = (err && err.hint) || '';
  const clientSideNetwork = code === 'network' && source === 'http'; // our server is unreachable, not the model

  switch (code) {
    case 'ai_not_configured':
      return {
        code, tone: 'info', retry: false, settings: settingsLink(code, providerId),
        message: "Saved. Your AI companion isn't set up yet.",
        hint: 'Your writing is safe. Pick Gemini, an OpenAI-compatible API or a local model whenever you want replies.',
      };
    case 'ai_disabled':
      return {
        code, tone: 'info', retry: false, settings: settingsLink(code, providerId),
        message: 'Saved. The AI companion is switched off.',
        hint: 'Turn it back on in Settings whenever you want replies.',
      };
    case 'generation_in_progress':
      return {
        code, tone: 'warn', retry: true, settings: null,
        message: 'The previous reply is still finishing.',
        hint: 'Give it a few seconds, then try again.',
      };
    case 'nothing_to_reply_to':
      return { code, tone: 'info', retry: false, settings: null, message: 'There is nothing new to reply to.', hint: 'Write something and send it first.' };
    case 'not_found':
      return { code, tone: 'error', retry: false, settings: null, message: 'This entry no longer exists.', hint: 'It may have been deleted in another tab.' };
    case 'payload_too_large':
      return { code, tone: 'error', retry: false, settings: null, message: 'That is too much text for one message.', hint: `Messages can be up to ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters. Your text is still in the box; split it in two.` };
    default:
      break;
  }

  if (clientSideNetwork) {
    return {
      code, tone: 'error', retry: true, settings: null,
      message: serverMessage || 'Could not reach the MyJournal server.',
      hint: serverHint || 'Is it still running? Your text has been kept.',
    };
  }

  return {
    code,
    tone: code === 'rate_limit' || code === 'overloaded' || code === 'timeout' ? 'warn' : 'error',
    retry: !NO_RETRY.has(code),
    settings: SETTINGS_CODES.has(code) ? settingsLink(code, providerId) : null,
    message: serverMessage || 'Something went wrong.',
    hint: serverHint,
  };
}
