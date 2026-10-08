// The live profile of the Gemini mock (`createMockGemini({ live: true })`): every behaviour in here was observed on the
// real service on 2026-10-08 (see test/fixtures/gemini-live/README.md). Where a captured body exists the mock must serve
// exactly that body, so a drift between mock and reality shows up here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  LIVE_ALIASES, LIVE_MODELS, LIVE_RETIRED, OVERLOADED_MESSAGE, createMockGemini, googleJson, modelFamily,
} from '../mocks/mock-gemini.js';
import { createProvider } from '../../src/providers/index.js';
import { clearGeminiQuirks } from '../../src/providers/gemini.js';
import {
  HELLO, drain, fakeSleep, withTimerCheck,
} from './helpers.js';

const KEY = 'AIzaMockLiveKey-0123456789';
const DIR = new URL('../fixtures/gemini-live/', import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, DIR), 'utf8');
const fixtureJson = (name) => JSON.parse(read(name));
const frames = (raw) => raw.split('\r\n\r\n').filter(Boolean).map((f) => f.replace(/^data: /, ''));
const GOOD = { contents: [{ role: 'user', parts: [{ text: 'Say hello' }] }], generationConfig: { maxOutputTokens: 2348 } };

async function withLive(opts, fn) {
  clearGeminiQuirks();
  const mock = await createMockGemini({ apiKey: KEY, live: true, ...opts });
  try {
    return await fn(mock);
  } finally {
    await mock.close();
  }
}
const call = (mock, model, body = GOOD, { method = 'streamGenerateContent' } = {}) => fetch(
  `${mock.url}/v1beta/models/${model}:${method}${method === 'streamGenerateContent' ? '?alt=sse' : ''}`,
  { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body) },
);
const withThinking = (thinkingConfig, extra = {}) => ({ ...GOOD, generationConfig: { ...GOOD.generationConfig, thinkingConfig, ...extra } });
const providerFor = (mock, model, cfg = {}, opts = {}) => createProvider('gemini', {
  baseUrl: mock.url, model, apiKey: KEY, timeoutMs: 5000, ...cfg,
}, { sleep: fakeSleep(), ...opts });

// ---- frame shape ------------------------------------------------------------------------------------------

test('googleJson reproduces every captured SSE frame byte for byte (space after colons, none after commas)', () => {
  for (const name of ['stream-success.body', 'stream-success-with-thoughts.body', 'stream-success-flash-latest-low.body']) {
    for (const data of frames(read(name))) {
      assert.equal(googleJson(JSON.parse(data)), data, name);
    }
  }
  assert.equal(googleJson({ a: [1, { b: 'x' }], c: undefined, d: null }), '{"a": [1,{"b": "x"}],"d": null}');
});

test('live mock: streamed frames have the captured shape and key order, CRLF separators and the captured headers', async () => {
  await withLive({ replies: ['Hello, my favorite color is blue!'] }, async (mock) => {
    const res = await call(mock, 'gemini-flash-lite-latest');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('content-disposition'), 'attachment');
    const raw = await res.text();
    assert.ok(raw.endsWith('\r\n\r\n'));
    const mine = frames(raw).map((f) => JSON.parse(f));
    const real = frames(read('stream-success.body')).map((f) => JSON.parse(f));
    const keysOf = (frame) => ({
      top: Object.keys(frame),
      candidate: Object.keys(frame.candidates[0]),
      content: Object.keys(frame.candidates[0].content),
      usage: Object.keys(frame.usageMetadata),
      part: Object.keys(frame.candidates[0].content.parts[0]),
    });
    // the first text frame and the closing empty-text frame look exactly like the captured ones
    assert.deepEqual(keysOf(mine[0]), keysOf(real[0]));
    assert.deepEqual(keysOf(mine.at(-1)), keysOf(real.at(-1)));
    assert.equal(mine.at(-1).candidates[0].finishReason, 'STOP');
    assert.equal(mine.at(-1).candidates[0].content.parts[0].text, '');
    assert.ok(mine.at(-1).candidates[0].content.parts[0].thoughtSignature);
    assert.equal(mine[0].modelVersion, 'gemini-3.5-flash-lite', 'the -latest alias resolves to the concrete model, as live');
    assert.deepEqual(mine[0].usageMetadata.promptTokensDetails, [{ modality: 'TEXT', tokenCount: mine[0].usageMetadata.promptTokenCount }]);
    assert.equal(mine[0].usageMetadata.serviceTier, 'standard');
    // candidatesTokenCount is running: it never goes down from one frame to the next
    const counts = mine.map((f) => f.usageMetadata.candidatesTokenCount);
    assert.deepEqual(counts, [...counts].sort((a, b) => a - b));
  });
});

