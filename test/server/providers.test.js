import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../../src/db/index.js';
import { createAiService } from '../../src/server/ai-service.js';
import { scrubSecrets, testTimeoutCapMs } from '../../src/server/routes/providers.js';
import { createMockOpenAI } from '../mocks/mock-openai.js';
import { freePort, saveSettings, waitFor, withApp } from './helpers.js';

const SECRET = 'sk-overlay-secret-123456';

describe('scrubSecrets', () => {
  it('removes secrets from every string in a structure', () => {
    const body = { ok: false, error: { message: `bad key ${SECRET}`, hint: ['try', `${SECRET}!`] }, n: 3 };
    const clean = scrubSecrets(body, [SECRET, '', undefined]);
    assert.equal(JSON.stringify(clean).includes(SECRET), false);
    assert.equal(clean.error.message, 'bad key [redacted]');
    assert.equal(clean.n, 3);
    assert.deepEqual(scrubSecrets(body, []), body);
  });
});

describe('GET /api/providers', () => {
  it('lists the three providers with catalog copy, configured state and key source', async () => {
    await withApp({}, async (h) => {
      const res = await h.get('/api/providers');
      assert.equal(res.status, 200);
      assert.equal(res.json.active, 'local');
      assert.deepEqual(res.json.providers.map((p) => p.id), ['gemini', 'openai', 'local']);
      const [gemini, openai, local] = res.json.providers;
      for (const row of res.json.providers) {
        for (const key of ['label', 'tagline', 'description', 'privacyNote', 'defaultBaseUrl', 'defaultModel']) assert.equal(typeof row[key], 'string', `${row.id}.${key}`);
        assert.equal(typeof row.needsKey, 'boolean');
        assert.equal(typeof row.configured, 'boolean');
        assert.ok(Array.isArray(row.suggestedModels) && row.suggestedModels.length > 0);
        assert.ok(['settings', 'env', 'none'].includes(row.keySource));
      }
      assert.equal(gemini.needsKey, true);
      assert.equal(gemini.keyUrl, 'https://aistudio.google.com/apikey');
      assert.equal(gemini.defaultModel, 'gemini-flash-lite-latest');
      assert.equal(gemini.suggestedModels[0].id, 'gemini-flash-lite-latest');
      assert.equal(gemini.configured, false);
      assert.equal(openai.configured, false);
      assert.ok(openai.presets.some((p) => p.id === 'openrouter'));
      assert.equal(local.needsKey, false);
      assert.equal(local.configured, true);
      assert.equal(local.defaultBaseUrl, 'http://localhost:11434/v1');
    });
  });

  it('reflects saved and environment keys without ever revealing them', async () => {
    await withApp({ ai: false, env: { GEMINI_API_KEY: 'env-gemini-key-0000' } }, async (h) => {
      assert.equal(( await h.get('/api/providers')).json.active, '');
      saveSettings(h.db, { ai: { providers: { openai: { apiKey: 'sk-saved-key-9999' } } } });
      const res = await h.get('/api/providers');
      const byId = Object.fromEntries(res.json.providers.map((p) => [p.id, p]));
      assert.deepEqual([byId.gemini.configured, byId.gemini.keySource], [true, 'env']);
      assert.deepEqual([byId.openai.configured, byId.openai.keySource], [true, 'settings']);
      assert.equal(byId.local.keySource, 'none');
      assert.doesNotMatch(res.text, /env-gemini-key-0000|sk-saved-key-9999/);
    });
  });
});

