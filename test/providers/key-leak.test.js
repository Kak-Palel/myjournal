// The API key must never appear in any error a provider throws: not in the message, hint, detail, cause,
// stack, JSON form or util.inspect form -- even when the (hostile) server repeats the key back to us,
// and even when the user pasted the key into the base URL.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import { createMockOpenAI } from '../mocks/mock-openai.js';
import { createMockGemini } from '../mocks/mock-gemini.js';
import { createProvider } from '../../src/providers/index.js';
import { clearOpenAIQuirks } from '../../src/providers/openai.js';
import { clearGeminiQuirks } from '../../src/providers/gemini.js';
import { ProviderError } from '../../src/providers/errors.js';
import { HELLO, closedPort, drain, fakeSleep } from './helpers.js';

const OPENAI_KEY = 'sk-LEAKCANARY-7f3a9c1e5b2d4086';
const GEMINI_KEY = 'AIzaLEAKCANARY-7f3a9c1e5b2d4086zz';
const SHORT_KEY = 'tiny-k3y'; // 8 chars: the shortest key that is scrubbed everywhere

const consoleCalls = [];
const realConsole = {};
before(() => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    realConsole[m] = console[m];
    console[m] = (...args) => { consoleCalls.push([m, args]); };
  }
});
after(() => {
  for (const m of Object.keys(realConsole)) console[m] = realConsole[m];
});

function collectStrings(value, out = [], seen = new Set(), depth = 0) {
  if (value === null || value === undefined || depth > 8) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (typeof value !== 'object' && typeof value !== 'function') { out.push(String(value)); return out; }
  if (seen.has(value)) return out;
  seen.add(value);
  for (const name of Object.getOwnPropertyNames(value)) {
    let v;
    try { v = value[name]; } catch { continue; }
    out.push(name);
    collectStrings(v, out, seen, depth + 1);
  }
  return out;
}

function assertNoKey(err, key, label) {
  assert.ok(err instanceof Error, `${label}: threw a non-error ${String(err)}`);
  const haystack = [
    String(err), err.message, err.hint, err.detail, err.stack, JSON.stringify(err), JSON.stringify(err.cause),
    util.inspect(err, { depth: 12, showHidden: true }), ...collectStrings(err),
  ].filter(Boolean).join('\n');
  assert.ok(!haystack.includes(key), `${label}: the key leaked into:\n${haystack.slice(0, 1500)}`);
  assert.ok(!haystack.includes(encodeURIComponent(key)), `${label}: the URL-encoded key leaked`);
  assert.ok(err instanceof ProviderError || err.name === 'AbortError', `${label}: unexpected ${err.name}`);
}