// ---- models.list ------------------------------------------------------------------------------------------

test('live mock: models.list is the captured 62-entry list; the adapter offers the same 17 chat models as against the real service', async () => {
  await withLive({}, async (mock) => {
    const res = await fetch(`${mock.url}/v1beta/models?pageSize=1000`, { headers: { 'x-goog-api-key': KEY } });
    const body = await res.json();
    assert.deepEqual(body.models, fixtureJson('models-list.json').models);
    assert.equal(body.nextPageToken, undefined, 'one page, as live');
    const ids = (await providerFor(mock, 'gemini-flash-lite-latest').listModels()).map((m) => m.id);
    assert.equal(ids.length, 17);
    assert.deepEqual(ids.slice(0, 3), ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest']);
    assert.deepEqual(ids.slice(-2), ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'], 'Gemma last');
    for (const retired of Object.keys(LIVE_RETIRED)) assert.ok(ids.includes(retired), 'retired models are still listed, as live');
  });
  assert.equal(LIVE_MODELS.length, 62);
});

// ---- retired models ---------------------------------------------------------------------------------------

test('live mock: a retired model answers the captured 404 body, as text/event-stream', async () => {
  await withLive({}, async (mock) => {
    const res = await call(mock, 'gemini-2.5-flash');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.deepEqual(await res.json(), fixtureJson('error-model-retired.body'));
    const pro = await (await call(mock, 'gemini-2.5-pro')).json();
    assert.match(pro.error.message, /use models\/gemini-3\.1-pro-preview /);
    assert.equal((await call(mock, 'gemini-nope-9')).status, 404);
    assert.deepEqual(await (await call(mock, 'gemini-nope-9')).json(), fixtureJson('error-model-unknown.body'));
  });
  await withLive({ live: false }, async (mock) => {
    assert.equal((await call(mock, 'gemini-2.5-flash')).status, 200, 'without the live profile the old default models keep working');
  });
});

test('live mock + adapter: retired model -> model_not_found quoting Google\'s replacement; the replacement works', async () => {
  await withLive({}, async (mock) => {
    const err = await providerFor(mock, 'gemini-2.5-pro').chat({ messages: HELLO }).then(() => assert.fail('expected a rejection'), (e) => e);
    assert.equal(err.code, 'model_not_found');
    assert.match(err.hint, /Google suggests gemini-3\.1-pro-preview/);
    assert.equal((await providerFor(mock, LIVE_RETIRED['gemini-2.5-pro']).chat({ messages: HELLO })).finishReason, 'stop');
  });
});

// ---- thinkingConfig rules ---------------------------------------------------------------------------------

test('live mock: thinkingConfig rules per model family answer the captured 400 bodies', async () => {
  await withLive({}, async (mock) => {
    const text = async (res) => (await res.json()).error.message;
    const minimal = fixtureJson('error-thinking-minimal-unsupported.body').error.message;
    const budget0 = fixtureJson('error-thinking-budget-zero-invalid.body').error.message;
    const level = fixtureJson('error-thinking-level-unsupported.body').error.message;
    // gemini-3.8-flash (= gemini-flash-latest): low is fine, minimal is rejected, budget 0 is rejected
    assert.equal((await call(mock, 'gemini-flash-latest', withThinking({ thinkingLevel: 'low' }))).status, 200);
    assert.equal(await text(await call(mock, 'gemini-3.8-flash', withThinking({ thinkingLevel: 'minimal' }))), minimal);
    assert.equal(await text(await call(mock, 'gemini-flash-latest', withThinking({ thinkingBudget: 0 }))), budget0);
    // Lite 3.x (gemini-flash-lite-latest): minimal is fine, budget 0 is rejected
    assert.equal((await call(mock, 'gemini-flash-lite-latest', withThinking({ thinkingLevel: 'minimal' }))).status, 200);
    assert.equal(await text(await call(mock, 'gemini-3.5-flash-lite', withThinking({ thinkingBudget: 0 }))), budget0);
    // Gemma and 2.5: any thinkingLevel is rejected, a budget is fine
    for (const model of ['gemma-4-26b-a4b-it', 'gemini-2.5-flash-lite']) {
      assert.equal(await text(await call(mock, model, withThinking({ thinkingLevel: 'low' }))), level, model);
      assert.equal((await call(mock, model, withThinking({ thinkingBudget: 0 }))).status, 200, model);
    }
  });
  assert.deepEqual(['gemma-4-31b-it', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-pro-latest'].map(modelFamily), ['gemma', 'gemini2', 'lite', 'flash', 'flash']);
});

test('live mock + adapter: thinking "low" is dropped after the first 400 on Gemma and 2.5 (once per model) and kept where accepted', async () => {
  await withLive({}, async (mock) => {
    for (const [model, expected] of [
      ['gemma-4-26b-a4b-it', [{ thinkingLevel: 'low' }, undefined]],
      ['gemini-2.5-flash-lite', [{ thinkingLevel: 'low' }, undefined]],
      ['gemini-flash-lite-latest', [{ thinkingLevel: 'low' }]],
      ['gemini-flash-latest', [{ thinkingLevel: 'low' }]],
    ]) {
      mock.reset();
      const r = await drain(providerFor(mock, model, { thinking: 'low' }).stream({ messages: HELLO, maxTokens: 300 }));
      assert.equal(r.done.finishReason, 'stop', model);
      assert.deepEqual(mock.generateRequests().map((x) => x.body.generationConfig.thinkingConfig), expected, model);
    }
  });
});

// ---- thoughts eat the output budget -----------------------------------------------------------------------

test('live mock: thought tokens per model and mode (flash-lite does not think on auto, thinks on low)', async () => {
  await withLive({}, async (mock) => {
    const usage = async (model, thinkingConfig) => {
      const raw = await (await call(mock, model, thinkingConfig ? withThinking(thinkingConfig) : GOOD)).text();
      return frames(raw).map((f) => JSON.parse(f)).at(-1).usageMetadata;
    };
    assert.equal((await usage('gemini-flash-lite-latest')).thoughtsTokenCount, undefined);
    assert.ok((await usage('gemini-flash-lite-latest', { thinkingLevel: 'low' })).thoughtsTokenCount > 300);
    const flash = await usage('gemini-3.5-flash');
    const flashLow = await usage('gemini-3.5-flash', { thinkingLevel: 'low' });
    assert.ok(flash.thoughtsTokenCount > flashLow.thoughtsTokenCount, 'low thinks less on the models that think by default');
    assert.equal(flash.totalTokenCount, flash.promptTokenCount + flash.candidatesTokenCount + flash.thoughtsTokenCount, 'total includes thoughts, candidates do not');
  });
});

test('live mock + adapter: a small maxOutputTokens is eaten by thoughts, the adapter\'s +2048 headroom keeps the reply whole', async () => {
  const reply = 'That sounds like a heavy week. What would help you most right now?';
  await withLive({ replies: [reply, reply] }, async (mock) => {
    // what the live service did with a bare cap of 200 (189 of 200 tokens went on thinking): the answer is cut off
    const starved = await (await call(mock, 'gemini-flash-latest', withThinking({ thinkingLevel: 'low' }, { maxOutputTokens: 200 }))).text();
    const last = frames(starved).map((f) => JSON.parse(f)).at(-1);
    assert.equal(last.candidates[0].finishReason, 'MAX_TOKENS');
    // the same request through the adapter asks for maxTokens + 2048 and finishes normally
    const r = await drain(providerFor(mock, 'gemini-flash-latest', { thinking: 'low' }).stream({ messages: HELLO, maxTokens: 200 }));
    assert.equal(r.text, reply);
    assert.equal(r.done.finishReason, 'stop');
    assert.equal(mock.lastGenerateRequest().body.generationConfig.maxOutputTokens, 2248);
  });
});

// ---- overload and latency ---------------------------------------------------------------------------------

test('live mock: overloadedModels answers 503 with the captured message, after the configured delay, only for that model', async () => {
  await withLive({ overloadedModels: { 'gemini-flash-latest': { afterMs: 120 } } }, async (mock) => {
    const started = Date.now();
    const res = await call(mock, 'gemini-flash-latest');
    assert.ok(Date.now() - started >= 100, 'the 503 arrives late, like live');
    assert.equal(res.status, 503);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const body = await res.json();
    assert.deepEqual(body, fixtureJson('error-overloaded-503.body'));
    assert.equal(body.error.message, OVERLOADED_MESSAGE);
    assert.equal((await call(mock, 'gemini-flash-lite-latest')).status, 200);
  });
});

test('live mock + adapter: 503 on gemini-flash-latest -> one automatic retry, then overloaded recommending Flash-Lite', async () => {
  await withLive({ overloadedModels: ['gemini-flash-latest'] }, async (mock) => {
    const sleep = fakeSleep();
    const p = providerFor(mock, 'gemini-flash-latest', {}, { sleep });
    const err = await p.chat({ messages: HELLO }).then(() => assert.fail('expected a rejection'), (e) => e);
    assert.equal(err.code, 'overloaded');
    assert.equal(err.status, 503);
    assert.match(err.hint, /switch to gemini-flash-lite-latest/);
    assert.equal(mock.generateRequests().length, 2, 'exactly one automatic retry');
    assert.equal(sleep.waits.length, 1);
  });
  // a busy moment that passes: the retry succeeds and the caller never notices
  await withLive({ overloadedModels: { 'gemini-flash-latest': { times: 1 } }, replies: ['Back again.'] }, async (mock) => {
    const r = await providerFor(mock, 'gemini-flash-latest').chat({ messages: HELLO });
    assert.equal(r.text, 'Back again.');
    assert.equal(mock.generateRequests().length, 2);
  });
});

test('live mock: a failure spec takes afterMs, so "503 after N seconds" can be scripted', async () => {
  await withLive({ failures: [{ kind: 'unavailable', afterMs: 120 }] }, async (mock) => {
    const started = Date.now();
    const res = await call(mock, 'gemini-flash-lite-latest');
    assert.equal(res.status, 503);
    assert.ok(Date.now() - started >= 100);
    assert.equal((await call(mock, 'gemini-flash-lite-latest')).status, 200, 'the queue is used up');
  });
});

test('live mock + adapter: a slow model hits the first-byte timeout; a patient caller gets the answer', async () => {
  await withLive({ slowModels: { 'gemini-flash-latest': 400 } }, async (mock) => {
    const err = await providerFor(mock, 'gemini-flash-latest', { timeoutMs: 100 }).chat({ messages: HELLO }).then(() => assert.fail('expected a rejection'), (e) => e);
    assert.equal(err.code, 'timeout');
    const started = Date.now();
    const r = await drain(providerFor(mock, 'gemini-flash-latest', { timeoutMs: 3000 }).stream({ messages: HELLO }));
    assert.ok(Date.now() - started >= 350, 'first byte after the configured delay');
    assert.equal(r.done.finishReason, 'stop');
  });
});

test('live mock + adapter: aborting while the model is still thinking releases the socket and leaks no timer', async () => {
  await withLive({ slowModels: { 'gemini-flash-latest': 5000 } }, async (mock) => {
    await withTimerCheck(assert, async () => {
      const ac = new AbortController();
      const pending = drain(providerFor(mock, 'gemini-flash-latest', { timeoutMs: 20_000 }).stream({ messages: HELLO, signal: ac.signal }));
      await mock.waitForRequests(1);
      ac.abort();
      const err = await pending.then(() => assert.fail('expected a rejection'), (e) => e);
      assert.equal(err.name, 'AbortError');
      await mock.waitForIdle();
    });
  });
});

// ---- profile mechanics ------------------------------------------------------------------------------------

test('live profile: explicit options win, options objects are not shared between mocks, aliases are consistent', async () => {
  const overloaded = { 'gemini-flash-latest': { times: 1 } };
  const a = await createMockGemini({ live: true, overloadedModels: overloaded, retiredModels: {} });
  try {
    assert.equal(a.behavior.modelQuirks, true);
    assert.deepEqual(a.behavior.retiredModels, {}, 'an explicit retiredModels replaces the live default');
    await fetch(`${a.url}/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse`, { method: 'POST', headers: { 'x-goog-api-key': 'k' }, body: JSON.stringify(GOOD) });
    assert.equal(overloaded['gemini-flash-latest'].times, 1, 'the caller\'s object is untouched');
  } finally {
    await a.close();
  }
  const custom = [{ name: 'models/gemini-custom', supportedGenerationMethods: ['generateContent'] }];
  const b = await createMockGemini({ live: true, models: custom });
  try {
    assert.deepEqual(b.behavior.models, custom);
  } finally {
    await b.close();
  }
  for (const [alias, target] of Object.entries(LIVE_ALIASES)) {
    assert.ok(LIVE_MODELS.some((m) => m.name === `models/${alias}`), alias);
    assert.ok(LIVE_MODELS.some((m) => m.name === `models/${target}`), target);
  }
});
