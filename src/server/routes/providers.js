// /api/providers : the catalog, connection tests, model lists and Ollama downloads.
//
// `config` in a request overlays the saved settings for that one call and is never stored. The overlay's API key
// is also scrubbed from every response, so it cannot come back even inside an upstream error message.

import { PROVIDER_IDS } from '../../settings.js';
import { ProviderError, errorPayload, isAbortError, isOllama, pullOllamaModel } from '../../providers/index.js';
import { PULL_LOCK_KEY } from '../generation.js';
import { HttpError, badRequest, conflict, openSse } from '../http.js';
import { bodyObject, charCount, isPlainObject } from '../validate.js';

const TEST_TIMEOUT_CAP_MS = 90_000;
const MODELS_TIMEOUT_CAP_MS = 20_000;
const MAX_MODELS = 2000;
// Same rule as the provider layer's Ollama model-name check: no spaces, no "..", no leading slash.
const MODEL_NAME_RE = /^(?!.*\.\.)(?!\/)[\w.:/@+-]{1,200}$/;
// eslint-disable-next-line no-control-regex
const KEY_STRIP = /[\s\u0000-\u001f\u007f-\u009f]/g;

function textField(config, key, max, { singleLine = false } = {}) {
  const raw = config[key];
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw badRequest(`config.${key} must be text.`, { fields: { [`config.${key}`]: 'must be text.' } });
  if (charCount(raw, max) > max) throw badRequest(`config.${key} is too long.`, { fields: { [`config.${key}`]: `must be at most ${max} characters.` } });
  return singleLine ? raw.replace(/\s+/g, ' ').trim() : raw.trim();
}

/** Validate `{ provider, config? }`. The overlay keeps only what was typed (empty means "use the saved value"). */
function parseRequest(body) {
  const obj = bodyObject(body);
  if (typeof obj.provider !== 'string' || !PROVIDER_IDS.includes(obj.provider)) {
    throw badRequest(`Unknown provider. Choose one of: ${PROVIDER_IDS.join(', ')}.`, { fields: { provider: `must be one of: ${PROVIDER_IDS.join(', ')}.` } });
  }
  const config = obj.config === undefined || obj.config === null ? {} : obj.config;
  if (!isPlainObject(config)) throw badRequest('config must be an object.', { fields: { config: 'must be an object.' } });
  const overlay = {
    baseUrl: textField(config, 'baseUrl', 2048),
    model: textField(config, 'model', 200, { singleLine: true }),
    apiKey: textField(config, 'apiKey', 512).replace(KEY_STRIP, ''),
  };
  return { id: obj.provider, overlay, model: typeof obj.model === 'string' ? obj.model : '' };
}

/** Replace every occurrence of a secret in all strings of a JSON-like value. */
export function scrubSecrets(value, secrets) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  if (list.length === 0) return value;
  const clean = (v) => {
    if (typeof v === 'string') return list.reduce((text, secret) => text.split(secret).join('[redacted]'), v);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
    return v;
  };
  return clean(value);
}

/**
 * @param {ReturnType<import('../http.js').createRouter>} router
 * @param {{ ai: ReturnType<import('../ai-service.js').createAiService>, generations: object, config: object, log: object }} deps
 */
export function register(router, { ai, generations, config, log }) {
  router.add('GET', '/providers', (ctx) => {
    const settings = ai.loadSettings();
    ctx.json({ active: settings.ai.provider, providers: ai.providerRows(settings) });
  });

  router.add('POST', '/providers/test', async (ctx) => {
    const { id, overlay } = parseRequest(await ctx.readJson());
    const { provider, cfg } = ai.buildWithOverlay(id, overlay, { timeoutCapMs: TEST_TIMEOUT_CAP_MS });
    let body;
    try {
      const result = await provider.test({ signal: ctx.signal });
      body = { ok: true, provider: id, model: result.model || cfg.model, latencyMs: result.latencyMs, sample: result.sample };
    } catch (err) {
      if (ctx.signal.aborted || isAbortError(err)) return; // the person closed the page: nobody to answer
      if (!(err instanceof ProviderError)) log.error('Connection test failed', err);
      body = { ok: false, provider: id, model: cfg.model, error: errorPayload(err) };
    }
    ctx.json(scrubSecrets(body, [cfg.apiKey, overlay.apiKey]));
  });

  router.add('POST', '/providers/models', async (ctx) => {
    const { id, overlay } = parseRequest(await ctx.readJson());
    const { provider, cfg } = ai.buildWithOverlay(id, overlay, { timeoutCapMs: MODELS_TIMEOUT_CAP_MS });
    let body;
    try {
      const models = await provider.listModels({ signal: ctx.signal });
      body = { ok: true, models: models.slice(0, MAX_MODELS).map((m) => ({ id: m.id, label: m.label || m.id })) };
    } catch (err) {
      if (ctx.signal.aborted || isAbortError(err)) return;
      if (!(err instanceof ProviderError)) log.error('Listing models failed', err);
      body = { ok: false, models: [], error: errorPayload(err) };
    }
    ctx.json(scrubSecrets(body, [cfg.apiKey, overlay.apiKey]));
  });

  router.add('POST', '/providers/local/pull', async (ctx) => {
    const body = bodyObject(await ctx.readJson());
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!MODEL_NAME_RE.test(model)) {
      throw badRequest('That does not look like a valid model name.', {
        hint: 'Examples: llama3.2:3b, qwen2.5:1.5b, gemma2:2b.',
        fields: { model: 'must be a model name such as llama3.2:3b.' },
      });
    }
    const { overlay } = parseRequest({ provider: 'local', config: body.config });
    const { cfg } = ai.buildWithOverlay('local', { baseUrl: overlay.baseUrl });
    const lock = generations.acquire(PULL_LOCK_KEY, 'pull');
    if (!lock) throw conflict('generation_in_progress', 'A model download is already running.', { hint: 'Wait for it to finish, or cancel it first.' });
    const fetchOpt = ai.fetch ? { fetch: ai.fetch } : {};
    let sse = null;
    const onClose = () => {
      if (!ctx.res.writableFinished) lock.controller.abort();
    };
    ctx.res.once('close', onClose);
    try {
      const reachable = await isOllama(cfg, { signal: lock.controller.signal, ...fetchOpt });
      if (lock.controller.signal.aborted) return;
      if (!reachable) {
        throw new HttpError(409, 'not_ollama', 'This does not look like an Ollama server.', {
          hint: 'Downloading models only works with Ollama. For llama.cpp or LM Studio, load the model in that program.',
        });
      }
      sse = openSse(ctx.res, { pingMs: config.ssePingMs });
      try {
        for await (const p of pullOllamaModel(cfg, { model, signal: lock.controller.signal, ...fetchOpt })) {
          const event = { status: p.status };
          for (const key of ['completed', 'total', 'percent']) if (typeof p[key] === 'number') event[key] = p[key];
          sse.send('progress', event);
        }
        sse.send('done', {});
      } catch (err) {
        if (lock.controller.signal.aborted || isAbortError(err)) return;
        if (!(err instanceof ProviderError)) log.error('Model download failed', err);
        sse.send('error', { error: errorPayload(err) });
      }
    } finally {
      generations.release(lock);
      ctx.res.off('close', onClose);
      if (sse) sse.close();
    }
  });
}
