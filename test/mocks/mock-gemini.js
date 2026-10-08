// Mock of the Gemini API (generativelanguage.googleapis.com, v1beta) for tests and manual UI trials.
//
//   const mock = await createMockGemini({ apiKey: 'test-key', replies: ['Hi!'] });
//   // point the gemini provider at  mock.url  (the bare origin; the adapter adds /v1beta/...).
//
// Behaves like the real service where it matters: `x-goog-api-key` is validated (a missing key is HTTP 403
// PERMISSION_DENIED "unregistered callers", an invalid key is HTTP 400 API_KEY_INVALID, both verified live),
// SSE frames end in CRLF CRLF, contents must start with a user turn and alternate, errors use Google's
// {error:{code,message,status,details}} envelope, and models are paginated with nextPageToken.
//
// `createMockGemini({ live: true })` switches on the model-specific behaviour verified against the real service on
// 2026-10-08 (test/fixtures/gemini-live/README.md): the real 62-entry model list, retired models that answer
// "404 no longer available", per-family thinkingConfig rules, thought tokens that eat maxOutputTokens, the *-latest
// aliases resolving to concrete model versions. Latency and overload are opt-in (`slowModels`, `overloadedModels`,
// failure `afterMs`) so the suite stays fast.

import { readFileSync } from 'node:fs';
import { allUserText, respond, splitIntoDeltas } from './mock-responder.js';
import { sendJson, sendText, startMockServer } from './mock-server.js';

export const DEFAULTS = Object.freeze({
  /** Scripted replies for generate requests, consumed in order. Exhausted => deterministic responder. */
  replies: [],
  /** Delay between SSE frames, ms. */
  delayMs: 0,
  /** Delay before the first byte, ms. */
  ttfbMs: 0,
  /**
   * Live profile (see the header): real model list, retired models, per-family thinking rules and thought tokens.
   * Anything else passed in the same options object still wins.
   */
  live: false,
  /** `{ 'gemini-2.5-flash': 'gemini-3.8-flash' }`: ids that answer 404 "no longer available" (value = Google's suggested replacement). */
  retiredModels: {},
  /** Apply the per-family thinkingConfig rules and thought-token counts of the live models (`live: true` turns this on). */
  modelQuirks: false,
  /** `{ 'gemini-flash-latest': 16000 }`: extra delay before the first byte per model (live: 16-23 s for gemini-flash-latest). */
  slowModels: {},
  /**
   * Models that answer `503 UNAVAILABLE` "high demand": an array of ids, or `{ id: { afterMs, times } }` (answers after
   * `afterMs`; `times` limits how many calls fail, default all). Live: the 503 arrives after 1-20 s.
   */
  overloadedModels: {},
  /** Fixed characters per chunk; default is a phrase-sized cycle. */
  chunkSize: 0,
  /** Slice socket writes at arbitrary byte offsets. */
  byteSplit: true,
  /** Required API key (string or array). Unset => any non-empty key is accepted. */
  apiKey: undefined,
  /** Models served by GET /v1beta/models (see DEFAULT_MODELS) and accepted by generate calls. */
  models: undefined,
  /** Max models per page (the real API honours pageSize; this lets tests force pagination). */
  listPageSize: 1000,
  /** Reject generate calls for models that are not in `models` with a 404. */
  strictModel: true,
  /** Failure queue (array), persistent failure (string/object) or function. */
  failures: [],
  /** Same shapes, for GET /v1beta/models. */
  modelsFailures: [],
  /**
   * Reject `thinkingConfig` with a 400, like models that do not support it: true (any), or an array of
   * 'thinkingLevel' | 'thinkingBudget' | 'minimal' (level minimal only) | 'budget0' (thinkingBudget 0 only).
   * Messages are the live ones: an unsupported level says so, a bad budget is a bare "Request contains an invalid argument."
   */
  rejectThinking: false,
  /** Reject `systemInstruction` (as the Gemma models do) for models matching this RegExp (or all, if true). */
  rejectSystemInstruction: false,
  /** Emit `thought: true` parts before the answer (a text, or true for a default). */
  thoughts: false,
  /**
   * Behave like the live thinking models: this many tokens (or `true` = 300) of maxOutputTokens are spent on thoughts
   * before the answer starts, so a small cap gives a MAX_TOKENS finish with an empty or truncated answer.
   * With `modelQuirks` the count follows the model and the request's thinkingConfig instead (see LIVE_THOUGHTS).
   */
  thinkingConsumesBudget: false,
  /** Reject consecutive same-role turns (the live API accepts them; the adapter merges them anyway). */
  strictAlternation: false,
  /** Like the live service, finish the stream with an extra frame holding `text: ""` + a thoughtSignature + finishReason. */
  trailingFrame: true,
});

const DEFAULT_THOUGHT = 'The user is sharing something personal. I should respond warmly and briefly.';

const m = (id, displayName, methods = ['generateContent', 'countTokens'], extra = {}) => ({
  name: `models/${id}`,
  version: '001',
  displayName,
  description: `${displayName} (mock)`,
  inputTokenLimit: 1048576,
  outputTokenLimit: 65536,
  supportedGenerationMethods: methods,
  temperature: 1,
  topP: 0.95,
  topK: 64,
  ...extra,
});

