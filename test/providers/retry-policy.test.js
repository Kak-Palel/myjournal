// The automatic retry of sendWithPolicy (src/providers/common.js): ONE retry for a short 429 / any 503, but not when the
// failed attempt itself was slow. Verified live on gemini-flash-latest under load: a 503 that took 15 s to arrive was
// retried, the retry failed after another 15 s, and the person saw the error after 30 s instead of 15 s (the retry never
// succeeded in 3 observed pairs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendWithPolicy } from '../../src/providers/common.js';
import { MAX_AUTO_RETRY_WAIT_MS, createScope } from '../../src/providers/http.js';
import { ProviderError } from '../../src/providers/errors.js';
import { clearGeminiQuirks } from '../../src/providers/gemini.js';
import { createProvider } from '../../src/providers/index.js';
import { createMockGemini } from '../mocks/mock-gemini.js';
import { HELLO, fakeSleep } from './helpers.js';

const URL_TRIED = 'http://127.0.0.1:9/v1/chat/completions';

/**
 * Run sendWithPolicy against scripted attempts on a fake clock. `script` is a list of
 * { status, ms, retryAfterMs? } (ms = how long that attempt takes before the answer arrives).
 */
async function run(script, extra = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const sleep = fakeSleep();
  const scope = createScope({ firstByteMs: 600_000, ctx: { provider: 'gemini', secrets: [], url: URL_TRIED } });
  let call = 0;
  const fetchFn = async () => {
    const step = script[Math.min(call, script.length - 1)];
    call += 1;
    clock += step.ms;
    return new Response(JSON.stringify({ error: { message: `attempt ${call}` } }), {
      status: step.status,
      headers: step.retryAfterMs === undefined ? {} : { 'retry-after-ms': String(step.retryAfterMs) },
    });
  };
  try {
    const result = await sendWithPolicy({
      fetchFn,
      url: URL_TRIED,
      scope,
      sleepFn: sleep,
      now,
      buildInit: () => ({ method: 'POST', body: '{}' }),
      mapError: (res, text) => new ProviderError(res.status === 429 ? 'rate_limit' : res.status === 503 ? 'overloaded' : 'bad_request', text, {
        status: res.status,
        retryAfterMs: Number(res.headers.get('retry-after-ms')) || undefined,
      }),
      ...extra,
    });
    return { result, calls: call, sleep };
  } catch (error) {
    return { error, calls: call, sleep };
  } finally {
    scope.close(true);
  }
}

test('a quick 503 keeps its single automatic retry', async () => {
  const quick = await run([{ status: 503, ms: 300 }, { status: 200, ms: 50 }]);
  assert.equal(quick.error, undefined);
  assert.equal(quick.result.response.status, 200);
  assert.equal(quick.calls, 2);
  assert.deepEqual(quick.sleep.waits, [1000], 'the default 1 s wait');

  // still only ONE retry: a second quick 503 is final
  const twice = await run([{ status: 503, ms: 300 }]);
  assert.equal(twice.error.code, 'overloaded');
  assert.equal(twice.calls, 2);
});

test('a 503 whose attempt took longer than the maximum retry wait is not retried', async () => {
  const slow = await run([{ status: 503, ms: MAX_AUTO_RETRY_WAIT_MS + 1 }, { status: 200, ms: 50 }]);
  assert.equal(slow.error.code, 'overloaded');
  assert.equal(slow.error.status, 503);
  assert.equal(slow.calls, 1, 'one request only: the person waits once, not twice');
  assert.deepEqual(slow.sleep.waits, [], 'no retry wait either');

  const verySlow = await run([{ status: 503, ms: 15_000 }, { status: 200, ms: 50 }]);
  assert.equal(verySlow.calls, 1);
});

test('the limit is exclusive: an attempt of exactly the maximum retry wait is still retried', async () => {
  const edge = await run([{ status: 503, ms: MAX_AUTO_RETRY_WAIT_MS }, { status: 200, ms: 50 }]);
  assert.equal(edge.error, undefined);
  assert.equal(edge.calls, 2);
});

test('a slow 429 with a short retry-after is not retried either; a quick one is', async () => {
  const slow = await run([{ status: 429, ms: 9000, retryAfterMs: 1000 }, { status: 200, ms: 50 }]);
  assert.equal(slow.error.code, 'rate_limit');
  assert.equal(slow.calls, 1);
  const quick = await run([{ status: 429, ms: 200, retryAfterMs: 1500 }, { status: 200, ms: 50 }]);
  assert.equal(quick.error, undefined);
  assert.deepEqual(quick.sleep.waits, [1500]);
});

test('the speed of an attempt only matters for the automatic retry: self-healing after a slow 400 still happens', async () => {
  let healed = 0;
  const out = await run([{ status: 400, ms: 12_000 }, { status: 200, ms: 50 }], { adapt: () => { healed += 1; return true; } });
  assert.equal(out.error, undefined);
  assert.equal(out.calls, 2);
  assert.equal(healed, 1);
  assert.deepEqual(out.sleep.waits, [], 'a heal is not a retry wait');
});

test('each attempt is timed on its own: a quick 503 after a slow heal is still retried', async () => {
  const out = await run(
    [{ status: 400, ms: 12_000 }, { status: 503, ms: 100 }, { status: 200, ms: 50 }],
    { adapt: () => true, maxAdaptations: 1 },
  );
  assert.equal(out.error, undefined);
  assert.equal(out.calls, 3);
  assert.equal(out.sleep.waits.length, 1);
});

// ---- the real adapter against the Gemini mock, which answers 503 after a delay like the live API did ---------------

const KEY = 'AIzaMockLiveKey-0123456789';

async function withLive(opts, fn) {
  clearGeminiQuirks();
  const mock = await createMockGemini({ apiKey: KEY, live: true, ...opts });
  try {
    return await fn(mock);
  } finally {
    await mock.close();
  }
}
const providerFor = (mock, sleep) => createProvider('gemini', {
  baseUrl: mock.url, model: 'gemini-flash-latest', apiKey: KEY, timeoutMs: 30_000,
}, { sleep });

test('Gemini adapter + mock: a 503 that arrives after 8.1 s is reported at once, without a second attempt', async () => {
  await withLive({ overloadedModels: { 'gemini-flash-latest': { afterMs: MAX_AUTO_RETRY_WAIT_MS + 100 } } }, async (mock) => {
    const sleep = fakeSleep();
    const started = Date.now();
    const err = await providerFor(mock, sleep).chat({ messages: HELLO }).then(() => assert.fail('expected a rejection'), (e) => e);
    const took = Date.now() - started;
    assert.equal(err.code, 'overloaded');
    assert.equal(err.status, 503);
    assert.equal(mock.generateRequests().length, 1, 'no automatic retry after a slow failure');
    assert.deepEqual(sleep.waits, []);
    assert.ok(took >= MAX_AUTO_RETRY_WAIT_MS, `the one attempt took ${took} ms`);
    assert.ok(took < 2 * MAX_AUTO_RETRY_WAIT_MS, `and the error came right after it (${took} ms), not after a second attempt`);
  });
});

test('Gemini adapter + mock: a 503 that arrives after 0.3 s is retried once and the retry can succeed', async () => {
  await withLive({ overloadedModels: { 'gemini-flash-latest': { afterMs: 300, times: 1 } }, replies: ['Back again.'] }, async (mock) => {
    const sleep = fakeSleep();
    const r = await providerFor(mock, sleep).chat({ messages: HELLO });
    assert.equal(r.text, 'Back again.');
    assert.equal(mock.generateRequests().length, 2);
    assert.equal(sleep.waits.length, 1);
  });
});
