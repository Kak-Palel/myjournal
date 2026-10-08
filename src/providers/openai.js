// OpenAI-compatible Chat Completions adapter. Serves both the `openai` provider (OpenAI, OpenRouter, Groq,
// Together, DeepSeek, ...) and the `local` provider (Ollama, llama.cpp llama-server, LM Studio, vLLM).
// Contract: docs/ARCHITECTURE.md §9.

import { ProviderError, errorFactory, isAbortError, redactSecrets } from './errors.js';
import {
  DEFAULT_IDLE_MS, createScope, describeUrl, oneLine, parseErrorBody, parseHttpUrl, readChunks, readText,
  retryAfterFromHeaders, scopedFetch, sleep,
} from './http.js';
import { iterateNdjson } from './sse.js';
import { createThinkFilter } from './think-filter.js';
import { withProviderDefaults } from './config.js';
import {
  MAX_ADAPTATIONS, MAX_OUTPUT_CHARS, chatFromStream, createQuirkStore, createReplyStats, mergeLearned, normalizeUsage, notAnApiError,
  prepareMessages, readJsonEvents, sendWithPolicy,
} from './common.js';

const LIST_TIMEOUT_MS = 30_000;
/** After the final chunk (finish_reason) we only wait this long for a [DONE] / usage chunk / socket close. */
const FINISH_GRACE_MS = 5_000;
const THINKING_HINT = 'The model spent its whole token budget thinking — raise max tokens or use a non-reasoning model.';

/** Quirks learned from 400 responses, shared by adapter instances talking to the same endpoint + model. */
const quirkStore = createQuirkStore();

/** Forget everything learned about endpoints (tests). */
export function clearOpenAIQuirks() {
  quirkStore.clear();
}

const REJECTION_WORDS = /unsupported|not supported|unrecognized|unknown|unexpected|not allowed|not permitted|not (?:a )?valid|extra (?:inputs|fields)|instead|deprecated|does not support|doesn't support|cannot be (?:used|set|specified)|only the default/i;

// ---------------------------------------------------------------------------------------------------
// Addresses

/**
 * Normalise a user-typed base URL into `scheme://host[:port][/path]` with no trailing slash and without a
 * trailing `/chat/completions`. For `local`, a bare host gets `/v1` appended (Ollama's compat endpoint);
 * for `api.openai.com` too. Query strings, embedded credentials and non-http(s) schemes are rejected.
 * @param {string} raw
 * @param {{local?: boolean, provider?: string}} [opts]
 * @returns {string}
 * @throws {ProviderError} bad_base_url
 */
export function normalizeBaseUrl(raw, { local = false, provider = local ? 'local' : 'openai' } = {}) {
  const url = parseHttpUrl(raw, { provider, preferHttp: local });
  let path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  if (!path && (local || url.hostname === 'api.openai.com')) path = '/v1';
  return `${url.origin}${path}`;
}

/** The server root Ollama's native API lives at: the base URL without its `/v1`. */
export function ollamaRoot(base) {
  return base.replace(/\/v1$/i, '');
}

// ---------------------------------------------------------------------------------------------------
// Error mapping

const CONTEXT_RE = /context_length|maximum context|context length|context window|exceed_context_size|exceeds the available context|too many tokens|prompt is too long|input is too long|reduce the length of the messages/;
// "billing" alone is not enough: OpenAI's ordinary rate-limit text links to platform.openai.com/account/billing.
const QUOTA_RE = /insufficient_quota|billing_hard_limit|(?<![/\w])billing(?![/\w])|exceeded your current quota|out of credits?|no credits?|payment required/;
const REGION_RE = /unsupported_country|not available in your (country|region)|country, region, or territory/;
const MEMORY_RE = /insufficient memory|failed to allocate|out of memory|requires more system memory|more memory than|cudamalloc|unable to allocate|not enough memory|std::bad_alloc|resource limitations/;
const MODEL_MISSING_RE = /model_not_found|model.{0,80}(not found|does not exist|not exist|is not available)|unknown model|invalid model|no such model|try pulling it first|no endpoints found/;