/** A realistic mix: chat models, aliases and a pile of things the picker must filter out. */
export const DEFAULT_MODELS = Object.freeze([
  m('gemini-2.5-flash', 'Gemini 2.5 Flash'),
  m('gemini-2.5-pro', 'Gemini 2.5 Pro'),
  m('gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite'),
  m('gemini-2.0-flash', 'Gemini 2.0 Flash'),
  m('gemini-flash-latest', 'Gemini Flash Latest'),
  m('gemini-flash-lite-latest', 'Gemini Flash-Lite Latest'),
  m('gemini-pro-latest', 'Gemini Pro Latest'),
  m('gemma-3-27b-it', 'Gemma 3 27B'),
  m('text-embedding-004', 'Text Embedding 004', ['embedContent']),
  m('embedding-001', 'Embedding 001', ['embedContent']),
  m('aqa', 'Model that performs Attributed Question Answering', ['generateAnswer']),
  m('imagen-4.0-generate-001', 'Imagen 4', ['predict']),
  m('veo-3.0-generate-001', 'Veo 3', ['predictLongRunning']),
  m('gemini-2.5-flash-preview-tts', 'Gemini 2.5 Flash Preview TTS', ['generateContent']),
  m('gemini-2.5-flash-image', 'Gemini 2.5 Flash Image', ['generateContent']),
  m('gemini-live-2.5-flash-preview', 'Gemini Live', ['bidiGenerateContent']),
  m('gemini-robotics-er-1.5-preview', 'Gemini Robotics-ER', ['generateContent']),
  m('gemini-2.5-computer-use-preview-10-2025', 'Computer Use', ['generateContent']),
  m('learnlm-2.0-flash-experimental', 'LearnLM 2.0 Flash', ['generateContent']),
]);

/**
 * The model list captured from the live service (test/fixtures/gemini-live/models-list.json): dozens of non-chat
 * models next to the chat ones. Falls back to DEFAULT_MODELS when the fixture is not there.
 */
export const LIVE_MODELS = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../fixtures/gemini-live/models-list.json', import.meta.url), 'utf8'));
    return Object.freeze(parsed.models);
  } catch {
    return DEFAULT_MODELS;
  }
})();

/** Retired chat models still listed by models.list that answer 404 (live), with the replacement Google names. */
export const LIVE_RETIRED = Object.freeze({
  'gemini-2.5-flash': 'gemini-3.8-flash',
  'gemini-2.5-pro': 'gemini-3.1-pro-preview',
});

/** What the *-latest aliases resolved to when captured (modelVersion in the frames). */
export const LIVE_ALIASES = Object.freeze({
  'gemini-flash-latest': 'gemini-3.8-flash',
  'gemini-flash-lite-latest': 'gemini-3.5-flash-lite',
  'gemini-pro-latest': 'gemini-3.1-pro-preview',
});

/**
 * Thought tokens measured live for the journal's reply prompt (auto = no thinkingConfig, low = thinkingLevel low):
 * flash-lite 0 / ~465, 3.5-flash ~810 / ~350, 3.8-flash 69-286 on "low", gemma-4 ~290 on auto (it rejects "low").
 */
export const LIVE_THOUGHTS = Object.freeze({
  lite: { auto: 0, low: 465 },
  flash: { auto: 800, low: 320 },
  gemma: { auto: 290, low: 290 },
  gemini2: { auto: 0, low: 0 },
});

/** @returns {'gemma'|'gemini2'|'lite'|'flash'} the behavioural family of a (resolved) model id */
export function modelFamily(modelId) {
  const id = LIVE_ALIASES[modelId] || modelId;
  if (/^gemma-/.test(id)) return 'gemma';
  if (/^gemini-2(\.|-)/.test(id)) return 'gemini2';
  return /lite/.test(id) ? 'lite' : 'flash';
}

// ---------------------------------------------------------------------------------------------------
// Real error bodies

const API_HOST = 'generativelanguage.googleapis.com';

/** Verified live: HTTP 400. */
export const INVALID_KEY_BODY = Object.freeze({
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com', metadata: { service: API_HOST } },
      { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'en-US', message: 'API key not valid. Please pass a valid API key.' },
    ],
  },
});

/** Verified live: HTTP 403. */
export const MISSING_KEY_BODY = Object.freeze({
  error: {
    code: 403,
    message: "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.",
    status: 'PERMISSION_DENIED',
  },
});

/** Verified live (503 UNAVAILABLE on gemini-flash-latest). */
export const OVERLOADED_MESSAGE = 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.';
const retiredMessage = (id, replacement) => `This model models/${id} is no longer available to new users. Please update your code to use models/${replacement} for the latest features and improvements. We recommend you to use the Interactions API (https://ai.google.dev/gemini-api/docs/get-started).`;

const googleError = (code, status, message, details) => ({ error: { code, message, status, ...(details ? { details } : {}) } });

function quotaDetails(quotaId, retryDelay) {
  return [
    { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Learn more about Gemini API quotas', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }] },
    {
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{
        quotaMetric: `${API_HOST}/generate_content_free_tier_requests`,
        quotaId,
        quotaDimensions: { location: 'global', model: 'gemini-2.5-flash' },
        quotaValue: '5',
      }],
    },
    ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
  ];
}

