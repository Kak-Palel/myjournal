// Google Gemini native REST adapter (generativelanguage.googleapis.com). Contract: docs/ARCHITECTURE.md §9.
// The API key is sent ONLY in the `x-goog-api-key` header, never in the URL.

import { errorFactory, redactSecrets } from './errors.js';
import {
  DEFAULT_IDLE_MS, createScope, describeUrl, oneLine, parseErrorBody, parseHttpUrl, readText,
  retryAfterFromHeaders, sleep,
} from './http.js';
import { createThinkFilter } from './think-filter.js';
import { withProviderDefaults } from './config.js';
import {
  MAX_OUTPUT_CHARS, chatFromStream, createQuirkStore, createReplyStats, mergeLearned, normalizeUsage, notAnApiError,
  prepareMessages, readJsonEvents, sendWithPolicy,
} from './common.js';

const LIST_TIMEOUT_MS = 30_000;
const MAX_MODEL_PAGES = 5;
// At most one thinking adaptation and one system-instruction adaptation per call.
const MAX_ADAPTATIONS = 2;
const FINISH_GRACE_MS = 5_000;
const KEY_URL = 'https://aistudio.google.com/apikey';
/** Thought tokens count against maxOutputTokens (live: 189 of 200 spent thinking), so every request gets this much extra room. */
const THOUGHT_HEADROOM_TOKENS = 2048;
const MAX_OUTPUT_TOKENS_CAP = 8192;

/** What we learned about a model from 400 responses; shared by adapter instances. */
const quirkStore = createQuirkStore();

/** Forget everything learned about models (tests). */
export function clearGeminiQuirks() {
  quirkStore.clear();
}

const BLOCKING_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'RECITATION']);
// models.list returns dozens of ids that are not chat models, and retired models that 404 (those are handled at
// request time). Allow-list first, then drop the known non-chat families (docs/ARCHITECTURE.md, live-verified item 4).
const MODEL_ALLOW = /^(gemini|gemma)-/;
const MODEL_EXCLUDE = /embed|aqa|imagen|veo|tts|image|banana|live|audio|transcribe|omni|robotics|computer-use|customtools|learnlm|lyria/;

// ---------------------------------------------------------------------------------------------------
// Request building

/**
 * Normalise the base URL: origin plus an optional proxy path, without a trailing slash and without a pasted
 * `/v1beta` (or `/v1`, `/v1beta/models`) suffix.
 * @param {string} raw
 * @returns {string}
 * @throws {ProviderError} bad_base_url
 */
export function normalizeGeminiBase(raw) {
  const url = parseHttpUrl(raw, { provider: 'gemini' });
  const path = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/v1(beta)?(\/models)?$/i, '')
    .replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** `models/gemini-x` -> `gemini-x` */
export function bareModelId(model) {
  return String(model || '').trim().replace(/^models\//, '');
}

/**
 * Convert chat messages into Gemini's shape: system messages become `systemInstruction` (or, for models that
 * reject it, are folded into the first turn), roles are mapped, and consecutive same-role turns are merged.
 * A conversation may start with a model turn (a guided-journal opening prompt): the live API accepts that, so no
 * stand-in turn is invented. A conversation that ENDS with a model turn is rejected by the API, so callers must
 * check `contents.at(-1).role` before sending. With `foldSystem` the system text goes into the first user turn
 * (a new one in front if the conversation opens with a model turn).
 * @param {{role: string, content: string}[]} messages
 * @param {{foldSystem?: boolean}} [opts]
 * @returns {{systemInstruction?: object, contents: {role: 'user'|'model', parts: {text: string}[]}[]}}
 */
export function buildGeminiContents(messages, { foldSystem = false } = {}) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join('\n\n');
  const turns = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text += `\n\n${m.content}`;
    else turns.push({ role, text: m.content });
  }
  if (foldSystem && system && turns.length) {
    // The instructions have nowhere else to live, so they ride along in the first user turn.
    if (turns[0].role === 'user') turns[0].text = `${system}\n\n${turns[0].text}`;
    else turns.unshift({ role: 'user', text: system });
  }
  const out = { contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })) };
  if (system && !foldSystem) out.systemInstruction = { parts: [{ text: system }] };
  return out;
}

