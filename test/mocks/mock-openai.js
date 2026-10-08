// Mock OpenAI-compatible server (+ a minimal Ollama API) for tests and manual UI trials.
//
//   const mock = await createMockOpenAI({ replies: ['Hello there!'] });
//   // point a provider at  mock.baseUrl  (= `${mock.url}/v1`);  mock.url is the bare origin.
//   ...
//   await mock.close();
//
// Realistic by design: SSE chunks cut inside words, a role-only first delta, occasional empty deltas, a
// finish_reason chunk, a usage chunk (only when stream_options.include_usage is set), `[DONE]`, and socket
// writes that are sliced at arbitrary byte offsets (inside multi-byte UTF-8 characters, between CR and LF).
// Both `/v1/...` and bare `/...` paths are served. See `DEFAULTS` for every option; change any of them
// at runtime with `mock.setBehavior({...})`.

import { allUserText, respond, splitIntoDeltas } from './mock-responder.js';
import { sendJson, sendText, startMockServer } from './mock-server.js';

export const DEFAULTS = Object.freeze({
  /** Scripted replies for chat requests, consumed in order (see `resolveReply`). Exhausted => deterministic responder. */
  replies: [],
  /** Delay between SSE frames, ms. */
  delayMs: 0,
  /** Delay before the first byte of a chat response, ms. */
  ttfbMs: 0,
  /** Fixed characters per delta; default is a 1-6 character cycle. */
  chunkSize: 0,
  /** Slice socket writes at arbitrary byte offsets. */
  byteSplit: true,
  /** Allow deltas to cut surrogate pairs (lone surrogates). */
  splitCodePoints: false,
  /** Put the first delta as `{role}` only (true) or `{role, content: ""}` (false). */
  roleOnly: false,
  /** Sprinkle empty deltas into the stream. */
  emptyDeltas: true,
  /** `data:{...}` without the space. */
  noSpaceAfterData: false,
  /** Use CRLF line endings. */
  crlf: false,
  /** Interleave `: keep-alive` comment frames. */
  keepAlive: false,
  /** Do not send `[DONE]` (and keep the socket open afterwards). */
  omitDone: false,
  /** Text for a `<think>` block put in front of every reply (true => a default thought). */
  think: false,
  /** Text sent as `delta.reasoning_content` before the answer (true => a default thought). */
  reasoningContent: false,
  /** 'requested' (only with stream_options.include_usage, like OpenAI) | 'always' | 'never'. */
  usage: 'requested',
  /** Models listed by GET /models and /api/tags. */
  models: ['llama3.2:3b', 'mock-model', 'gpt-4o-mini'],
  /** When true, chat requests for a model not in `models` get a 404 model-not-found. */
  strictModel: false,
  /** Error body flavour: 'openai' | 'ollama' (string error) | 'llamacpp'. */
  errorStyle: 'openai',
  /** Required bearer token (string or array). Unset => no auth. */
  apiKey: undefined,
  /** Request body params the server refuses with a 400, e.g. ['max_tokens', 'temperature', 'stream_options']. */
  rejectParams: [],
  /** Failure queue (array: one entry per chat request), persistent failure (string/object) or function. */
  failures: [],
  /** Same shapes as `failures` but for GET /models. */
  modelsFailures: [],
  /** GET /models body flavour: 'openai' | 'llamacpp' | 'array' | 'models-key'. */
  modelsStyle: 'openai',
  /** Serve the Ollama endpoints (/api/version, /api/tags, /api/pull). */
  ollama: true,
  ollamaVersion: '0.5.7-mock',
  /** Ollama pull behaviour. */
  pull: { delayMs: 0, steps: 4, fail: false, failMidway: false, truncate: false },
});

const DEFAULT_THOUGHT = 'The user wants a short answer. Let me consider what to say. I should be kind.';

function matches(value, candidates) {
  return Array.isArray(candidates) ? candidates.includes(value) : value === candidates;
}

