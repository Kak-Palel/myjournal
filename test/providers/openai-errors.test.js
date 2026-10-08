import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockOpenAI } from '../mocks/mock-openai.js';
import { createProvider } from '../../src/providers/index.js';
import { clearOpenAIQuirks, healQuirks, mapOpenAIError } from '../../src/providers/openai.js';
import { ProviderError } from '../../src/providers/errors.js';
import { HELLO, USER, closedPort, drain, fakeFetch, fakeSleep, withTimerCheck } from './helpers.js';

async function run(mockOpts, fn, { id = 'openai', cfg = {}, opts = {}, sleep = fakeSleep() } = {}) {
  clearOpenAIQuirks();
  const mock = await createMockOpenAI(mockOpts);
  try {
    const provider = createProvider(id, { baseUrl: mock.baseUrl, model: 'mock-model', apiKey: '', timeoutMs: 5000, ...cfg }, { sleep, ...opts });
    return await fn({ mock, provider, sleep });
  } finally {
    await mock.close();
  }
}

const rejection = (promise) => promise.then(() => assert.fail('expected a rejection'), (e) => e);

// ---- error mapping through a real HTTP round trip ----------------------------------------------------------

const MAPPING = [
  // [name, failure spec, expected code, expected status, predicate on the error]
  ['401', 'unauthorized', 'auth', 401, (e) => /API key/.test(e.message)],
  ['403', 'forbidden', 'auth', 403],
  ['404 model (openai style)', 'model_not_found', 'model_not_found', 404, (e) => /mock-model/.test(e.message) && /Load models/.test(e.hint)],
  ['404 wrong URL', 'not_found', 'bad_base_url', 404, (e) => /\/v1/.test(e.hint)],
  ['429 quota', 'quota', 'quota', 429, (e) => /billing/.test(e.hint)],
  ['429 rate limit (long wait, not retried)', { kind: 'rate_limit', retryAfter: 30 }, 'rate_limit', 429, (e) => e.retryAfterMs === 30000 && /30 seconds/.test(e.hint)],
  ['400 context length', 'context_length', 'context_too_long', 400, (e) => /context/i.test(e.hint)],
  ['400 other', 'bad_request', 'bad_request', 400, (e) => /Invalid request/.test(e.message)],
  ['500', 'server_error', 'server', 500],
  ['502 html page', 'html', 'server', 502],
  ['301 redirect', 'redirect', 'bad_base_url', 301, (e) => /redirect/i.test(e.message)],
  ['http 408', { kind: 'http', status: 408, body: { error: { message: 'timeout' } } }, 'timeout', 408],
  ['http 413', { kind: 'http', status: 413, body: { error: { message: 'too big' } } }, 'context_too_long', 413],
  ['http 418 (unknown 4xx)', { kind: 'http', status: 418, body: { error: { message: 'teapot' } } }, 'bad_request', 418, (e) => /teapot/.test(e.message)],
  ['403 region block', { kind: 'http', status: 403, body: { error: { code: 'unsupported_country_region_territory', message: 'Country, region, or territory not supported' } } }, 'region', 403],
  ['400 unknown model', { kind: 'http', status: 400, body: { error: { message: 'Invalid model: foo', code: 'model_not_found' } } }, 'model_not_found', 400],
];

for (const style of ['openai', 'ollama', 'llamacpp']) {
  for (const [name, spec, code, status, check] of MAPPING) {
    test(`error mapping [${style}]: ${name} -> ${code}`, async () => {
      await run({ failures: [spec], errorStyle: style }, async ({ provider, mock }) => {
        const err = await rejection(drain(provider.stream({ messages: HELLO })));
        assert.ok(err instanceof ProviderError, String(err));
        assert.equal(err.code, code, `${err.message}`);
        assert.equal(err.status, status);
        assert.equal(err.provider, 'openai');
        assert.ok(err.message.length > 0 && err.hint !== '');
        if (check && style === 'openai') assert.ok(check(err), JSON.stringify(err));
        assert.equal(mock.chatRequests().length, 1, 'not retried');
      });
    });
  }
}