async function expectError(promise, key, label) {
  let err;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${label}: expected an error`);
  assertNoKey(err, key, label);
  return err;
}

// ---- OpenAI-compatible --------------------------------------------------------------------------------------

const OPENAI_FAILURES = [
  'unauthorized', 'echo_key', 'forbidden', 'model_not_found', 'not_found', 'rate_limit', 'quota', 'context_length', 'bad_request',
  'server_error', 'unavailable', 'html', 'redirect', 'hang', 'hang_after_headers', 'reset_before_response',
  { kind: 'stall', after: 2 }, { kind: 'reset', after: 2 }, 'malformed_only', { kind: 'error_in_stream', after: 1 }, 'think_only',
  'reasoning_only', 'empty', 'content_filter', 'length_empty',
  { kind: 'echo_key', status: 403 },
];

for (const id of ['openai', 'local']) {
  for (const errorStyle of ['openai', 'ollama', 'llamacpp']) {
    test(`no key leak: ${id} provider, ${errorStyle}-style errors, every failure kind (stream, chat, test, listModels)`, async () => {
      clearOpenAIQuirks();
      const mock = await createMockOpenAI({ errorStyle, apiKey: OPENAI_KEY, replies: ['fine'] });
      try {
        const make = (cfg = {}, idleTimeoutMs = 3000) => createProvider(id, {
          baseUrl: mock.baseUrl, model: 'mock-model', apiKey: OPENAI_KEY, timeoutMs: 3000, ...cfg,
        }, { sleep: fakeSleep(), idleTimeoutMs, graceMs: 100 });
        let count = 0;
        for (const spec of OPENAI_FAILURES) {
          const failure = typeof spec === 'string' ? { kind: spec, times: 3 } : { ...spec, times: 3 };
          const label = `${id}/${errorStyle}/${failure.kind}`;
          const silent = ['hang', 'hang_after_headers', 'stall'].includes(failure.kind);
          for (const how of ['stream', 'chat', 'test']) {
            mock.setBehavior({ failures: [failure] });
            const p = silent ? make({ timeoutMs: 100 }, 100) : make();
            const call = how === 'stream' ? drain(p.stream({ messages: HELLO })) : how === 'chat' ? p.chat({ messages: HELLO }) : p.test();
            let err;
            try { await call; } catch (e) { err = e; }
            // some kinds are legitimately survivable for test() (it accepts empty answers); the rest must not leak either way
            if (err) { assertNoKey(err, OPENAI_KEY, `${label}/${how}`); count += 1; }
          }
          mock.setBehavior({ modelsFailures: [failure] });
          await expectError(make(silent ? { timeoutMs: 100 } : {}).listModels(), OPENAI_KEY, `${label}/listModels`).catch((e) => {
            if (!/expected an error/.test(e.message)) throw e;
          });
        }
        assert.ok(count > 40, `only ${count} errors were exercised`);
        mock.setBehavior({ failures: [], modelsFailures: [], replies: ['fine'] });
        // the happy path still works with this key (the mock really requires it)
        assert.equal((await make({ timeoutMs: 3000 }).chat({ messages: HELLO })).text, 'fine');
        // and a wrong key is rejected by the mock and reported without echoing either key
        const wrong = make({ apiKey: 'sk-WRONGKEY-1234567890', timeoutMs: 3000 });
        const err = await expectError(wrong.chat({ messages: HELLO }), 'sk-WRONGKEY-1234567890', `${id}/wrong key`);
        assert.equal(err.code, 'auth');
      } finally {
        await mock.close();
      }
    });
  }
}

test('no key leak: the key is scrubbed from a server that echoes it, even a short one (>= 8 chars)', async () => {
  clearOpenAIQuirks();
  const mock = await createMockOpenAI({ failures: [{ kind: 'echo_key', times: 5 }] });
  try {
    for (const key of [SHORT_KEY, OPENAI_KEY, 'ollama-key-123']) {
      const p = createProvider('local', { baseUrl: mock.baseUrl, model: 'm', apiKey: key, timeoutMs: 3000 });
      const err = await expectError(p.chat({ messages: HELLO }), key, `echo ${key}`);
      assert.equal(err.code, 'auth');
      assert.ok(err.detail.includes('[redacted]'), err.detail);
    }
    // a 4-7 character key is scrubbed from upstream text too (but not from our own static hints)
    const p = createProvider('local', { baseUrl: mock.baseUrl, model: 'm', apiKey: 'ollama', timeoutMs: 3000 });
    const err = await p.chat({ messages: HELLO }).catch((e) => e);
    assert.ok(!/Incorrect API key provided: ollama/.test(JSON.stringify(err)), JSON.stringify(err));
  } finally {
    await mock.close();
  }
});

test('no key leak: keys pasted into the base URL (path, userinfo, query) never reach an error', async () => {
  const port = await closedPort();
  const urls = [
    `http://127.0.0.1:${port}/${OPENAI_KEY}/v1`,
    `http://user:${OPENAI_KEY}@127.0.0.1:${port}/v1`,
    `http://127.0.0.1:${port}/v1?key=${OPENAI_KEY}`,
    `http://127.0.0.1:${port}/v1?api_key=${encodeURIComponent(OPENAI_KEY)}`,
    `http://${OPENAI_KEY}.invalid/v1`,
  ];
  for (const baseUrl of urls) {
    for (const id of ['openai', 'local']) {
      const p = createProvider(id, { baseUrl, model: 'm', apiKey: OPENAI_KEY, timeoutMs: 2000 });
      await expectError(drain(p.stream({ messages: HELLO })), OPENAI_KEY, `${id} ${baseUrl.replace(OPENAI_KEY, '<KEY>')} stream`);
      await expectError(p.listModels(), OPENAI_KEY, `${id} listModels`);
      await expectError(p.test(), OPENAI_KEY, `${id} test`);
    }
    const g = createProvider('gemini', { baseUrl, model: 'gemini-flash-latest', apiKey: OPENAI_KEY, timeoutMs: 2000 });
    await expectError(drain(g.stream({ messages: HELLO })), OPENAI_KEY, 'gemini stream with key in url');
    await expectError(g.listModels(), OPENAI_KEY, 'gemini listModels with key in url');
  }
});

