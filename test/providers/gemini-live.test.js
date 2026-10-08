// Replays the responses captured from the real Gemini service (test/fixtures/gemini-live/) through the adapter.
// These are ground truth: if the live service changes shape again, re-capture the fixtures and this file tells us
// what broke.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createProvider } from '../../src/providers/index.js';
import { clearGeminiQuirks } from '../../src/providers/gemini.js';
import { LIVE_MODELS } from '../mocks/mock-gemini.js';
import { HELLO, drain, twoWaySplits } from './helpers.js';

const DIR = new URL('../fixtures/gemini-live/', import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, DIR));
const KEY = 'AIzaLiveReplayKey-0123456789';

/** Status code and content type from a captured `.headers.txt` (the first block is the proxy's CONNECT answer). */
function captured(name) {
  const headers = read(`${name}.headers.txt`).toString('utf8');
  const status = Number(/^HTTP\/2 (\d{3})/m.exec(headers)[1]);
  const contentType = /^content-type: (.+)$/mi.exec(headers)[1].trim();
  return { status, contentType, body: read(`${name}.body`) };
}

/** A fetch double that serves one captured response, optionally delivering the body in the given pieces. */
function replayFetch(name, { pieces } = {}) {
  const { status, contentType, body } = captured(name);
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init, body: init && init.body ? JSON.parse(init.body) : null });
    const payload = pieces
      ? new ReadableStream({ start(c) { for (const p of pieces) c.enqueue(p); c.close(); } })
      : body;
    return new Response(payload, { status, headers: { 'content-type': contentType } });
  };
  fn.calls = calls;
  return fn;
}

