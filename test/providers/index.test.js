import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as providers from '../../src/providers/index.js';
import {
  ERROR_CODES, PROVIDER_DEFAULTS, PROVIDER_IDS, ProviderError, createProvider, describeProviders, isOllama, pullOllamaModel,
  resolveProviderConfig,
} from '../../src/providers/index.js';
import { ENV_KEY_NAMES } from '../../src/env-keys.js';
import { createMockGemini } from '../mocks/mock-gemini.js';
import { createMockOpenAI } from '../mocks/mock-openai.js';
import { HELLO, drain } from './helpers.js';

test('index exports what ARCHITECTURE.md §9 promises', () => {
  for (const name of ['createProvider', 'describeProviders', 'resolveProviderConfig', 'PROVIDER_IDS', 'ProviderError', 'pullOllamaModel', 'isOllama']) {
    assert.ok(name in providers, name);
  }
  assert.deepEqual([...PROVIDER_IDS], ['gemini', 'openai', 'local']);
  assert.equal(typeof isOllama, 'function');
  assert.equal(typeof pullOllamaModel, 'function');
  assert.ok(ERROR_CODES.includes('empty'));
});

test('createProvider builds each adapter with the documented surface', () => {
  for (const id of PROVIDER_IDS) {
    const p = createProvider(id, { baseUrl: 'http://localhost:1/v1', model: 'm', apiKey: '' });
    assert.equal(p.id, id);
    assert.equal(typeof p.label, 'string');
    for (const fn of ['stream', 'chat', 'listModels', 'test']) assert.equal(typeof p[fn], 'function', `${id}.${fn}`);
    assert.equal(p.stream({ messages: [] })[Symbol.asyncIterator] !== undefined, true, 'stream() returns an async generator');
  }
  assert.equal(typeof createProvider('local', {}).pullModel, 'function');
  assert.equal(createProvider('gemini', {}).pullModel, undefined);
});

test('createProvider: cfg.id cannot override the id argument; a partial cfg gets defaults; unknown ids throw', async () => {
  assert.equal(createProvider('local', { id: 'gemini', baseUrl: 'http://x/v1' }).id, 'local');
  assert.equal(createProvider('gemini', { id: 'openai' }).id, 'gemini');
  assert.doesNotThrow(() => createProvider('openai', undefined));
  for (const bad of ['', 'anthropic', undefined, null, 'GEMINI', '__proto__']) {
    assert.throws(() => createProvider(bad, {}), (e) => e instanceof ProviderError && e.code === 'bad_request');
  }
});