/** Error body in the configured flavour. */
export function errorBody(style, { message, type = 'invalid_request_error', code = null, param = null, status = 400 }) {
  if (style === 'ollama') return { error: message };
  if (style === 'llamacpp') return { error: { code: status, message, type } };
  return { error: { message, type, param, code } };
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

/**
 * Failure kinds (use in `failures`, as a string, `{ kind, ...params }` or `{ status, ... }`; common aliases such as
 * '401', '429', 'auth', 'timeout' work, and an unknown kind answers 500 "mock crashed" so typos fail loudly):
 *   unauthorized (401) · echo_key (401 that repeats the received key) · forbidden (403) · model_not_found (404, `model`) · not_found (404 plain text, wrong URL) ·
 *   rate_limit (429 + retry-after, `retryAfter` seconds) · quota (429 insufficient_quota) · context_length (400) ·
 *   bad_request (400) · server_error (500) · unavailable (503) · html (502 web page) · redirect (301) ·
 *   http (`status`, `body`, `headers`) · hang (no response at all) · hang_after_headers · reset_before_response ·
 *   stall (`after` deltas, then silence) · reset (`after` deltas, then the socket dies) · malformed (`after`) ·
 *   malformed_only · error_in_stream (`after`) · json (JSON instead of SSE) · json_no_type · empty · think_only ·
 *   no_done · content_filter · length_empty · reasoning_only
 */
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

const KIND_BY_STATUS = { 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'model_not_found', 429: 'rate_limit', 500: 'server_error', 503: 'unavailable' };
const KIND_ALIASES = {
  auth: 'unauthorized', 401: 'unauthorized', 403: 'forbidden', 404: 'model_not_found', model: 'model_not_found', model_404: 'model_not_found',
  429: 'rate_limit', ratelimit: 'rate_limit', 400: 'bad_request', 500: 'server_error', server: 'server_error', error: 'server_error',
  503: 'unavailable', overloaded: 'unavailable', timeout: 'hang', never: 'hang', malformed_chunk: 'malformed', garbage: 'malformed_only',
  reset_mid_stream: 'reset', disconnect: 'reset',
};
/** Kinds handled while streaming or by altering the reply (not by an up-front HTTP error). */
const STREAM_KINDS = new Set(['hang', 'reset_before_response', 'hang_after_headers', 'stall', 'reset', 'malformed', 'malformed_only', 'error_in_stream',
  'json', 'json_no_type', 'empty', 'think_only', 'reasoning_only', 'content_filter', 'length_empty', 'no_done']);

/** Accepts 'kind', { kind, ... } or { status, ... } (`retry_after` works for `retryAfter`). */
function normalizeSpec(spec) {
  if (!spec) return null;
  const s = typeof spec === 'string' ? { kind: spec } : { ...spec };
  if (s.retry_after !== undefined && s.retryAfter === undefined) s.retryAfter = s.retry_after;
  if (!s.kind && s.status) s.kind = KIND_BY_STATUS[s.status] || 'http';
  if (s.kind) {
    const k = String(s.kind).toLowerCase().replace(/[\s-]+/g, '_');
    s.kind = KIND_ALIASES[k] || k;
  }
  return s;
}

function failureHttp(spec, behavior, ctx) {
  const style = behavior.errorStyle;
  const model = spec.model || (ctx.body && ctx.body.model) || 'mock-model';
  switch (spec.kind) {
    case 'unauthorized':
      return { status: 401, body: errorBody(style, { message: 'Incorrect API key provided: sk-mock***. You can find your API key at https://platform.openai.com/account/api-keys.', type: 'invalid_request_error', code: 'invalid_api_key', status: 401 }) };
    case 'echo_key': {
      // A hostile/buggy server that reflects the credential it received back in the error text.
      const token = String(ctx.req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      return { status: spec.status || 401, body: errorBody(style, { message: `Incorrect API key provided: ${token}. Also tried ${token}.`, type: 'invalid_request_error', code: 'invalid_api_key', status: 401 }), headers: { 'x-echo': token } };
    }
    case 'forbidden':
      return { status: 403, body: errorBody(style, { message: 'You do not have access to this resource.', type: 'permission_error', code: 'forbidden', status: 403 }) };
    case 'model_not_found':
      if (style === 'ollama') return { status: 404, body: { error: `model '${model}' not found` } };
      if (style === 'llamacpp') return { status: 404, body: errorBody(style, { message: `model '${model}' not found`, type: 'not_found_error', status: 404 }) };
      return { status: 404, body: errorBody(style, { message: `The model \`${model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', code: 'model_not_found', status: 404 }) };
    case 'not_found':
      return { status: 404, text: '404 page not found' };
    case 'rate_limit':
      return {
        status: 429,
        headers: { 'retry-after': String(spec.retryAfter ?? 1) },
        body: errorBody(style, { message: 'Rate limit reached for requests. Please try again later.', type: 'rate_limit_error', code: 'rate_limit_exceeded', status: 429 }),
      };
    case 'quota':
      return { status: 429, body: errorBody(style, { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota', status: 429 }) };
    case 'context_length':
      if (style === 'llamacpp') return { status: 400, body: { error: { code: 400, message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 9000, n_ctx: 4096 } } };
      return { status: 400, body: errorBody(style, { message: "This model's maximum context length is 4096 tokens. However, you requested 9000 tokens (8500 in the messages, 500 in the completion). Please reduce the length of the messages or completion.", code: 'context_length_exceeded', status: 400 }) };
    case 'bad_request':
      return { status: 400, body: errorBody(style, { message: spec.message || 'Invalid request.', code: null, status: 400 }) };
    case 'server_error':
      return { status: 500, body: errorBody(style, { message: 'The server had an error while processing your request.', type: 'server_error', status: 500 }) };
    case 'unavailable':
      return { status: 503, headers: spec.retryAfter ? { 'retry-after': String(spec.retryAfter) } : {}, body: errorBody(style, { message: spec.message || 'The engine is currently overloaded, please try again later.', type: 'server_error', status: 503 }) };
    case 'html':
      return { status: 502, headers: { 'Content-Type': 'text/html' }, text: '<!doctype html><html><body><h1>502 Bad Gateway</h1></body></html>' };
    case 'redirect':
      return { status: 301, headers: { Location: spec.location || '/elsewhere' }, text: 'moved' };
    case 'http':
      return { status: spec.status || 500, headers: spec.headers || {}, body: spec.body, text: spec.text };
    default:
      return null;
  }
}

/** Resolve the reply for this chat request from `replies`, falling back to the deterministic responder. */
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

function frameWriter(behavior) {
  const eol = behavior.crlf ? '\r\n' : '\n';
  const prefix = behavior.noSpaceAfterData ? 'data:' : 'data: ';
  return {
    data: (obj) => `${prefix}${typeof obj === 'string' ? obj : JSON.stringify(obj)}${eol}${eol}`,
    comment: (text) => `: ${text}${eol}${eol}`,
  };
}

function buildChunks(reply, body, behavior) {
  const id = `chatcmpl-mock${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const model = (body && body.model) || 'mock-model';
  const base = (delta, finish = null) => ({
    id, object: 'chat.completion.chunk', created, model, system_fingerprint: 'fp_mock',
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
  });
  const thought = reply.think ?? behavior.think;
  const thinkText = thought ? `<think>${thought === true ? DEFAULT_THOUGHT : thought}</think>\n\n` : '';
  const reasoning = reply.reasoningContent ?? behavior.reasoningContent;
  const text = reply.thinkOnly ? `<think>${DEFAULT_THOUGHT}` : `${thinkText}${reply.text}`;
  const frames = [];
  frames.push(base(behavior.roleOnly ? { role: 'assistant' } : { role: 'assistant', content: '' }));
  if (reasoning) {
    for (const piece of splitIntoDeltas(reasoning === true ? DEFAULT_THOUGHT : String(reasoning), { chunkSize: 12 })) {
      frames.push(base({ reasoning_content: piece }));
    }
  }
  const pieces = reply.reasoningOnly ? [] : splitIntoDeltas(text, { chunkSize: behavior.chunkSize, splitCodePoints: behavior.splitCodePoints });
  pieces.forEach((piece, i) => {
    frames.push(base({ content: piece }));
    if (behavior.emptyDeltas && i === 1) frames.push(base({}));
    if (behavior.emptyDeltas && i === 3) frames.push(base({ content: '' }));
  });
  return { frames, base, id, text, finish: reply.finishReason || 'stop' };
}

async function sendStream(ctx, behavior, reply, fault) {
  const { res, conn, body } = ctx;
  const w = frameWriter(behavior);
  const { frames, base, id, text, finish } = buildChunks(reply, body, behavior);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'x-request-id': id,
  });
  res.flushHeaders();
  if (fault && fault.kind === 'hang_after_headers') {
    await conn.hang();
    return;
  }
  let seed = 0;
  const emit = (str) => {
    seed += 1;
    return behavior.byteSplit ? conn.writeSliced(str, seed) : conn.write(str);
  };
  const midStream = fault && ['reset', 'stall', 'malformed', 'error_in_stream'].includes(fault.kind) ? fault : null;
  let fired = false;
  /** Returns true when the response is over (the caller must stop). */
  const fire = async () => {
    fired = true;
    if (midStream.kind === 'reset') { conn.reset(); return true; }
    if (midStream.kind === 'stall') { await conn.hang(); return true; }
    if (midStream.kind === 'error_in_stream') {
      await emit(w.data({ error: { message: 'The server had an error while processing your request.', type: 'server_error', code: 500 } }));
      res.end();
      return true;
    }
    // malformed: a truncated JSON event, after which the stream carries on normally.
    return !(await emit(w.data('{"id":"chatcmpl-broken","choices":[{"index":0,"delta":{"content":"Hel')));
  };

  let sentContent = 0;
  for (let i = 0; i < frames.length; i += 1) {
    const delta = frames[i].choices[0].delta;
    const isContent = typeof delta.content === 'string' && delta.content !== '';
    if (midStream && !fired && isContent && sentContent === (midStream.after ?? 2) && await fire()) return;
    if (!(await emit(w.data(frames[i])))) return;
    if (isContent) sentContent += 1;
    if (behavior.keepAlive && i % 3 === 0 && !(await emit(w.comment('keep-alive')))) return;
    if (!(await conn.wait(behavior.delayMs))) return;
  }
  if (midStream && !fired && await fire()) return;

  if (!(await emit(w.data(base({}, finish))))) return;
  const wantUsage = behavior.usage === 'always'
    || (behavior.usage === 'requested' && body.stream_options && body.stream_options.include_usage);
  if (wantUsage) {
    const prompt = estimateTokens((body.messages || []).map((m) => m.content).join(' '));
    const completion = estimateTokens(text);
    const usageChunk = {
      id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model || 'mock-model',
      choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    };
    if (!(await emit(w.data(usageChunk)))) return;
  }
  if (behavior.omitDone || (fault && fault.kind === 'no_done')) {
    await conn.hang();
    return;
  }
  await emit(w.data('[DONE]'));
  res.end();
}

function sendCompletionJson(ctx, behavior, reply, { contentType = 'application/json' } = {}) {
  const { res, body } = ctx;
  const thought = reply.think ?? behavior.think;
  const text = `${thought ? `<think>${thought === true ? DEFAULT_THOUGHT : thought}</think>\n\n` : ''}${reply.text}`;
  const prompt = estimateTokens((body.messages || []).map((m) => m.content).join(' '));
  const completion = estimateTokens(text);
  const payload = {
    id: `chatcmpl-mock${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model || 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: reply.finishReason || 'stop' }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
  const json = JSON.stringify(payload);
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function validateChat(ctx, behavior) {
  const { body } = ctx;
  const style = behavior.errorStyle;
  if (!body || typeof body !== 'object') {
    return { status: 400, body: errorBody(style, { message: 'We could not parse the JSON body of your request.', status: 400 }) };
  }
  if (typeof body.model !== 'string' || !body.model) {
    return { status: 400, body: errorBody(style, { message: "you must provide a model parameter", code: null, status: 400 }) };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { status: 400, body: errorBody(style, { message: "'messages' is a required property", param: 'messages', status: 400 }) };
  }
  for (const m of body.messages) {
    if (!m || typeof m.content !== 'string' || !['system', 'user', 'assistant'].includes(m.role)) {
      return { status: 400, body: errorBody(style, { message: "Invalid value for 'messages': each message needs a role and string content.", param: 'messages', status: 400 }) };
    }
  }
  for (const param of [].concat(behavior.rejectParams || [])) {
    if (param in body) {
      const messages = {
        max_tokens: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
        max_completion_tokens: "Unrecognized request argument supplied: max_completion_tokens",
        temperature: "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.",
        stream_options: "Unknown parameter: 'stream_options'.",
      };
      return { status: 400, body: errorBody(style, { message: messages[param] || `Unsupported parameter: '${param}'.`, param, code: 'unsupported_parameter', status: 400 }) };
    }
  }
  if (behavior.strictModel && !behavior.models.includes(body.model)) {
    return failureHttp({ kind: 'model_not_found', model: body.model }, behavior, ctx);
  }
  return null;
}

function checkAuth(ctx, behavior) {
  if (!behavior.apiKey) return null;
  const header = ctx.req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');
  const ok = [].concat(behavior.apiKey).includes(token);
  return ok ? null : failureHttp({ kind: 'unauthorized' }, behavior, ctx);
}

function respondHttp(ctx, out) {
  const { res } = ctx;
  if (out.text !== undefined) {
    sendText(res, out.status, out.text, out.headers || {});
  } else {
    sendJson(res, out.status, out.body ?? {}, out.headers || {});
  }
}

async function handleChat(ctx, state) {
  const { behavior } = state;
  const { conn, res, body } = ctx;
  const spec = takeFailure(behavior, ctx, 'failures');
  if (spec) {
    if (spec.kind === 'hang') { await conn.hang(); return; }
    if (spec.kind === 'reset_before_response') { conn.reset(); return; }
    const http = failureHttp(spec, behavior, ctx);
    if (http) { respondHttp(ctx, http); return; }
    if (!STREAM_KINDS.has(spec.kind)) throw new Error(`unknown failure kind "${spec.kind}"`);
  }
  const authFail = checkAuth(ctx, behavior);
  if (authFail) { respondHttp(ctx, authFail); return; }
  const invalid = validateChat(ctx, behavior);
  if (invalid) { respondHttp(ctx, invalid); return; }

  if (behavior.ttfbMs > 0 && !(await conn.wait(behavior.ttfbMs))) return;
  const index = state.replyIndex;
  state.replyIndex += 1;
  const replyCtx = { index, messages: body.messages, body, request: ctx.record };
  const reply = await resolveReply(behavior, replyCtx);
  if (spec && spec.kind === 'think_only') reply.thinkOnly = true;
  if (spec && spec.kind === 'reasoning_only') { reply.reasoningOnly = true; reply.reasoningContent = true; reply.finishReason = 'length'; }
  if (spec && spec.kind === 'empty') reply.text = '';
  if (spec && spec.kind === 'content_filter') { reply.text = ''; reply.finishReason = 'content_filter'; }
  if (spec && spec.kind === 'length_empty') { reply.text = ''; reply.finishReason = 'length'; }

  if (spec && spec.kind === 'malformed_only') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {not json at all\n\ndata: <html>nope</html>\n\n');
    res.end();
    return;
  }
  if (body.stream === false || spec?.kind === 'json' || spec?.kind === 'json_no_type') {
    sendCompletionJson(ctx, behavior, reply, { contentType: spec?.kind === 'json_no_type' ? 'text/plain' : 'application/json' });
    return;
  }
  await sendStream(ctx, behavior, reply, spec);
}

function modelsPayload(behavior) {
  const list = behavior.models;
  switch (behavior.modelsStyle) {
    case 'array': return list.map((id) => ({ id, object: 'model' }));
    case 'models-key': return { models: list.map((name) => ({ name, model: name })) };
    case 'llamacpp':
      return {
        models: list.map((name) => ({ name, model: name, capabilities: ['completion'] })),
        object: 'list',
        data: list.map((id) => ({ id, object: 'model', created: 1760000000, owned_by: 'llamacpp' })),
      };
    default:
      return { object: 'list', data: list.map((id) => ({ id, object: 'model', created: 1760000000, owned_by: 'mock' })) };
  }
}

async function handleModels(ctx, state) {
  const { behavior } = state;
  const spec = takeFailure(behavior, ctx, 'modelsFailures');
  if (spec) {
    if (spec.kind === 'hang') { await ctx.conn.hang(); return; }
    const http = failureHttp(spec, behavior, ctx);
    if (http) { respondHttp(ctx, http); return; }
    throw new Error(`unknown failure kind "${spec.kind}" for /models`);
  }
  const authFail = checkAuth(ctx, behavior);
  if (authFail) { respondHttp(ctx, authFail); return; }
  sendJson(ctx.res, 200, modelsPayload(behavior));
}

async function handlePull(ctx, state) {
  const { behavior } = state;
  const { res, conn, body } = ctx;
  const pull = { ...DEFAULTS.pull, ...behavior.pull };
  const model = body && (body.model || body.name);
  if (typeof model !== 'string' || !model) {
    sendJson(res, 400, { error: 'model is required' });
    return;
  }
  const line = (obj) => `${JSON.stringify(obj)}\n`;
  if (body.stream === false) {
    sendJson(res, 200, { status: 'success' });
    if (!behavior.models.includes(model)) behavior.models.push(model);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  res.flushHeaders();
  if (!(await conn.writeSliced(line({ status: 'pulling manifest' }), 1))) return;
  if (pull.fail || /nonexistent|missing/i.test(model)) {
    await conn.write(line({ error: 'pull model manifest: file does not exist' }));
    res.end();
    return;
  }
  const total = 1_300_000_000;
  const digest = 'sha256:6340dc3229b0d08ea9cc49b75d4098702983e17b4c096d57afbbf2ffc813f2be';
  const steps = Math.max(1, pull.steps);
  for (let i = 0; i <= steps; i += 1) {
    const completed = Math.floor((total * i) / steps);
    if (!(await conn.writeSliced(line({ status: `pulling ${digest.slice(7, 19)}`, digest, total, completed }), i + 2))) return;
    if (pull.failMidway && i === Math.floor(steps / 2)) {
      await conn.write(line({ error: 'write /root/.ollama/models/blobs: no space left on device' }));
      res.end();
      return;
    }
    if (!(await conn.wait(pull.delayMs))) return;
  }
  if (pull.truncate) { res.end(); return; }
  await conn.write(line({ status: 'verifying sha256 digest' }));
  await conn.write(line({ status: 'writing manifest' }));
  await conn.write(line({ status: 'removing any unused layers' }));
  if (!behavior.models.includes(model)) behavior.models.push(model);
  await conn.write(line({ status: 'success' }));
  res.end();
}

/**
 * @param {Partial<typeof DEFAULTS> & {port?: number, host?: string}} [options]
 * @returns {Promise<{
 *   url: string, baseUrl: string, port: number, requests: object[], close(): Promise<void>,
 *   setBehavior(patch: object): void, behavior: object, readonly inflight: number, readonly replyCount: number,
 *   chatRequests(): object[], lastChatRequest(): object|undefined, reset(): void,
 *   waitForRequests(count?: number, o?: object): Promise<object[]>, waitForIdle(ms?: number): Promise<void>
 * }>}
 */
export async function createMockOpenAI(options = {}) {
  const { port = 0, host = '127.0.0.1', ...rest } = options;
  if (typeof rest.replies === 'string') rest.replies = [rest.replies];
  const state = {
    behavior: { ...DEFAULTS, ...rest, models: [...(rest.models || DEFAULTS.models)], pull: { ...DEFAULTS.pull, ...(rest.pull || {}) } },
    replyIndex: 0,
  };
  if (Array.isArray(rest.failures)) state.behavior.failures = [...rest.failures];
  if (Array.isArray(rest.modelsFailures)) state.behavior.modelsFailures = [...rest.modelsFailures];

  const server = await startMockServer({
    name: 'openai',
    port,
    host,
    async handle(ctx) {
      const path = ctx.url.pathname.replace(/^\/v1(?=\/|$)/, '').replace(/\/+$/, '') || '/';
      const { method } = ctx.req;
      if (method === 'POST' && path === '/chat/completions') return handleChat(ctx, state);
      if (method === 'GET' && path === '/models') return handleModels(ctx, state);
      if (state.behavior.ollama) {
        if (method === 'GET' && path === '/api/version') {
          return sendJson(ctx.res, 200, { version: state.behavior.ollamaVersion });
        }
        if (method === 'GET' && path === '/api/tags') {
          return sendJson(ctx.res, 200, {
            models: state.behavior.models.map((name) => ({
              name, model: name, modified_at: '2026-10-01T10:00:00Z', size: 2019393189,
              digest: 'a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72',
              details: { format: 'gguf', family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' },
            })),
          });
        }
        if (method === 'POST' && path === '/api/pull') return handlePull(ctx, state);
      }
      return sendText(ctx.res, 404, '404 page not found');
    },
  });

  return {
    server: server.server,
    port: server.port,
    /** Bare origin, e.g. http://127.0.0.1:41234 */
    url: server.url,
    /** Base URL for the provider (`.../v1`). */
    baseUrl: `${server.url}/v1`,
    requests: server.requests,
    behavior: state.behavior,
    get inflight() { return server.inflight; },
    get replyCount() { return state.replyIndex; },
    waitForRequests: server.waitForRequests,
    waitForIdle: server.waitForIdle,
    close: server.close,
    /** Change options at runtime (arrays like `failures` are copied; setting `replies` rewinds the script). */
    setBehavior(patch) {
      const next = { ...patch };
      for (const key of ['failures', 'modelsFailures', 'models']) {
        if (Array.isArray(next[key])) next[key] = [...next[key]];
      }
      if (typeof next.replies === 'string') next.replies = [next.replies];
      if (next.pull) next.pull = { ...state.behavior.pull, ...next.pull };
      Object.assign(state.behavior, next);
      if (Object.hasOwn(next, 'replies')) state.replyIndex = 0;
    },
    chatRequests: () => server.requests.filter((r) => r.method === 'POST' && /\/chat\/completions$/.test(r.path)),
    lastChatRequest: () => server.requests.filter((r) => r.method === 'POST' && /\/chat\/completions$/.test(r.path)).at(-1),
    /** Forget recorded requests and rewind the scripted replies. */
    reset() {
      server.requests.length = 0;
      state.replyIndex = 0;
    },
    /** All user text of the last chat request (handy in assertions). */
    lastUserText() {
      const last = server.requests.filter((r) => r.method === 'POST' && /\/chat\/completions$/.test(r.path)).at(-1);
      return last && last.body ? allUserText(last.body.messages) : '';
    },
  };
}