const providerFor = (fetchFn, cfg = {}) => {
  clearGeminiQuirks();
  return createProvider('gemini', { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest', apiKey: KEY, timeoutMs: 5000, ...cfg }, { fetch: fetchFn });
};
const rejection = (p) => p.then(() => assert.fail('expected a rejection'), (e) => e);

test('LIVE: a normal streamed answer (CRLF frames, trailing empty-text frame with a thoughtSignature)', async () => {
  const fetchFn = replayFetch('stream-success');
  const r = await drain(providerFor(fetchFn).stream({ messages: HELLO }));
  assert.equal(r.text, 'Hello, my favorite color is blue!');
  assert.deepEqual(r.deltas, ['Hello,', ' my favorite color is blue!']);
  assert.equal(r.done.finishReason, 'stop');
  assert.deepEqual(r.done.usage, { promptTokens: 20, completionTokens: 8, totalTokens: 28 });
  assert.equal(fetchFn.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:streamGenerateContent?alt=sse');
  assert.equal(fetchFn.calls[0].init.headers['x-goog-api-key'], KEY);
});

test('LIVE: a thinking model\'s answer; thought tokens count in the total but no thought text appears', async () => {
  const r = await drain(providerFor(replayFetch('stream-success-with-thoughts')).stream({ messages: HELLO }));
  assert.equal(r.text, 'Hello there, my favorite color is blue!');
  assert.equal(r.done.finishReason, 'stop');
  assert.equal(r.done.usage.promptTokens, 20);
  assert.equal(r.done.usage.completionTokens, 9);
  assert.equal(r.done.usage.totalTokens, 227);
});

test('LIVE: thoughts ate the output budget -> MAX_TOKENS with a partial answer is kept and reported as finishReason length', async () => {
  const r = await drain(providerFor(replayFetch('stream-success-flash-latest-low')).stream({ messages: HELLO }));
  assert.equal(r.text, 'Hello there, it is wonderful to meet you,');
  assert.equal(r.done.finishReason, 'length');
});

test('LIVE: every success capture gives identical results however the body is cut (every 2-way split + byte by byte)', async () => {
  for (const name of ['stream-success', 'stream-success-with-thoughts', 'stream-success-flash-latest-low']) {
    const bytes = new Uint8Array(captured(name).body);
    const reference = await drain(providerFor(replayFetch(name)).stream({ messages: HELLO }));
    const check = async (pieces, label) => {
      const r = await drain(providerFor(replayFetch(name, { pieces })).stream({ messages: HELLO }));
      assert.equal(r.text, reference.text, `${name} ${label}`);
      assert.deepEqual(r.done, reference.done, `${name} ${label}`);
    };
    for (const [a, b] of twoWaySplits(bytes)) await check([a, b], `split ${a.length}`);
    await check(Array.from(bytes, (_, i) => bytes.subarray(i, i + 1)), 'byte by byte');
  }
});

test('LIVE: invalid key (400 API_KEY_INVALID) and missing key (403) -> auth with the right hints', async () => {
  const bad = await rejection(drain(providerFor(replayFetch('error-api-key-invalid')).stream({ messages: HELLO })));
  assert.equal(bad.code, 'auth');
  assert.equal(bad.status, 400);
  assert.match(bad.hint, /aistudio\.google\.com\/apikey/);
  const none = await rejection(drain(providerFor(replayFetch('error-no-key'), { apiKey: '' }).stream({ messages: HELLO })));
  assert.equal(none.code, 'auth');
  assert.equal(none.status, 403);
  assert.match(none.hint, /no API key was sent/);
});

test('LIVE: unknown model (404 NOT_FOUND) -> model_not_found; retired model -> model_not_found naming Google\'s suggestion', async () => {
  const unknown = await rejection(drain(providerFor(replayFetch('error-model-unknown'), { model: 'gemini-nope-9' }).stream({ messages: HELLO })));
  assert.equal(unknown.code, 'model_not_found');
  assert.match(unknown.message, /gemini-nope-9/);
  assert.match(unknown.hint, /Load models/);
  const retired = await rejection(drain(providerFor(replayFetch('error-model-retired'), { model: 'gemini-2.5-flash' }).stream({ messages: HELLO })));
  assert.equal(retired.code, 'model_not_found');
  assert.match(retired.message, /retired/);
  assert.match(retired.hint, /Google suggests gemini-3\.8-flash/);
  assert.match(retired.hint, /Load models/);
});

test('LIVE: the two errors that carry no useful words (empty input, ends with a model turn) are bad_request with Google\'s text', async () => {
  for (const [name, pattern] of [['error-empty-input', /empty input/], ['error-ends-with-model-turn', /ending with a model turn/]]) {
    const err = await rejection(drain(providerFor(replayFetch(name)).stream({ messages: HELLO })));
    assert.equal(err.code, 'bad_request', name);
    assert.match(err.message, pattern, name);
  }
});

test('LIVE: thinking "low" rejected with the captured 400 ("Thinking level ... is not supported") -> retried once without it', async () => {
  clearGeminiQuirks();
  const rejected = captured('error-thinking-minimal-unsupported');
  const success = captured('stream-success-flash-latest-low');
  const bodies = [];
  const fetchFn = async (url, init) => {
    bodies.push(JSON.parse(init.body).generationConfig);
    return bodies.length === 1
      ? new Response(rejected.body, { status: rejected.status, headers: { 'content-type': rejected.contentType } })
      : new Response(success.body, { status: success.status, headers: { 'content-type': success.contentType } });
  };
  const p = createProvider('gemini', { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-latest', apiKey: KEY, thinking: 'low' }, { fetch: fetchFn });
  const r = await drain(p.stream({ messages: HELLO, maxTokens: 700 }));
  assert.equal(r.text, 'Hello there, it is wonderful to meet you,');
  assert.deepEqual(bodies.map((g) => g.thinkingConfig), [{ thinkingLevel: 'low' }, undefined]);
  assert.deepEqual(bodies.map((g) => g.maxOutputTokens), [2748, 2748], 'headroom for thoughts in both attempts');
});

test('LIVE: the captured bare "Request contains an invalid argument." also drops thinking, once', async () => {
  clearGeminiQuirks();
  const rejected = captured('error-thinking-budget-zero-invalid');
  const success = captured('stream-success');
  const seen = [];
  const fetchFn = async (url, init) => {
    const cfg = JSON.parse(init.body).generationConfig.thinkingConfig;
    seen.push(cfg);
    const pick = cfg ? rejected : success;
    return new Response(pick.body, { status: pick.status, headers: { 'content-type': pick.contentType } });
  };
  const p = createProvider('gemini', { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-latest', apiKey: KEY, thinking: 'low' }, { fetch: fetchFn });
  const r = await drain(p.stream({ messages: HELLO }));
  assert.equal(r.text, 'Hello, my favorite color is blue!');
  assert.deepEqual(seen, [{ thinkingLevel: 'low' }, undefined]);
});

test('LIVE: neither thinkingLevel "minimal" nor thinkingBudget is ever sent (both are rejected by current models)', async () => {
  const success = captured('stream-success');
  const raw = [];
  const fetchFn = async (url, init) => { raw.push(init.body); return new Response(success.body, { status: 200, headers: { 'content-type': success.contentType } }); };
  for (const thinking of ['auto', 'low']) {
    for (const model of ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.8-flash']) {
      clearGeminiQuirks();
      const p = createProvider('gemini', { baseUrl: 'https://generativelanguage.googleapis.com', model, apiKey: KEY, thinking }, { fetch: fetchFn });
      await drain(p.stream({ messages: HELLO, maxTokens: 500 }));
      await p.test();
    }
  }
  assert.ok(raw.length >= 16);
  assert.ok(raw.every((b) => !/minimal|thinkingBudget/i.test(b)));
});

test('LIVE: a request ending with a model turn is refused locally (the API would answer 400), a model-first opening is sent as is', async () => {
  const bodies = [];
  const success = captured('stream-success');
  const fetchFn = async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response(success.body, { status: 200, headers: { 'content-type': success.contentType } }); };
  const p = createProvider('gemini', { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest', apiKey: KEY }, { fetch: fetchFn });
  const err = await rejection(drain(p.stream({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] })));
  assert.equal(err.code, 'bad_request');
  assert.equal(bodies.length, 0);
  await drain(p.stream({ messages: [{ role: 'assistant', content: 'What is on your mind?' }, { role: 'user', content: 'work' }] }));
  assert.deepEqual(bodies[0].contents.map((c) => c.role), ['model', 'user']);
  await rejection(drain(p.stream({ messages: [{ role: 'system', content: 'only system' }, { role: 'user', content: '  ' }] })));
  assert.equal(bodies.length, 1, 'an empty conversation never reaches the network');
});

test('LIVE: models.list -> chat models only, aliases first, newest first', async () => {
  const body = read('models-list.json');
  const fetchFn = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' } });
  const models = await providerFor(fetchFn).listModels();
  const ids = models.map((m) => m.id);
  assert.deepEqual(ids, [
    'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest',
    'gemma-4-31b-it', 'gemma-4-26b-a4b-it',
    'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash',
    'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview',
    'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.5-flash',
  ]);
  const unwanted = /embed|aqa|imagen|veo|tts|image|banana|live|audio|transcribe|omni|robotics|computer-use|customtools|learnlm|lyria|antigravity|deep-research/;
  assert.deepEqual(ids.filter((id) => !/^(gemini|gemma)-/.test(id) || unwanted.test(id)), [], 'only chat models are offered');
  assert.ok(models.every((m) => m.label && !m.id.startsWith('models/')));
  assert.equal(models.find((m) => m.id === 'gemini-3.8-flash').label, 'Gemini 3.8 Flash');
  assert.ok(ids.length < LIVE_MODELS.length / 2, `${ids.length} of ${LIVE_MODELS.length}`);
});

test('LIVE: the mock\'s default catalogue for serve.js is the same list', () => {
  assert.equal(LIVE_MODELS.length, JSON.parse(read('models-list.json')).models.length);
});
