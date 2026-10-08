// Provider layer entry point. See docs/ARCHITECTURE.md §9.
//
//   const cfg = resolveProviderConfig('local', settings, process.env);
//   const provider = createProvider('local', cfg);
//   for await (const ev of provider.stream({ messages, signal })) { ... }

import { effectiveApiKey } from '../env-keys.js';
import { PROVIDER_DEFAULTS, PROVIDER_IDS, resolveProviderConfig } from './config.js';
import { ProviderError, abortError, errorPayload, isAbortError, ERROR_CODES } from './errors.js';
import { createGeminiProvider } from './gemini.js';
import { createOpenAIProvider, isOllama, pullOllamaModel } from './openai.js';

export {
  PROVIDER_DEFAULTS, PROVIDER_IDS, resolveProviderConfig,
  ProviderError, ERROR_CODES, abortError, errorPayload, isAbortError,
  isOllama, pullOllamaModel,
};

/**
 * Build a provider adapter.
 * @param {'gemini'|'openai'|'local'} id
 * @param {object} cfg resolved config from resolveProviderConfig (a partial `{ baseUrl, model, apiKey }` also works)
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch] injectable for tests (defaults to the global fetch)
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [opts.sleep] injectable retry wait
 * @param {number} [opts.idleTimeoutMs] silence allowed between chunks, default 60000
 * @returns {{
 *   id: string, label: string,
 *   stream(req: object): AsyncGenerator<{type: 'delta', text: string} | {type: 'done', finishReason: string, usage?: object}>,
 *   chat(req: object): Promise<{text: string, finishReason: string, usage?: object}>,
 *   listModels(o?: {signal?: AbortSignal}): Promise<{id: string, label: string}[]>,
 *   test(o?: {signal?: AbortSignal}): Promise<{ok: true, model: string, latencyMs: number, sample: string}>,
 *   isOllama?: Function, pullModel?: Function,
 * }}
 * @throws {ProviderError} bad_request for an unknown id. A bad base URL is reported lazily, by the first call.
 */
export function createProvider(id, cfg, opts = {}) {
  if (id === 'gemini') return createGeminiProvider({ ...cfg, id }, opts);
  if (id === 'openai' || id === 'local') return createOpenAIProvider({ ...cfg, id }, opts);
  throw new ProviderError('bad_request', `Unknown AI provider "${String(id).slice(0, 40)}".`, {
    hint: `Choose one of: ${PROVIDER_IDS.join(', ')}.`,
  });
}

const GEMINI_PRIVACY = 'On the free tier, Google may use your prompts and responses to improve its products, and they may be reviewed by humans. Billing-enabled projects are not used this way. Do not journal secrets with the free tier.';

const CATALOG = [
  {
    id: 'gemini',
    label: 'Free Gemini API',
    tagline: 'Free key from Google AI Studio',
    description: 'Google\'s Gemini models through the free tier of the Gemini API. Fast, capable, and the key takes a minute to create. Your journal text is sent to Google.',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    privacyNote: GEMINI_PRIVACY,
    suggestedModels: [
      { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite (latest)', note: 'Fast — recommended' },
      { id: 'gemini-flash-latest', label: 'Gemini Flash (latest)', note: 'Smarter, can be slow or busy' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    ],
    presets: [],
  },
  {
    id: 'openai',
    label: 'OpenAI-compatible API',
    tagline: 'OpenAI, OpenRouter, Groq, Together, DeepSeek, …',
    description: 'Connect any service that speaks the OpenAI Chat Completions API: OpenAI itself, OpenRouter, Groq, Together, DeepSeek, Mistral and many more. Bring your own key.',
    needsKey: true,
    privacyNote: 'Your journal text is sent to the service behind the base URL. Check that provider\'s data retention and training policy before writing anything sensitive.',
    suggestedModels: [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', note: 'Inexpensive, good for journaling' },
    ],
    presets: [
      { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
      { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
      { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
      { id: 'together', label: 'Together', baseUrl: 'https://api.together.xyz/v1' },
    ],
  },
  {
    id: 'local',
    label: 'Self-hosted small LLM',
    tagline: 'Runs on your machine — nothing leaves it',
    description: 'Run a small open model on your own computer with Ollama, llama.cpp or LM Studio. It is free, private and works offline. Small models are less polished than the big cloud ones, but fine for journaling.',
    needsKey: false,
    privacyNote: 'With a server on your own machine, your journal text never leaves it. If you point the address at another computer, that computer sees your text.',
    suggestedModels: [
      { id: 'llama3.2:1b', label: 'Llama 3.2 1B', note: '~1.3 GB, good for testing the plumbing' },
      { id: 'qwen2.5:1.5b', label: 'Qwen 2.5 1.5B', note: 'Small and multilingual' },
      { id: 'gemma2:2b', label: 'Gemma 2 2B' },
      { id: 'llama3.2:3b', label: 'Llama 3.2 3B', note: 'Better quality' },
      { id: 'smollm2:1.7b', label: 'SmolLM2 1.7B' },
    ],
    presets: [
      { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
      { id: 'llamacpp', label: 'llama.cpp', baseUrl: 'http://localhost:8080/v1' },
      { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
    ],
  },
];

/**
 * Catalog rows for `GET /api/providers`, without `configured` (the server adds it). `keySource` reflects the
 * environment only: the server overrides it with 'settings' when a key is saved.
 * @param {Record<string, string|undefined>} [env]
 */
export function describeProviders(env = process.env) {
  return CATALOG.map((row) => ({
    ...row,
    suggestedModels: row.suggestedModels.map((m) => ({ ...m })),
    presets: row.presets.map((p) => ({ ...p })),
    defaultBaseUrl: PROVIDER_DEFAULTS[row.id].baseUrl,
    defaultModel: PROVIDER_DEFAULTS[row.id].model,
    keySource: effectiveApiKey(row.id, '', env).source,
  }));
}
