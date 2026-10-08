// Replays responses captured from a REAL Ollama 0.40.1 (CPU, llama.cpp runner; models llama3.2:1b, qwen3:1.7b,
// smollm2:360m imported from GGUF files) through the `local` adapter. These are ground truth: if Ollama changes its
// wire format, re-capture the fixtures (see test/fixtures/ollama-live/README.md) and this file tells us what broke.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, isOllama, pullOllamaModel } from '../../src/providers/index.js';
import { clearOpenAIQuirks } from '../../src/providers/openai.js';
import { HELLO, USER, SYSTEM, collect, drain, randomSplit, twoWaySplits } from './helpers.js';
import { captured, readBody, replayFetch, sseTexts } from './live-replay.js';

const BASE = 'http://127.0.0.1:11434/v1';
const providerFor = (fetchFn, cfg = {}) => {
  clearOpenAIQuirks();
  return createProvider('local', { baseUrl: BASE, model: 'llama3.2:1b', timeoutMs: 5000, ...cfg }, { fetch: fetchFn });
};
const rejection = (p) => p.then(() => assert.fail('expected a rejection'), (e) => e);
const bytesOf = (name) => new Uint8Array(readBody('ollama', name));

test('OLLAMA LIVE: a normal answer. The first delta carries the role AND the first token (no role-only chunk); usage chunk has choices [] and timings', async () => {
  const fetchFn = replayFetch('ollama', 'stream-success');
  const r = await drain(providerFor(fetchFn).stream({ messages: HELLO, maxTokens: 60, temperature: 0.7 }));
  const real = sseTexts('ollama', 'stream-success');
  assert.equal(r.text, real.content);
  assert.match(r.text, /^Writing down your thoughts/);
  assert.equal(r.deltas[0], 'Writing', 'the token that rode on the role chunk must not be lost');
  assert.equal(r.done.finishReason, 'stop');
  assert.deepEqual(r.done.usage, { promptTokens: 61, completionTokens: 25, totalTokens: 86 });
  const call = fetchFn.calls[0];
  assert.equal(call.url, `${BASE}/chat/completions`);
  assert.equal(call.body.model, 'llama3.2:1b');
  assert.equal(call.body.max_tokens, 60, 'Ollama honours max_tokens (it IGNORES max_completion_tokens, see stream-max-completion-tokens)');
  assert.equal('max_completion_tokens' in call.body, false);
  assert.deepEqual(call.body.stream_options, { include_usage: true });
  assert.equal(call.init.headers.Authorization, undefined);
});