/**
 * Failure kinds (use in `failures`, as a string, `{ kind, ...params }` or `{ status, ... }`; common aliases such as
 * '429', 'auth', 'timeout', 'safety' work, and an unknown kind answers 500 "mock crashed" so typos fail loudly):
 *   model_retired (404 "no longer available to new users") · invalid_key (400) · missing_key (403) · echo_key (400 that repeats the received key) · rate_limit (429 per-minute, `retryDelay` e.g. '12s') ·
 *   quota_daily (429 PerDay) · quota_zero (429 limit: 0) · not_found (404 model) · unavailable (503) · internal (500) ·
 *   deadline (504) · region (400 FAILED_PRECONDITION) · bad_request (400) · context_length (400) · html (502) ·
 *   http (`status`, `body`) · safety_prompt (200, promptFeedback.blockReason) · safety_candidate (finishReason SAFETY,
 *   no text) · recitation · max_tokens_empty (finishReason MAX_TOKENS, no text) · empty · thought_only ·
 *   hang · hang_after_headers · reset_before_response · stall/reset/malformed/error_in_stream (`after` chunks) · json_array
 * Every HTTP failure also takes `afterMs`: the answer arrives that much later (live: a 503 after 3-20 s).
 */
function failureHttp(spec, ctx) {
  switch (spec.kind) {
    case 'invalid_key': return { status: 400, body: INVALID_KEY_BODY };
    case 'missing_key': return { status: 403, body: MISSING_KEY_BODY };
    case 'echo_key': {
      // A hostile/buggy server that reflects the credential it received back in the error text.
      const key = String((ctx && ctx.req.headers['x-goog-api-key']) || '');
      return { status: 400, body: googleError(400, 'INVALID_ARGUMENT', `API key not valid: ${key}. Please pass a valid API key (${key}).`, [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }]) };
    }
    case 'rate_limit':
      return {
        status: 429,
        body: googleError(429, 'RESOURCE_EXHAUSTED',
          `You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: ${API_HOST}/generate_content_free_tier_requests, limit: 5, model: gemini-2.5-flash\nPlease retry in ${spec.retryDelay || '12s'}.`,
          quotaDetails('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', spec.retryDelay || '12s')),
      };
    case 'quota_daily':
      return {
        status: 429,
        body: googleError(429, 'RESOURCE_EXHAUSTED',
          `You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: ${API_HOST}/generate_content_free_tier_requests, limit: 20, model: gemini-2.5-flash\nPlease retry in 41s.`,
          quotaDetails('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '41s')),
      };
    case 'quota_zero':
      return {
        status: 429,
        body: googleError(429, 'RESOURCE_EXHAUSTED',
          `You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: ${API_HOST}/generate_content_free_tier_input_token_count, limit: 0, model: gemini-2.5-pro`,
          quotaDetails('GenerateContentInputTokensPerModelPerMinute-FreeTier')),
      };
    case 'not_found':
      return { status: 404, body: googleError(404, 'NOT_FOUND', `models/${spec.model || 'unknown-model'} is not found for API version v1beta, or is not supported for generateContent. Call ModelService.ListModels to see the list of available models and their supported methods.`) };
    case 'model_retired':
      return { status: 404, body: googleError(404, 'NOT_FOUND', retiredMessage(spec.model || 'gemini-2.5-flash', spec.replacement || 'gemini-3.8-flash')) };
    case 'unavailable':
      return { status: 503, body: googleError(503, 'UNAVAILABLE', OVERLOADED_MESSAGE) };
    case 'internal':
      return { status: 500, body: googleError(500, 'INTERNAL', 'An internal error has occurred. Please retry or report in https://developers.generativeai.google/guide/troubleshooting') };
    case 'deadline':
      return { status: 504, body: googleError(504, 'DEADLINE_EXCEEDED', 'The service is unable to finish processing within the deadline.') };
    case 'region':
      return { status: 400, body: googleError(400, 'FAILED_PRECONDITION', 'User location is not supported for the API use.') };
    case 'bad_request':
      return { status: 400, body: googleError(400, 'INVALID_ARGUMENT', spec.message || 'Invalid JSON payload received.') };
    case 'context_length':
      return { status: 400, body: googleError(400, 'INVALID_ARGUMENT', 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).') };
    case 'html':
      return { status: 502, headers: { 'Content-Type': 'text/html' }, text: '<!doctype html><html><body><h1>502 Bad Gateway</h1></body></html>' };
    case 'http':
      return { status: spec.status || 500, headers: spec.headers || {}, body: spec.body, text: spec.text };
    default:
      return null;
  }
}

const KIND_BY_STATUS = { 400: 'bad_request', 403: 'missing_key', 404: 'not_found', 429: 'rate_limit', 500: 'internal', 503: 'unavailable', 504: 'deadline' };
const KIND_ALIASES = {
  auth: 'invalid_key', bad_key: 'invalid_key', no_key: 'missing_key', 403: 'missing_key', 404: 'not_found', model: 'not_found', 429: 'rate_limit',
  ratelimit: 'rate_limit', quota: 'quota_daily', 400: 'bad_request', 500: 'internal', server: 'internal', error: 'internal', 503: 'unavailable',
  overloaded: 'unavailable', 504: 'deadline', safety: 'safety_prompt', blocked: 'safety_prompt', timeout: 'hang', never: 'hang',
  malformed_chunk: 'malformed', reset_mid_stream: 'reset', disconnect: 'reset', retired: 'model_retired',
};
/** Kinds handled while streaming or by altering the reply (not by an up-front HTTP error). */
const STREAM_KINDS = new Set(['hang', 'reset_before_response', 'hang_after_headers', 'stall', 'reset', 'malformed', 'error_in_stream',
  'json_array', 'safety_prompt', 'safety_candidate', 'recitation', 'max_tokens_empty', 'empty', 'thought_only']);

/** Accepts 'kind', { kind, ... } or { status, ... }. */
function normalizeSpec(spec) {
  if (!spec) return null;
  const s = typeof spec === 'string' ? { kind: spec } : { ...spec };
  if (!s.kind && s.status) s.kind = KIND_BY_STATUS[s.status] || 'http';
  if (s.kind) {
    const k = String(s.kind).toLowerCase().replace(/[\s-]+/g, '_');
    s.kind = KIND_ALIASES[k] || k;
  }
  return s;
}

function takeFailure(behavior, ctx, listKey) {
  const f = behavior[listKey];
  if (!f || (Array.isArray(f) && f.length === 0)) return null;
  if (typeof f === 'function') return normalizeSpec(f(ctx));
  if (!Array.isArray(f)) return normalizeSpec(f);
  const head = f[0];
  if (head === null || head === undefined) {
    f.shift();
    return null;
  }
  const spec = normalizeSpec(head);
  spec.times = (spec.times ?? 1) - 1;
  if (spec.times <= 0) f.shift();
  else f[0] = { ...spec };
  return spec;
}

function respondHttp(ctx, out) {
  if (out.text !== undefined) {
    sendText(ctx.res, out.status, out.text, out.headers || {});
    return;
  }
  // Live quirk: key errors are application/json, but other errors on :streamGenerateContent come back as
  // text/event-stream carrying a plain JSON body.
  const keyError = out.body === INVALID_KEY_BODY || out.body === MISSING_KEY_BODY;
  const streamCall = /:streamGenerateContent$/.test(ctx.url.pathname);
  // Google pretty-prints its error bodies (2 spaces, trailing newline); key errors say charset=UTF-8.
  const text = `${JSON.stringify(out.body ?? {}, null, 2)}\n`;
  const type = !keyError && streamCall ? 'text/event-stream' : 'application/json; charset=UTF-8';
  ctx.res.writeHead(out.status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text), 'Vary': 'Origin, X-Origin, Referer', ...(out.headers || {}) });
  ctx.res.end(text);
}