test('Ollama-style string error {error:"model \'x\' not found"} -> model_not_found with an `ollama pull` hint (local)', async () => {
  await run({ failures: [{ kind: 'model_not_found', model: 'llama3.2:3b' }], errorStyle: 'ollama' }, async ({ provider }) => {
    const err = await rejection(drain(provider.stream({ messages: HELLO })));
    assert.equal(err.code, 'model_not_found');
    assert.match(err.hint, /ollama pull mock-model/);
    assert.match(err.hint, /Download model/);
    assert.equal(err.provider, 'local');
  }, { id: 'local' });
});

test('llama.cpp-style {error:{code,message,type}} bodies', async () => {
  await run({ failures: ['context_length'], errorStyle: 'llamacpp' }, async ({ provider }) => {
    const err = await rejection(drain(provider.stream({ messages: HELLO })));
    assert.equal(err.code, 'context_too_long');
    assert.match(err.hint, /num_ctx|ctx-size/);
  }, { id: 'local' });
  await run({ failures: [{ kind: 'unavailable', message: 'Loading model' }, { kind: 'unavailable', message: 'Loading model' }], errorStyle: 'llamacpp' }, async ({ provider }) => {
    const err = await rejection(drain(provider.stream({ messages: HELLO })));
    assert.equal(err.code, 'server');
    assert.match(err.hint, /loading the model/);
  }, { id: 'local' });
});