describe('GET /api/providers: configured and keySource, as documented in ARCHITECTURE section 6', () => {
  // The onboarding view shows "Found GEMINI_API_KEY in your environment" when a row says keySource === 'env'.
  const ROW_KEYS = ['configured', 'defaultBaseUrl', 'defaultModel', 'description', 'id', 'keySource', 'label', 'needsKey', 'presets', 'privacyNote', 'suggestedModels', 'tagline'];
  const byId = (res) => Object.fromEntries(res.json.providers.map((p) => [p.id, p]));

  it('every row has exactly the documented fields (keyUrl only for Gemini)', async () => {
    await withApp({}, async (h) => {
      const res = await h.get('/api/providers');
      for (const row of res.json.providers) {
        const expected = row.id === 'gemini' ? [...ROW_KEYS, 'keyUrl'].sort() : ROW_KEYS;
        assert.deepEqual(Object.keys(row).sort(), expected, row.id);
        assert.equal(typeof row.configured, 'boolean', row.id);
        assert.ok(['env', 'settings', 'none'].includes(row.keySource), row.id);
      }
    });
  });

  it('keySource is "none" with no key anywhere, "env" when only the environment has one, "settings" when a saved key exists', async () => {
    await withApp({ ai: false }, async (h) => {
      const none = byId(await h.get('/api/providers'));
      assert.deepEqual([none.gemini.keySource, none.openai.keySource, none.local.keySource], ['none', 'none', 'none']);
      assert.deepEqual([none.gemini.configured, none.openai.configured, none.local.configured], [false, false, true]);
    });
    await withApp({ ai: false, env: { GEMINI_API_KEY: 'env-gemini-key-0000' } }, async (h) => {
      const row = byId(await h.get('/api/providers')).gemini;
      assert.deepEqual([row.keySource, row.configured], ['env', true]);
      // a saved key wins over the environment and says so
      saveSettings(h.db, { ai: { providers: { gemini: { apiKey: 'saved-gemini-key-1111' } } } });
      const saved = byId(await h.get('/api/providers')).gemini;
      assert.deepEqual([saved.keySource, saved.configured], ['settings', true]);
      // clearing it brings the environment back
      saveSettings(h.db, { ai: { providers: { gemini: { apiKey: null } } } });
      assert.equal(byId(await h.get('/api/providers')).gemini.keySource, 'env');
    });
  });

  it('every environment variable that can supply a key is recognised, for its own provider only', async () => {
    const cases = [
      [{ GEMINI_API_KEY: 'k-gemini-0001' }, 'gemini'],
      [{ GOOGLE_API_KEY: 'k-google-0002' }, 'gemini'],
      [{ OPENAI_API_KEY: 'k-openai-0003' }, 'openai'],
      [{ LOCAL_LLM_API_KEY: 'k-local-0004' }, 'local'],
    ];
    for (const [env, provider] of cases) {
      await withApp({ ai: false, env }, async (h) => {
        const rows = byId(await h.get('/api/providers'));
        for (const id of ['gemini', 'openai', 'local']) assert.equal(rows[id].keySource, id === provider ? 'env' : 'none', `${Object.keys(env)[0]} -> ${id}`);
        assert.equal(rows[provider].configured, true);
        assert.doesNotMatch(JSON.stringify(rows), new RegExp(Object.values(env)[0]), 'the key itself is never in the catalog');
      });
    }
    // a blank variable does not count
    await withApp({ ai: false, env: { GEMINI_API_KEY: '   ', OPENAI_API_KEY: '' } }, async (h) => {
      const rows = byId(await h.get('/api/providers'));
      assert.deepEqual([rows.gemini.keySource, rows.openai.keySource], ['none', 'none']);
    });
  });

  it('configured needs a key for Gemini and OpenAI-compatible, never for the local provider', async () => {
    await withApp({ ai: false }, async (h) => {
      saveSettings(h.db, { ai: { providers: { openai: { apiKey: 'sk-saved-key-9999' } } } });
      const rows = byId(await h.get('/api/providers'));
      assert.deepEqual([rows.gemini.configured, rows.openai.configured, rows.local.configured], [false, true, true]);
      assert.equal(rows.openai.keySource, 'settings');
      assert.equal(rows.local.keySource, 'none', 'configured is true without a key, keySource stays "none"');
    });
  });
});