function checkKey(ctx, behavior) {
  const key = ctx.req.headers['x-goog-api-key'] || ctx.url.searchParams.get('key') || '';
  if (!key) return { status: 403, body: MISSING_KEY_BODY };
  if (behavior.apiKey && !([].concat(behavior.apiKey)).includes(key)) return { status: 400, body: INVALID_KEY_BODY };
  return null;
}

const estimateTokens = (text) => Math.max(1, Math.ceil(String(text).length / 4));

function toMessages(body) {
  const out = [];
  const sys = body.systemInstruction && Array.isArray(body.systemInstruction.parts)
    ? body.systemInstruction.parts.map((p) => p.text || '').join('\n') : '';
  if (sys) out.push({ role: 'system', content: sys });
  for (const c of body.contents || []) {
    out.push({ role: c.role === 'model' ? 'assistant' : 'user', content: (c.parts || []).map((p) => p.text || '').join('') });
  }
  return out;
}

function validateGenerate(ctx, behavior, modelId) {
  const { body } = ctx;
  if (!body || typeof body !== 'object') {
    return { status: 400, body: googleError(400, 'INVALID_ARGUMENT', 'Invalid JSON payload received. Unexpected token.') };
  }
  const models = behavior.models;
  const retired = behavior.retiredModels && behavior.retiredModels[modelId];
  if (retired) return failureHttp({ kind: 'model_retired', model: modelId, replacement: retired }, ctx);
  const known = models.find((x) => x.name === `models/${modelId}`);
  if (behavior.strictModel && (!known || !(known.supportedGenerationMethods || []).includes('generateContent'))) {
    return failureHttp({ kind: 'not_found', model: modelId }, ctx);
  }
  if (!Array.isArray(body.contents) || body.contents.length === 0) {
    return { status: 400, body: googleError(400, 'INVALID_ARGUMENT', '* GenerateContentRequest.contents: contents is not specified\n') };
  }
  for (const c of body.contents) {
    if (!c || !Array.isArray(c.parts) || c.parts.length === 0) {
      return { status: 400, body: googleError(400, 'INVALID_ARGUMENT', '* GenerateContentRequest.contents[0].parts: contents.parts must not be empty.\n') };
    }
    if (c.parts.some((p) => typeof p.text !== 'string' || p.text === '')) {
      return { status: 400, body: googleError(400, 'INVALID_ARGUMENT', 'Request has empty input.') };
    }
    if (c.role !== 'user' && c.role !== 'model') {
      return { status: 400, body: googleError(400, 'INVALID_ARGUMENT', `Please use a valid role: user, model.`) };
    }
  }
  // Live-verified: a conversation may start with a model turn, but must not end with one.
  if (body.contents[body.contents.length - 1].role === 'model') {
    return { status: 400, body: googleError(400, 'INVALID_ARGUMENT', 'Requests ending with a model turn are not supported.') };
  }
  if (behavior.strictAlternation) {
    for (let i = 1; i < body.contents.length; i += 1) {
      if (body.contents[i].role === body.contents[i - 1].role) {
        return { status: 400, body: googleError(400, 'INVALID_ARGUMENT', 'Please ensure that multiturn requests alternate between user and model.') };
      }
    }
  }
  const tc = body.generationConfig && body.generationConfig.thinkingConfig;
  if (tc && behavior.rejectThinking) {
    const rules = behavior.rejectThinking === true ? ['thinkingLevel', 'thinkingBudget'] : [].concat(behavior.rejectThinking);
    const levelRejected = typeof tc.thinkingLevel === 'string'
      && (rules.includes('thinkingLevel') || (rules.includes('minimal') && tc.thinkingLevel === 'minimal'));
    const budgetRejected = tc.thinkingBudget !== undefined
      && (rules.includes('thinkingBudget') || (rules.includes('budget0') && tc.thinkingBudget === 0));
    if (levelRejected) {
      return { status: 400, body: googleError(400, 'INVALID_ARGUMENT', `Thinking level ${String(tc.thinkingLevel).toUpperCase()} is not supported for this model. Please retry with other thinking level.`) };
    }
    if (budgetRejected) {
      return { status: 400, body: googleError(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.') };
    }
  }
  const quirk = tc && behavior.modelQuirks ? thinkingQuirk(modelId, tc) : null;
  if (quirk) return { status: 400, body: googleError(400, 'INVALID_ARGUMENT', quirk) };
  if (body.systemInstruction) {
    const rule = behavior.rejectSystemInstruction;
    if (rule === true || (rule instanceof RegExp && rule.test(modelId))) {
      return { status: 400, body: googleError(400, 'INVALID_ARGUMENT', `Developer instruction is not enabled for models/${modelId}`) };
    }
  }
  return null;
}

/**
 * What the live models say to a thinkingConfig (null = accepted). Verified 2026-10-08:
 *  - gemma-* and gemini-2.x: any thinkingLevel -> "Thinking level is not supported for this model."; thinkingBudget is fine;
 *  - Lite 3.x (gemini-flash-lite-latest = 3.5-flash-lite): every level incl. minimal is fine; thinkingBudget 0 -> bare "invalid argument";
 *  - Flash/Pro 3.x (gemini-3.8-flash): minimal -> "Thinking level MINIMAL is not supported ..."; thinkingBudget 0 -> bare "invalid argument".
 */
function thinkingQuirk(modelId, tc) {
  const family = modelFamily(modelId);
  if (typeof tc.thinkingLevel === 'string') {
    if (family === 'gemma' || family === 'gemini2') return 'Thinking level is not supported for this model.';
    if (family === 'flash' && tc.thinkingLevel.toLowerCase() === 'minimal') {
      return 'Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.';
    }
  }
  if (tc.thinkingBudget === 0 && (family === 'lite' || family === 'flash')) return 'Request contains an invalid argument.';
  return null;
}

async function resolveReply(behavior, ctx) {
  const list = behavior.replies;
  let reply;
  if (typeof list === 'function') reply = await list(ctx);
  else if (Array.isArray(list) && ctx.index < list.length) {
    const item = list[ctx.index];
    reply = typeof item === 'function' ? await item(ctx) : item;
  }
  if (typeof reply === 'string') return { text: reply };
  if (reply && typeof reply === 'object') return { ...reply, text: reply.text ?? respond(ctx.messages) };
  return { text: respond(ctx.messages) };
}

/**
 * How many output tokens would go on thoughts before the answer starts (0 = thinking is not simulated).
 * `thinkingConsumesBudget` is a flat number; `modelQuirks` looks the model and its thinkingConfig up in LIVE_THOUGHTS.
 */
function thoughtTokens(behavior, modelId, body) {
  if (behavior.thinkingConsumesBudget) return behavior.thinkingConsumesBudget === true ? 300 : Number(behavior.thinkingConsumesBudget) || 0;
  if (!behavior.modelQuirks) return 0;
  const tc = body && body.generationConfig && body.generationConfig.thinkingConfig;
  const mode = tc && (tc.thinkingLevel === 'low' || tc.thinkingLevel === 'minimal' || tc.thinkingBudget === 0) ? 'low' : 'auto';
  if (tc && tc.thinkingBudget === 0) return 0;
  return LIVE_THOUGHTS[modelFamily(modelId)][mode];
}

function candidateChunk(parts, extra = {}) {
  // Live key order: content, finishReason (last frame only), index.
  return { candidates: [{ content: { parts, role: 'model' }, ...extra, index: 0 }] };
}

/** usageMetadata in the live shape and key order (see stream-success*.body). */
function usageFor(body, outputText, thoughts = 0) {
  const prompt = estimateTokens((body.contents || []).map((c) => (c.parts || []).map((p) => p.text).join('')).join(' '));
  const out = outputText ? estimateTokens(outputText) : 0;
  return {
    promptTokenCount: prompt,
    ...(out ? { candidatesTokenCount: out } : {}),
    totalTokenCount: prompt + out + thoughts,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: prompt }],
    ...(thoughts ? { thoughtsTokenCount: thoughts } : {}),
    serviceTier: 'standard',
  };
}

