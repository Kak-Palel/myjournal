// Replays responses captured from a REAL llama.cpp `llama-server` (the one bundled with Ollama 0.40.1, commit 631109b34,
// "version 0.5.0-dev", serving Qwen3-1.7B / SmolLM2-360M GGUF files) through the `local` adapter. Ground truth, like
// ollama-live.test.js: re-capture (test/fixtures/llamacpp-live/README.md) when the wire format changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../../src/providers/index.js';
import { clearOpenAIQuirks } from '../../src/providers/openai.js';
import { HELLO, USER, drain, randomSplit, twoWaySplits } from './helpers.js';
import { captured, readBody, replayFetch, sseTexts } from './live-replay.js';

const BASE = 'http://127.0.0.1:8080/v1';
const providerFor = (fetchFn, cfg = {}) => {
  clearOpenAIQuirks();
  return createProvider('local', { baseUrl: BASE, model: 'qwen3', timeoutMs: 5000, ...cfg }, { fetch: fetchFn });
};
const rejection = (p) => p.then(() => assert.fail('expected a rejection'), (e) => e);
const bytesOf = (name) => new Uint8Array(readBody('llamacpp', name));

test('LLAMA.CPP LIVE: the first delta is {role, content: null}; reasoning arrives as delta.reasoning_content and is not shown', async () => {
  const real = sseTexts('llamacpp', 'stream-thinking');
  assert.ok(real.reasoning.length > 300);
  assert.match(readBody('llamacpp', 'stream-thinking').toString().split('\n')[0], /"role":"assistant","content":null/);
  const r = await drain(providerFor(replayFetch('llamacpp', 'stream-thinking')).stream({ messages: HELLO }));
  assert.equal(r.text, real.content);
  assert.ok(r.text.length > 10 && !/Okay, the user/.test(r.text));
  assert.equal(r.done.finishReason, 'stop');
  assert.deepEqual(r.done.usage, { promptTokens: 39, completionTokens: 134, totalTokens: 173 });
});

test('LLAMA.CPP LIVE: with --reasoning-format none the <think> block is INLINE in content; the think filter removes it (and the blank lines after it)', async () => {
  const raw = sseTexts('llamacpp', 'stream-inline-think');
  assert.match(raw.content, /^<think>\n/);
  assert.match(raw.content, /<\/think>\n\n/);
  const answer = raw.content.slice(raw.content.indexOf('</think>') + '</think>'.length).replace(/^\s+/, '');
  assert.ok(answer.length > 10);
  const r = await drain(providerFor(replayFetch('llamacpp', 'stream-inline-think')).stream({ messages: HELLO }));
  assert.equal(r.text, answer);
  assert.ok(!r.text.includes('<think>') && !r.text.includes('</think>'));
});

test('LLAMA.CPP LIVE: the inline-think capture reads identically however the body is cut (random multi-way splits, byte by byte)', async () => {
  const name = 'stream-inline-think';
  const bytes = bytesOf(name);
  const reference = await drain(providerFor(replayFetch('llamacpp', name)).stream({ messages: HELLO }));
  for (let seed = 1; seed <= 30; seed += 1) {
    const r = await drain(providerFor(replayFetch('llamacpp', name, { pieces: randomSplit(bytes, seed, 7) })).stream({ messages: HELLO }));
    assert.equal(r.text, reference.text, `seed ${seed}`);
    assert.deepEqual(r.done, reference.done, `seed ${seed}`);
  }
  const small = bytesOf('stream-inline-think-truncated');
  const err1 = await rejection(drain(providerFor(replayFetch('llamacpp', 'stream-inline-think-truncated')).stream({ messages: HELLO })));
  for (const [a, b] of twoWaySplits(small)) {
    const err = await rejection(drain(providerFor(replayFetch('llamacpp', 'stream-inline-think-truncated', { pieces: [a, b] })).stream({ messages: HELLO })));
    assert.equal(err.code, err1.code);
  }
});

test('LLAMA.CPP LIVE: <think> never closed because max_tokens ran out inside it -> empty with the thinking hint (inline AND reasoning_content variants)', async () => {
  for (const name of ['stream-inline-think-truncated', 'stream-thinking-truncated']) {
    const err = await rejection(drain(providerFor(replayFetch('llamacpp', name)).stream({ messages: HELLO, maxTokens: 25 })));
    assert.equal(err.code, 'empty', name);
    assert.match(err.hint, /token budget thinking/, name);
  }
});

test('LLAMA.CPP LIVE: reasoning_effort "none" answers directly (the empty <think></think> pair llama.cpp still emits is filtered out)', async () => {
  const fetchFn = replayFetch('llamacpp', 'stream-reasoning-none');
  const r = await drain(providerFor(fetchFn).stream({ messages: HELLO }));
  assert.equal(fetchFn.calls[0].body.reasoning_effort, 'none');
  const real = sseTexts('llamacpp', 'stream-reasoning-none');
  assert.equal(real.reasoning, '');
  assert.equal(r.text, real.content);
  assert.ok(r.text.length > 20);
});