/**
 * Map an HTTP error from an OpenAI-compatible server (or an error object found inside a 200 stream, with
 * status 0) onto a ProviderError. Understands OpenAI `{error:{message,type,code}}`, Ollama's
 * `{error:"model 'x' not found"}`, llama.cpp's `{error:{code,message,type}}` and FastAPI `{detail}` bodies.
 * @param {object} p
 * @param {number} p.status
 * @param {string} p.text raw response body
 * @param {Headers} [p.headers]
 * @param {{provider: string, secrets?: string[], model?: string, url: string, hasKey?: boolean}} p.ctx
 */
export function mapOpenAIError({ status, text, headers, ctx }) {
  const fail = errorFactory(ctx.provider, ctx.secrets || []);
  const local = ctx.provider === 'local';
  const body = parseErrorBody(text);
  const hay = String(text ?? '').toLowerCase();
  const detail = redactSecrets(body.message, ctx.secrets || []);
  const model = oneLine(ctx.model || 'the selected model', 80);
  const retryAfterMs = retryAfterFromHeaders(headers);
  const base = { status: status || undefined, detail, retryAfterMs };
  const tried = describeUrl(ctx.url);
  const heard = detail ? ` The server said: ${detail}` : '';

  if (status >= 300 && status < 400) {
    const where = headers && headers.get ? headers.get('location') : '';
    let target = '';
    try { target = where ? describeUrl(new URL(where, ctx.url).href) : ''; } catch { /* unparseable Location header */ }
    return fail('bad_base_url', 'The server redirected the request somewhere else.', {
      ...base,
      hint: `${tried} answered with a redirect${target ? ` to ${target}` : ''}. Use that final address as the base URL (for example https:// instead of http://).`,
    });
  }
  if (status === 413 || ([400, 422, 0, 200].includes(status) && CONTEXT_RE.test(hay))) {
    // llama.cpp (and Ollama, which relays it) report both numbers: "request (6063 tokens) exceeds the available
    // context size (4096 tokens)". Saying so tells the user which knob to turn.
    const sizes = body.promptTokens && body.contextTokens
      ? `The prompt needs about ${body.promptTokens} tokens but the model's context window holds ${body.contextTokens}. `
      : '';
    return fail('context_too_long', 'This conversation is too long for the model.', {
      ...base,
      hint: local
        ? `${sizes}Shorten the entry, lower the context budget in Settings, or raise the model's context size (Ollama: set OLLAMA_CONTEXT_LENGTH, e.g. 8192, and restart it; llama.cpp: --ctx-size).`
        : `${sizes}Shorten the entry, lower the context budget in Settings, or choose a model with a longer context window.`,
    });
  }
  if (status === 401 || status === 403) {
    if (status === 403 && REGION_RE.test(hay)) {
      return fail('region', 'This service is not available in your region.', {
        ...base,
        hint: 'Choose another provider (or a local model) in Settings.',
      });
    }
    if (!ctx.hasKey) {
      return fail('auth', local ? 'The local server wants an API key.' : 'The service wants an API key, but none is set.', {
        ...base,
        hint: 'Add the API key in Settings.',
      });
    }
    return fail('auth', 'The API key was rejected.', {
      ...base,
      hint: local
        ? 'Check the API key in Settings against the one your local server expects.'
        : 'Check that the key is copied in full, belongs to this service, and has not been revoked.',
    });
  }
  if (status === 404 || (status === 400 && MODEL_MISSING_RE.test(hay)) || (status === 0 && MODEL_MISSING_RE.test(hay))) {
    const mentionsModel = (ctx.model && hay.includes(String(ctx.model).toLowerCase())) || MODEL_MISSING_RE.test(hay);
    if (mentionsModel) {
      return fail('model_not_found', `The model "${model}" was not found.`, {
        ...base,
        hint: local
          ? `Download it with \`ollama pull ${model}\` (or use Download model in Settings), or pick another model.`
          : 'Use Load models in Settings to see which models this key can use.',
      });
    }
    return fail('bad_base_url', 'The server did not recognise that address.', {
      ...base,
      hint: `${tried} answered "not found". The base URL normally ends in /v1${local ? ' (Ollama: http://localhost:11434/v1)' : ''}; check it in Settings.`,
    });
  }
  if (status === 408) {
    return fail('timeout', 'The server gave up waiting for the request.', { ...base, hint: 'Try again.' });
  }
  if (status === 402 || status === 429 || (status === 0 && /rate.?limit|too many requests/.test(hay))) {
    if (status === 402 || QUOTA_RE.test(hay)) {
      return fail('quota', 'The account is out of credit or quota.', {
        ...base,
        hint: 'Check your plan and billing with the provider, or switch to another provider in Settings.',
      });
    }
    const wait = retryAfterMs !== undefined ? ` Try again in about ${Math.max(1, Math.round(retryAfterMs / 1000))} seconds.` : ' Wait a moment and try again.';
    return fail('rate_limit', 'The service is rate limiting requests.', { ...base, hint: `Too many requests.${wait}` });
  }
  if (status === 0 && QUOTA_RE.test(hay)) {
    return fail('quota', 'The account is out of credit or quota.', {
      ...base,
      hint: 'Check your plan and billing with the provider.',
    });
  }
  if ((status >= 500 || status === 0) && MEMORY_RE.test(hay)) {
    // Verified live (Ollama 0.40.1, a 131072-token window x 16 slots): HTTP 500 {"error":{"message":"llama-server process has
    // terminated: exit status 1: ggml_aligned_malloc: insufficient memory (attempted to allocate 65536.00 MB) ... failed to
    // allocate buffer for kv cache","type":"api_error"}}. The raw text is noise for a journal user; say what to do.
    return fail('server', 'The model does not fit in this computer\'s memory.', {
      ...base,
      hint: local
        ? 'Choose a smaller model (llama3.2:1b needs about 2 GB), or lower the context size (Ollama: OLLAMA_CONTEXT_LENGTH=4096, fewer OLLAMA_NUM_PARALLEL), close other programs, and try again.'
        : 'The service ran out of memory for this request. Try again, or choose a smaller model.',
    });
  }
  if (status >= 500 || status === 0) {
    const loading = /loading model|model is loading|still loading/.test(hay);
    return fail(status === 529 ? 'overloaded' : 'server', `The model server had an internal problem${status ? ` (HTTP ${status})` : ''}.${heard}`, {
      ...base,
      hint: loading || status === 503
        ? 'The server may still be loading the model. Wait a few seconds and try again.'
        : local
          ? 'Check the terminal where your model server runs for the cause, then try again.'
          : 'Try again in a moment; if it keeps failing, check the provider\'s status page.',
    });
  }
  if (status >= 400) {
    if (body.html) {
      return fail('bad_base_url', 'The address answered with a web page, not an AI API.', {
        ...base,
        hint: `${tried} does not look like an OpenAI-compatible endpoint; the base URL normally ends in /v1.`,
      });
    }
    return fail('bad_request', `The server rejected the request (HTTP ${status}).${heard}`, {
      ...base,
      hint: 'Check the model name and settings; a different model may accept it.',
    });
  }
  return fail('unknown', `The server answered with an unexpected status (HTTP ${status}).${heard}`, base);
}