describe('the key typed into the form (overlay) is used once and then gone', () => {
  const OVERLAY_KEY = 'sk-overlay-NEVERSTORE-7788991122';

  it('never reaches a response, the request log, the error log or the database files, whatever the upstream does', async () => {
    const logged = [];
    const logger = { request: (i) => logged.push(JSON.stringify(i)), warn: (m, e) => logged.push(`${m} ${e && e.stack}`), error: (m, e) => logged.push(`${m} ${e && e.stack}`) };
    await withApp({ ai: false, config: { logger } }, async (h) => {
      const answers = [];
      const hostile = await createMockOpenAI({ failures: ['echo_key'], apiKey: [OVERLAY_KEY] });
      const good = await createMockOpenAI({ apiKey: [OVERLAY_KEY], models: ['m1'] });
      try {
        const port = await freePort();
        const attempts = [
          ['test', { provider: 'openai', config: { baseUrl: good.baseUrl, model: 'm1', apiKey: OVERLAY_KEY } }],
          ['test', { provider: 'openai', config: { baseUrl: hostile.baseUrl, apiKey: OVERLAY_KEY } }],
          ['test', { provider: 'openai', config: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: OVERLAY_KEY } }],
          ['test', { provider: 'openai', config: { baseUrl: 'http://127.0.0.1:6000/v1', apiKey: OVERLAY_KEY } }],
          ['test', { provider: 'openai', config: { baseUrl: 'not a url', apiKey: OVERLAY_KEY } }],
          ['test', { provider: 'gemini', config: { baseUrl: `http://127.0.0.1:${port}`, apiKey: OVERLAY_KEY } }],
          ['models', { provider: 'openai', config: { baseUrl: good.baseUrl, apiKey: OVERLAY_KEY } }],
          ['models', { provider: 'openai', config: { baseUrl: hostile.baseUrl, apiKey: OVERLAY_KEY } }],
          ['models', { provider: 'openai', config: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: OVERLAY_KEY } }],
          ['local/pull', { model: 'qwen2.5:1.5b', config: { baseUrl: good.baseUrl, apiKey: OVERLAY_KEY } }],
        ];
        for (const [route, body] of attempts) {
          const res = route === 'local/pull' ? await h.sse('/api/providers/local/pull', body) : await h.post(`/api/providers/${route}`, body);
          answers.push(route === 'local/pull' ? res.raw : res.text);
        }
        // a key the HTTP client cannot even put in a header (undici quotes the value in the error it throws)
        const odd = await h.post('/api/providers/test', { provider: 'openai', config: { baseUrl: good.baseUrl, apiKey: 'sch\u00fcssel-NEVERSTORE-5566' } });
        answers.push(odd.text);
        assert.equal(odd.json.ok, false);
      } finally {
        await hostile.close();
        await good.close();
      }
      const everything = [...answers, ...logged].join('\n');
      assert.ok(answers.length > 5 && logged.length > 5, 'something was answered and logged');
      assert.doesNotMatch(everything, /NEVERSTORE|OVERLAY/i, 'not in any response or log line');
      assert.equal(h.db.settings.exists(), false, 'saving nothing is what "test before you save" means');
      for (const name of readdirSync(h.dir)) assert.ok(!readFileSync(join(h.dir, name)).includes('NEVERSTORE'), `${name} does not contain the key`);
    });
  });
});

describe('Test connection waits long enough for a cold local model', () => {
  it('local gets the full configured timeout (up to 300 s), the hosted providers stay capped at 90 s', () => {
    assert.equal(testTimeoutCapMs('local'), 300_000);
    assert.equal(testTimeoutCapMs('openai'), 90_000);
    assert.equal(testTimeoutCapMs('gemini'), 90_000);
    const db = openDb({ file: ':memory:' });
    try {
      const ai = createAiService({ db, env: {} });
      // defaults: the 180 s first-byte allowance survives for the local provider, hosted ones are cut to 90 s
      assert.equal(ai.buildWithOverlay('local', {}, { timeoutCapMs: testTimeoutCapMs('local') }).cfg.timeoutMs, 180_000);
      assert.equal(ai.buildWithOverlay('openai', {}, { timeoutCapMs: testTimeoutCapMs('openai') }).cfg.timeoutMs, 90_000);
      assert.equal(ai.buildWithOverlay('gemini', {}, { timeoutCapMs: testTimeoutCapMs('gemini') }).cfg.timeoutMs, 90_000);
      db.settings.set({ ai: { timeoutSec: 600 } });
      assert.equal(ai.buildWithOverlay('local', {}, { timeoutCapMs: testTimeoutCapMs('local') }).cfg.timeoutMs, 300_000, 'never more than Node itself waits for headers');
    } finally {
      db.close();
    }
  });
});