/**
 * The `thinkingConfig` values to try, best first; `null` means "send none".
 *  - `auto` (default): never send one.
 *  - `low`: `{ thinkingLevel: 'low' }` (accepted by 3.x models), then none if the API objects.
 * `thinkingBudget: 0` and `thinkingLevel: 'minimal'` are never sent: the live API rejects them on current models
 * (docs/ARCHITECTURE.md, live-verified item 2).
 * @param {'auto'|'low'} mode
 * @returns {(object|null)[]}
 */
export function thinkingCandidates(mode) {
  return mode === 'low' ? [{ thinkingLevel: 'low' }, null] : [null];
}

/**
 * maxOutputTokens to send: the requested cap plus room for thoughts (never below the request, at most 8192).
 * @param {number|undefined} requested
 * @returns {number|undefined}
 */
export function outputTokenLimit(requested) {
  if (!Number.isFinite(requested) || requested <= 0) return undefined;
  const wanted = Math.floor(requested);
  return Math.max(wanted, Math.min(MAX_OUTPUT_TOKENS_CAP, wanted + THOUGHT_HEADROOM_TOKENS));
}

// ---------------------------------------------------------------------------------------------------
// Error mapping

function parseGoogleDuration(value) {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(value ?? '').trim());
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

/** Pull the structured parts out of a Google error body. */
function googleErrorInfo(text) {
  let raw = String(text ?? '').trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed[0]) raw = JSON.stringify(parsed[0]); // streamed errors come as [{error}]
  } catch { /* not JSON */ }
  const body = parseErrorBody(raw);
  const err = body.json && typeof body.json.error === 'object' && body.json.error ? body.json.error : {};
  const details = Array.isArray(err.details) ? err.details : [];
  const byType = (suffix) => details.filter((d) => d && typeof d['@type'] === 'string' && d['@type'].endsWith(suffix));
  const info = byType('ErrorInfo')[0] || {};
  const retry = byType('RetryInfo')[0] || {};
  const quotaIds = byType('QuotaFailure')
    .flatMap((d) => (Array.isArray(d.violations) ? d.violations : []))
    .map((v) => String((v && (v.quotaId || v.quotaMetric)) || ''));
  return {
    body,
    message: body.message,
    status: typeof err.status === 'string' ? err.status.toUpperCase() : '',
    reason: typeof info.reason === 'string' ? info.reason : '',
    retryDelayMs: parseGoogleDuration(retry.retryDelay),
    quotaIds,
  };
}

/**
 * Map a Gemini HTTP error (or an `error` object found inside a 200 stream, with status = its `code`) onto a
 * ProviderError. Verified against the live service: an invalid key is HTTP 400 with reason API_KEY_INVALID,
 * a missing key is HTTP 403 PERMISSION_DENIED "Method doesn't allow unregistered callers".
 * @param {object} p
 * @param {number} p.status
 * @param {string} p.text
 * @param {Headers} [p.headers]
 * @param {{secrets?: string[], model?: string, url: string}} p.ctx
 */
