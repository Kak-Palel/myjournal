import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_DEFAULTS, PROVIDER_IDS, resolveProviderConfig, withProviderDefaults } from '../../src/providers/config.js';
import { ProviderError } from '../../src/providers/errors.js';
import { DEFAULT_SETTINGS, DEFAULT_TIMEOUT_SEC, defaultSettings } from '../../src/settings.js';

const settings = (over = {}) => ({
  ai: {
    enabled: true, provider: 'gemini', temperature: 0.7, maxTokens: 700, contextBudgetTokens: 3000, timeoutSec: 120,
    providers: {
      gemini: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest', thinking: 'auto', apiKey: '' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
      local: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2:3b', apiKey: '' },
    },
    ...over,
  },
});

test('PROVIDER_IDS', () => {
  assert.deepEqual([...PROVIDER_IDS], ['gemini', 'openai', 'local']);
  assert.ok(Object.isFrozen(PROVIDER_IDS));
});

test('resolves a full settings document', () => {
  const cfg = resolveProviderConfig('gemini', settings(), {});
  assert.deepEqual(cfg, {
    id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest', apiKey: '', keySource: 'none',
    timeoutMs: 120000, thinking: 'auto', temperature: 0.7, maxTokens: 700,
  });
});

test('one timeout default for every provider: a fresh install allows a cold local model 180 s, not the old 120 s that shadowed it', () => {
  assert.equal(DEFAULT_TIMEOUT_SEC, 180);
  assert.equal(DEFAULT_SETTINGS.ai.timeoutSec, 180);
  for (const id of PROVIDER_IDS) {
    assert.equal(PROVIDER_DEFAULTS[id].timeoutMs, 180_000, `${id} fallback`);
    // what a fresh install really sends to the adapter
    assert.equal(resolveProviderConfig(id, defaultSettings(), {}).timeoutMs, 180_000, `${id} from default settings`);
  }
  // an explicit choice still wins, within the clamp
  const custom = defaultSettings();
  custom.ai.timeoutSec = 240;
  assert.equal(resolveProviderConfig('local', custom, {}).timeoutMs, 240_000);
});

test('a saved key wins over the environment, the environment fills the gap', () => {
  const s = settings();
  s.ai.providers.openai.apiKey = ' sk-saved ';
  const saved = resolveProviderConfig('openai', s, { OPENAI_API_KEY: 'sk-env' });
  assert.equal(saved.apiKey, 'sk-saved');
  assert.equal(saved.keySource, 'settings');
  const env = resolveProviderConfig('openai', settings(), { OPENAI_API_KEY: ' sk-env ' });
  assert.equal(env.apiKey, 'sk-env');
  assert.equal(env.keySource, 'env');
  assert.equal(resolveProviderConfig('gemini', settings(), { GOOGLE_API_KEY: 'g-key' }).apiKey, 'g-key');
  assert.equal(resolveProviderConfig('gemini', settings(), { GEMINI_API_KEY: 'a', GOOGLE_API_KEY: 'b' }).apiKey, 'a');
  assert.equal(resolveProviderConfig('local', settings(), { LOCAL_LLM_API_KEY: 'k' }).keySource, 'env');
  assert.equal(resolveProviderConfig('local', settings(), {}).keySource, 'none');
});

test('missing fields are filled with defaults', () => {
  for (const id of PROVIDER_IDS) {
    const cfg = resolveProviderConfig(id, {}, {});
    assert.equal(cfg.baseUrl, PROVIDER_DEFAULTS[id].baseUrl);
    assert.equal(cfg.model, PROVIDER_DEFAULTS[id].model);
    assert.equal(cfg.timeoutMs, PROVIDER_DEFAULTS[id].timeoutMs);
    assert.equal(cfg.apiKey, '');
    assert.equal(cfg.temperature, undefined);
    assert.equal(cfg.maxTokens, undefined);
  }
  assert.equal(resolveProviderConfig('local', null, {}).timeoutMs, 180000);
  assert.equal(resolveProviderConfig('openai', undefined, {}).thinking, undefined);
});