describe('POST /api/providers/test', () => {
  it('connects to the saved provider and reports latency and a sample', async () => {
    await withApp({}, async (h) => {
      const res = await h.post('/api/providers/test', { provider: 'local' });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.provider, 'local');
      assert.equal(res.json.model, 'llama3.2:3b');
      assert.equal(typeof res.json.latencyMs, 'number');
      assert.equal(typeof res.json.sample, 'string');
      assert.deepEqual(Object.keys(res.json).sort(), ['latencyMs', 'model', 'ok', 'provider', 'sample']);
      assert.equal(h.mock.chatRequests().length, 1);
    });
  });

  it('tests an unsaved configuration without saving it, and never echoes or stores the key', async () => {
    await withApp({ ai: false }, async (h) => {
      const other = await createMockOpenAI({ apiKey: [SECRET], models: ['special-model'] });
      try {
        const before = JSON.stringify(h.db.settings.get());
        const res = await h.post('/api/providers/test', { provider: 'openai', config: { baseUrl: other.baseUrl, model: 'special-model', apiKey: SECRET } });
        assert.equal(res.status, 200);
        assert.equal(res.json.ok, true);
        assert.equal(res.json.model, 'special-model');
        assert.equal(other.lastChatRequest().headers.authorization, `Bearer ${SECRET}`);
        assert.equal(other.lastChatRequest().body.model, 'special-model');
        assert.doesNotMatch(res.text, new RegExp(SECRET));
        assert.equal(JSON.stringify(h.db.settings.get()), before, 'nothing was persisted');
        const settings = (await h.get('/api/settings')).json;
        assert.equal(settings.ai.providers.openai.apiKeySet, false);
        assert.equal(settings.ai.providers.openai.baseUrl, 'https://api.openai.com/v1');
        assert.doesNotMatch(JSON.stringify(settings), new RegExp(SECRET));
      } finally {
        await other.close();
      }
    });
  });

  it('lets the overlay win over saved values, field by field', async () => {
    await withApp({}, async (h) => {
      const other = await createMockOpenAI({});
      try {
        const res = await h.post('/api/providers/test', { provider: 'local', config: { baseUrl: other.baseUrl, model: '', apiKey: '' } });
        assert.equal(res.json.ok, true);
        assert.equal(res.json.model, 'llama3.2:3b', 'an empty overlay field keeps the saved value');
        assert.equal(other.chatRequests().length, 1);
        assert.equal(h.mock.chatRequests().length, 0, 'the saved server was not contacted');
      } finally {
        await other.close();
      }
    });
  });

  it('answers 200 with ok:false and a readable error for every provider failure', async () => {
    const cases = [
      [{ failures: ['unauthorized'] }, 'auth'],
      [{ failures: ['model_not_found'] }, 'model_not_found'],
      [{ failures: ['server_error'] }, 'server'],
      [{ failures: ['quota'] }, 'quota'],
      [{ failures: ['html'] }, 'server'],
    ];
    for (const [mock, code] of cases) {
      await withApp({ mock }, async (h) => {
        const res = await h.post('/api/providers/test', { provider: 'local' });
        assert.equal(res.status, 200, code);
        assert.equal(res.json.ok, false, code);
        assert.equal(res.json.provider, 'local');
        assert.equal(res.json.error.code, code);
        assert.equal(typeof res.json.error.message, 'string');
        assert.ok(res.json.error.message.length > 0);
        assert.equal('sample' in res.json, false);
      });
    }
  });

  it('reports an unreachable server and a malformed address', async () => {
    await withApp({}, async (h) => {
      const port = await freePort();
      const down = await h.post('/api/providers/test', { provider: 'local', config: { baseUrl: `http://127.0.0.1:${port}/v1` } });
      assert.equal(down.status, 200);
      assert.equal(down.json.ok, false);
      assert.equal(down.json.error.code, 'network');
      assert.ok(down.json.error.hint);
      const junk = await h.post('/api/providers/test', { provider: 'local', config: { baseUrl: 'this is not a url' } });
      assert.equal(junk.status, 200);
      assert.equal(junk.json.ok, false);
      assert.equal(junk.json.error.code, 'bad_base_url');
    });
  });

  it('names a blocked port (6000, 10080: fetch refuses them) instead of calling the address invalid', async () => {
    await withApp({}, async (h) => {
      for (const port of [6000, 10080]) {
        const res = await h.post('/api/providers/test', { provider: 'local', config: { baseUrl: `http://127.0.0.1:${port}/v1` } });
        assert.equal(res.status, 200);
        assert.equal(res.json.ok, false);
        assert.equal(res.json.error.code, 'bad_base_url');
        assert.equal(res.json.error.message, 'That port is blocked.');
        assert.match(res.json.error.hint, new RegExp(`port ${port} is on it`));
        assert.match(res.json.error.hint, /another port/);
        assert.doesNotMatch(res.text, /not valid/);
      }
      const models = await h.post('/api/providers/models', { provider: 'local', config: { baseUrl: 'http://127.0.0.1:6000/v1' } });
      assert.equal(models.json.error.message, 'That port is blocked.');
    });
  });

  it('scrubs an overlay key that a hostile server repeats in its error', async () => {
    await withApp({ ai: false }, async (h) => {
      const hostile = await createMockOpenAI({ failures: ['echo_key'] });
      try {
        const res = await h.post('/api/providers/test', { provider: 'openai', config: { baseUrl: hostile.baseUrl, apiKey: SECRET } });
        assert.equal(res.status, 200);
        assert.equal(res.json.ok, false);
        assert.doesNotMatch(res.text, new RegExp(SECRET));
        assert.doesNotMatch(res.text, /123456/);
      } finally {
        await hostile.close();
      }
    });
  });

  it('asks for a key when the provider needs one and none is known', async () => {
    await withApp({ ai: false, mock: undefined }, async (h) => {
      const other = await createMockOpenAI({ apiKey: ['whatever'] });
      try {
        const res = await h.post('/api/providers/test', { provider: 'openai', config: { baseUrl: other.baseUrl } });
        assert.equal(res.json.ok, false);
        assert.equal(res.json.error.code, 'auth');
      } finally {
        await other.close();
      }
    });
  });

  it('works for the Gemini adapter with a key in the overlay (header only)', async () => {
    await withApp({ ai: 'gemini' }, async (h) => {
      const ok = await h.post('/api/providers/test', { provider: 'gemini' });
      assert.equal(ok.json.ok, true);
      assert.equal(ok.json.model, 'gemini-flash-lite-latest');
      const bad = await h.post('/api/providers/test', { provider: 'gemini', config: { apiKey: 'wrong-gemini-key-000' } });
      assert.equal(bad.json.ok, false);
      assert.equal(bad.json.error.code, 'auth');
      assert.doesNotMatch(bad.text, /wrong-gemini-key-000/);
      const request = h.mock.requests.filter((r) => r.method === 'POST').at(-1);
      assert.equal(request.headers['x-goog-api-key'], 'wrong-gemini-key-000');
      assert.ok(!request.path.includes('wrong-gemini-key') && !JSON.stringify(request.query).includes('wrong-gemini-key'));
      assert.equal(h.db.settings.get().ai.providers.gemini.apiKey, 'test-gemini-key', 'the saved key is untouched');
    });
  });

  it('validates the request', async () => {
    await withApp({}, async (h) => {
      const bad = [
        {}, { provider: 'nope' }, { provider: 5 }, { provider: 'local', config: 'x' }, { provider: 'local', config: [] },
        { provider: 'local', config: { baseUrl: 5 } }, { provider: 'local', config: { model: {} } }, { provider: 'local', config: { apiKey: false } },
        { provider: 'local', config: { baseUrl: `http://x/${'a'.repeat(2100)}` } }, { provider: 'local', config: { apiKey: 'k'.repeat(600) } },
        { provider: 'local', config: { model: 'm'.repeat(300) } },
      ];
      for (const body of bad) {
        const res = await h.post('/api/providers/test', body);
        assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
        assert.equal(res.json.error.code, 'bad_request');
      }
      assert.equal((await h.request('POST', '/api/providers/test', { rawBody: '[]' })).status, 400);
      assert.equal(h.mock.chatRequests().length, 0);
    });
  });

  it('stops the model call when the caller goes away', async () => {
    await withApp({ mock: { failures: ['hang'] } }, async (h) => {
      const stream = h.stream('/api/providers/test', { provider: 'local' });
      await h.mock.waitForRequests(1, { filter: (r) => /chat\/completions/.test(r.path) });
      stream.abort();
      await stream.finished;
      await h.mock.waitForIdle();
      assert.equal(h.mock.chatRequests()[0].aborted, true);
    });
  });
});