test('LLAMA.CPP LIVE: a non-streamed answer carries message.reasoning_content next to content', async () => {
  const r = await drain(providerFor(replayFetch('llamacpp', 'nonstream-thinking')).stream({ messages: HELLO }));
  const msg = JSON.parse(readBody('llamacpp', 'nonstream-thinking')).choices[0].message;
  assert.ok(msg.reasoning_content.length > 100);
  assert.equal(r.text, msg.content.trim() === msg.content ? msg.content : msg.content.trim());
});

test('LLAMA.CPP LIVE: GET /v1/models reports the GGUF PATH as the id; the label is the file name; the same list also answers /models', async () => {
  const real = JSON.parse(readBody('llamacpp', 'models'));
  assert.match(real.data[0].id, /\/qwen3-1\.7b-q4km\.gguf$/);
  assert.equal(real.data[0].meta.n_ctx, 4096, 'the context window is visible here (useful for the budget)');
  const list = await providerFor(replayFetch('llamacpp', 'models')).listModels();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, real.data[0].id);
  assert.equal(list[0].label, 'qwen3-1.7b-q4km.gguf');
  const bare = await providerFor(replayFetch('llamacpp', 'models-bare')).listModels();
  assert.deepEqual(bare, list);
});

test('LLAMA.CPP LIVE: --api-key: 401 {error:{type:authentication_error}} -> auth, with and without a configured key', async () => {
  const none = await rejection(drain(providerFor(replayFetch('llamacpp', 'error-401-no-key')).stream({ messages: HELLO })));
  assert.equal(none.code, 'auth');
  assert.equal(none.status, 401);
  assert.match(none.message, /wants an API key/);
  const wrong = await rejection(drain(providerFor(replayFetch('llamacpp', 'error-401-wrong-key'), { apiKey: 'nope-key-12345' }).stream({ messages: HELLO })));
  assert.equal(wrong.code, 'auth');
  assert.match(wrong.message, /rejected/);
  assert.ok(!wrong.message.includes('nope-key-12345') && !wrong.hint.includes('nope-key-12345'));
  const models = await rejection(providerFor(replayFetch('llamacpp', 'error-401-models-no-key')).listModels());
  assert.equal(models.code, 'auth');
  const ok = await drain(providerFor(replayFetch('llamacpp', 'stream-small-with-key'), { apiKey: 'sekret-llama-key', model: 'smollm2' }).stream({ messages: HELLO }));
  assert.ok(ok.text.length > 3);
});

test('LLAMA.CPP LIVE: prompt longer than the context window -> context_too_long naming both sizes (and --ctx-size)', async () => {
  const err = await rejection(drain(providerFor(replayFetch('llamacpp', 'error-context-overflow')).stream({ messages: [USER('x'.repeat(40))] })));
  assert.equal(err.code, 'context_too_long');
  assert.match(err.hint, /needs about 8006 tokens/);
  assert.match(err.hint, /holds 4096/);
  assert.match(err.hint, /--ctx-size/);
});

test('LLAMA.CPP LIVE: other errors: malformed JSON / no messages -> bad_request; unknown path (JSON "File Not Found") -> bad_base_url', async () => {
  for (const [name, words] of [['error-malformed-json', /parse_error|syntax error/], ['error-no-messages', /'messages' is required/]]) {
    const err = await rejection(drain(providerFor(replayFetch('llamacpp', name)).stream({ messages: HELLO })));
    assert.equal(err.code, 'bad_request', name);
    assert.match(err.message, words, name);
  }
  const wrong = await rejection(drain(providerFor(replayFetch('llamacpp', 'error-wrong-path'), { baseUrl: 'http://127.0.0.1:8080/v2' }).stream({ messages: HELLO })));
  assert.equal(wrong.code, 'bad_base_url');
  assert.match(wrong.hint, /\/v1/);
});

test('LLAMA.CPP LIVE: llama-server accepts ANY model name (HTTP 200 for "nope", unlike Ollama\'s 404); that capture\'s 5-token budget died inside <think> -> empty', async () => {
  const { status } = captured('llamacpp', 'error-model-unknown');
  assert.equal(status, 200);
  assert.equal(JSON.parse(readBody('llamacpp', 'error-model-unknown').toString().split('\n')[0].slice(6)).choices[0].delta.content, null);
  const err = await rejection(drain(providerFor(replayFetch('llamacpp', 'error-model-unknown'), { model: 'nope' }).stream({ messages: HELLO, maxTokens: 5 })));
  assert.equal(err.code, 'empty');
});