test('mapOpenAIError: direct table for odd bodies', () => {
  const ctx = { provider: 'openai', secrets: [], model: 'gpt-x', url: 'https://api.openai.com/v1/chat/completions', hasKey: true };
  const map = (status, body, headers) => mapOpenAIError({ status, text: typeof body === 'string' ? body : JSON.stringify(body), headers: headers && new Headers(headers), ctx });
  assert.equal(map(401, '', undefined).code, 'auth');
  assert.equal(map(401, 'Unauthorized', undefined).code, 'auth');
  assert.equal(map(404, '', undefined).code, 'bad_base_url');
  assert.equal(map(404, '<html>Not Found</html>', undefined).code, 'bad_base_url');
  assert.equal(map(404, { error: { message: 'The model `gpt-x` does not exist' } }).code, 'model_not_found');
  assert.equal(map(404, { error: 'model "gpt-x" not found, try pulling it first' }).code, 'model_not_found');
  assert.equal(map(404, { detail: 'Not Found' }).code, 'bad_base_url');
  assert.equal(map(429, { error: { message: 'Rate limit', code: 'rate_limit_exceeded' } }, { 'retry-after': '4' }).retryAfterMs, 4000);
  assert.equal(map(429, { error: { type: 'insufficient_quota' } }).code, 'quota');
  assert.equal(map(429, 'You have run out of credits').code, 'quota');
  // OpenAI's ordinary rate-limit text links to the billing page; that must not turn it into a quota error
  const rl = 'Rate limit reached for gpt-4o-mini in organization org-abc on requests per min (RPM): Limit 3, Used 3, Requested 1. Please try again in 20s. Visit https://platform.openai.com/account/rate-limits to learn more. You can increase your rate limit by adding a payment method to your account at https://platform.openai.com/account/billing.';
  assert.equal(map(429, { error: { message: rl, type: 'requests', code: 'rate_limit_exceeded' } }).code, 'rate_limit');
  assert.equal(map(429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', code: 'insufficient_quota' } }).code, 'quota');
  assert.equal(map(429, { error: { message: 'Billing hard limit has been reached', code: 'billing_hard_limit_reached' } }).code, 'quota');
  assert.equal(map(429, { error: { message: 'Please check your billing details' } }).code, 'quota');
  assert.equal(map(302, '', { location: 'http://[bad' }).code, 'bad_base_url');
  assert.equal(map(429, 'Too many requests, slow down').code, 'rate_limit');
  assert.equal(map(402, { error: { message: 'Insufficient credits. Add more at openrouter.ai/credits' } }).code, 'quota');
  assert.equal(map(400, { error: { message: 'Context length exceeded' } }).code, 'context_too_long');
  assert.equal(map(400, { error: { code: 'context_length_exceeded', message: 'x' } }).code, 'context_too_long');
  assert.equal(map(400, { error: { message: 'maximum context length is 8192 tokens' } }).code, 'context_too_long');
  assert.equal(map(503, '', { 'retry-after': '2' }).retryAfterMs, 2000);
  assert.equal(map(529, '').code, 'overloaded');
  assert.equal(map(0, { error: { message: 'Rate limit hit', code: 'rate_limit_exceeded' } }).code, 'rate_limit');
  assert.equal(map(0, { error: { message: 'boom' } }).code, 'server');
  assert.equal(map(200, { error: { message: 'maximum context length is 8192 tokens' } }).code, 'context_too_long');
  assert.equal(map(302, '', { location: '/login' }).code, 'bad_base_url');
  assert.equal(map(302, '', { location: 'https://user:pw@other.example/login?x=1' }).code, 'bad_base_url');
  assert.ok(!JSON.stringify(map(302, '', { location: 'https://user:pw@other.example/login?x=1' })).includes('pw@'));
  const noKey = mapOpenAIError({ status: 401, text: '', ctx: { ...ctx, hasKey: false } });
  assert.match(noKey.message, /wants an API key/);
});

test('upstream error text is capped to one short line in the message', () => {
  const ctx = { provider: 'openai', secrets: [], model: 'm', url: 'https://x/v1/chat/completions', hasKey: true };
  const err = mapOpenAIError({ status: 500, text: JSON.stringify({ error: { message: `${'boom '.repeat(500)}\n\nline2` } }), ctx });
  assert.ok(err.message.length < 400, `${err.message.length}`);
  assert.ok(!err.message.includes('\n'));
});

test('connection refused -> network with the URL tried; local hint says `ollama serve`', async () => {
  const port = await closedPort();
  const p = createProvider('local', { baseUrl: `http://127.0.0.1:${port}`, model: 'llama3.2:3b', timeoutMs: 3000 });
  const err = await rejection(drain(p.stream({ messages: HELLO })));
  assert.equal(err.code, 'network');
  assert.match(err.hint, new RegExp(`127\\.0\\.0\\.1:${port}/v1/chat/completions`));
  assert.match(err.hint, /ollama serve/);
  const remote = createProvider('openai', { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', timeoutMs: 3000 });
  const err2 = await rejection(remote.listModels());
  assert.equal(err2.code, 'network');
  assert.doesNotMatch(err2.hint, /ollama serve/);
  assert.match(err2.hint, /\/v1\/models/);
});

test('DNS failure -> network', async () => {
  const p = createProvider('openai', { baseUrl: 'http://no-such-host.invalid/v1', model: 'm', timeoutMs: 5000 });
  const err = await rejection(drain(p.stream({ messages: HELLO })));
  assert.equal(err.code, 'network');
  assert.match(err.hint, /no-such-host\.invalid/);
});

// ---- retry rules --------------------------------------------------------------------------------------------

test('a short 429 is retried exactly once after the advertised wait, then succeeds', async () => {
  await run({ failures: [{ kind: 'rate_limit', retryAfter: 2 }], replies: ['After the retry.'] }, async ({ provider, mock, sleep }) => {
    const r = await drain(provider.stream({ messages: HELLO }));
    assert.equal(r.text, 'After the retry.');
    assert.equal(mock.chatRequests().length, 2);
    assert.deepEqual(sleep.waits, [2000]);
  });
});

test('429 without retry-after waits the default 1s; 429 > 8s is not retried; quota is never retried', async () => {
  await run({ failures: [{ kind: 'http', status: 429, body: { error: { message: 'slow down' } } }] }, async ({ provider, mock, sleep }) => {
    await drain(provider.stream({ messages: HELLO }));
    assert.deepEqual(sleep.waits, [1000]);
    assert.equal(mock.chatRequests().length, 2);
  });
  await run({ failures: [{ kind: 'rate_limit', retryAfter: 9 }] }, async ({ provider, mock, sleep }) => {
    const err = await rejection(drain(provider.stream({ messages: HELLO })));
    assert.equal(err.code, 'rate_limit');
    assert.equal(err.retryAfterMs, 9000);
    assert.equal(mock.chatRequests().length, 1);
    assert.deepEqual(sleep.waits, []);
  });
  await run({ failures: ['quota'] }, async ({ provider, mock }) => {
    await rejection(drain(provider.stream({ messages: HELLO })));
    assert.equal(mock.chatRequests().length, 1);
  });
});

test('there is at most ONE automatic retry, whichever mix of 429/503 comes back', async () => {
  for (const failures of [
    [{ kind: 'rate_limit', retryAfter: 1, times: 5 }],
    [{ kind: 'unavailable', times: 5 }],
    [{ kind: 'rate_limit', retryAfter: 1 }, { kind: 'unavailable', times: 5 }],
    [{ kind: 'unavailable' }, { kind: 'rate_limit', retryAfter: 1, times: 5 }],
  ]) {
    await run({ failures }, async ({ provider, mock, sleep }) => {
      await assert.rejects(drain(provider.stream({ messages: HELLO })), (e) => e instanceof ProviderError);
      assert.equal(mock.chatRequests().length, 2, JSON.stringify(failures));
      assert.equal(sleep.waits.length, 1);
    });
  }
});

test('503 is retried once (and honours retry-after when short); a long retry-after is not retried', async () => {
  await run({ failures: [{ kind: 'unavailable', retryAfter: 3 }] }, async ({ provider, mock, sleep }) => {
    await drain(provider.stream({ messages: HELLO }));
    assert.equal(mock.chatRequests().length, 2);
    assert.deepEqual(sleep.waits, [3000]);
  });
  await run({ failures: [{ kind: 'unavailable', retryAfter: 120 }] }, async ({ provider, mock }) => {
    await rejection(drain(provider.stream({ messages: HELLO })));
    assert.equal(mock.chatRequests().length, 1);
  });
});

test('500 and 401 are never retried', async () => {
  for (const kind of ['server_error', 'unauthorized', 'model_not_found']) {
    await run({ failures: [{ kind, times: 3 }] }, async ({ provider, mock }) => {
      await rejection(drain(provider.stream({ messages: HELLO })));
      assert.equal(mock.chatRequests().length, 1, kind);
    });
  }
});

test('the retry wait is abortable and leaves nothing behind', async () => {
  await withTimerCheck(assert, async () => {
    // real sleep this time: the Retry-After is 5s, we abort after the first request
    await run({ failures: [{ kind: 'rate_limit', retryAfter: 5 }] }, async ({ provider, mock }) => {
      const { sleep } = await import('../../src/providers/http.js');
      const real = createProvider('openai', { baseUrl: mock.baseUrl, model: 'm', timeoutMs: 5000 }, { sleep });
      const ac = new AbortController();
      const pending = drain(real.stream({ messages: HELLO, signal: ac.signal }));
      await mock.waitForRequests(1);
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await assert.rejects(pending, (e) => e.name === 'AbortError' && !(e instanceof ProviderError));
      assert.equal(mock.chatRequests().length, 1);
    });
  });
});

test('no retry once any output was delivered', async () => {
  await run({ failures: [{ kind: 'error_in_stream', after: 1 }, 'unavailable'] }, async ({ provider, mock }) => {
    await assert.rejects(drain(provider.stream({ messages: HELLO })));
    assert.equal(mock.chatRequests().length, 1);
  });
});

// ---- self-healing -------------------------------------------------------------------------------------------

test('400 mentioning max_tokens flips to max_completion_tokens and succeeds; the choice is remembered', async () => {
  await run({ rejectParams: ['max_tokens'], replies: ['one', 'two', 'three'] }, async ({ provider, mock }) => {
    const first = await drain(provider.stream({ messages: HELLO, maxTokens: 64 }));
    assert.equal(first.text, 'one');
    const bodies = mock.chatRequests().map((r) => r.body);
    assert.equal(bodies.length, 2);
    assert.ok('max_tokens' in bodies[0] && !('max_completion_tokens' in bodies[0]));
    assert.ok('max_completion_tokens' in bodies[1] && !('max_tokens' in bodies[1]));
    assert.equal(bodies[1].max_completion_tokens, 64);

    await drain(provider.stream({ messages: HELLO, maxTokens: 64 }));
    assert.equal(mock.chatRequests().length, 3, 'same instance: no repeated failing request');
    assert.ok('max_completion_tokens' in mock.chatRequests()[2].body);

    const fresh = createProvider('openai', { baseUrl: mock.baseUrl, model: 'mock-model', timeoutMs: 5000 });
    await drain(fresh.stream({ messages: HELLO, maxTokens: 64 }));
    assert.equal(mock.chatRequests().length, 4, 'a new instance for the same endpoint+model also starts with the learned parameter');
  });
});

test('the reverse flip: a server that rejects max_completion_tokens gets max_tokens', async () => {
  const bodies = [];
  const fetchFn = fakeFetch((url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if ('max_completion_tokens' in body) {
      return new Response(JSON.stringify({ error: { message: "Unrecognized request argument supplied: max_completion_tokens" } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  clearOpenAIQuirks();
  const p = createProvider('openai', { baseUrl: 'https://api.openai.com/v1', model: 'proxy-model', apiKey: 'sk-abcdefgh' }, { fetch: fetchFn });
  assert.equal((await drain(p.stream({ messages: HELLO, maxTokens: 10 }))).text, 'ok');
  assert.deepEqual(bodies.map((b) => Object.keys(b).filter((k) => k.startsWith('max'))), [['max_completion_tokens'], ['max_tokens']]);
});

test('400 mentioning temperature drops it; mentioning stream_options drops it', async () => {
  await run({ rejectParams: ['temperature'] }, async ({ provider, mock }) => {
    await drain(provider.stream({ messages: HELLO, temperature: 0.7 }));
    const [a, b] = mock.chatRequests().map((r) => r.body);
    assert.equal(a.temperature, 0.7);
    assert.equal('temperature' in b, false);
  });
  await run({ rejectParams: ['stream_options'] }, async ({ provider, mock }) => {
    const r = await drain(provider.stream({ messages: HELLO }));
    const [a, b] = mock.chatRequests().map((x) => x.body);
    assert.ok(a.stream_options);
    assert.equal('stream_options' in b, false);
    assert.equal(r.done.usage, undefined, 'no usage without stream_options');
  });
});

test('two rejected parameters need two adaptations: still succeeds (3 requests)', async () => {
  await run({ rejectParams: ['max_tokens', 'temperature'] }, async ({ provider, mock }) => {
    const r = await drain(provider.stream({ messages: HELLO, temperature: 0.5, maxTokens: 50 }));
    assert.ok(r.text.length > 0);
    assert.equal(mock.chatRequests().length, 3);
    const last = mock.chatRequests().at(-1).body;
    assert.equal('temperature' in last, false);
    assert.equal(last.max_completion_tokens, 50);
  });
});

test('three rejected parameters exceed the two-adaptation limit: a clear error, exactly 3 requests, no loop', async () => {
  await run({ rejectParams: ['max_tokens', 'temperature', 'stream_options'] }, async ({ provider, mock }) => {
    const err = await rejection(drain(provider.stream({ messages: HELLO, temperature: 0.5, maxTokens: 50 })));
    assert.equal(err.code, 'bad_request');
    assert.equal(err.status, 400);
    assert.equal(mock.chatRequests().length, 3);
  });
});

test('a server that rejects both token parameters cannot make us flip back and forth', async () => {
  await run({ rejectParams: ['max_tokens', 'max_completion_tokens'] }, async ({ provider, mock }) => {
    const err = await rejection(drain(provider.stream({ messages: HELLO, maxTokens: 50 })));
    assert.equal(err.code, 'bad_request');
    assert.equal(mock.chatRequests().length, 2);
  });
});

test('a 400 that names no adaptable parameter is not retried', async () => {
  await run({ failures: [{ kind: 'bad_request', message: 'Invalid request.' }] }, async ({ provider, mock }) => {
    await rejection(drain(provider.stream({ messages: HELLO, temperature: 0.5, maxTokens: 50 })));
    assert.equal(mock.chatRequests().length, 1);
  });
  await run({ failures: [{ kind: 'bad_request', message: 'temperature must be between 0 and 1' }] }, async ({ provider, mock }) => {
    await rejection(drain(provider.stream({ messages: HELLO, temperature: 1.5 })));
    assert.equal(mock.chatRequests().length, 1, 'a range complaint is not an "unsupported parameter" complaint');
  });
});

test('learning happens only after success: a failure with an unrelated error leaves the cache clean', async () => {
  clearOpenAIQuirks();
  await run({ rejectParams: ['max_tokens', 'temperature', 'stream_options'] }, async ({ provider }) => {
    await rejection(drain(provider.stream({ messages: HELLO, temperature: 0.5, maxTokens: 50 })));
  });
  await run({}, async ({ provider, mock }) => {
    await drain(provider.stream({ messages: HELLO, temperature: 0.5, maxTokens: 50 }));
    const body = mock.lastChatRequest().body;
    assert.equal(body.temperature, 0.5);
    assert.ok(body.stream_options);
  });
});

test('healQuirks: pure decisions', () => {
  const q = { tokenParam: 'max_tokens', dropTemperature: false, dropStreamOptions: false };
  const used = { hasTemperature: true, hasTokens: true, hasStreamOptions: true };
  assert.deepEqual(healQuirks(q, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", used),
    { tokenParam: 'max_completion_tokens', dropTemperature: false, dropStreamOptions: false });
  assert.equal(healQuirks(q, "Unsupported value: 'temperature' does not support 0.7 with this model.", used).dropTemperature, true);
  assert.equal(healQuirks(q, 'Unknown parameter: stream_options', used).dropStreamOptions, true);
  assert.equal(healQuirks(q, 'Unsupported parameter(s): temperature, stream_options', used).dropTemperature, true);
  assert.equal(healQuirks(q, 'max_tokens is too large: 100000', used), null);
  assert.equal(healQuirks(q, 'This model does not support images', used), null);
  assert.equal(healQuirks(q, "maximum context length. Unsupported max_tokens", used), null, 'context errors are never "healed"');
  assert.equal(healQuirks(q, 'Unsupported parameter: temperature', { ...used, hasTemperature: false }), null, 'nothing to drop');
  assert.equal(healQuirks({ ...q, dropTemperature: true }, 'Unsupported parameter: temperature', used), null, 'already dropped');
  assert.equal(healQuirks(q, '', used), null);
  assert.equal(healQuirks(q, undefined, used), null);
});

// ---- listModels / test() ------------------------------------------------------------------------------------

test('listModels: sorted alphabetically, de-duplicated, labels = ids', async () => {
  await run({ models: ['zeta-1', 'Alpha-2', 'beta-10', 'beta-9', 'gpt-4o-mini', 'zeta-1'] }, async ({ provider }) => {
    const models = await provider.listModels();
    assert.deepEqual(models.map((m) => m.id), ['Alpha-2', 'beta-9', 'beta-10', 'gpt-4o-mini', 'zeta-1']);
    assert.ok(models.every((m) => m.label === m.id));
  });
});

test('listModels tolerates {data:[...]}, {models:[...]}, bare arrays and llama.cpp', async () => {
  for (const modelsStyle of ['openai', 'llamacpp', 'array', 'models-key']) {
    await run({ modelsStyle, models: ['b-model', 'a-model'] }, async ({ provider }) => {
      assert.deepEqual((await provider.listModels()).map((m) => m.id), ['a-model', 'b-model'], modelsStyle);
    });
  }
});

test('listModels: empty list is fine, junk is a bad_base_url, errors are mapped', async () => {
  await run({ models: [] }, async ({ provider }) => assert.deepEqual(await provider.listModels(), []));
  const junk = createProvider('openai', { baseUrl: 'https://x.example/v1', model: 'm' }, {
    fetch: fakeFetch(() => new Response('{"hello":"world"}', { status: 200, headers: { 'content-type': 'application/json' } })),
  });
  assert.equal((await rejection(junk.listModels())).code, 'bad_base_url');
  const html = createProvider('openai', { baseUrl: 'https://x.example/v1', model: 'm' }, {
    fetch: fakeFetch(() => new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } })),
  });
  assert.equal((await rejection(html.listModels())).code, 'bad_base_url');
  await run({ modelsFailures: ['unauthorized'] }, async ({ provider }) => assert.equal((await rejection(provider.listModels())).code, 'auth'));
  await run({ modelsFailures: ['not_found'] }, async ({ provider }) => {
    const err = await rejection(provider.listModels());
    assert.equal(err.code, 'bad_base_url', 'a 404 on /models is about the address, not a model');
  });
  await run({ modelsFailures: ['hang'] }, async ({ provider, mock }) => {
    const ac = new AbortController();
    const pending = rejection(provider.listModels({ signal: ac.signal }));
    await mock.waitForRequests(1);
    ac.abort();
    assert.equal((await pending).name, 'AbortError');
  });
});

test('listModels: retried once for a short 429, and the request is a plain GET', async () => {
  await run({ modelsFailures: [{ kind: 'rate_limit', retryAfter: 1 }] }, async ({ provider, mock, sleep }) => {
    assert.equal((await provider.listModels()).length, 3);
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[1].method, 'GET');
    assert.equal(mock.requests[1].path, '/v1/models');
    assert.deepEqual(sleep.waits, [1000]);
  });
});

test('test(): ok, model, latency, sample; a tiny request with max tokens 16', async () => {
  await run({ replies: ['OK'] }, async ({ provider, mock }) => {
    const r = await provider.test();
    assert.deepEqual(Object.keys(r).sort(), ['latencyMs', 'model', 'ok', 'sample']);
    assert.equal(r.ok, true);
    assert.equal(r.model, 'mock-model');
    assert.equal(r.sample, 'OK');
    assert.ok(Number.isInteger(r.latencyMs) && r.latencyMs >= 0);
    const body = mock.lastChatRequest().body;
    assert.equal(body.max_tokens, 16);
    assert.equal(body.stream, true);
  });
});

test('test(): reasoning models that return nothing within 16 tokens still count as a working connection', async () => {
  await run({ failures: ['reasoning_only'] }, async ({ provider }) => {
    const r = await provider.test();
    assert.equal(r.ok, true);
    assert.equal(r.sample, '');
  });
});

test('test() throws the mapped ProviderError on failure', async () => {
  await run({ apiKey: 'right-key-123456' }, async ({ mock }) => {
    const p = createProvider('openai', { baseUrl: mock.baseUrl, model: 'm', apiKey: 'wrong-key-123456', timeoutMs: 3000 });
    const err = await rejection(p.test());
    assert.equal(err.code, 'auth');
    assert.equal(err.status, 401);
  });
  await run({ strictModel: true, models: ['a'], errorStyle: 'ollama' }, async ({ mock }) => {
    const p = createProvider('local', { baseUrl: mock.baseUrl, model: 'nope:1b', timeoutMs: 3000 });
    const err = await rejection(p.test());
    assert.equal(err.code, 'model_not_found');
    assert.match(err.hint, /ollama pull nope:1b/);
  });
  await run({ failures: ['hang'] }, async ({ provider }) => {
    const err = await rejection(provider.test());
    assert.equal(err.code, 'timeout');
  }, { cfg: { timeoutMs: 120 } });
});

test('strictModel mock: unknown model -> model_not_found; known model streams', async () => {
  await run({ strictModel: true, models: ['known'] }, async ({ mock }) => {
    const good = createProvider('openai', { baseUrl: mock.baseUrl, model: 'known', timeoutMs: 3000 });
    assert.ok((await drain(good.stream({ messages: HELLO }))).text.length > 0);
    const bad = createProvider('openai', { baseUrl: mock.baseUrl, model: 'unknown', timeoutMs: 3000 });
    assert.equal((await rejection(drain(bad.stream({ messages: HELLO })))).code, 'model_not_found');
  });
});

test('scripted replies: array consumed in order, functions get the request, then the deterministic responder', async () => {
  await run({
    replies: ['first', (ctx) => `second saw ${ctx.messages.at(-1).content}`, { text: 'third', finishReason: 'length' }],
  }, async ({ provider, mock }) => {
    assert.equal((await provider.chat({ messages: [USER('q1 here')] })).text, 'first');
    assert.equal((await provider.chat({ messages: [USER('q2 here')] })).text, 'second saw q2 here');
    const third = await provider.chat({ messages: [USER('q3 here')] });
    assert.equal(third.text, 'third');
    assert.equal(third.finishReason, 'length');
    assert.match((await provider.chat({ messages: [USER('I felt tired after the long meeting today.')] })).text, /\?$/);
    assert.equal(mock.replyCount, 4);
  });
});