describe('POST /api/providers/models', () => {
  it('lists the models of the saved provider', async () => {
    await withApp({}, async (h) => {
      const res = await h.post('/api/providers/models', { provider: 'local' });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.deepEqual(res.json.models.map((m) => m.id), ['gpt-4o-mini', 'llama3.2:3b', 'mock-model']);
      assert.ok(res.json.models.every((m) => typeof m.label === 'string'));
      assert.equal('error' in res.json, false);
    });
  });

  it('uses an unsaved address and key, and does not echo or keep the key', async () => {
    await withApp({ ai: false }, async (h) => {
      const other = await createMockOpenAI({ apiKey: [SECRET], models: ['alpha', 'beta'] });
      try {
        const res = await h.post('/api/providers/models', { provider: 'openai', config: { baseUrl: other.baseUrl, apiKey: SECRET } });
        assert.deepEqual(res.json.models.map((m) => m.id), ['alpha', 'beta']);
        assert.doesNotMatch(res.text, new RegExp(SECRET));
        assert.equal(h.db.settings.get().ai.providers.openai.apiKey, '');
        assert.equal(h.db.settings.get().ai.providers.openai.baseUrl, 'https://api.openai.com/v1');
      } finally {
        await other.close();
      }
    });
  });

  it('lists the Gemini chat models only', async () => {
    await withApp({ ai: 'gemini' }, async (h) => {
      const res = await h.post('/api/providers/models', { provider: 'gemini' });
      assert.equal(res.json.ok, true);
      const ids = res.json.models.map((m) => m.id);
      assert.ok(ids.length > 0);
      assert.ok(ids.every((id) => /^(gemini|gemma)-/.test(id) && !/embed|imagen|veo|tts|image/.test(id)), ids.join(','));
    });
  });

  it('answers 200 with ok:false and an empty list when the provider fails', async () => {
    await withApp({ mock: { modelsFailures: ['unauthorized'] } }, async (h) => {
      const res = await h.post('/api/providers/models', { provider: 'local' });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, false);
      assert.deepEqual(res.json.models, []);
      assert.equal(res.json.error.code, 'auth');
    });
    await withApp({}, async (h) => {
      const port = await freePort();
      const res = await h.post('/api/providers/models', { provider: 'local', config: { baseUrl: `http://127.0.0.1:${port}/v1` } });
      assert.equal(res.json.ok, false);
      assert.equal(res.json.error.code, 'network');
    });
  });

  it('rejects unknown providers and malformed config', async () => {
    await withApp({}, async (h) => {
      assert.equal((await h.post('/api/providers/models', { provider: 'x' })).status, 400);
      assert.equal((await h.post('/api/providers/models', { provider: 'local', config: 3 })).status, 400);
    });
  });
});