test('OLLAMA LIVE: the local provider asks the model not to think (reasoning_effort "none"), which Ollama accepts for every model', async () => {
  const fetchFn = replayFetch('ollama', 'qwen3-stream-reasoning-none');
  const r = await drain(providerFor(fetchFn, { model: 'qwen3:1.7b' }).stream({ messages: HELLO }));
  assert.equal(fetchFn.calls[0].body.reasoning_effort, 'none');
  assert.equal(r.text, sseTexts('ollama', 'qwen3-stream-reasoning-none').content);
  assert.ok(r.text.length > 20);
  assert.equal(sseTexts('ollama', 'qwen3-stream-reasoning-none').reasoning, '', 'with "none" Ollama sends no reasoning at all');
  // ... but the openai provider never sends the field (OpenAI itself rejects it for non-reasoning models)
  clearOpenAIQuirks();
  const oa = replayFetch('ollama', 'stream-success');
  await drain(createProvider('openai', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-test-0123456789' }, { fetch: oa }).stream({ messages: HELLO }));
  assert.equal('reasoning_effort' in oa.calls[0].body, false);
});

test('OLLAMA LIVE: identical results however the body is cut (every 2-way split, byte by byte, random multi-way splits)', async () => {
  for (const name of ['stream-success', 'qwen3-stream-reasoning-none', 'stream-max-tokens-5-length']) {
    const bytes = bytesOf(name);
    const reference = await drain(providerFor(replayFetch('ollama', name)).stream({ messages: HELLO }));
    const check = async (pieces, label) => {
      const r = await drain(providerFor(replayFetch('ollama', name, { pieces })).stream({ messages: HELLO }));
      assert.equal(r.text, reference.text, `${name} ${label}`);
      assert.deepEqual(r.done, reference.done, `${name} ${label}`);
    };
    if (bytes.length < 2000) {
      for (const [a, b] of twoWaySplits(bytes)) await check([a, b], `split ${a.length}`);
    } else {
      for (let seed = 1; seed <= 40; seed += 1) await check(randomSplit(bytes, seed, 6), `seed ${seed}`);
    }
    await check(Array.from(bytes, (_, i) => bytes.subarray(i, i + 1)), 'byte by byte');
  }
});

test('OLLAMA LIVE: without stream_options there is no usage chunk; the answer still completes with [DONE]', async () => {
  const r = await drain(providerFor(replayFetch('ollama', 'stream-no-stream-options')).stream({ messages: HELLO }));
  assert.equal(r.text, sseTexts('ollama', 'stream-no-stream-options').content);
  assert.equal(r.done.finishReason, 'stop');
  assert.equal(r.done.usage, undefined);
});

test('OLLAMA LIVE: max_tokens hit -> finish_reason "length" with the partial text kept (a 5-token cut)', async () => {
  const r = await drain(providerFor(replayFetch('ollama', 'stream-max-tokens-5-length')).stream({ messages: HELLO, maxTokens: 5 }));
  assert.equal(r.done.finishReason, 'length');
  assert.ok(r.text.length > 0);
  assert.equal(r.done.usage.completionTokens, 5);
});

test('OLLAMA LIVE: servers that return one JSON document for a streaming request are read too (nonstream capture)', async () => {
  const r = await drain(providerFor(replayFetch('ollama', 'nonstream-success')).stream({ messages: HELLO }));
  assert.match(r.text, /^Take a deep breath/);
  assert.equal(r.done.finishReason, 'stop');
  assert.equal(r.done.usage.completionTokens, JSON.parse(readBody('ollama', 'nonstream-success')).usage.completion_tokens);
});

test('OLLAMA LIVE: a thinking model (qwen3) puts its reasoning in delta.reasoning next to content ""; only the answer is shown', async () => {
  const real = sseTexts('ollama', 'qwen3-stream-thinking');
  assert.ok(real.reasoning.length > 300, 'the capture really contains reasoning');
  const r = await drain(providerFor(replayFetch('ollama', 'qwen3-stream-thinking'), { model: 'qwen3:1.7b' }).stream({ messages: HELLO }));
  assert.equal(r.text, real.content);
  assert.ok(!r.text.includes(real.reasoning.slice(0, 40)));
  assert.equal(r.done.usage.completionTokens, 148);
  // non-streamed variant: message.reasoning next to message.content
  const j = await drain(providerFor(replayFetch('ollama', 'qwen3-nonstream-thinking'), { model: 'qwen3:1.7b' }).stream({ messages: HELLO }));
  assert.match(j.text, /^You're not alone in feeling tired/);
  assert.ok(!/Okay, the user/.test(j.text));
});

test('OLLAMA LIVE: all tokens spent thinking (max_tokens 30 -> finish "length", content never starts) -> empty with the thinking hint', async () => {
  const err = await rejection(drain(providerFor(replayFetch('ollama', 'qwen3-stream-thinking-truncated'), { model: 'qwen3:1.7b' }).stream({ messages: HELLO, maxTokens: 30 })));
  assert.equal(err.code, 'empty');
  assert.match(err.hint, /token budget thinking/);
  // test() must still pass: a reasoning model may legitimately say nothing in 16 tokens
  const ok = await providerFor(replayFetch('ollama', 'qwen3-stream-thinking-truncated'), { model: 'qwen3:1.7b' }).test();
  assert.equal(ok.ok, true);
  assert.equal(ok.sample, '');
});

test('OLLAMA LIVE: a small model\'s reply (smollm2:360m) and multi-byte text come through intact', async () => {
  const small = await drain(providerFor(replayFetch('ollama', 'smollm2-stream'), { model: 'smollm2:360m' }).stream({ messages: HELLO }));
  assert.equal(small.text, sseTexts('ollama', 'smollm2-stream').content);
  assert.ok(small.text.length > 10);
  const u = await drain(providerFor(replayFetch('ollama', 'stream-utf8')).stream({ messages: HELLO }));
  assert.equal(u.text, sseTexts('ollama', 'stream-utf8').content);
  assert.ok(!u.text.includes('�'));
  // the same text arrives intact when cut inside every multi-byte character
  const bytes = bytesOf('stream-utf8');
  for (const [a, b] of twoWaySplits(bytes)) {
    const r = await drain(providerFor(replayFetch('ollama', 'stream-utf8', { pieces: [a, b] })).stream({ messages: HELLO }));
    assert.equal(r.text, u.text);
  }
});

test('OLLAMA LIVE: unknown model -> model_not_found with the "ollama pull" hint (the OpenAI-shaped 404 body)', async () => {
  for (const name of ['error-model-unknown', 'error-model-unknown-nonstream']) {
    const err = await rejection(drain(providerFor(replayFetch('ollama', name), { model: 'nope:1b' }).stream({ messages: HELLO })));
    assert.equal(err.code, 'model_not_found', name);
    assert.equal(err.status, 404);
    assert.match(err.message, /nope:1b/);
    assert.match(err.hint, /ollama pull nope:1b/);
  }
  const t = await rejection(providerFor(replayFetch('ollama', 'error-model-unknown'), { model: 'nope:1b' }).test());
  assert.equal(t.code, 'model_not_found');
});

test('OLLAMA LIVE: wrong path ("404 page not found" plain text) -> bad_base_url that tells the user to end the URL in /v1', async () => {
  for (const name of ['error-wrong-path-v2', 'error-wrong-path-bare']) {
    const err = await rejection(drain(providerFor(replayFetch('ollama', name), { baseUrl: 'http://127.0.0.1:11434/v2' }).stream({ messages: HELLO })));
    assert.equal(err.code, 'bad_base_url', name);
    assert.match(err.hint, /\/v1/);
  }
  const models = await rejection(providerFor(replayFetch('ollama', 'error-models-bare')).listModels());
  assert.equal(models.code, 'bad_base_url');
});

test('OLLAMA LIVE: malformed / incomplete requests (400 invalid_request_error) -> bad_request with the server\'s words', async () => {
  for (const [name, words] of [['error-malformed-json', /unexpected EOF/], ['error-no-messages', /too short/], ['error-no-model', /model is required/]]) {
    const err = await rejection(drain(providerFor(replayFetch('ollama', name)).stream({ messages: HELLO })));
    assert.equal(err.code, 'bad_request', name);
    assert.equal(err.status, 400);
    assert.match(err.message, words, name);
  }
});

test('OLLAMA LIVE: a single message bigger than the context window (nested JSON error) -> context_too_long that names both sizes and OLLAMA_CONTEXT_LENGTH', async () => {
  const err = await rejection(drain(providerFor(replayFetch('ollama', 'error-context-overflow')).stream({ messages: [SYSTEM('Be brief.'), USER('x'.repeat(30))] })));
  assert.equal(err.code, 'context_too_long');
  assert.equal(err.status, 400);
  assert.match(err.hint, /needs about 7538 tokens/);
  assert.match(err.hint, /holds 4096/);
  assert.match(err.hint, /OLLAMA_CONTEXT_LENGTH/);
  assert.ok(!/\{"error"/.test(err.message + err.hint), 'the nested JSON must not leak into the user-facing text');
});

test('OLLAMA LIVE: GET /v1/models lists newest first; the adapter returns them alphabetically; GET /api/version identifies Ollama', async () => {
  const real = JSON.parse(readBody('ollama', 'models'));
  assert.notDeepEqual(real.data.map((m) => m.id), [...real.data.map((m) => m.id)].sort(), 'Ollama itself does not sort');
  const list = await providerFor(replayFetch('ollama', 'models')).listModels();
  assert.deepEqual(list.map((m) => m.id), ['llama3.2:1b', 'qwen3-raw:1.7b', 'qwen3:1.7b', 'smollm2:360m']);
  assert.deepEqual(list[0], { id: 'llama3.2:1b', label: 'llama3.2:1b' });
  const fetchFn = replayFetch('ollama', { '/api/version': 'version' });
  assert.equal(await isOllama({ baseUrl: BASE }, { fetch: fetchFn }), true);
  assert.equal(fetchFn.calls[0].url, 'http://127.0.0.1:11434/api/version');
  assert.equal(JSON.parse(readBody('ollama', 'version')).version, '0.40.1');
});

test('OLLAMA LIVE: /api/pull when the registry cannot be reached is a NETWORK error that quotes Ollama, not "no such model"', async () => {
  for (const name of ['pull-unreachable-stream', 'pull-unreachable-name-and-model', 'pull-already-present', 'pull-offline-stream']) {
    const events = [];
    const err = await rejection((async () => {
      for await (const ev of pullOllamaModel({ baseUrl: BASE }, { model: 'llama3.2:3b', fetch: replayFetch('ollama', name) })) events.push(ev);
    })());
    assert.equal(events[0].status, 'pulling manifest', name);
    assert.equal(err.code, 'network', name);
    assert.match(err.message, /registry/, name);
    const errorLine = readBody('ollama', name).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((o) => o.error);
    const wanted = /"(https:\/\/registry\.ollama\.ai\/v2\/library\/[^"]+)"/.exec(errorLine.error)[1];
    assert.ok(err.hint.includes(wanted), `${name}: the hint quotes Ollama's own words (${wanted})`);
    assert.match(err.hint, /ollama create/, `${name}: offline users are told how to load a model file`);
  }
  const offline = await rejection(collect(pullOllamaModel({ baseUrl: BASE }, { model: 'llama3.2:3b', fetch: replayFetch('ollama', 'pull-offline-nonstream') })));
  assert.equal(offline.code, 'server', 'a non-streaming pull is a plain HTTP 500 and is not what the adapter asks for');
});

test('OLLAMA LIVE: GET on the chat path (405 "method not allowed") and the bare root are not mistaken for a model reply', async () => {
  const { status } = captured('ollama', 'error-get-chat');
  assert.equal(status, 405);
  assert.equal(readBody('ollama', 'error-root').toString(), 'Ollama is running');
});

test('OLLAMA LIVE: the model cannot be loaded because it does not fit in memory (HTTP 500 with llama-server\'s allocation errors) -> a plain "does not fit" message with what to do', async () => {
  assert.equal(captured('ollama', 'error-model-too-big').status, 500);
  const err = await rejection(drain(providerFor(replayFetch('ollama', 'error-model-too-big')).stream({ messages: HELLO })));
  assert.equal(err.code, 'server');
  assert.equal(err.status, 500);
  assert.match(err.message, /does not fit in this computer's memory/);
  assert.match(err.hint, /smaller model/);
  assert.match(err.hint, /OLLAMA_CONTEXT_LENGTH/);
  assert.ok(!/ggml_aligned_malloc/.test(err.message), 'allocator noise is not shown as the headline');
});