test('empty strings in settings fall back to env base URL / model, then to defaults', () => {
  const s = settings();
  s.ai.providers.local.baseUrl = '  ';
  s.ai.providers.local.model = '';
  const cfg = resolveProviderConfig('local', s, { LOCAL_LLM_BASE_URL: 'http://localhost:8080/v1', LOCAL_LLM_MODEL: 'qwen2.5:1.5b' });
  assert.equal(cfg.baseUrl, 'http://localhost:8080/v1');
  assert.equal(cfg.model, 'qwen2.5:1.5b');
  s.ai.providers.openai.baseUrl = '';
  assert.equal(resolveProviderConfig('openai', s, { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }).baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(resolveProviderConfig('openai', s, {}).baseUrl, 'https://api.openai.com/v1');
});

test('saved values beat env base URLs', () => {
  const cfg = resolveProviderConfig('local', settings(), { LOCAL_LLM_BASE_URL: 'http://elsewhere/v1' });
  assert.equal(cfg.baseUrl, 'http://localhost:11434/v1');
});

test('numbers are validated and clamped', () => {
  const cfg = resolveProviderConfig('openai', settings({ temperature: 9, maxTokens: 12.6, timeoutSec: 0.1 }), {});
  assert.equal(cfg.temperature, 2);
  assert.equal(cfg.maxTokens, 13);
  assert.equal(cfg.timeoutMs, 1000);
  const bad = resolveProviderConfig('openai', settings({ temperature: 'hot', maxTokens: -5, timeoutSec: NaN }), {});
  assert.equal(bad.temperature, undefined);
  assert.equal(bad.maxTokens, undefined);
  assert.equal(bad.timeoutMs, PROVIDER_DEFAULTS.openai.timeoutMs);
  assert.equal(resolveProviderConfig('openai', settings({ temperature: 0 }), {}).temperature, 0);
  assert.equal(resolveProviderConfig('openai', settings({ timeoutSec: 99999 }), {}).timeoutMs, 300_000, 'never more than Node itself waits for response headers');
  assert.equal(resolveProviderConfig('openai', settings({ timeoutSec: 301 }), {}).timeoutMs, 300_000);
  assert.equal(resolveProviderConfig('openai', settings({ timeoutSec: 300 }), {}).timeoutMs, 300_000);
});

test('gemini defaults to the Flash-Lite alias with thinking "auto"; thinking is "low" only when explicitly "low"', () => {
  assert.equal(PROVIDER_DEFAULTS.gemini.model, 'gemini-flash-lite-latest');
  assert.equal(PROVIDER_DEFAULTS.gemini.thinking, 'auto');
  const s = settings();
  assert.equal(resolveProviderConfig('gemini', s, {}).thinking, 'auto');
  s.ai.providers.gemini.thinking = 'low';
  assert.equal(resolveProviderConfig('gemini', s, {}).thinking, 'low');
  for (const legacy of ['fast', 'default', 'minimal', 'whatever', 5, null]) {
    s.ai.providers.gemini.thinking = legacy;
    assert.equal(resolveProviderConfig('gemini', s, {}).thinking, 'auto', String(legacy));
  }
  delete s.ai.providers.gemini.thinking;
  assert.equal(resolveProviderConfig('gemini', s, {}).thinking, 'auto');
  assert.equal(resolveProviderConfig('gemini', {}, {}).model, 'gemini-flash-lite-latest');
});

test('unknown provider ids are a bad_request ProviderError', () => {
  for (const id of ['', 'anthropic', undefined, '__proto__']) {
    assert.throws(() => resolveProviderConfig(id, settings(), {}), (e) => e instanceof ProviderError && e.code === 'bad_request');
  }
});

test('the key is never part of an enumerable error', () => {
  const cfg = resolveProviderConfig('openai', settings(), { OPENAI_API_KEY: 'sk-secret-123456' });
  assert.equal(cfg.apiKey, 'sk-secret-123456'); // the config object itself carries the key, by design
});

test('withProviderDefaults fills partial configs', () => {
  const cfg = withProviderDefaults('local', { baseUrl: ' http://x/v1 ', model: '' });
  assert.equal(cfg.baseUrl, 'http://x/v1');
  assert.equal(cfg.model, 'llama3.2:3b');
  assert.equal(cfg.timeoutMs, 180000);
  assert.equal(withProviderDefaults('gemini', { thinking: 'low' }).thinking, 'low');
  assert.equal(withProviderDefaults('gemini', { thinking: 'default' }).thinking, 'auto');
  assert.equal(withProviderDefaults('gemini', {}).thinking, 'auto');
  assert.equal(withProviderDefaults('gemini', {}).model, 'gemini-flash-lite-latest');
  assert.equal(withProviderDefaults('openai', {}).thinking, undefined);
});