// ---------------------------------------------------------------------------------------------------
// Self-healing

function quirkSignature(q) {
  return `${q.tokenParam}|${q.dropTemperature}|${q.dropStreamOptions}|${Boolean(q.dropReasoningEffort)}`;
}

/**
 * Decide how to rewrite a request after a 400. Returns the changed quirks, or null when the error text does
 * not point at a parameter we can adapt (so we never retry blindly).
 * @param {{tokenParam: string, dropTemperature: boolean, dropStreamOptions: boolean, dropReasoningEffort?: boolean}} quirks
 * @param {string} text raw 400 body
 * @param {{hasTemperature: boolean, hasTokens: boolean, hasStreamOptions: boolean, hasReasoningEffort?: boolean}} used what the failed request contained
 */
export function healQuirks(quirks, text, used) {
  const lower = String(text ?? '').toLowerCase();
  if (!REJECTION_WORDS.test(lower) || CONTEXT_RE.test(lower)) return null;
  const next = { ...quirks };
  if (used.hasTokens && lower.includes(quirks.tokenParam)) {
    next.tokenParam = quirks.tokenParam === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
  }
  if (used.hasTemperature && lower.includes('temperature')) next.dropTemperature = true;
  if (used.hasStreamOptions && lower.includes('stream_options')) next.dropStreamOptions = true;
  // A server that knows the field but not our value ("does not support thinking") names `reasoning_effort`,
  // `reasoning` or `think` in its text; any of them means: stop asking.
  if (used.hasReasoningEffort && /reasoning|think/.test(lower)) next.dropReasoningEffort = true;
  return quirkSignature(next) === quirkSignature(quirks) ? null : next;
}