describe('POST /api/providers/local/pull', () => {
  it('streams progress events and ends with done', async () => {
    await withApp({ mock: { pull: { steps: 4 } } }, async (h) => {
      const stream = await h.sse('/api/providers/local/pull', { model: 'qwen2.5:1.5b' });
      assert.equal(stream.status, 200);
      assert.match(stream.headers['content-type'], /text\/event-stream/);
      const names = stream.names();
      assert.equal(names.at(-1), 'done');
      assert.deepEqual(stream.of('done')[0], {});
      assert.ok(names.filter((n) => n === 'progress').length >= 5);
      assert.ok(!names.includes('error'));
      const progress = stream.of('progress');
      assert.equal(progress[0].status, 'pulling manifest');
      const sized = progress.filter((p) => typeof p.total === 'number');
      assert.ok(sized.length >= 3);
      assert.ok(sized.every((p) => typeof p.completed === 'number' && p.completed <= p.total));
      assert.ok(sized.some((p) => typeof p.percent === 'number'));
      assert.equal(progress.at(-1).status, 'success');
      for (const p of progress) assert.deepEqual(Object.keys(p).filter((k) => !['status', 'completed', 'total', 'percent'].includes(k)), []);
      assert.ok(h.mock.behavior.models.includes('qwen2.5:1.5b'), 'Ollama now has the model');
      assert.equal(h.app.generations.size, 0);
    });
  });

  it('uses a base URL from the request and answers 409 not_ollama for anything else', async () => {
    await withApp({ ai: false }, async (h) => {
      const ollama = await createMockOpenAI({});
      const plain = await createMockOpenAI({ ollama: false });
      try {
        const ok = await h.sse('/api/providers/local/pull', { model: 'gemma2:2b', config: { baseUrl: ollama.baseUrl } });
        assert.equal(ok.names().at(-1), 'done');
        const llama = await h.sse('/api/providers/local/pull', { model: 'gemma2:2b', config: { baseUrl: plain.baseUrl } });
        assert.equal(llama.status, 409);
        assert.match(llama.headers['content-type'], /json/);
        assert.equal(llama.error.code, 'not_ollama');
        assert.ok(llama.error.hint);
        const port = await freePort();
        const down = await h.sse('/api/providers/local/pull', { model: 'gemma2:2b', config: { baseUrl: `http://127.0.0.1:${port}/v1` } });
        assert.equal(down.status, 409);
        assert.equal(down.error.code, 'not_ollama');
        assert.equal(h.app.generations.size, 0, 'a refused pull frees the lock');
      } finally {
        await ollama.close();
        await plain.close();
      }
    });
  });

  it('validates the model name before doing anything', async () => {
    await withApp({}, async (h) => {
      for (const body of [{}, { model: '' }, { model: 5 }, { model: 'bad name' }, { model: '../etc' }, { model: 'a'.repeat(300) }, { model: 'x;rm -rf' }, { model: 'ok', config: 5 }]) {
        const res = await h.sse('/api/providers/local/pull', body);
        assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
        assert.equal(res.error.code, 'bad_request');
      }
      assert.equal(h.mock.requests.length, 0);
    });
  });

  it('turns Ollama problems into error events', async () => {
    await withApp({}, async (h) => {
      const missing = await h.sse('/api/providers/local/pull', { model: 'nonexistent-model' });
      assert.equal(missing.names().at(-1), 'error');
      assert.equal(missing.of('error')[0].error.code, 'model_not_found');
      h.mock.setBehavior({ pull: { failMidway: true, steps: 6 } });
      const disk = await h.sse('/api/providers/local/pull', { model: 'llama3.2:1b' });
      assert.ok(disk.of('progress').length >= 3);
      assert.equal(disk.names().at(-1), 'error');
      assert.equal(disk.of('error')[0].error.code, 'server');
      assert.match(disk.of('error')[0].error.message + disk.of('error')[0].error.hint, /./);
      h.mock.setBehavior({ pull: { failMidway: false, truncate: true, steps: 3 } });
      const cut = await h.sse('/api/providers/local/pull', { model: 'llama3.2:1b' });
      assert.equal(cut.of('error')[0].error.code, 'network');
      assert.ok(!cut.names().includes('done'));
    });
  });

  it('can be cancelled, and then runs again; only one download at a time', async () => {
    await withApp({ mock: { pull: { delayMs: 40, steps: 30 } } }, async (h) => {
      const first = h.stream('/api/providers/local/pull', { model: 'llama3.2:3b' });
      await first.waitForEvent('progress');
      const second = await h.sse('/api/providers/local/pull', { model: 'other:1b' });
      assert.equal(second.status, 409);
      assert.equal(second.error.code, 'generation_in_progress');
      first.abort();
      await first.finished;
      await h.mock.waitForIdle();
      const pullRequest = h.mock.requests.find((r) => /api\/pull/.test(r.path));
      assert.equal(pullRequest.aborted, true, 'Ollama was told to stop');
      await waitFor(() => h.app.generations.size === 0, { message: 'lock release' });
      h.mock.setBehavior({ pull: { delayMs: 0, steps: 2 } });
      assert.equal((await h.sse('/api/providers/local/pull', { model: 'llama3.2:3b' })).names().at(-1), 'done');
    });
  });
});