/**
 * JSON the way Google serialises SSE frames: a space after every colon and none after commas
 * (`{"candidates": [{"content": {"parts": [{"text": "Hi"}],"role": "model"},"index": 0}],...`).
 */
export function googleJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => googleJson(v === undefined ? null : v)).join(',')}]`;
  const parts = [];
  for (const [k, v] of Object.entries(value)) if (v !== undefined) parts.push(`${JSON.stringify(k)}: ${googleJson(v)}`);
  return `{${parts.join(',')}}`;
}

/** Build the list of response objects (one per SSE frame) for a reply. */
function buildResponses(reply, body, behavior, modelId, spec) {
  const kind = spec && spec.kind;
  const base = { modelVersion: LIVE_ALIASES[modelId] || modelId, responseId: `mockresp${Date.now().toString(36)}` };
  if (kind === 'safety_prompt') {
    return [{ promptFeedback: { blockReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'HIGH' }] }, usageMetadata: usageFor(body, ''), ...base }];
  }
  if (kind === 'safety_candidate' || kind === 'recitation') {
    return [{ candidates: [{ finishReason: kind === 'recitation' ? 'RECITATION' : 'SAFETY', index: 0, safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }] }], usageMetadata: usageFor(body, ''), ...base }];
  }
  const cap = body.generationConfig && Number.isFinite(body.generationConfig.maxOutputTokens) ? body.generationConfig.maxOutputTokens : 8192;
  const spent = thoughtTokens(behavior, modelId, body);
  if (kind === 'max_tokens_empty' || (spent > 0 && cap <= spent)) {
    const used = kind === 'max_tokens_empty' ? Math.min(cap, 16) : cap;
    return [{ candidates: [{ content: { role: 'model' }, finishReason: 'MAX_TOKENS', index: 0 }], usageMetadata: { ...usageFor(body, '', used), candidatesTokenCount: undefined }, ...base }];
  }
  const responses = [];
  const thought = reply.thoughts ?? behavior.thoughts;
  if (thought || kind === 'thought_only') {
    const t = thought === true || !thought ? DEFAULT_THOUGHT : String(thought);
    responses.push({ ...candidateChunk([{ text: t, thought: true }]), usageMetadata: usageFor(body, ''), ...base });
  }
  let text = kind === 'empty' || kind === 'thought_only' ? '' : reply.text;
  let finishOverride = '';
  if (spent > 0 && text && (cap - spent) * 4 < text.length) {
    text = text.slice(0, Math.max(1, (cap - spent) * 4)); // roughly 4 characters per token
    finishOverride = 'MAX_TOKENS';
  }
  const sizes = behavior.chunkSize ? [behavior.chunkSize] : [14, 7, 22, 5, 31, 11];
  const pieces = text ? splitIntoDeltas(text, { sizes }) : [];
  const finish = finishOverride || reply.finishReason || 'STOP';
  const thoughtCount = spent || (thought ? estimateTokens(String(thought)) : 0);
  // Live captures: the text frames carry running usage, and the last frame is an empty-text part (with a
  // thoughtSignature) that holds the finishReason. `trailingFrame: false` puts finishReason on the last text frame.
  const trailing = behavior.trailingFrame && pieces.length > 0;
  let soFar = '';
  pieces.forEach((piece, i) => {
    const last = i === pieces.length - 1;
    soFar += piece;
    // Live: every text frame carries the running candidatesTokenCount; thoughts are only counted once they are over (frame 1).
    responses.push({
      ...candidateChunk([{ text: piece }], last && !trailing ? { finishReason: finish } : {}),
      usageMetadata: usageFor(body, soFar, thoughtCount),
      ...base,
    });
  });
  if (trailing) {
    responses.push({
      ...candidateChunk([{ text: '', thoughtSignature: 'EmAKXgFpFH0TCk45bHJsLt4GdLW9xu/9KU1HlEisaujuNl4E425MoUFBbfTgIVBoU7K2CyCdDKRlFaU0QVodBFRaTqmfVOqIlgsOe0cBAe1nCiE2Sk59LQlKznbMn5V2skw=' }], { finishReason: finish }),
      usageMetadata: usageFor(body, text, thoughtCount),
      ...base,
    });
  }
  if (pieces.length === 0 && kind !== 'thought_only') {
    responses.push({ candidates: [{ content: { role: 'model' }, finishReason: finish, index: 0 }], usageMetadata: usageFor(body, ''), ...base });
  }
  if (kind === 'thought_only') {
    responses.push({ candidates: [{ content: { role: 'model' }, finishReason: 'MAX_TOKENS', index: 0 }], usageMetadata: usageFor(body, ''), ...base });
  }
  return responses;
}

/** The `overloadedModels` entry for a model that must answer 503 now (its `times` budget is used up here), else null. */
function overloadFor(behavior, modelId) {
  const cfg = behavior.overloadedModels;
  if (!cfg) return null;
  const entry = Array.isArray(cfg) ? (cfg.includes(modelId) ? {} : null) : cfg[modelId];
  if (!entry) return null;
  const spec = entry === true ? {} : entry;
  if (Number.isFinite(spec.times)) {
    if (spec.times <= 0) return null;
    spec.times -= 1;
  }
  return { afterMs: spec.afterMs || 0 };
}

async function handleGenerate(ctx, state, modelId, streaming) {
  const { behavior } = state;
  const { conn, res, body } = ctx;
  const spec = takeFailure(behavior, ctx, 'failures');
  if (spec) {
    if (spec.kind === 'hang') { await conn.hang(); return; }
    if (spec.kind === 'reset_before_response') { conn.reset(); return; }
    const http = failureHttp(spec, ctx);
    if (http) {
      if (spec.afterMs > 0 && !(await conn.wait(spec.afterMs))) return;
      respondHttp(ctx, http);
      return;
    }
    if (!STREAM_KINDS.has(spec.kind)) throw new Error(`unknown failure kind "${spec.kind}"`);
  }
  const keyFail = checkKey(ctx, behavior);
  if (keyFail) { respondHttp(ctx, keyFail); return; }
  const invalid = validateGenerate(ctx, behavior, modelId);
  if (invalid) { respondHttp(ctx, invalid); return; }

  // Live: a valid request to a busy model is answered with 503 after a while; a slow model is just slow to the first byte.
  const busy = overloadFor(behavior, modelId);
  if (busy) {
    if (busy.afterMs > 0 && !(await conn.wait(busy.afterMs))) return;
    respondHttp(ctx, failureHttp({ kind: 'unavailable' }, ctx));
    return;
  }
  const slow = (behavior.slowModels && behavior.slowModels[modelId]) || 0;
  if (slow > 0 && !(await conn.wait(slow))) return;
  if (behavior.ttfbMs > 0 && !(await conn.wait(behavior.ttfbMs))) return;
  const index = state.replyIndex;
  state.replyIndex += 1;
  const reply = await resolveReply(behavior, { index, messages: toMessages(body), body, model: modelId, request: ctx.record });
  const responses = buildResponses(reply, body, behavior, modelId, spec);

  if (!streaming) {
    // Non-streaming: one JSON document with everything merged.
    const text = responses.flatMap((r) => (r.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text)).join('');
    const last = responses[responses.length - 1];
    const parts = text ? [{ text }] : [];
    sendJson(res, 200, {
      ...(last.promptFeedback ? { promptFeedback: last.promptFeedback } : {}),
      ...(last.candidates ? { candidates: [{ content: { role: 'model', ...(parts.length ? { parts } : {}) }, finishReason: last.candidates[0].finishReason || 'STOP', index: 0 }] } : {}),
      usageMetadata: last.usageMetadata,
      modelVersion: modelId,
    });
    return;
  }

  if (spec && spec.kind === 'json_array') {
    const json = JSON.stringify(responses);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(json) });
    res.end(json);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Content-Disposition': 'attachment',
    'Vary': 'Origin, X-Origin, Referer',
    'X-Content-Type-Options': 'nosniff',
    'Server-Timing': 'gfet4t7; dur=300',
  });
  res.flushHeaders();
  if (spec && spec.kind === 'hang_after_headers') { await conn.hang(); return; }

  let seed = 0;
  const frame = (obj) => `data: ${typeof obj === 'string' ? obj : googleJson(obj)}\r\n\r\n`;
  const emit = (str) => {
    seed += 1;
    return behavior.byteSplit ? conn.writeSliced(str, seed) : conn.write(str);
  };
  const midStream = spec && ['reset', 'stall', 'malformed', 'error_in_stream'].includes(spec.kind) ? spec : null;
  let fired = false;
  const fire = async () => {
    fired = true;
    if (midStream.kind === 'reset') { conn.reset(); return true; }
    if (midStream.kind === 'stall') { await conn.hang(); return true; }
    if (midStream.kind === 'error_in_stream') {
      await emit(frame(googleError(503, 'UNAVAILABLE', OVERLOADED_MESSAGE)));
      res.end();
      return true;
    }
    return !(await emit(frame('{"candidates":[{"content":{"parts":[{"text":"Hel')));
  };
  for (let i = 0; i < responses.length; i += 1) {
    if (midStream && !fired && i === (midStream.after ?? 1) && await fire()) return;
    if (!(await emit(frame(responses[i])))) return;
    if (!(await conn.wait(behavior.delayMs))) return;
  }
  if (midStream && !fired && await fire()) return;
  res.end();
}

function paginate(behavior, query) {
  const all = behavior.models;
  const requested = Number(query.pageSize);
  const size = Math.max(1, Math.min(behavior.listPageSize, Number.isFinite(requested) && requested > 0 ? requested : 50));
  let start = 0;
  if (query.pageToken) {
    const decoded = Buffer.from(query.pageToken, 'base64url').toString('utf8');
    const n = /^offset:(\d+)$/.exec(decoded);
    if (!n) return { error: { status: 400, body: googleError(400, 'INVALID_ARGUMENT', 'Invalid page token.') } };
    start = Number(n[1]);
  }
  const page = all.slice(start, start + size);
  const next = start + size < all.length ? Buffer.from(`offset:${start + size}`).toString('base64url') : undefined;
  return { page, next };
}

async function handleList(ctx, state) {
  const { behavior } = state;
  const spec = takeFailure(behavior, ctx, 'modelsFailures');
  if (spec) {
    if (spec.kind === 'hang') { await ctx.conn.hang(); return; }
    const http = failureHttp(spec, ctx);
    if (http) { respondHttp(ctx, http); return; }
    throw new Error(`unknown failure kind "${spec.kind}" for models.list`);
  }
  const keyFail = checkKey(ctx, behavior);
  if (keyFail) { respondHttp(ctx, keyFail); return; }
  const { page, next, error } = paginate(behavior, Object.fromEntries(ctx.url.searchParams));
  if (error) { respondHttp(ctx, error); return; }
  sendJson(ctx.res, 200, { models: page, ...(next ? { nextPageToken: next } : {}) });
}

/**
 * @param {Partial<typeof DEFAULTS> & {port?: number, host?: string}} [options]
 */
export async function createMockGemini(options = {}) {
  const { port = 0, host = '127.0.0.1', ...rest } = options;
  if (typeof rest.replies === 'string') rest.replies = [rest.replies];
  const live = rest.live ? { retiredModels: { ...LIVE_RETIRED }, modelQuirks: true } : {};
  const state = {
    behavior: { ...DEFAULTS, ...live, ...rest, models: [...(rest.models || (rest.live ? LIVE_MODELS : DEFAULT_MODELS))] },
    replyIndex: 0,
  };
  // overloadedModels entries carry a mutable `times` counter: copy them so one mock never changes the caller's object.
  if (state.behavior.overloadedModels && !Array.isArray(state.behavior.overloadedModels)) {
    state.behavior.overloadedModels = Object.fromEntries(Object.entries(state.behavior.overloadedModels)
      .map(([id, v]) => [id, v && typeof v === 'object' ? { ...v } : v]));
  }
  if (Array.isArray(rest.failures)) state.behavior.failures = [...rest.failures];
  if (Array.isArray(rest.modelsFailures)) state.behavior.modelsFailures = [...rest.modelsFailures];

  const server = await startMockServer({
    name: 'gemini',
    port,
    host,
    async handle(ctx) {
      const path = ctx.url.pathname.replace(/\/+$/, '');
      const { method } = ctx.req;
      const gen = /^\/v1(?:beta)?\/models\/([^/:]+):(streamGenerateContent|generateContent)$/.exec(path);
      if (method === 'POST' && gen) {
        return handleGenerate(ctx, state, decodeURIComponent(gen[1]), gen[2] === 'streamGenerateContent');
      }
      if (method === 'GET' && /^\/v1(?:beta)?\/models$/.test(path)) return handleList(ctx, state);
      const one = /^\/v1(?:beta)?\/models\/([^/:]+)$/.exec(path);
      if (method === 'GET' && one) {
        const keyFail = checkKey(ctx, state.behavior);
        if (keyFail) return respondHttp(ctx, keyFail);
        const found = state.behavior.models.find((x) => x.name === `models/${decodeURIComponent(one[1])}`);
        return found ? sendJson(ctx.res, 200, found) : respondHttp(ctx, failureHttp({ kind: 'not_found', model: one[1] }, ctx));
      }
      return sendJson(ctx.res, 404, googleError(404, 'NOT_FOUND', 'Not found.'));
    },
  });

  const generateRequests = () => server.requests.filter((r) => r.method === 'POST' && /:(stream)?generateContent$/i.test(r.path));
  return {
    server: server.server,
    port: server.port,
    /** Bare origin; the adapter appends /v1beta/... */
    url: server.url,
    requests: server.requests,
    behavior: state.behavior,
    get inflight() { return server.inflight; },
    get replyCount() { return state.replyIndex; },
    waitForRequests: server.waitForRequests,
    waitForIdle: server.waitForIdle,
    close: server.close,
    setBehavior(patch) {
      const next = { ...patch };
      for (const key of ['failures', 'modelsFailures', 'models', 'overloadedModels']) {
        if (Array.isArray(next[key])) next[key] = [...next[key]];
      }
      if (next.overloadedModels && !Array.isArray(next.overloadedModels)) {
        next.overloadedModels = Object.fromEntries(Object.entries(next.overloadedModels).map(([id, v]) => [id, v && typeof v === 'object' ? { ...v } : v]));
      }
      if (typeof next.replies === 'string') next.replies = [next.replies];
      Object.assign(state.behavior, next);
      if (Object.hasOwn(next, 'replies')) state.replyIndex = 0;
    },
    generateRequests,
    lastGenerateRequest: () => generateRequests().at(-1),
    reset() {
      server.requests.length = 0;
      state.replyIndex = 0;
    },
    lastUserText() {
      const last = generateRequests().at(-1);
      return last && last.body ? allUserText(toMessages(last.body)) : '';
    },
  };
}
