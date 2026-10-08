import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockGemini, INVALID_KEY_BODY, MISSING_KEY_BODY } from '../mocks/mock-gemini.js';
import { createProvider } from '../../src/providers/index.js';
import { clearGeminiQuirks, mapGeminiError } from '../../src/providers/gemini.js';
import { ProviderError } from '../../src/providers/errors.js';
import { HELLO, drain, fakeFetch, fakeSleep } from './helpers.js';

const KEY = 'AIzaTestKey-0123456789abcdef';
const CTX = { secrets: [KEY], model: 'gemini-2.5-flash', url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse' };
const map = (status, body, headers) => mapGeminiError({ status, text: typeof body === 'string' ? body : JSON.stringify(body), headers: headers && new Headers(headers), ctx: CTX });
const rejection = (p) => p.then(() => assert.fail('expected a rejection'), (e) => e);

// ---- the two bodies verified against the live service ------------------------------------------------------

test('LIVE FIXTURE: invalid key = HTTP 400 INVALID_ARGUMENT with ErrorInfo reason API_KEY_INVALID -> auth', () => {
  const live = '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID","domain":"googleapis.com","metadata":{"service":"generativelanguage.googleapis.com"}},{"@type":"type.googleapis.com/google.rpc.LocalizedMessage","locale":"en-US","message":"API key not valid. Please pass a valid API key."}]}}';
  assert.deepEqual(JSON.parse(live), INVALID_KEY_BODY, 'the mock serves exactly the live body');
  const err = map(400, live);
  assert.ok(err instanceof ProviderError);
  assert.equal(err.code, 'auth');
  assert.equal(err.status, 400);
  assert.equal(err.provider, 'gemini');
  assert.match(err.message, /rejected the API key/);
  assert.match(err.hint, /aistudio\.google\.com\/apikey/);
  assert.equal(err.detail, 'API key not valid. Please pass a valid API key.');
});

test('LIVE FIXTURE: missing key = HTTP 403 PERMISSION_DENIED "unregistered callers" -> auth with the "no API key was sent" hint', () => {
  const live = '{"error":{"code":403,"message":"Method doesn\'t allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.","status":"PERMISSION_DENIED"}}';
  assert.deepEqual(JSON.parse(live), MISSING_KEY_BODY);
  const err = map(403, live);
  assert.equal(err.code, 'auth');
  assert.equal(err.status, 403);
  assert.match(err.hint, /no API key was sent/);
  assert.match(err.hint, /Settings/);
});

// ---- Google's documented envelopes -------------------------------------------------------------------------

const RATE_LIMIT_PER_MINUTE = {
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-2.5-flash\nPlease retry in 12.5s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '5' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' },
    ],
  },
};

test('429 per-minute limit -> rate_limit with retryAfterMs parsed from RetryInfo', () => {
  const err = map(429, RATE_LIMIT_PER_MINUTE);
  assert.equal(err.code, 'rate_limit');
  assert.equal(err.retryAfterMs, 12000);
  assert.match(err.hint, /12 seconds/);
});