describe('PUT /api/settings and the environment seeds', () => {
  // Regression: PUT answered with the saved document while GET (and every provider call) used the document with
  // the environment's URL/model seeds applied, so the form showed one address right after saving and another
  // after a reload. Since then the seeds start a FRESH install only (see test/server/env-seed.test.js).
  const ENV = { OPENAI_BASE_URL: 'https://env.example/v1', LOCAL_LLM_BASE_URL: 'http://env-box:11434/v1', LOCAL_LLM_MODEL: 'env-model' };

  it('answers with exactly what the next GET returns', async () => {
    await withApp({ ai: false, env: ENV }, async (h) => {
      const patches = [
        { profile: { name: 'Sam' } },
        { ai: { providers: { openai: { model: 'gpt-4.1-mini', apiKey: 'sk-test-1234567890' } } } },
        { ai: { providers: { openai: { baseUrl: 'https://api.openai.com/v1' } } } }, // the built-in default, chosen on purpose
        { ai: { providers: { local: { model: 'llama3.2:3b', baseUrl: 'http://localhost:11434/v1' } } } },
        { ai: { providers: { local: { model: 'qwen2.5:1.5b' } } } },
      ];
      for (const patch of patches) {
        const put = await h.put('/api/settings', patch);
        assert.equal(put.status, 200, JSON.stringify(patch));
        const get = await h.get('/api/settings');
        assert.deepEqual(put.json, get.json, `PUT and GET disagree after ${JSON.stringify(patch)}`);
      }
      const settings = (await h.get('/api/settings')).json;
      assert.equal(settings.ai.providers.openai.baseUrl, 'https://api.openai.com/v1', 'a built-in default that was chosen explicitly is kept, whatever the environment says');
      assert.equal(settings.ai.providers.openai.model, 'gpt-4.1-mini');
      assert.equal(settings.ai.providers.local.baseUrl, 'http://localhost:11434/v1');
      assert.equal(settings.ai.providers.local.model, 'qwen2.5:1.5b');
      assert.equal(settings.ai.providers.openai.apiKeySet, true);
      assert.doesNotMatch(JSON.stringify(settings), /sk-test-1234567890/, 'the key never comes back');
    });
  });

  it('shows and keeps the seeds the first time settings are saved', async () => {
    await withApp({ ai: false, env: ENV }, async (h) => {
      const before = (await h.get('/api/settings')).json;
      assert.equal(before.ai.providers.local.baseUrl, 'http://env-box:11434/v1', 'a fresh install shows the seeds');
      const put = await h.put('/api/settings', { profile: { name: 'Robin' } });
      assert.equal(put.json.ai.providers.local.baseUrl, 'http://env-box:11434/v1');
      assert.equal(put.json.ai.providers.local.model, 'env-model');
      assert.equal(put.json.ai.providers.openai.baseUrl, 'https://env.example/v1');
      assert.equal(h.db.settings.get().ai.providers.local.model, 'env-model', 'persisted, so a later change of the environment cannot flip it');
      assert.equal(h.db.settings.get().ai.providers.openai.baseUrl, 'https://env.example/v1');
    });
  });
});

