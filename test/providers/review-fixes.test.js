// Regression tests for the adversarial review of the providers module:
//  1. a 2xx answer that is not an AI API reply (web page, plain text, foreign JSON) must not pass test() and
//     must not be reported as a retryable "empty reply";
//  2. concurrent first requests on ONE adapter instance must each heal their own request;
//  3. the think filter must be linear in the size of a chunk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../../src/providers/index.js';
import { clearOpenAIQuirks } from '../../src/providers/openai.js';
import { clearGeminiQuirks } from '../../src/providers/gemini.js';
import { createThinkFilter, stripThinkBlocks } from '../../src/providers/think-filter.js';
import { HELLO, SYSTEM, USER, drain, fakeFetch, fakeSleep, withTimerCheck } from './helpers.js';

const rejection = (promise) => promise.then(() => assert.fail('expected a rejection'), (e) => e);
const reply = (body, type) => new Response(body, { status: 200, headers: type ? { 'content-type': type } : {} });
const KEY = 'AIzaTestKey-0123456789abcdef';

const openai = (id, fetch, opts = {}) => createProvider(id, {
  baseUrl: id === 'local' ? 'http://localhost:11434' : 'https://api.example.test/v1', model: 'm', apiKey: id === 'local' ? '' : 'sk-test-12345678',
}, { fetch, sleep: fakeSleep(), ...opts });
const gemini = (fetch, opts = {}) => createProvider('gemini', {
  baseUrl: 'https://gemini.example.test', model: 'gemini-flash-lite-latest', apiKey: KEY,
}, { fetch, sleep: fakeSleep(), ...opts });

// ---- 1. 2xx bodies that are not an AI API reply ------------------------------------------------------------

const NOT_AN_API = [
  ['an nginx welcome page', '<!doctype html><html><body><h1>Welcome to nginx!</h1></body></html>', 'text/html'],
  ['a page served without a content type', '<html><body>SPA shell</body></html>', null],
  ['plain text', 'OK', 'text/plain'],
  ['an SSE comment stream and nothing else', ': hello\n\n: still here\n\n', 'text/event-stream'],
  ['a JSON object from some other API', '{"status":"ok","version":"1.2.3"}', 'application/json'],
  ['a JSON array of unrelated things', '[{"id":1},{"id":2}]', 'application/json'],
];

for (const [name, body, type] of NOT_AN_API) {
  for (const id of ['openai', 'local']) {
    test(`${id}: ${name} answering 200 is a bad_base_url for test(), stream() and chat()`, async () => {
      const p = openai(id, fakeFetch(() => reply(body, type)));
      for (const [what, call] of [['test', () => p.test()], ['stream', () => drain(p.stream({ messages: HELLO }))], ['chat', () => p.chat({ messages: HELLO })]]) {
        const err = await rejection(call());
        assert.equal(err.code, 'bad_base_url', `${what}: ${err.message}`);
        assert.match(err.hint, /base URL|\/v1/, what);
        assert.doesNotMatch(err.hint, /Try again in a moment/, 'the user must not be sent in the wrong direction');
      }
    });
  }
  test(`gemini: ${name} answering 200 is a bad_base_url for test(), stream() and chat()`, async () => {
    const p = gemini(fakeFetch(() => reply(body, type)));
    for (const [what, call] of [['test', () => p.test()], ['stream', () => drain(p.stream({ messages: HELLO }))], ['chat', () => p.chat({ messages: HELLO })]]) {
      const err = await rejection(call());
      assert.equal(err.code, 'bad_base_url', `${what}: ${err.message}`);
      assert.match(err.hint, /base URL|generativelanguage/, what);
    }
  });
}

test('a web page is recognised from its first bytes: the rest of the body is not awaited and the connection is released', async () => {
  for (const make of [
    (f) => openai('openai', f, { idleTimeoutMs: 5000 }),
    (f) => gemini(f, { idleTimeoutMs: 5000 }),
  ]) {
    let cancelled = false;
    const f = fakeFetch(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('<!doctype html><html><head>')); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { 'content-type': 'text/html' } }));
    await withTimerCheck(assert, async () => {
      // Reading on would end in the 5 s idle timeout ('timeout'), not in this error.
      const err = await rejection(make(f).test());
      assert.equal(err.code, 'bad_base_url');
    });
    assert.equal(cancelled, true, 'the upstream body was cancelled');
  }
});