test('createProvider({ fetch }) uses the injected fetch (and the global one is untouched)', async () => {
  const calls = [];
  const fetchFn = async (url) => { calls.push(url); return new Response('{"data":[{"id":"x"}]}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  const p = createProvider('openai', { baseUrl: 'https://example.test/v1', model: 'm', apiKey: 'sk-abcdefgh' }, { fetch: fetchFn });
  assert.deepEqual(await p.listModels(), [{ id: 'x', label: 'x' }]);
  assert.deepEqual(calls, ['https://example.test/v1/models']);
});

test('describeProviders: one complete row per provider, in a stable order', () => {
  const rows = describeProviders({});
  assert.deepEqual(rows.map((r) => r.id), ['gemini', 'openai', 'local']);
  for (const row of rows) {
    for (const key of ['id', 'label', 'tagline', 'description', 'needsKey', 'defaultBaseUrl', 'defaultModel', 'privacyNote', 'suggestedModels', 'keySource']) {
      assert.ok(key in row, `${row.id}.${key}`);
    }
    assert.ok(!('configured' in row), 'the server adds `configured`');
    assert.equal(row.defaultBaseUrl, PROVIDER_DEFAULTS[row.id].baseUrl);
    assert.equal(row.defaultModel, PROVIDER_DEFAULTS[row.id].model);
    assert.ok(Array.isArray(row.suggestedModels) && row.suggestedModels.length > 0);
    for (const m of row.suggestedModels) assert.ok(typeof m.id === 'string' && typeof m.label === 'string');
    assert.ok(row.description.length > 40 && row.tagline.length > 10 && row.privacyNote.length > 40);
  }
  const [gemini, openai, local] = rows;
  assert.deepEqual([gemini.needsKey, openai.needsKey, local.needsKey], [true, true, false]);
  assert.equal(gemini.keyUrl, 'https://aistudio.google.com/apikey');
  assert.equal(openai.keyUrl, undefined);
  assert.equal(local.keyUrl, undefined);
});

test('describeProviders: catalog copy from the architecture document', () => {
  const [gemini, openai, local] = describeProviders({});
  assert.equal(gemini.label, 'Free Gemini API');
  assert.equal(gemini.tagline, 'Free key from Google AI Studio');
  assert.deepEqual(gemini.suggestedModels.map((m) => [m.id, m.note]), [
    ['gemini-flash-lite-latest', 'Fast — recommended'], ['gemini-flash-latest', 'Smarter, can be slow or busy'], ['gemini-3.5-flash-lite', undefined], ['gemini-3.5-flash', undefined],
  ]);
  assert.equal(gemini.defaultModel, 'gemini-flash-lite-latest');
  assert.match(gemini.privacyNote, /free tier/i);
  assert.match(gemini.privacyNote, /Google/);
  assert.match(gemini.privacyNote, /human/i);
  assert.match(gemini.privacyNote, /billing/i);
  assert.equal(openai.label, 'OpenAI-compatible API');
  assert.match(openai.tagline, /OpenAI, OpenRouter, Groq, Together, DeepSeek/);
  assert.deepEqual(openai.suggestedModels.map((m) => m.id), ['gpt-4o-mini']);
  assert.deepEqual(Object.fromEntries(openai.presets.map((p) => [p.label, p.baseUrl])), {
    OpenAI: 'https://api.openai.com/v1', OpenRouter: 'https://openrouter.ai/api/v1', Groq: 'https://api.groq.com/openai/v1', Together: 'https://api.together.xyz/v1',
  });
  assert.equal(local.label, 'Self-hosted small LLM');
  assert.equal(local.tagline, 'Runs on your machine — nothing leaves it');
  assert.deepEqual(Object.fromEntries(local.presets.map((p) => [p.label, p.baseUrl])), {
    Ollama: 'http://localhost:11434/v1', 'llama.cpp': 'http://localhost:8080/v1', 'LM Studio': 'http://localhost:1234/v1',
  });
  assert.deepEqual(local.suggestedModels.map((m) => m.id), ['llama3.2:1b', 'qwen2.5:1.5b', 'gemma2:2b', 'llama3.2:3b', 'smollm2:1.7b']);
  assert.match(local.suggestedModels[0].note, /1\.3 GB/);
  assert.equal(gemini.presets.length, 0);
  // every preset URL is a valid base URL for the adapter
  for (const row of [openai, local]) for (const p of row.presets) assert.doesNotThrow(() => new URL(p.baseUrl));
});

test('describeProviders: keySource reflects only the environment; the key itself is never included', () => {
  const secret = 'AIza-super-secret-value-123456';
  const withEnv = describeProviders({ GEMINI_API_KEY: secret, OPENAI_API_KEY: 'sk-another-secret-value' });
  assert.deepEqual(withEnv.map((r) => r.keySource), ['env', 'env', 'none']);
  assert.ok(!JSON.stringify(withEnv).includes(secret) && !JSON.stringify(withEnv).includes('sk-another'));
  assert.deepEqual(describeProviders({ GOOGLE_API_KEY: 'g' }).map((r) => r.keySource), ['env', 'none', 'none']);
  assert.deepEqual(describeProviders({ LOCAL_LLM_API_KEY: 'k' }).map((r) => r.keySource), ['none', 'none', 'env']);
  assert.deepEqual(describeProviders({}).map((r) => r.keySource), ['none', 'none', 'none']);
  assert.deepEqual(describeProviders().map((r) => r.id), ['gemini', 'openai', 'local'], 'defaults to process.env');
  for (const [id, names] of Object.entries(ENV_KEY_NAMES)) assert.ok(names.length > 0, id);
});

test('describeProviders returns fresh copies each call', () => {
  const a = describeProviders({});
  a[0].suggestedModels.push({ id: 'junk', label: 'junk' });
  a[1].presets.length = 0;
  const b = describeProviders({});
  assert.equal(b[0].suggestedModels.length, 4);
  assert.equal(b[1].presets.length, 4);
});

test('end to end: settings document + env -> resolveProviderConfig -> createProvider -> mock, for all three providers', async () => {
  const openaiMock = await createMockOpenAI({ apiKey: 'sk-env-key-123456', replies: (ctx) => (ctx.body.model === 'llama3.2:3b' ? 'Local says hi.' : 'OpenAI-compatible says hi.') });
  const geminiMock = await createMockGemini({ apiKey: 'AIza-env-key-123456', replies: () => 'Gemini says hi.' });
  try {
    const settings = {
      ai: {
        temperature: 0.6, maxTokens: 200, timeoutSec: 20,
        providers: {
          gemini: { baseUrl: geminiMock.url, model: 'gemini-flash-lite-latest', thinking: 'auto', apiKey: '' },
          openai: { baseUrl: openaiMock.baseUrl, model: 'mock-model', apiKey: '' },
          local: { baseUrl: openaiMock.url, model: 'llama3.2:3b', apiKey: 'sk-env-key-123456' },
        },
      },
    };
    const env = { GEMINI_API_KEY: 'AIza-env-key-123456', OPENAI_API_KEY: 'sk-env-key-123456' };
    const expected = { gemini: 'Gemini says hi.', openai: 'OpenAI-compatible says hi.', local: 'Local says hi.' };
    for (const id of ['gemini', 'openai', 'local']) {
      const cfg = resolveProviderConfig(id, settings, env);
      const provider = createProvider(id, cfg);
      assert.equal((await drain(provider.stream({ messages: HELLO }))).text, expected[id], id);
      assert.equal((await provider.test()).ok, true, id);
      assert.ok((await provider.listModels()).length > 0, id);
    }
    const sent = openaiMock.chatRequests().find((r) => r.body.messages[0].content === 'Hello there, how are you today?');
    assert.equal(sent.body.temperature, 0.6);
    assert.equal(sent.body.max_tokens, 200);
    assert.equal(geminiMock.generateRequests()[0].body.generationConfig.maxOutputTokens, 2248, 'requested 200 + 2048 of room for thoughts');
    assert.equal(geminiMock.requests[0].headers['x-goog-api-key'], 'AIza-env-key-123456');
  } finally {
    await openaiMock.close();
    await geminiMock.close();
  }
});

test('every error code is produced somewhere by the adapters (the table below is the proof)', async () => {
  const { mapOpenAIError } = await import('../../src/providers/openai.js');
  const { mapGeminiError } = await import('../../src/providers/gemini.js');
  const { createScope } = await import('../../src/providers/http.js');
  const oa = (status, body, extra = {}) => mapOpenAIError({ status, text: JSON.stringify(body), ctx: { provider: 'openai', secrets: [], model: 'm', url: 'https://x/v1/chat/completions', hasKey: true, ...extra } });
  const ge = (status, body) => mapGeminiError({ status, text: JSON.stringify(body), ctx: { secrets: [], model: 'gemini-x', url: 'https://x/v1beta/models/gemini-x:streamGenerateContent' } });
  const timeoutErr = await (async () => {
    const scope = createScope({ firstByteMs: 20, ctx: { provider: 'openai', secrets: [], url: 'https://x/' } });
    try {
      await new Promise((resolve, reject) => scope.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    } catch (e) {
      return scope.fail(e);
    } finally {
      scope.close();
    }
    return null;
  })();
  const produced = {
    auth: oa(401, {}),
    rate_limit: oa(429, { error: { message: 'slow' } }),
    quota: oa(429, { error: { type: 'insufficient_quota' } }),
    model_not_found: oa(404, { error: { message: 'The model `m` does not exist' } }),
    bad_base_url: oa(404, {}),
    network: (await createProvider('openai', { baseUrl: 'http://no-such-host.invalid/v1', model: 'm', timeoutMs: 3000 }).listModels().catch((e) => e)),
    timeout: timeoutErr,
    blocked: ge(200, { promptFeedback: { blockReason: 'x' } }) && await (async () => {
      const m = await createMockGemini({ failures: ['safety_prompt'] });
      try { return await createProvider('gemini', { baseUrl: m.url, model: 'gemini-flash-latest', apiKey: 'k' }).chat({ messages: HELLO }).catch((e) => e); } finally { await m.close(); }
    })(),
    context_too_long: oa(400, { error: { code: 'context_length_exceeded', message: 'x' } }),
    bad_request: oa(400, { error: { message: 'bad' } }),
    server: oa(500, {}),
    overloaded: ge(503, { error: { status: 'UNAVAILABLE', message: 'x' } }),
    region: ge(400, { error: { status: 'FAILED_PRECONDITION', message: 'User location is not supported' } }),
    empty: await (async () => {
      const m = await createMockOpenAI({ failures: ['empty'] });
      try { return await createProvider('openai', { baseUrl: m.baseUrl, model: 'm' }).chat({ messages: HELLO }).catch((e) => e); } finally { await m.close(); }
    })(),
    unknown: ge(200, { error: { message: 'weird' } }),
  };
  assert.deepEqual(Object.keys(produced).sort(), [...ERROR_CODES].sort(), 'the table covers every documented code');
  for (const [code, err] of Object.entries(produced)) {
    assert.ok(err instanceof ProviderError, `${code}: ${err}`);
    assert.equal(err.code, code);
    assert.ok(err.message.length > 5 && !/undefined|\[object/.test(err.message + (err.hint || '')), `${code}: ${err.message} / ${err.hint}`);
    assert.equal(typeof err.provider, 'string', `${code} carries its provider`);
  }
});