describe('providers and the environment', () => {
  it('seeds the local model and address from LOCAL_LLM_* for a fresh install', async () => {
    const mock = await createMockOpenAI({ models: ['env-model'] });
    try {
      await withApp({ ai: false, env: { LOCAL_LLM_BASE_URL: mock.baseUrl, LOCAL_LLM_MODEL: 'env-model' } }, async (h) => {
        const settings = (await h.get('/api/settings')).json;
        assert.equal(settings.ai.providers.local.baseUrl, mock.baseUrl);
        assert.equal(settings.ai.providers.local.model, 'env-model');
        assert.equal(h.db.settings.exists(), false, 'still a fresh install: nothing saved yet');
        // the first thing a person does: choose the local provider (this first save writes the seeds explicitly)
        assert.equal((await h.put('/api/settings', { ai: { provider: 'local' } })).status, 200);
        const test = await h.post('/api/providers/test', { provider: 'local' });
        assert.equal(test.json.ok, true);
        assert.equal(test.json.model, 'env-model');
        const { entry } = await h.entry({ content: 'hello from env config' });
        assert.equal((await h.sse(`/api/entries/${entry.id}/reply`, {})).names().at(-1), 'done');
        assert.equal(mock.lastChatRequest().body.model, 'env-model');
      });
    } finally {
      await mock.close();
    }
  });
});