test('nothing is lost for real API replies: [DONE]-only, reasoning-only and ordinary streams behave as before', async () => {
  const doneOnly = openai('openai', fakeFetch(() => reply('data: [DONE]\n\n', 'text/event-stream')));
  assert.equal((await doneOnly.test()).ok, true, 'a server that spoke the protocol is a working connection');
  assert.equal((await rejection(doneOnly.chat({ messages: HELLO }))).code, 'empty');

  const reasoning = openai('openai', fakeFetch(() => reply(
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm' }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`, 'text/event-stream')));
  assert.deepEqual(await reasoning.test().then((r) => [r.ok, r.sample]), [true, '']);

  const usageOnly = openai('openai', fakeFetch(() => reply(
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 0 } })}\n\n`, 'text/event-stream')));
  assert.equal((await usageOnly.test()).ok, true);

  const gemFinishOnly = gemini(fakeFetch(() => reply(
    `data: ${JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 3 } })}\r\n\r\n`, 'text/event-stream')));
  assert.deepEqual(await gemFinishOnly.test().then((r) => [r.ok, r.sample]), [true, '']);
  assert.equal((await rejection(gemFinishOnly.chat({ messages: HELLO }))).code, 'empty');
});

test('an empty 2xx body: chat() says "empty", and test() does not claim a working connection', async () => {
  for (const p of [openai('openai', fakeFetch(() => reply('', 'text/event-stream'))), gemini(fakeFetch(() => reply('  \n', 'text/event-stream')))]) {
    assert.equal((await rejection(p.chat({ messages: HELLO }))).code, 'empty');
    assert.equal((await rejection(p.test())).code, 'empty');
  }
});

test('garbage SSE data lines: test() fails like chat() does instead of passing', async () => {
  const body = 'data: {not json at all\n\ndata: <html>nope</html>\n\n';
  const o = openai('openai', fakeFetch(() => reply(body, 'text/event-stream')));
  assert.equal((await rejection(o.chat({ messages: HELLO }))).code, 'server');
  assert.equal((await rejection(o.test())).code, 'server');
  const g = gemini(fakeFetch(() => reply(body, 'text/event-stream')));
  assert.equal((await rejection(g.test())).code, 'bad_base_url');
});

// ---- 2. concurrent first requests on one adapter instance --------------------------------------------------

/**
 * A fetch double for two concurrent requests on one instance. The first request is answered with `rejection`
 * at once; the second one is held back until a request that avoids the problem has been SENT (so the first
 * request has certainly healed already) and is then answered with the same rejection. Everything else succeeds.
 */
function racingFetch({ rejects, avoided, rejection: makeRejection, ok }) {
  const seen = [];
  let release;
  const healedFirst = new Promise((resolve) => { release = resolve; });
  let held = 0;
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    if (!rejects(body)) {
      if (avoided(body)) release();
      return ok();
    }
    held += 1;
    if (held === 2) await healedFirst; // the loser: its 400 is processed after the winner's retry went out
    return makeRejection();
  };
  fn.seen = seen;
  return fn;
}

const json400 = (message) => new Response(JSON.stringify({ error: { message } }), { status: 400, headers: { 'content-type': 'application/json' } });

test('openai: two concurrent first requests on one instance both heal the rejected max_tokens', async () => {
  clearOpenAIQuirks();
  const f = racingFetch({
    rejects: (b) => 'max_tokens' in b,
    avoided: (b) => 'max_completion_tokens' in b,
    rejection: () => json400("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."),
    ok: () => reply(`data: ${JSON.stringify({ choices: [{ delta: { content: 'fine' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, 'text/event-stream'),
  });
  const p = createProvider('openai', { baseUrl: 'https://proxy.example.test/v1', model: 'race-model', apiKey: 'sk-test-12345678' }, { fetch: f, sleep: fakeSleep() });
  const results = await Promise.allSettled([p.chat({ messages: HELLO, maxTokens: 50 }), p.chat({ messages: HELLO, maxTokens: 50 })]);
  assert.deepEqual(results.map((r) => (r.status === 'fulfilled' ? r.value.text : r.reason.message)), ['fine', 'fine']);
  assert.equal(f.seen.length, 4, 'two failures, two healed retries');
  // and the lesson was kept for the next call on the same instance
  await p.chat({ messages: HELLO, maxTokens: 50 });
  assert.ok('max_completion_tokens' in f.seen.at(-1) && !('max_tokens' in f.seen.at(-1)));
  assert.equal(f.seen.length, 5);
});

test('openai: concurrent requests that learn different lessons keep both of them', async () => {
  clearOpenAIQuirks();
  const seen = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    if ('max_tokens' in body) return json400("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'.");
    if ('temperature' in body) return json400("Unsupported value: 'temperature' does not support 0.5 with this model.");
    return reply(`data: ${JSON.stringify({ choices: [{ delta: { content: 'fine' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, 'text/event-stream');
  };
  const p = createProvider('openai', { baseUrl: 'https://proxy2.example.test/v1', model: 'race-model-2', apiKey: 'sk-test-12345678' }, { fetch: fetchFn, sleep: fakeSleep() });
  // A can only learn about temperature, B only about the token parameter; neither may erase the other's lesson.
  const results = await Promise.all([p.chat({ messages: HELLO, temperature: 0.5 }), p.chat({ messages: HELLO, maxTokens: 50 })]);
  assert.deepEqual(results.map((r) => r.text), ['fine', 'fine']);
  seen.length = 0;
  await p.chat({ messages: HELLO, maxTokens: 50, temperature: 0.5 });
  assert.equal(seen.length, 1, 'the next call needs no failing request at all');
  assert.ok(!('max_tokens' in seen[0]) && 'max_completion_tokens' in seen[0], 'token parameter lesson kept');
  assert.ok(!('temperature' in seen[0]), 'temperature lesson kept');
});

test('gemini: two concurrent first requests on one instance both drop the rejected thinkingConfig', async () => {
  clearGeminiQuirks();
  const f = racingFetch({
    rejects: (b) => Boolean(b.generationConfig && b.generationConfig.thinkingConfig),
    avoided: (b) => !(b.generationConfig && b.generationConfig.thinkingConfig),
    rejection: () => new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Thinking level LOW is not supported for this model.' } }), { status: 400, headers: { 'content-type': 'application/json' } }),
    ok: () => reply(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'fine' }] }, finishReason: 'STOP' }] })}\r\n\r\n`, 'text/event-stream'),
  });
  const p = createProvider('gemini', { baseUrl: 'https://gemini-race.example.test', model: 'gemini-race-model', apiKey: KEY, thinking: 'low' }, { fetch: f, sleep: fakeSleep() });
  const results = await Promise.allSettled([p.chat({ messages: HELLO, maxTokens: 50 }), p.chat({ messages: HELLO, maxTokens: 50 })]);
  assert.deepEqual(results.map((r) => (r.status === 'fulfilled' ? r.value.text : r.reason.message)), ['fine', 'fine']);
  assert.equal(f.seen.length, 4);
  await p.chat({ messages: HELLO });
  assert.equal(f.seen.length, 5, 'the next call goes straight to the working configuration');
  assert.equal(f.seen.at(-1).generationConfig.thinkingConfig, undefined);
});