export function mapGeminiError({ status, text, headers, ctx }) {
  const fail = errorFactory('gemini', ctx.secrets || []);
  const info = googleErrorInfo(text);
  const message = redactSecrets(info.message, ctx.secrets || []);
  const hay = `${message} ${info.reason} ${info.status}`.toLowerCase();
  const retryAfterMs = info.retryDelayMs ?? retryAfterFromHeaders(headers);
  const base = { status: status || undefined, detail: message, retryAfterMs };
  const heard = message ? ` Google said: ${message}` : '';
  const model = oneLine(bareModelId(ctx.model) || 'the selected model', 80);
  const tried = describeUrl(ctx.url);

  if (status >= 300 && status < 400) {
    return fail('bad_base_url', 'The server redirected the request somewhere else.', {
      ...base,
      hint: `${tried} answered with a redirect. Use the final address as the base URL.`,
    });
  }
  const restricted = /^API_KEY_(HTTP_REFERRER|IP_ADDRESS|ANDROID_APP|IOS_APP|SERVICE)_BLOCKED$/.test(info.reason);
  if (restricted) {
    return fail('auth', 'This Gemini API key has restrictions that block MyJournal.', {
      ...base,
      hint: `Create a key without application or IP restrictions at ${KEY_URL} and paste it in Settings.`,
    });
  }
  if (info.reason === 'API_KEY_INVALID' || /api key not valid|api key expired|invalid api key|api_key_invalid/.test(hay)) {
    return fail('auth', 'Gemini rejected the API key.', {
      ...base,
      hint: `Copy a fresh key from ${KEY_URL} and paste it in Settings (check for stray spaces).`,
    });
  }
  if (info.reason === 'SERVICE_DISABLED' || /has not been used in project|api has not been enabled|is disabled/.test(hay)) {
    return fail('auth', 'The Gemini API is not enabled for this key\'s Google project.', {
      ...base,
      hint: `Create a new key at ${KEY_URL}, which sets the project up for you, or enable the Generative Language API in Google Cloud.`,
    });
  }
  if (/unregistered callers|callers without established identity/.test(hay)) {
    return fail('auth', 'Gemini needs an API key.', {
      ...base,
      hint: `Gemini says no API key was sent. Paste your key in Settings (a free one is at ${KEY_URL}).`,
    });
  }
  if ((info.status === 'FAILED_PRECONDITION' && /location|country|region|billing|free tier/.test(hay))
    || /user location is not supported|not available in your (country|region)|location is not supported/.test(hay)) {
    return fail('region', 'Gemini is not available in your region.', {
      ...base,
      hint: 'The free tier is not offered everywhere. Enable billing for your Google project, or choose another provider in Settings.',
    });
  }
  if (status === 401 || status === 403 || info.status === 'UNAUTHENTICATED' || info.status === 'PERMISSION_DENIED') {
    return fail('auth', 'Gemini did not accept this API key for that request.', {
      ...base,
      hint: `Check the key in Settings (a free one is at ${KEY_URL}) and that it may use this model.${heard}`,
    });
  }
  if (status === 429 || info.status === 'RESOURCE_EXHAUSTED') {
    const daily = info.quotaIds.some((id) => /perday/i.test(id)) || /per day|daily|per-day/.test(hay);
    const zero = /limit: 0\b/.test(message);
    const minuteOnly = info.quotaIds.length > 0 && info.quotaIds.every((id) => /perminute/i.test(id));
    // `limit: 0` means this model has no free quota at all, so waiting a minute can never help.
    if (zero || (daily && !minuteOnly)) {
      return fail('quota', zero ? 'This model has no free quota for your key.' : 'The free daily limit for this model is used up.', {
        ...base,
        hint: 'Try again tomorrow (free quotas reset daily), choose another model such as gemini-flash-lite-latest, or enable billing for your Google project.',
      });
    }
    const secs = retryAfterMs !== undefined ? Math.max(1, Math.round(retryAfterMs / 1000)) : null;
    return fail('rate_limit', 'Gemini\'s free-tier rate limit was reached.', {
      ...base,
      hint: secs ? `Wait about ${secs} seconds and try again.` : 'Wait a minute and try again.',
    });
  }
  if (status === 404 || info.status === 'NOT_FOUND') {
    if (/no longer available/.test(hay)) {
      const suggestion = /use models\/([\w.-]+)/i.exec(message);
      return fail('model_not_found', `Gemini has retired "${model}".`, {
        ...base,
        hint: suggestion
          ? `Google suggests ${suggestion[1]} — pick a model from Load models in Settings.`
          : 'Pick a current model from Load models in Settings.',
      });
    }
    if (info.status === 'NOT_FOUND' || /models?\/|model/.test(hay)) {
      return fail('model_not_found', `Gemini has no model called "${model}" for this API.`, {
        ...base,
        hint: 'Open Settings and use Load models to pick one from the list.',
      });
    }
    return fail('bad_base_url', 'The server did not recognise that address.', {
      ...base,
      hint: `${tried} answered "not found". The Gemini base URL is normally https://generativelanguage.googleapis.com.`,
    });
  }
  if (status === 503 || info.status === 'UNAVAILABLE') {
    return fail('overloaded', 'Gemini is overloaded right now.', {
      ...base,
      hint: 'This is usually brief. Try again in a moment, or switch to gemini-flash-lite-latest in Settings.',
    });
  }
  if (status === 413 || (status === 400 && /token count|maximum number of tokens|too many tokens|input.{0,20}too long|exceeds the maximum/.test(hay))) {
    return fail('context_too_long', 'This conversation is too long for the model.', {
      ...base,
      hint: 'Shorten the entry or lower the context budget in Settings.',
    });
  }
  if (status >= 500 || info.status === 'INTERNAL' || info.status === 'DEADLINE_EXCEEDED') {
    return fail('server', `Gemini had an internal problem${status ? ` (HTTP ${status})` : ''}.`, {
      ...base,
      hint: 'Try again in a moment; if it keeps failing, check the Google AI status page.',
    });
  }
  if (status >= 400 || info.status === 'INVALID_ARGUMENT') {
    if (info.body.html) {
      return fail('bad_base_url', 'The address answered with a web page, not the Gemini API.', {
        ...base,
        hint: `${tried} does not look like the Gemini API.`,
      });
    }
    return fail('bad_request', `Gemini rejected the request${status ? ` (HTTP ${status})` : ''}.${heard}`, {
      ...base,
      hint: 'Check the model name in Settings; another model may accept it.',
    });
  }
  return fail('unknown', `Gemini answered with an unexpected status (HTTP ${status}).${heard}`, base);
}