test('no key leak: invalid inputs', async () => {
  const p = createProvider('openai', { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: OPENAI_KEY });
  for (const messages of [undefined, [], [{ role: 'user', content: 5 }], [{ role: 'x', content: 'y' }]]) {
    await expectError(drain(p.stream({ messages })), OPENAI_KEY, 'invalid input');
  }
  const ac = new AbortController();
  ac.abort();
  await expectError(drain(p.stream({ messages: HELLO, signal: ac.signal })), OPENAI_KEY, 'aborted');
});

// ---- Gemini -------------------------------------------------------------------------------------------------

const GEMINI_FAILURES = [
  'invalid_key', 'echo_key', 'missing_key', 'rate_limit', 'quota_daily', 'quota_zero', 'not_found', 'unavailable', 'internal', 'deadline',
  'region', 'bad_request', 'context_length', 'html', 'safety_prompt', 'safety_candidate', 'recitation', 'max_tokens_empty', 'thought_only',
  'empty', 'hang', 'hang_after_headers', 'reset_before_response', { kind: 'stall', after: 1 }, { kind: 'reset', after: 1 },
  { kind: 'error_in_stream', after: 1 }, 'json_array',
];

test('no key leak: Gemini, every failure kind (stream, chat, test, listModels)', async () => {
  clearGeminiQuirks();
  const mock = await createMockGemini({ apiKey: GEMINI_KEY, replies: ['fine'] });
  try {
    const make = (cfg = {}, idleTimeoutMs = 3000) => createProvider('gemini', {
      baseUrl: mock.url, model: 'gemini-flash-latest', apiKey: GEMINI_KEY, timeoutMs: 3000, ...cfg,
    }, { sleep: fakeSleep(), idleTimeoutMs, graceMs: 100 });
    let count = 0;
    for (const spec of GEMINI_FAILURES) {
      const failure = typeof spec === 'string' ? { kind: spec, times: 3 } : { ...spec, times: 3 };
      const silent = ['hang', 'hang_after_headers', 'stall'].includes(failure.kind);
      for (const how of ['stream', 'chat', 'test']) {
        mock.setBehavior({ failures: [failure] });
        const p = silent ? make({ timeoutMs: 100 }, 100) : make();
        const call = how === 'stream' ? drain(p.stream({ messages: HELLO })) : how === 'chat' ? p.chat({ messages: HELLO }) : p.test();
        let err;
        try { await call; } catch (e) { err = e; }
        if (err) { assertNoKey(err, GEMINI_KEY, `gemini/${failure.kind}/${how}`); count += 1; }
      }
      mock.setBehavior({ modelsFailures: [failure] });
      try { await make(silent ? { timeoutMs: 100 } : {}).listModels(); } catch (e) { assertNoKey(e, GEMINI_KEY, `gemini/${failure.kind}/listModels`); count += 1; }
    }
    assert.ok(count > 50, `only ${count} errors were exercised`);
    mock.setBehavior({ failures: [], modelsFailures: [], replies: ['fine'] });
    assert.equal((await make({ timeoutMs: 3000 }).chat({ messages: HELLO })).text, 'fine');
    // the key only ever travelled in a header
    for (const rq of mock.requests) {
      const wire = JSON.stringify([rq.path, rq.query, rq.rawBody]);
      assert.ok(!wire.includes(GEMINI_KEY), `key found in URL/body of ${rq.method} ${rq.path}`);
    }
    assert.ok(mock.requests.some((r) => r.headers['x-goog-api-key'] === GEMINI_KEY));
  } finally {
    await mock.close();
  }
});

test('no key leak: Gemini echo_key variants with short keys', async () => {
  const mock = await createMockGemini({ failures: [{ kind: 'echo_key', times: 9 }] });
  try {
    for (const key of [SHORT_KEY, GEMINI_KEY]) {
      const p = createProvider('gemini', { baseUrl: mock.url, model: 'gemini-flash-latest', apiKey: key, timeoutMs: 3000 });
      const err = await expectError(p.chat({ messages: HELLO }), key, `gemini echo ${key}`);
      assert.equal(err.code, 'auth');
    }
  } finally {
    await mock.close();
  }
});

test('the provider code never writes to the console (so a key cannot be logged)', () => {
  assert.deepEqual(consoleCalls, []);
});