test('429 daily quota -> quota, whichever way the daily limit is signalled', () => {
  const perDay = JSON.parse(JSON.stringify(RATE_LIMIT_PER_MINUTE));
  perDay.error.details[0].violations[0].quotaId = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier';
  assert.equal(map(429, perDay).code, 'quota');
  assert.equal(map(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded: requests per day limit reached' } }).code, 'quota');
  assert.equal(map(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Exceeded the daily limit' } }).code, 'quota');
  assert.equal(map(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric ..., limit: 0, model: gemini-2.5-pro' } }).code, 'quota');
  // a per-minute violation wins even if the message also says "quota exceeded"
  assert.equal(map(429, RATE_LIMIT_PER_MINUTE).code, 'rate_limit');
  // plain 429 without details
  assert.equal(map(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).' } }).code, 'rate_limit');
  assert.equal(map(429, '').code, 'rate_limit');
});

test('retry delays: "3.5s" style durations and the Retry-After header as a fallback', () => {
  const withDelay = (retryDelay) => ({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'x', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] } });
  assert.equal(map(429, withDelay('3.5s')).retryAfterMs, 3500);
  assert.equal(map(429, withDelay('0s')).retryAfterMs, 0);
  assert.equal(map(429, withDelay('soon')).retryAfterMs, undefined);
  assert.equal(map(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'x' } }, { 'retry-after': '7' }).retryAfterMs, 7000);
});

test('NOT_FOUND -> model_not_found with a Load-models hint; a non-Google 404 -> bad_base_url', () => {
  const body = { error: { code: 404, message: 'models/gemini-nope is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.', status: 'NOT_FOUND' } };
  const err = map(404, body);
  assert.equal(err.code, 'model_not_found');
  assert.match(err.message, /gemini-2\.5-flash/);
  assert.match(err.hint, /Load models/);
  assert.equal(map(404, '404 page not found').code, 'bad_base_url');
  assert.equal(map(404, '<html>nope</html>').code, 'bad_base_url');
  assert.equal(map(404, '').code, 'bad_base_url');
});

test('retired model: 404 "no longer available to new users" -> model_not_found quoting Google\'s suggestion', () => {
  const body = { error: { code: 404, status: 'NOT_FOUND', message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements. We recommend you to use the Interactions API (https://ai.google.dev/gemini-api/docs/get-started).' } };
  const err = map(404, body);
  assert.equal(err.code, 'model_not_found');
  assert.match(err.message, /retired/);
  assert.equal(err.hint, 'Google suggests gemini-3.8-flash — pick a model from Load models in Settings.');
  const noSuggestion = map(404, { error: { code: 404, status: 'NOT_FOUND', message: 'This model is no longer available to new users.' } });
  assert.equal(noSuggestion.code, 'model_not_found');
  assert.match(noSuggestion.hint, /Load models/);
});

test('UNAVAILABLE / 503 -> overloaded (hint: switch to Flash-Lite); INTERNAL -> server; DEADLINE_EXCEEDED -> server', () => {
  const live = map(503, { error: { code: 503, message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.', status: 'UNAVAILABLE' } });
  assert.equal(live.code, 'overloaded');
  assert.match(live.hint, /switch to gemini-flash-lite-latest in Settings/);
  assert.equal(map(503, { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }).code, 'overloaded');
  assert.equal(map(503, '').code, 'overloaded');
  assert.equal(map(500, { error: { code: 500, message: 'An internal error has occurred.', status: 'INTERNAL' } }).code, 'server');
  assert.equal(map(504, { error: { code: 504, message: 'Deadline expired', status: 'DEADLINE_EXCEEDED' } }).code, 'server');
  assert.equal(map(502, '<html>Bad gateway</html>').code, 'server');
});

test('overloaded hint: Lite models are not told to switch to Flash-Lite; listing models (no model) keeps the generic advice', () => {
  const body = { error: { code: 503, message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.', status: 'UNAVAILABLE' } };
  const at = (model) => mapGeminiError({ status: 503, text: JSON.stringify(body), ctx: { ...CTX, model } });
  for (const model of ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'models/gemini-3.1-flash-lite-preview']) {
    const err = at(model);
    assert.equal(err.code, 'overloaded', model);
    assert.ok(!/switch to gemini-flash-lite-latest/.test(err.hint), model);
    assert.match(err.hint, /Try again in a moment/, model);
  }
  for (const model of ['gemini-flash-latest', 'gemini-3.8-flash', 'gemma-4-31b-it', '']) {
    assert.match(at(model).hint, /switch to gemini-flash-lite-latest in Settings/, model || '(none)');
  }
});

test('FAILED_PRECONDITION about location -> region; other FAILED_PRECONDITION is a plain bad_request', () => {
  const err = map(400, { error: { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' } });
  assert.equal(err.code, 'region');
  assert.match(err.hint, /billing|another provider/);
  assert.equal(map(400, { error: { code: 400, message: 'Gemini API free tier is not available in your country. Please enable billing on your project.', status: 'FAILED_PRECONDITION' } }).code, 'region');
  assert.equal(map(400, { error: { code: 400, message: 'The caller does not have the right state', status: 'FAILED_PRECONDITION' } }).code, 'bad_request');
});

test('other INVALID_ARGUMENT -> bad_request carrying Google\'s message; token overflow -> context_too_long', () => {
  const err = map(400, { error: { code: 400, message: 'Please ensure that multiturn requests alternate between user and model.', status: 'INVALID_ARGUMENT' } });
  assert.equal(err.code, 'bad_request');
  assert.match(err.message, /alternate between user and model/);
  assert.equal(map(400, { error: { code: 400, message: 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).', status: 'INVALID_ARGUMENT' } }).code, 'context_too_long');
  assert.equal(map(413, '').code, 'context_too_long');
});

test('auth variants: restricted keys, disabled API, expired key, 401, generic permission denied', () => {
  const info = (reason, extra = {}) => ({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'x', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, ...extra }] } });
  assert.match(map(403, info('API_KEY_HTTP_REFERRER_BLOCKED')).message, /restrictions/);
  assert.equal(map(403, info('API_KEY_IP_ADDRESS_BLOCKED')).code, 'auth');
  assert.equal(map(403, info('API_KEY_SERVICE_BLOCKED')).code, 'auth');
  const disabled = map(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Generative Language API has not been used in project 123 before or it is disabled.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] } });
  assert.equal(disabled.code, 'auth');
  assert.match(disabled.message, /not enabled/);
  assert.equal(map(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key expired. Please renew the API key.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } }).code, 'auth');
  assert.equal(map(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } }).code, 'auth');
  assert.equal(map(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Your API key was reported as leaked. Please use another API key.' } }).code, 'auth');
  assert.equal(map(401, '').code, 'auth');
});

test('streamed errors arrive as [{error}] arrays and are still understood', () => {
  const err = map(503, JSON.stringify([{ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }]));
  assert.equal(err.code, 'overloaded');
});

test('redirects, html pages and unknown statuses', () => {
  assert.equal(map(301, '', { location: 'https://elsewhere.example/' }).code, 'bad_base_url');
  assert.equal(map(418, '<!doctype html><html></html>').code, 'bad_base_url');
  assert.equal(map(418, { error: { message: 'teapot' } }).code, 'bad_request');
  assert.equal(map(200, { error: { code: 200, message: 'weird' } }).code, 'unknown');
});

test('upstream text is one short line and never carries the API key', () => {
  const echoed = map(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: `Bad request for key ${KEY}\n\n${'x'.repeat(2000)}` } });
  const text = JSON.stringify(echoed) + echoed.stack;
  assert.ok(!text.includes(KEY));
  assert.ok(echoed.message.length < 400);
  assert.ok(!echoed.message.includes('\n'));
});

// ---- round trips through the mock, with the retry policy ------------------------------------------------------

async function run(mockOpts, fn, { cfg = {}, sleep = fakeSleep() } = {}) {
  clearGeminiQuirks();
  const mock = await createMockGemini({ apiKey: KEY, ...mockOpts });
  try {
    const provider = createProvider('gemini', { baseUrl: mock.url, model: 'gemini-flash-lite-latest', apiKey: KEY, timeoutMs: 3000, ...cfg }, { sleep });
    return await fn({ mock, provider, sleep });
  } finally {
    await mock.close();
  }
}

const TABLE = [
  ['invalid_key', 'auth', 400],
  ['missing_key', 'auth', 403],
  ['rate_limit', 'rate_limit', 429],
  ['quota_daily', 'quota', 429],
  ['quota_zero', 'quota', 429],
  ['not_found', 'model_not_found', 404],
  ['model_retired', 'model_not_found', 404],
  ['internal', 'server', 500],
  ['deadline', 'server', 504],
  ['region', 'region', 400],
  ['bad_request', 'bad_request', 400],
  ['context_length', 'context_too_long', 400],
  ['html', 'server', 502],
];
for (const [kind, code, status] of TABLE) {
  test(`mock round trip: ${kind} -> ${code}`, async () => {
    await run({ failures: [{ kind, times: 3 }] }, async ({ provider, mock }) => {
      const err = await rejection(drain(provider.stream({ messages: HELLO })));
      assert.ok(err instanceof ProviderError, String(err));
      assert.equal(err.code, code, err.message);
      assert.equal(err.status, status);
      assert.equal(err.provider, 'gemini');
      assert.ok(err.hint);
      assert.equal(mock.generateRequests().length, 1, 'not retried');
    });
  });
}

test('a missing key really is sent without the header and gets the live 403; a wrong key the live 400', async () => {
  await run({}, async ({ mock }) => {
    const none = createProvider('gemini', { baseUrl: mock.url, model: 'gemini-flash-lite-latest', apiKey: '', timeoutMs: 3000 });
    const e1 = await rejection(drain(none.stream({ messages: HELLO })));
    assert.equal(e1.code, 'auth');
    assert.equal(e1.status, 403);
    assert.equal(mock.requests.at(-1).headers['x-goog-api-key'], undefined);
    const wrong = createProvider('gemini', { baseUrl: mock.url, model: 'gemini-flash-lite-latest', apiKey: 'nope-nope-nope', timeoutMs: 3000 });
    const e2 = await rejection(drain(wrong.stream({ messages: HELLO })));
    assert.equal(e2.status, 400);
    assert.match(e2.hint, /fresh key/);
  });
});

test('503 UNAVAILABLE is retried once, then surfaces as overloaded', async () => {
  await run({ failures: ['unavailable'], replies: ['Recovered.'] }, async ({ provider, mock, sleep }) => {
    assert.equal((await drain(provider.stream({ messages: HELLO }))).text, 'Recovered.');
    assert.equal(mock.generateRequests().length, 2);
    assert.deepEqual(sleep.waits, [1000]);
  });
  await run({ failures: [{ kind: 'unavailable', times: 5 }] }, async ({ provider, mock }) => {
    const err = await rejection(drain(provider.stream({ messages: HELLO })));
    assert.equal(err.code, 'overloaded');
    assert.equal(mock.generateRequests().length, 2);
  });
});

test('429: a short RetryInfo delay is waited out once; a long one (12s) or a daily quota is not', async () => {
  await run({ failures: [{ kind: 'rate_limit', retryDelay: '2s' }], replies: ['After waiting.'] }, async ({ provider, mock, sleep }) => {
    assert.equal((await drain(provider.stream({ messages: HELLO }))).text, 'After waiting.');
    assert.deepEqual(sleep.waits, [2000]);
    assert.equal(mock.generateRequests().length, 2);
  });
  await run({ failures: [{ kind: 'rate_limit', retryDelay: '12s', times: 3 }] }, async ({ provider, mock, sleep }) => {
    const err = await rejection(drain(provider.stream({ messages: HELLO })));
    assert.equal(err.code, 'rate_limit');
    assert.equal(err.retryAfterMs, 12000);
    assert.equal(mock.generateRequests().length, 1);
    assert.deepEqual(sleep.waits, []);
  });
  await run({ failures: [{ kind: 'rate_limit', retryDelay: '1s', times: 5 }] }, async ({ provider, mock }) => {
    await rejection(drain(provider.stream({ messages: HELLO })));
    assert.equal(mock.generateRequests().length, 2, 'only one automatic retry');
  });
  await run({ failures: [{ kind: 'quota_daily', times: 3 }] }, async ({ provider, mock }) => {
    await rejection(drain(provider.stream({ messages: HELLO })));
    assert.equal(mock.generateRequests().length, 1);
  });
});

test('a 400 about something other than thinking/system instructions is not retried', async () => {
  await run({ failures: [{ kind: 'bad_request', message: 'Invalid JSON payload received.', times: 3 }] }, async ({ provider, mock }) => {
    await rejection(drain(provider.stream({ messages: HELLO })));
    assert.equal(mock.generateRequests().length, 1);
  });
});

test('network failure keeps the URL in the hint but never the key', async () => {
  const p = createProvider('gemini', { baseUrl: 'http://no-such-host.invalid', model: 'gemini-flash-latest', apiKey: KEY, timeoutMs: 3000 });
  const err = await rejection(drain(p.stream({ messages: HELLO })));
  assert.equal(err.code, 'network');
  assert.match(err.hint, /no-such-host\.invalid\/v1beta\/models\/gemini-flash-latest:streamGenerateContent/);
  assert.ok(!JSON.stringify(err).includes(KEY));
});

test('a 200 JSON error object where a stream was expected (some proxies) is mapped, not parsed as an answer', async () => {
  const body = JSON.stringify([{ error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }]);
  const p = createProvider('gemini', { baseUrl: 'https://x.example', model: 'm', apiKey: KEY }, { fetch: fakeFetch(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) });
  const err = await rejection(drain(p.stream({ messages: HELLO })));
  assert.equal(err.code, 'rate_limit');
});