// ---------------------------------------------------------------------------------------------------
// Adapter

function normalizeFinish(reason) {
  const r = String(reason || '').toUpperCase();
  if (!r || r === 'STOP' || r === 'FINISH_REASON_UNSPECIFIED') return 'stop';
  if (r === 'MAX_TOKENS') return 'length';
  if (BLOCKING_FINISH.has(r)) return 'content_filter';
  return r.toLowerCase();
}

/**
 * @param {object} rawCfg resolved config ({ baseUrl, model, apiKey, thinking, timeoutMs, temperature?, maxTokens? })
 * @param {object} [opts] same knobs as createOpenAIProvider
 */
export function createGeminiProvider(rawCfg, opts = {}) {
  const cfg = withProviderDefaults('gemini', rawCfg || {});
  const secrets = cfg.apiKey ? [cfg.apiKey] : [];
  const fail = errorFactory('gemini', secrets);
  const fetchFn = opts.fetch || ((...args) => globalThis.fetch(...args));
  const sleepFn = opts.sleep || sleep;
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const graceMs = opts.graceMs ?? FINISH_GRACE_MS;
  const maxOutputChars = opts.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const store = opts.quirks || quirkStore;
  const mode = cfg.thinking === 'low' ? 'low' : 'auto';
  let learned = null;

  const headers = (extra) => {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (cfg.apiKey) h['x-goog-api-key'] = cfg.apiKey;
    return h;
  };
  const newScope = (signal, url, firstByteMs) => createScope({
    signal, firstByteMs, idleMs, ctx: { provider: 'gemini', secrets, url },
  });
  const errorCtx = (url) => ({ secrets, model: cfg.model, url });
  const quirkKey = (base) => `gemini|${base}|${bareModelId(cfg.model)}|${mode}`;

  function modelUrl(base, method, query = '') {
    return `${base}/v1beta/models/${encodeURIComponent(bareModelId(cfg.model))}:${method}${query}`;
  }

  function emptyError(url, { blockReason, finishReason, sawThought, recognized }, sawText) {
    if (!recognized && sawText) {
      return notAnApiError(fail, url, 'The Gemini base URL is normally https://generativelanguage.googleapis.com.');
    }
    const blocked = blockReason || (BLOCKING_FINISH.has(finishReason) ? finishReason : '');
    if (blocked) {
      return fail('blocked', 'Gemini declined to answer this one.', {
        detail: `blocked: ${blocked}`,
        hint: 'Journaling about hard things can trip safety filters. Try rephrasing, or switch to another provider in Settings.',
      });
    }
    if (finishReason === 'MAX_TOKENS' || sawThought) {
      return fail('empty', 'Gemini used its whole token budget thinking and wrote no answer.', {
        hint: 'Raise max tokens in Settings, or set Gemini thinking to "low"; thinking models spend part of the budget on thoughts.',
      });
    }
    return fail('empty', 'Gemini returned an empty reply.', { hint: 'Try again, or pick another model in Settings.' });
  }

  async function* readReply(response, scope, url, { allowEmpty }) {
    const filter = createThinkFilter();
    const state = { finishReason: '', blockReason: '', usage: undefined, sawThought: false, emitted: 0, recognized: false };
    const stats = createReplyStats();

    function absorb(obj) {
      if (!obj || typeof obj !== 'object') return '';
      if (obj.error) {
        const code = Number(typeof obj.error === 'object' && obj.error ? obj.error.code : NaN);
        throw mapGeminiError({ status: code >= 400 && code < 600 ? code : 500, text: JSON.stringify(obj), ctx: errorCtx(url) });
      }
      const meta = obj.usageMetadata;
      if (meta && typeof meta === 'object') {
        state.recognized = true;
        const usage = normalizeUsage(meta.promptTokenCount, meta.candidatesTokenCount, meta.totalTokenCount);
        if (usage) state.usage = usage;
      }
      const feedback = obj.promptFeedback;
      if (feedback && typeof feedback === 'object') {
        state.recognized = true;
        if (feedback.blockReason) state.blockReason = String(feedback.blockReason);
      }
      if (Array.isArray(obj.candidates)) state.recognized = true;
      const cand = Array.isArray(obj.candidates) ? obj.candidates[0] : undefined;
      if (!cand || typeof cand !== 'object') return '';
      if (cand.finishReason) state.finishReason = String(cand.finishReason).toUpperCase();
      const parts = cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
      let text = '';
      for (const part of parts) {
        if (!part || typeof part.text !== 'string') continue;
        if (part.thought === true) state.sawThought = true;
        else text += part.text;
      }
      return text;
    }

    const events = readJsonEvents(response, scope, { stats, isFinished: () => Boolean(state.finishReason), fail });
    for await (const obj of events) {
      const out = filter.push(absorb(obj));
      if (state.blockReason && !filter.hasVisibleText && !state.emitted) {
        // The whole prompt was refused; there is nothing more to wait for.
        throw emptyError(url, state, stats.sawText);
      }
      if (state.finishReason) scope.setIdle(graceMs);
      if (out) {
        state.emitted += out.length;
        yield { type: 'delta', text: out };
      }
      if (state.emitted > maxOutputChars) {
        state.finishReason = 'MAX_TOKENS';
        break;
      }
    }

    const tail = filter.end();
    if (tail.text) yield { type: 'delta', text: tail.text };
    if (!filter.hasVisibleText) {
      // As in the OpenAI adapter: an empty reply only counts for test() when the server answered like the API.
      const blocked = state.blockReason || BLOCKING_FINISH.has(state.finishReason);
      if (blocked || !allowEmpty || !state.recognized) throw emptyError(url, state, stats.sawText);
    }
    const done = { type: 'done', finishReason: normalizeFinish(state.finishReason) };
    if (state.usage) done.usage = state.usage;
    yield done;
  }

  async function* streamInternal(req, { allowEmpty = false, useDefaults = true } = {}) {
    const messages = prepareMessages(req && req.messages, fail);
    if (!bareModelId(cfg.model)) {
      throw fail('bad_request', 'No model name is set.', { hint: 'Choose a model in Settings (use Load models to see what is available).' });
    }
    // The API rejects a request that ends with a model turn; there is nothing to reply to, so do not even ask.
    const probe = buildGeminiContents(messages);
    if (probe.contents[probe.contents.length - 1].role === 'model') {
      throw fail('bad_request', 'There is nothing to reply to yet.', { hint: 'Write something first, then ask for a reply.' });
    }
    const base = normalizeGeminiBase(cfg.baseUrl);
    const url = modelUrl(base, 'streamGenerateContent', '?alt=sse');
    const candidates = thinkingCandidates(mode);
    if (!learned) learned = { thinkingIdx: 0, foldSystem: false, ...(store.get(quirkKey(base)) || {}) };
    // `learned` is what the adapter has confirmed; this request adapts its own copy (see openai.js for why) and
    // writes back what worked.
    const started = { ...learned };
    const q = { ...learned };
    const scope = newScope(req.signal, url, req.timeoutMs ?? cfg.timeoutMs);
    const temperature = req.temperature ?? (useDefaults ? cfg.temperature : undefined);
    const maxOutputTokens = outputTokenLimit(req.maxTokens ?? (useDefaults ? cfg.maxTokens : undefined));
    let completed = false;
    try {
      const { response, adaptations } = await sendWithPolicy({
        fetchFn,
        url,
        scope,
        sleepFn,
        maxAdaptations: MAX_ADAPTATIONS,
        retryFallbackMs: opts.retryFallbackMs,
        buildInit: () => {
          const { systemInstruction, contents } = buildGeminiContents(messages, { foldSystem: q.foldSystem });
          const generationConfig = {};
          if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
          if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;
          const thinking = candidates[Math.min(q.thinkingIdx, candidates.length - 1)];
          if (thinking) generationConfig.thinkingConfig = thinking;
          const body = { contents, generationConfig };
          if (systemInstruction) body.systemInstruction = systemInstruction;
          return { method: 'POST', headers: headers({ Accept: 'text/event-stream' }), body: JSON.stringify(body) };
        },
        mapError: (res, text) => mapGeminiError({ status: res.status, text, headers: res.headers, ctx: errorCtx(url) }),
        adapt: (status, text) => {
          const lower = String(text).toLowerCase();
          // Models that do not know thinkingLevel say so, or answer a bare "Request contains an invalid argument."
          const sentThinking = candidates[Math.min(q.thinkingIdx, candidates.length - 1)] !== null;
          const aboutThinking = /thinking/.test(lower) || /request contains an invalid argument/.test(lower);
          if (sentThinking && aboutThinking && q.thinkingIdx < candidates.length - 1) {
            q.thinkingIdx += 1;
            return true;
          }
          if (/developer instruction|system instruction|systeminstruction|system_instruction/.test(lower) && !q.foldSystem) {
            q.foldSystem = true;
            return true;
          }
          return false;
        },
      });
      if (adaptations > 0) {
        mergeLearned(learned, started, q);
        store.set(quirkKey(base), { ...learned });
      }
      yield* readReply(response, scope, url, { allowEmpty });
      completed = true;
    } finally {
      scope.close(!completed);
    }
  }

  const stream = (req) => streamInternal(req || {});

  async function listModels({ signal } = {}) {
    const base = normalizeGeminiBase(cfg.baseUrl);
    const found = new Map();
    let pageToken = '';
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const query = `?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const url = `${base}/v1beta/models${query}`;
      const scope = newScope(signal, url, Math.min(cfg.timeoutMs, LIST_TIMEOUT_MS));
      let json = null;
      try {
        const { response } = await sendWithPolicy({
          fetchFn,
          url,
          scope,
          sleepFn,
          retryFallbackMs: opts.retryFallbackMs,
          buildInit: () => ({ method: 'GET', headers: headers({ Accept: 'application/json' }) }),
          mapError: (res, text) => mapGeminiError({ status: res.status, text, headers: res.headers, ctx: { ...errorCtx(url), model: '' } }),
        });
        try { json = JSON.parse(await readText(response, scope)); } catch { json = null; }
      } finally {
        scope.close(true);
      }
      if (!json || typeof json !== 'object' || !Array.isArray(json.models)) {
        throw fail('bad_base_url', 'The server answered, but not with a Gemini model list.', {
          hint: `${describeUrl(url)} did not return a model list. The Gemini base URL is normally https://generativelanguage.googleapis.com.`,
        });
      }
      for (const m of json.models) {
        if (!m || typeof m.name !== 'string') continue;
        const id = bareModelId(m.name);
        const lower = id.toLowerCase();
        if (!id || !MODEL_ALLOW.test(lower) || MODEL_EXCLUDE.test(lower)) continue;
        const methods = m.supportedGenerationMethods;
        if (Array.isArray(methods) && !methods.includes('generateContent')) continue;
        if (!found.has(id)) found.set(id, { id, label: typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName.trim() : id });
      }
      pageToken = typeof json.nextPageToken === 'string' ? json.nextPageToken : '';
      if (!pageToken) break;
    }
    return sortGeminiModels([...found.values()]);
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
      model: bareModelId(cfg.model),
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      sample: sample.trim().slice(0, 120),
    };
  }

  return { id: 'gemini', label: 'Gemini', stream, chat: chatFromStream(stream), listModels, test };
}

/**
 * `*-latest` aliases first (alphabetically, so flash comes before pro), then everything else with the
 * highest id first (newest versions on top).
 * @param {{id: string, label: string}[]} models
 */
export function sortGeminiModels(models) {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const alias = (m) => m.id.endsWith('-latest');
  return [...models].sort((a, b) => {
    if (alias(a) !== alias(b)) return alias(a) ? -1 : 1;
    const cmp = collator.compare(a.id, b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return alias(a) ? cmp : -cmp;
  });
}
