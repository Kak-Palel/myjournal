// The mock OpenAI server's `flavor: 'ollama' | 'llamacpp'` must keep behaving like the REAL servers captured in
// test/fixtures/{ollama,llamacpp}-live, and the adapter must cope with every one of those quirks end to end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockOpenAI } from '../mocks/mock-openai.js';
import { createProvider, pullOllamaModel } from '../../src/providers/index.js';
import { clearOpenAIQuirks, healQuirks } from '../../src/providers/openai.js';
import { HELLO, SYSTEM, USER, ASSISTANT, collect, drain } from './helpers.js';

async function withMock(opts, fn) {
  clearOpenAIQuirks();
  const mock = await createMockOpenAI(opts);
  try {
    return await fn(mock);
  } finally {
    await mock.close();
  }
}
const local = (mock, cfg = {}) => createProvider('local', { baseUrl: mock.baseUrl, model: mock.behavior.models[0], timeoutMs: 5000, ...cfg });
const rejection = (p) => p.then(() => assert.fail('expected a rejection'), (e) => e);
const post = (mock, body, path = '/v1/chat/completions') => fetch(`${mock.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const frames = (text) => text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));

test('flavor ollama: no role-only chunk (role + first token share a delta), no empty deltas, finish chunk has delta {}, usage chunk has choices [] + timings', async () => {
  await withMock({ flavor: 'ollama', replies: ['Hello from a pretend Ollama.'], byteSplit: false }, async (mock) => {
    const res = await post(mock, { model: 'llama3.2:1b', messages: HELLO, stream: true, stream_options: { include_usage: true } });
    const all = frames(await res.text());
    assert.equal(all[0].choices[0].delta.role, 'assistant');
    assert.equal(typeof all[0].choices[0].delta.content, 'string');
    assert.ok(all[0].choices[0].delta.content.length > 0, 'the first delta already carries text');
    assert.equal(all[0].system_fingerprint, 'fp_ollama');
    assert.ok(all.slice(1).every((f) => !('role' in (f.choices[0]?.delta || {}))), 'the role is only on the first delta');
    assert.ok(all.every((f) => !f.choices.length || Object.keys(f.choices[0].delta).length > 0 || f.choices[0].finish_reason), 'no empty mid-stream deltas');
    const finish = all.find((f) => f.choices[0]?.finish_reason);
    assert.deepEqual(finish.choices[0].delta, {});
    const usage = all.at(-1);
    assert.deepEqual(usage.choices, []);
    assert.ok(usage.usage.prompt_tokens_details && usage.timings.predicted_per_second > 0);
  });
});

test('flavor ollama: usage chunk only when stream_options.include_usage is set; max_completion_tokens is accepted and ignored', async () => {
  await withMock({ flavor: 'ollama', replies: ['ok'] }, async (mock) => {
    const a = frames(await (await post(mock, { model: 'llama3.2:1b', messages: HELLO, stream: true })).text());
    assert.ok(!a.some((f) => f.usage));
    const res = await post(mock, { model: 'llama3.2:1b', messages: HELLO, stream: true, max_completion_tokens: 5 });
    assert.equal(res.status, 200);
  });
});

test('flavor ollama: reasoning is delta.reasoning beside content "" (first delta carries the role); the adapter shows only the answer', async () => {
  await withMock({ flavor: 'ollama', replies: ['The answer.', 'The answer.'], reasoningContent: 'Let me think about it first.', byteSplit: false }, async (mock) => {
    const raw = frames(await (await post(mock, { model: 'qwen3:1.7b', messages: HELLO, stream: true })).text());
    assert.deepEqual(Object.keys(raw[0].choices[0].delta), ['role', 'content', 'reasoning']);
    assert.equal(raw[0].choices[0].delta.content, '');
    assert.ok(raw.some((f) => f.choices[0]?.delta.content === 'The'));
    const r = await drain(local(mock, { model: 'qwen3:1.7b' }).stream({ messages: HELLO }));
    assert.equal(r.text, 'The answer.');
  });
  await withMock({ flavor: 'ollama', replies: [''], reasoningContent: true, byteSplit: false, failures: ['reasoning_only'] }, async (mock) => {
    const err = await rejection(drain(local(mock).stream({ messages: HELLO, maxTokens: 30 })));
    assert.equal(err.code, 'empty');
    assert.match(err.hint, /thinking/);
  });
});

test('flavor ollama: errors have the real /v1 shape. Unknown model: 404 not_found_error; plain-text 404 for other paths; 405 for GET on the chat path; root says "Ollama is running"', async () => {
  await withMock({ flavor: 'ollama' }, async (mock) => {
    const missing = await post(mock, { model: 'nope:1b', messages: HELLO });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: { message: "model 'nope:1b' not found", type: 'not_found_error', param: null, code: null } });
    const err = await rejection(drain(local(mock, { model: 'nope:1b' }).stream({ messages: HELLO })));
    assert.equal(err.code, 'model_not_found');
    assert.match(err.hint, /ollama pull nope:1b/);

    const wrong = await post(mock, { model: 'llama3.2:1b', messages: HELLO }, '/v2/chat/completions');
    assert.equal(wrong.status, 404);
    assert.equal(await wrong.text(), '404 page not found');
    const get = await fetch(`${mock.url}/v1/chat/completions`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    assert.equal(await (await fetch(`${mock.url}/`)).text(), 'Ollama is running');

    const bad = await post(mock, { messages: [] });
    assert.equal(bad.status, 400);
    assert.deepEqual((await bad.json()).error, { message: 'model is required', type: 'invalid_request_error', param: null, code: null });
  });
});

test('flavor ollama: GET /v1/models is newest-first with owned_by "library" and the adapter sorts it; /api/version reports 0.40.1', async () => {
  await withMock({ flavor: 'ollama', models: ['zeta:1b', 'alpha:1b', 'mid:1b'] }, async (mock) => {
    const body = await (await fetch(`${mock.baseUrl}/models`)).json();
    assert.deepEqual(body.data.map((m) => m.id), ['zeta:1b', 'alpha:1b', 'mid:1b']);
    assert.equal(body.data[0].owned_by, 'library');
    assert.deepEqual((await local(mock).listModels()).map((m) => m.id), ['alpha:1b', 'mid:1b', 'zeta:1b']);
    assert.equal((await (await fetch(`${mock.url}/api/version`)).json()).version, '0.40.1');
  });
});

test('flavor ollama + numCtx: older messages are trimmed (system and latest kept), usage shows the trimmed prompt; a latest message that alone is too big is a 400', async () => {
  await withMock({ flavor: 'ollama', numCtx: 400, replies: ['fine'] }, async (mock) => {
    const long = 'word '.repeat(300); // ~375 estimated tokens
    const messages = [SYSTEM('Rule: be brief.'), USER(long), ASSISTANT('noted'), USER(long), ASSISTANT('noted again'), USER('And now the real question?')];
    const res = await post(mock, { model: 'llama3.2:1b', messages, stream: true, stream_options: { include_usage: true } });
    const all = frames(await res.text());
    const usage = all.at(-1).usage;
    assert.ok(usage.prompt_tokens <= 400, `prompt was trimmed to fit (got ${usage.prompt_tokens})`);
    const rec = mock.requests.at(-1);
    assert.ok(rec.trimmedMessages >= 2, `trimmed ${rec.trimmedMessages} messages`);
    // the system message always survives: the mock's own trimming never touches it
    const tooBig = await post(mock, { model: 'llama3.2:1b', messages: [SYSTEM('Rule.'), USER('word '.repeat(1000))], stream: true });
    assert.equal(tooBig.status, 400);
    const err = (await tooBig.json()).error;
    assert.equal(err.type, 'invalid_request_error');
    const nested = JSON.parse(err.message);
    assert.equal(nested.error.type, 'exceed_context_size_error');
    assert.equal(nested.error.n_ctx, 400);
    assert.ok(nested.error.n_prompt_tokens > 400);
    // ... and the adapter turns it into a precise, readable error
    const e = await rejection(drain(local(mock).stream({ messages: [SYSTEM('Rule.'), USER('word '.repeat(1000))] })));
    assert.equal(e.code, 'context_too_long');
    assert.match(e.hint, /holds 400/);
    assert.match(e.hint, /OLLAMA_CONTEXT_LENGTH/);
  });
});

test('flavor ollama + pull.unreachable: HTTP 200 NDJSON with "pulling manifest" then the registry error; the adapter reports a network problem, not a missing model', async () => {
  await withMock({ flavor: 'ollama', pull: { unreachable: true } }, async (mock) => {
    const res = await fetch(`${mock.url}/api/pull`, { method: 'POST', body: JSON.stringify({ model: 'llama3.2:3b', stream: true }) });
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].status, 'pulling manifest');
    assert.equal(lines[1].error, 'pull model manifest: Get "https://registry.ollama.ai/v2/library/llama3.2/manifests/3b": Forbidden');
    const err = await rejection(collect(pullOllamaModel({ baseUrl: mock.baseUrl }, { model: 'llama3.2:3b' })));
    assert.equal(err.code, 'network');
    assert.match(err.hint, /Forbidden/);
    const plain = await fetch(`${mock.url}/api/pull`, { method: 'POST', body: JSON.stringify({ model: 'llama3.2:3b', stream: false }) });
    assert.equal(plain.status, 500);
  });
  await withMock({ flavor: 'ollama', pull: { unreachable: 'proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused' } }, async (mock) => {
    const err = await rejection(collect(pullOllamaModel({ baseUrl: mock.baseUrl }, { model: 'x:1b' })));
    assert.equal(err.code, 'network');
  });
});

test('flavor llamacpp: first delta {role, content: null}, reasoning_content frames, any model accepted, GGUF path as model id, /health, JSON 404', async () => {
  await withMock({ flavor: 'llamacpp', replies: ['The answer.', 'The answer.'], reasoningContent: 'Hmm.', byteSplit: false }, async (mock) => {
    const raw = frames(await (await post(mock, { model: 'whatever', messages: HELLO, stream: true, stream_options: { include_usage: true } })).text());
    assert.deepEqual(raw[0].choices[0].delta, { role: 'assistant', content: null });
    assert.deepEqual(raw[1].choices[0].delta, { reasoning_content: 'Hmm.' });
    assert.equal(raw[0].system_fingerprint, 'b1-631109b34');
    assert.match(raw[0].model, /\.gguf$/);
    const usage = raw.at(-1);
    assert.deepEqual(usage.choices, []);
    assert.ok(usage.timings.cache_n === 0 && usage.usage.completion_tokens > 0);
    const r = await drain(local(mock, { model: 'anything-at-all' }).stream({ messages: HELLO }));
    assert.equal(r.text, 'The answer.');

    assert.deepEqual(await (await fetch(`${mock.url}/health`)).json(), { status: 'ok' });
    const nf = await fetch(`${mock.url}/api/version`);
    assert.equal(nf.status, 404);
    assert.deepEqual(await nf.json(), { error: { message: 'File Not Found', type: 'not_found_error', code: 404 } });
    const list = await local(mock).listModels();
    assert.equal(list[0].id, '/models/qwen3-1.7b-q4km.gguf');
    assert.equal(list[0].label, 'qwen3-1.7b-q4km.gguf');
  });
});

test('flavor llamacpp: errors {error:{code,message,type}}; --api-key 401 is authentication_error; numCtx overflow carries n_prompt_tokens and n_ctx', async () => {
  await withMock({ flavor: 'llamacpp', apiKey: 'sekret-key-123', numCtx: 100 }, async (mock) => {
    const noKey = await post(mock, { model: 'x', messages: HELLO });
    assert.equal(noKey.status, 401);
    assert.deepEqual(await noKey.json(), { error: { message: 'Invalid API Key', type: 'authentication_error', code: 401 } });
    const err = await rejection(drain(local(mock, { apiKey: 'sekret-key-123' }).stream({ messages: [USER('word '.repeat(500))] })));
    assert.equal(err.code, 'context_too_long');
    assert.match(err.hint, /holds 100/);
    assert.match(err.hint, /--ctx-size/);
    assert.ok(!JSON.stringify(err).includes('sekret-key-123'));
  });
});

test('adapter: the local provider sends reasoning_effort "none"; a server that rejects it with a 400 is retried once without it and remembered', async () => {
  await withMock({ rejectParams: ['reasoning_effort'], replies: ['one', 'two', 'three'] }, async (mock) => {
    const p = local(mock, { model: 'mock-model' });
    const first = await drain(p.stream({ messages: HELLO }));
    assert.equal(first.text, 'one');
    const reqs = mock.chatRequests();
    assert.equal(reqs.length, 2, 'rejected once, then healed');
    assert.equal(reqs[0].body.reasoning_effort, 'none');
    assert.equal('reasoning_effort' in reqs[1].body, false);
    await drain(p.stream({ messages: HELLO }));
    assert.equal(mock.chatRequests().length, 3, 'remembered: no second rejection');
    // another adapter instance for the same endpoint + model also remembers
    const q = local(mock, { model: 'mock-model' });
    await drain(q.stream({ messages: HELLO }));
    assert.equal(mock.chatRequests().length, 4);
  });
});

test('healQuirks: reasoning_effort rejected ("does not support thinking", "Unknown parameter: reasoning_effort") -> dropReasoningEffort; unrelated 400s are left alone', () => {
  const quirks = { tokenParam: 'max_tokens', dropTemperature: false, dropStreamOptions: false, dropReasoningEffort: false };
  const used = { hasTemperature: true, hasTokens: true, hasStreamOptions: true, hasReasoningEffort: true };
  for (const text of [
    '{"error":{"message":"\\"llama3.2:1b\\" does not support thinking","type":"invalid_request_error"}}',
    '{"error":{"message":"Unknown parameter: \'reasoning_effort\'."}}',
    '{"detail":"Extra inputs are not permitted: reasoning"}',
  ]) {
    assert.deepEqual(healQuirks(quirks, text, used), { ...quirks, dropReasoningEffort: true }, text);
  }
  assert.equal(healQuirks(quirks, '{"error":{"message":"messages: content must be a string"}}', used), null);
  assert.equal(healQuirks({ ...quirks, dropReasoningEffort: true }, 'does not support thinking', used), null, 'nothing left to adapt');
  assert.equal(healQuirks(quirks, 'does not support thinking', { ...used, hasReasoningEffort: false }), null, 'the request never had the field');
});

test('adapter: openai provider never sends reasoning_effort; healQuirks without the new fields keeps working (older callers)', async () => {
  await withMock({ replies: ['hi'] }, async (mock) => {
    clearOpenAIQuirks();
    const p = createProvider('openai', { baseUrl: mock.baseUrl, model: 'gpt-4o-mini', apiKey: 'sk-test-0123456789abcdef' });
    await drain(p.stream({ messages: HELLO }));
    assert.equal('reasoning_effort' in mock.lastChatRequest().body, false);
  });
  assert.deepEqual(
    healQuirks({ tokenParam: 'max_tokens', dropTemperature: false, dropStreamOptions: false }, "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.", { hasTemperature: false, hasTokens: true, hasStreamOptions: false }),
    { tokenParam: 'max_completion_tokens', dropTemperature: false, dropStreamOptions: false },
  );
});

test('adapter: a strict local server that refuses reasoning_effort AND stream_options AND temperature is still served (3 adaptations); the openai provider keeps its limit of 2', async () => {
  await withMock({ rejectParams: ['reasoning_effort', 'stream_options', 'temperature'], replies: ['fine'] }, async (mock) => {
    const r = await drain(local(mock, { model: 'mock-model' }).stream({ messages: HELLO, temperature: 0.5 }));
    assert.equal(r.text, 'fine');
    assert.equal(mock.chatRequests().length, 4);
    const last = mock.chatRequests().at(-1).body;
    assert.equal('reasoning_effort' in last, false);
    assert.equal('stream_options' in last, false);
    assert.equal('temperature' in last, false);
  });
  await withMock({ rejectParams: ['max_tokens', 'temperature', 'stream_options'] }, async (mock) => {
    clearOpenAIQuirks();
    const p = createProvider('openai', { baseUrl: mock.baseUrl, model: 'gpt-4o-mini', apiKey: 'sk-test-0123456789abcdef' });
    const err = await rejection(drain(p.stream({ messages: HELLO, temperature: 0.5, maxTokens: 50 })));
    assert.equal(err.code, 'bad_request');
    assert.equal(mock.chatRequests().length, 3);
  });
});

test('flavor ollama: /api/tags has the real 0.40.1 shape (capabilities, details.context_length) and /api/ps shows the loaded model with the default 4096 window', async () => {
  await withMock({ flavor: 'ollama', replies: ['hi'] }, async (mock) => {
    const tags = await (await fetch(`${mock.url}/api/tags`)).json();
    assert.deepEqual(tags.models[0].capabilities, ['tools', 'thinking', 'completion']);
    assert.equal(tags.models[0].details.runner, 'llamacpp');
    assert.ok(tags.models[0].details.context_length > 0);
    assert.deepEqual((await (await fetch(`${mock.url}/api/ps`)).json()).models, []);
    await drain(local(mock).stream({ messages: HELLO }));
    const ps = (await (await fetch(`${mock.url}/api/ps`)).json()).models;
    assert.equal(ps.length, 1);
    assert.equal(ps[0].context_length, 4096);
  });
});

test('flavor ollama accepts an unknown message role like the real server (HTTP 200); the generic flavor still rejects it', async () => {
  const messages = [{ role: 'wizard', content: 'hi' }];
  await withMock({ flavor: 'ollama', replies: ['ok'] }, async (mock) => {
    assert.equal((await post(mock, { model: 'llama3.2:1b', messages, stream: true })).status, 200);
  });
  await withMock({ replies: ['ok'] }, async (mock) => {
    assert.equal((await post(mock, { model: 'mock-model', messages, stream: true })).status, 400);
  });
});