test('gemini: two concurrent first requests on one instance both fold a rejected systemInstruction', async () => {
  clearGeminiQuirks();
  const f = racingFetch({
    rejects: (b) => Boolean(b.systemInstruction),
    avoided: (b) => !b.systemInstruction,
    rejection: () => new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Developer instruction is not enabled for models/gemma-race' } }), { status: 400, headers: { 'content-type': 'application/json' } }),
    ok: () => reply(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'fine' }] }, finishReason: 'STOP' }] })}\r\n\r\n`, 'text/event-stream'),
  });
  const p = createProvider('gemini', { baseUrl: 'https://gemini-race2.example.test', model: 'gemma-race', apiKey: KEY }, { fetch: f, sleep: fakeSleep() });
  const messages = [SYSTEM('RULES'), USER('hi')];
  const results = await Promise.allSettled([p.chat({ messages }), p.chat({ messages })]);
  assert.deepEqual(results.map((r) => (r.status === 'fulfilled' ? r.value.text : r.reason.message)), ['fine', 'fine']);
  assert.equal(f.seen.length, 4);
});

test('a lesson is only kept when the adapted request actually worked', async () => {
  clearOpenAIQuirks();
  let calls = 0;
  const fetchFn = async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    if ('max_tokens' in body) return json400("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'.");
    return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  };
  const p = createProvider('openai', { baseUrl: 'https://proxy3.example.test/v1', model: 'race-model-3', apiKey: 'sk-test-12345678' }, { fetch: fetchFn, sleep: fakeSleep() });
  assert.equal((await rejection(p.chat({ messages: HELLO, maxTokens: 5 }))).code, 'auth');
  assert.equal(calls, 2);
  assert.equal((await rejection(p.chat({ messages: HELLO, maxTokens: 5 }))).code, 'auth');
  assert.equal(calls, 4, 'the unverified guess was not baked in: the second call starts from the original parameters again');
});

// ---- 3. think filter performance ----------------------------------------------------------------------------

// The old implementation lower-cased the whole remaining buffer for every '<' and for every closed block, so these
// inputs took many seconds (200 KB of '<a>' ~ 6 s, 20 000 blocks ~ 5 s). Linear code needs milliseconds; the bound
// is generous so a slow CI machine cannot fail it, yet far below the quadratic cost.
const FAST_ENOUGH_MS = 1500;

function timed(fn) {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

test('think filter is linear: 200 KB of tag-like text in one chunk passes through unchanged and quickly', () => {
  const input = '<a>'.repeat(70_000);
  const { value, ms } = timed(() => stripThinkBlocks(input));
  assert.equal(value, input);
  assert.ok(ms < FAST_ENOUGH_MS, `took ${Math.round(ms)} ms`);
});

test('think filter is linear: 300 000 "<" characters', () => {
  const input = '<'.repeat(300_000);
  const { value, ms } = timed(() => stripThinkBlocks(input));
  assert.equal(value.length, input.length);
  assert.ok(ms < FAST_ENOUGH_MS, `took ${Math.round(ms)} ms`);
});

test('think filter is linear: 20 000 closed blocks in one chunk', () => {
  const input = '<think>x</think>'.repeat(20_000) + 'done';
  const { value, ms } = timed(() => stripThinkBlocks(input));
  assert.equal(value, 'done');
  assert.ok(ms < FAST_ENOUGH_MS, `took ${Math.round(ms)} ms`);
});

test('think filter is linear: blocks interleaved with tag-like text, and a huge unterminated block', () => {
  const mixed = '<b>hi</b> <THINK>x</THINK>'.repeat(10_000);
  const a = timed(() => stripThinkBlocks(mixed));
  assert.equal(a.value, '<b>hi</b> '.repeat(10_000));
  assert.ok(a.ms < FAST_ENOUGH_MS, `mixed took ${Math.round(a.ms)} ms`);

  const f = createThinkFilter();
  const b = timed(() => {
    let out = f.push('<think>');
    for (let i = 0; i < 200; i += 1) out += f.push('some very long reasoning </thin '.repeat(500));
    return out + f.end().text;
  });
  assert.equal(b.value, '');
  assert.ok(b.ms < FAST_ENOUGH_MS, `unterminated took ${Math.round(b.ms)} ms`);
});

test('think filter: results with many blocks in one chunk match the same text fed piece by piece', () => {
  const text = '<b>x</b> a < b <Think>1</Think>  keep <reasoning>2</reasoning>\n\ntail <thi <think>3</think>end <3';
  const whole = stripThinkBlocks(text.repeat(50));
  const f = createThinkFilter();
  let pieces = '';
  for (const ch of text.repeat(50)) pieces += f.push(ch);
  pieces += f.end().text;
  assert.equal(pieces, whole);
});

test('a non-streamed reply full of markup does not freeze the event loop', async () => {
  const content = '<b>'.repeat(50_000);
  const body = JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] });
  const p = createProvider('openai', { baseUrl: 'https://api.example.test/v1', model: 'm', apiKey: 'sk-test-12345678' }, {
    fetch: async () => reply(body, 'application/json'),
  });
  const started = performance.now();
  const r = await p.chat({ messages: HELLO });
  assert.equal(r.text, content.trim());
  assert.ok(performance.now() - started < FAST_ENOUGH_MS, 'finished quickly');
});