// ---------------------------------------------------------------------------------------------------
// Adapter

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

/**
 * llama.cpp's llama-server lists the model under the full path of the GGUF file it was started with
 * ("/home/me/models/qwen3-1.7b-q4km.gguf", verified live); show the file name, keep the id as reported.
 */
function modelLabel(modelId) {
  if (/\.gguf$/i.test(modelId) && /[\\/]/.test(modelId)) return modelId.split(/[\\/]/).pop() || modelId;
  return modelId;
}

function parseModelIds(json) {
  const items = Array.isArray(json) ? json
    : Array.isArray(json && json.data) ? json.data
      : Array.isArray(json && json.models) ? json.models
        : null;
  if (!items) return null;
  const ids = new Set();
  for (const item of items) {
    const id = typeof item === 'string' ? item : item && (item.id || item.name || item.model);
    if (typeof id === 'string' && id.trim()) ids.add(id.trim());
  }
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return [...ids].sort((a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, 2000);
}

/**
 * @param {object} rawCfg resolved provider config ({ id: 'openai'|'local', baseUrl, model, apiKey, timeoutMs, ... })
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [opts.sleep] replaceable so tests do not wait
 * @param {number} [opts.idleTimeoutMs] silence allowed between chunks (default 60 s)
 * @param {number} [opts.graceMs] wait after the final chunk for [DONE]/usage (default 5 s)
 * @param {number} [opts.retryFallbackMs] wait before retrying a 429/503 that named no delay (default 1 s)
 * @param {number} [opts.maxOutputChars]
 * @param {ReturnType<typeof createQuirkStore>} [opts.quirks] shared store of learned parameter quirks
 */
export function createOpenAIProvider(rawCfg, opts = {}) {
  const id = rawCfg && rawCfg.id === 'local' ? 'local' : 'openai';
  const cfg = withProviderDefaults(id, rawCfg || {});
  const local = id === 'local';
  const secrets = cfg.apiKey ? [cfg.apiKey] : [];
  const fail = errorFactory(id, secrets);
  const fetchFn = opts.fetch || ((...args) => globalThis.fetch(...args));
  const sleepFn = opts.sleep || sleep;
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const graceMs = opts.graceMs ?? FINISH_GRACE_MS;
  const maxOutputChars = opts.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const store = opts.quirks || quirkStore;
  let quirks = null;

  const resolveBase = () => normalizeBaseUrl(cfg.baseUrl, { local, provider: id });

  function currentQuirks(base) {
    if (!quirks) {
      const host = new URL(base).hostname;
      quirks = {
        tokenParam: host === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens',
        dropTemperature: false,
        dropStreamOptions: false,
        // Only the local provider asks the model not to think (see buildBody); other services never see the field.
        dropReasoningEffort: !local,
        ...(store.get(`${id}|${base}|${cfg.model}`) || {}),
      };
    }
    return quirks;
  }

  function headers(extra) {
    const h = { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...extra };
    if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
    return h;
  }

  const newScope = (signal, url, firstByteMs) => createScope({
    signal,
    firstByteMs,
    idleMs,
    ctx: { provider: id, secrets, url },
  });

  const errorCtx = (url) => ({ provider: id, secrets, model: cfg.model, url, hasKey: Boolean(cfg.apiKey) });

  function emptyError(url, { unterminated, sawReasoning, finishReason, malformed, apiReply, sawText }) {
    if (!apiReply && sawText && !malformed) {
      return notAnApiError(fail, url, `The base URL normally ends in /v1${local ? ' (Ollama: http://localhost:11434/v1)' : ''}.`);
    }
    if (unterminated || sawReasoning) {
      return fail('empty', 'The model only produced hidden reasoning and no answer.', { hint: THINKING_HINT });
    }
    if (finishReason === 'content_filter') {
      return fail('blocked', 'The model declined to answer this one.', {
        hint: 'Journaling about hard things can trip safety filters; rephrase, or switch provider in Settings.',
      });
    }
    if (finishReason === 'length') {
      return fail('empty', 'The reply was cut off before any text appeared.', {
        hint: 'Raise the max tokens setting, or use a model that does not spend tokens on hidden reasoning.',
      });
    }
    if (malformed > 0) {
      return fail('server', 'The server\'s reply could not be read.', {
        hint: 'Check that the base URL points at an OpenAI-compatible API (it normally ends in /v1).',
      });
    }
    return fail('empty', 'The model returned an empty reply.', {
      hint: local ? 'Try again, or try a different model; very small models sometimes return nothing.' : 'Try again in a moment.',
    });
  }

  /** Turn the response body (SSE or a single JSON document) into delta/done events. */
  async function* readReply(response, scope, url, { allowEmpty }) {
    const filter = createThinkFilter();
    const state = { finishReason: null, usage: undefined, sawReasoning: false, emitted: 0, recognized: false };
    const stats = createReplyStats();

    /** Extract the text of one chunk object; throws on an in-band error. */
    function absorb(obj) {
      if (!obj || typeof obj !== 'object') return '';
      if (obj.error) {
        const e = obj.error;
        const status = Number(typeof e === 'object' && e ? e.code : NaN);
        throw mapOpenAIError({
          status: status >= 400 && status < 600 ? status : 0,
          text: JSON.stringify(obj),
          headers: undefined,
          ctx: errorCtx(url),
        });
      }
      if (obj.usage && typeof obj.usage === 'object') {
        const u = obj.usage;
        state.usage = normalizeUsage(u.prompt_tokens, u.completion_tokens, u.total_tokens) || state.usage;
        state.recognized = true;
      }
      if (Array.isArray(obj.choices)) state.recognized = true;
      const choice = Array.isArray(obj.choices) ? obj.choices[0] : undefined;
      if (!choice || typeof choice !== 'object') return '';
      const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : (choice.message || {});
      if (choice.finish_reason) state.finishReason = String(choice.finish_reason);
      const text = contentText(delta.content) || (typeof choice.text === 'string' ? choice.text : '');
      if (!text && (contentText(delta.reasoning_content) || contentText(delta.reasoning))) state.sawReasoning = true;
      return text;
    }

    const events = readJsonEvents(response, scope, { stats, isFinished: () => Boolean(state.finishReason), fail });
    for await (const obj of events) {
      const out = filter.push(absorb(obj));
      if (state.finishReason) scope.setIdle(graceMs);
      if (out) {
        state.emitted += out.length;
        yield { type: 'delta', text: out };
      }
      if (state.emitted > maxOutputChars) {
        state.finishReason = 'length';
        break;
      }
    }

    const tail = filter.end();
    if (tail.text) yield { type: 'delta', text: tail.text };
    // test() accepts a reply without text (a reasoning model may spend all 16 tokens thinking), but only from a
    // server that answered like an API; a web page or other text on a wrong base URL must not pass for one.
    const apiReply = state.recognized || stats.sawDone;
    if (!filter.hasVisibleText && (!allowEmpty || !apiReply)) {
      throw emptyError(url, {
        unterminated: tail.unterminated,
        sawReasoning: state.sawReasoning,
        finishReason: state.finishReason,
        malformed: stats.malformed,
        apiReply,
        sawText: stats.sawText,
      });
    }
    const done = { type: 'done', finishReason: state.finishReason || 'stop' };
    if (state.usage) done.usage = state.usage;
    yield done;
  }

  function buildBody(messages, req, q, useDefaults) {
    const body = { model: cfg.model, messages, stream: true };
    const temperature = req.temperature ?? (useDefaults ? cfg.temperature : undefined);
    if (Number.isFinite(temperature) && !q.dropTemperature) body.temperature = temperature;
    const maxTokens = req.maxTokens ?? (useDefaults ? cfg.maxTokens : undefined);
    if (Number.isFinite(maxTokens) && maxTokens > 0) body[q.tokenParam] = Math.floor(maxTokens);
    if (!q.dropStreamOptions) body.stream_options = { include_usage: true };
    // A journaling reply should not start with seconds of hidden reasoning. Verified live: Ollama 0.40.1 and the
    // llama.cpp server both honour `reasoning_effort: "none"` (qwen3:1.7b answers in ~1.7 s instead of 8-14 s, no
    // token budget burnt on <think>) and ignore it for models that cannot think. A server that rejects it with a
    // 400 is healed by dropping the field (healQuirks).
    if (local && !q.dropReasoningEffort) body.reasoning_effort = 'none';
    return body;
  }

  async function* streamInternal(req, { allowEmpty = false, useDefaults = true } = {}) {
    const messages = prepareMessages(req && req.messages, fail);
    if (!cfg.model) {
      throw fail('bad_request', 'No model name is set.', { hint: 'Choose a model in Settings (use Load models to see what is available).' });
    }
    const base = resolveBase();
    const url = `${base}/chat/completions`;
    // What the adapter has confirmed so far, and this request's private working copy of it. Healing a 400 edits
    // only the copy: another request in flight on this instance has its own body and must judge its own 400
    // from the parameters IT sent. What worked is written back below.
    const known = currentQuirks(base);
    const started = { ...known };
    const q = { ...known };
    const scope = newScope(req.signal, url, req.timeoutMs ?? cfg.timeoutMs);
    const tried = new Set();
    let completed = false;
    try {
      let lastBody = null;
      const { response, adaptations } = await sendWithPolicy({
        fetchFn,
        url,
        scope,
        sleepFn,
        retryFallbackMs: opts.retryFallbackMs,
        // The local provider also sends reasoning_effort, so a strict server may have one more parameter to refuse.
        maxAdaptations: local ? MAX_ADAPTATIONS + 1 : MAX_ADAPTATIONS,
        buildInit: () => {
          lastBody = buildBody(messages, req, q, useDefaults);
          tried.add(quirkSignature(q));
          return { method: 'POST', headers: headers(), body: JSON.stringify(lastBody) };
        },
        mapError: (res, text) => mapOpenAIError({ status: res.status, text, headers: res.headers, ctx: errorCtx(url) }),
        adapt: (status, text) => {
          const next = healQuirks(q, text, {
            hasTemperature: 'temperature' in lastBody,
            hasTokens: q.tokenParam in lastBody,
            hasStreamOptions: 'stream_options' in lastBody,
            hasReasoningEffort: 'reasoning_effort' in lastBody,
          });
          if (!next || tried.has(quirkSignature(next))) return false;
          Object.assign(q, next);
          return true;
        },
      });
      if (adaptations > 0) {
        mergeLearned(known, started, q);
        store.set(`${id}|${base}|${cfg.model}`, { ...known });
      }
      yield* readReply(response, scope, url, { allowEmpty });
      completed = true;
    } finally {
      scope.close(!completed);
    }
  }

  const stream = (req) => streamInternal(req || {});

  async function listModels({ signal } = {}) {
    const base = resolveBase();
    const url = `${base}/models`;
    const scope = newScope(signal, url, Math.min(cfg.timeoutMs, LIST_TIMEOUT_MS));
    try {
      const { response } = await sendWithPolicy({
        fetchFn,
        url,
        scope,
        sleepFn,
        retryFallbackMs: opts.retryFallbackMs,
        buildInit: () => ({ method: 'GET', headers: headers({ Accept: 'application/json' }) }),
        mapError: (res, text) => mapOpenAIError({ status: res.status, text, headers: res.headers, ctx: { ...errorCtx(url), model: '' } }),
      });
      const text = await readText(response, scope);
      let json = null;
      try { json = JSON.parse(text); } catch { /* handled below */ }
      const ids = parseModelIds(json);
      if (!ids) {
        throw fail('bad_base_url', 'The server answered, but not with a list of models.', {
          hint: `${describeUrl(url)} did not return an OpenAI-style model list. The base URL normally ends in /v1; you can also type the model name by hand.`,
        });
      }
      return ids.map((modelId) => ({ id: modelId, label: modelLabel(modelId) }));
    } finally {
      scope.close(true);
    }
  }

  async function test({ signal } = {}) {
    const started = performance.now();
    let sample = '';
    const req = {
      messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
      maxTokens: 16,
      signal,
    };
    for await (const ev of streamInternal(req, { allowEmpty: true, useDefaults: false })) {
      if (ev.type === 'delta') sample += ev.text;
    }
    return {
      ok: true,
      model: cfg.model,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      sample: sample.trim().slice(0, 120),
    };
  }

  return {
    id,
    label: local ? 'Local model' : 'OpenAI-compatible API',
    stream,
    chat: chatFromStream(stream),
    listModels,
    test,
    /** Ollama only: is there an Ollama server at this base URL? */
    isOllama: (o) => isOllama(cfg, { fetch: fetchFn, ...o }),
    /** Ollama only: download a model, yielding progress objects. */
    pullModel: (o) => pullOllamaModel(cfg, { fetch: fetchFn, idleTimeoutMs: opts.idleTimeoutMs, ...o }),
  };
}

// ---------------------------------------------------------------------------------------------------
// Ollama helpers (native API, NOT the OpenAI-compatible one)

function ollamaBase(cfgOrUrl) {
  const raw = typeof cfgOrUrl === 'string' ? cfgOrUrl : cfgOrUrl && cfgOrUrl.baseUrl;
  return ollamaRoot(normalizeBaseUrl(raw, { local: true, provider: 'local' }));
}

/**
 * Is there an Ollama server behind this base URL? (`GET {root}/api/version`, where root is the URL minus `/v1`).
 * Never throws for connection problems; only a caller abort rejects (AbortError).
 * @param {{baseUrl: string, apiKey?: string}|string} cfgOrUrl
 * @param {{fetch?: typeof fetch, signal?: AbortSignal, timeoutMs?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export async function isOllama(cfgOrUrl, opts = {}) {
  let root;
  try {
    root = ollamaBase(cfgOrUrl);
  } catch {
    return false;
  }
  const apiKey = typeof cfgOrUrl === 'object' && cfgOrUrl ? String(cfgOrUrl.apiKey || '') : '';
  const url = `${root}/api/version`;
  const fetchFn = opts.fetch || ((...args) => globalThis.fetch(...args));
  const scope = createScope({
    signal: opts.signal,
    firstByteMs: opts.timeoutMs ?? 5_000,
    ctx: { provider: 'local', secrets: apiKey ? [apiKey] : [], url },
  });
  try {
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await scopedFetch(fetchFn, url, { method: 'GET', headers }, scope);
    if (!res.ok) return false;
    const json = JSON.parse(await readText(res, scope, 64 * 1024, { truncate: true }));
    return Boolean(json) && typeof json.version === 'string';
  } catch (err) {
    if (isAbortError(err)) throw err;
    return false;
  } finally {
    scope.close(true);
  }
}

// How Ollama words a failed download, in the NDJSON `{"error": "..."}` line (HTTP status 200, the stream just ends).
// Verified live (0.40.1): every error starts with "pull model manifest: " even when the manifest request never got
// an answer, e.g.  pull model manifest: Get "https://registry.ollama.ai/v2/library/x/manifests/3b": Forbidden  or
// ...: proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused.  So "manifest" says nothing about the
// model being unknown; only the registry's own "file does not exist" does (assumed from Ollama's source, the
// registry is unreachable from the verification sandbox).
const PULL_UNREACHABLE_RE = /\b(?:Get|Head|Post|Put) "https?:|dial tcp|lookup |no such host|connection (?:refused|reset)|i\/o timeout|timed? ?out|deadline exceeded|proxyconnect|forbidden|proxy|network is unreachable|temporary failure|x509|tls:|certificate|unexpected eof|\beof\b|server misbehaving|too many requests|\b(?:401|403|407|429|50[0-9])\b/i;
const PULL_MISSING_RE = /file does not exist|manifest unknown|name unknown|repository does not exist/i;
const PULL_MISSING_LOOSE_RE = /model not found|not found/i;

/**
 * Map the error text of a failed `/api/pull` onto a ProviderError: registry unreachable (network), unknown model,
 * disk full, too-old Ollama, anything else (server).
 * @param {string} rawMessage
 * @param {string} model
 * @param {string[]} secrets
 */
export function mapPullError(rawMessage, model, secrets = []) {
  const fail = errorFactory('local', secrets);
  const message = oneLine(redactSecrets(String(rawMessage ?? ''), secrets));
  const name = oneLine(model, 80);
  if (/no space left|disk quota|not enough space/i.test(message)) {
    return fail('server', `Ollama ran out of disk space while downloading the model: ${message}`, {
      detail: message,
      hint: 'Free some disk space (models are 1-5 GB) or move the Ollama models folder (OLLAMA_MODELS), then try again.',
    });
  }
  if (/newer version of ollama/i.test(message)) {
    return fail('server', 'This model needs a newer version of Ollama.', {
      detail: message,
      hint: 'Update Ollama from ollama.com/download and try again.',
    });
  }
  const missing = (detail) => fail('model_not_found', `Ollama has no model called "${name}".`, {
    detail,
    hint: 'Check the spelling against the list at ollama.com/library.',
  });
  if (PULL_MISSING_RE.test(message)) return missing(message);
  if (PULL_UNREACHABLE_RE.test(message)) {
    return fail('network', 'Ollama could not reach its model registry (registry.ollama.ai).', {
      detail: message,
      hint: `Check your internet connection (and proxy settings for Ollama), then try again. Without internet, load a model file you already have with \`ollama create\` (a GGUF file and a Modelfile) instead. Ollama said: ${oneLine(message, 220)}`,
    });
  }
  if (PULL_MISSING_LOOSE_RE.test(message)) return missing(message);
  return fail('server', `Ollama could not download the model: ${message || 'unknown error'}`, {
    detail: message,
    hint: 'Check free disk space and your internet connection, then try again.',
  });
}

// Ollama names look like `llama3.2:3b` or `hf.co/user/repo:Q4_K_M`; no spaces, no path tricks.
const MODEL_NAME_RE = /^(?!.*\.\.)(?!\/)[\w.:/@+-]{1,200}$/;

/**
 * Download a model through Ollama's native `POST {root}/api/pull` (NDJSON). Yields
 * `{ status, completed?, total?, percent?, digest? }` objects and ends after Ollama reports `success`.
 * @param {{baseUrl: string, apiKey?: string}|string} cfgOrUrl
 * @param {{model: string, signal?: AbortSignal, fetch?: typeof fetch, timeoutMs?: number, idleTimeoutMs?: number}} opts
 * @returns {AsyncGenerator<{status: string, completed?: number, total?: number, percent?: number, digest?: string}>}
 */
export async function* pullOllamaModel(cfgOrUrl, opts = {}) {
  const fail = errorFactory('local', []);
  const model = typeof opts.model === 'string' ? opts.model.trim() : '';
  if (!MODEL_NAME_RE.test(model)) {
    throw fail('bad_request', 'That does not look like a valid model name.', { hint: 'Examples: llama3.2:3b, qwen2.5:1.5b, gemma2:2b.' });
  }
  const root = ollamaBase(cfgOrUrl);
  const apiKey = typeof cfgOrUrl === 'object' && cfgOrUrl ? String(cfgOrUrl.apiKey || '') : '';
  const secrets = apiKey ? [apiKey] : [];
  const url = `${root}/api/pull`;
  const fetchFn = opts.fetch || ((...args) => globalThis.fetch(...args));
  const scope = createScope({
    signal: opts.signal,
    firstByteMs: opts.timeoutMs ?? 120_000,
    idleMs: opts.idleTimeoutMs ?? 120_000,
    ctx: { provider: 'local', secrets, url },
  });
  let completed = false;
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await scopedFetch(fetchFn, url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, name: model, stream: true }),
    }, scope);
    if (!res.ok) {
      const text = await readText(res, scope, 64 * 1024, { truncate: true }).catch((e) => {
        if (isAbortError(e)) throw e;
        return '';
      });
      throw mapOpenAIError({ status: res.status, text, headers: res.headers, ctx: { provider: 'local', secrets, model, url, hasKey: Boolean(apiKey) } });
    }
    let succeeded = false;
    for await (const line of iterateNdjson(readChunks(res, scope))) {
      if (!line || typeof line !== 'object') continue;
      if (line.error) {
        throw mapPullError(typeof line.error === 'string' ? line.error : (line.error && line.error.message) || '', model, secrets);
      }
      const progress = { status: typeof line.status === 'string' ? line.status : '' };
      if (typeof line.digest === 'string') progress.digest = line.digest;
      if (Number.isFinite(line.total) && line.total > 0) {
        progress.total = line.total;
        if (Number.isFinite(line.completed)) {
          progress.completed = line.completed;
          progress.percent = Math.max(0, Math.min(100, Math.floor((line.completed / line.total) * 100)));
        }
      }
      if (progress.status === 'success') {
        succeeded = true;
        progress.percent = 100;
      }
      yield progress;
      if (succeeded) break;
    }
    if (!succeeded) {
      throw errorFactory('local', secrets)('network', 'The download stopped before it finished.', {
        hint: 'Run it again; Ollama resumes where it left off.',
      });
    }
    completed = true;
  } finally {
    scope.close(!completed);
  }
}
