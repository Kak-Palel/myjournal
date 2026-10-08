// The mock servers are test infrastructure that other agents rely on, so they get their own tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createMockOpenAI } from '../mocks/mock-openai.js';
import { createMockGemini, DEFAULT_MODELS, INVALID_KEY_BODY, MISSING_KEY_BODY } from '../mocks/mock-gemini.js';
import { sliceOffsets } from '../mocks/mock-server.js';
import { closedPort, until } from './helpers.js';

const J = { 'Content-Type': 'application/json' };
const chat = (mock, body, headers = {}) => fetch(`${mock.baseUrl}/chat/completions`, { method: 'POST', headers: { ...J, ...headers }, body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hello there friend' }], ...body }) });
const sseData = (text) => text.split(/\r?\n\r?\n/).filter(Boolean).map((f) => f.replace(/^data: ?/, ''));

async function withOpenAI(opts, fn) {
  const mock = await createMockOpenAI(opts);
  try { return await fn(mock); } finally { await mock.close(); }
}
async function withGemini(opts, fn) {
  const mock = await createMockGemini(opts);
  try { return await fn(mock); } finally { await mock.close(); }
}

// ---- mock-openai --------------------------------------------------------------------------------------------

test('mock-openai: binds to loopback on a free port and exposes url/baseUrl/port', async () => {
  await withOpenAI({}, async (mock) => {
    assert.match(mock.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(mock.baseUrl, `${mock.url}/v1`);
    assert.equal(mock.port, Number(new URL(mock.url).port));
    assert.ok(mock.port > 0);
    assert.equal(mock.server.address().address, '127.0.0.1');
    const other = await createMockOpenAI({});
    assert.notEqual(other.port, mock.port);
    await other.close();
  });
});

test('mock-openai: the SSE stream looks like OpenAI\'s (role-only first delta, finish chunk, usage chunk, [DONE])', async () => {
  await withOpenAI({ roleOnly: true, replies: ['Hello there, friend!'] }, async (mock) => {
    const res = await chat(mock, { stream: true, stream_options: { include_usage: true } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const frames = sseData(await res.text());
    assert.equal(frames.at(-1), '[DONE]');
    const objs = frames.slice(0, -1).map((f) => JSON.parse(f));
    assert.deepEqual(objs[0].choices[0].delta, { role: 'assistant' });
    assert.equal(objs[0].object, 'chat.completion.chunk');
    const content = objs.map((o) => o.choices[0]?.delta?.content).filter((c) => typeof c === 'string');
    assert.equal(content.join(''), 'Hello there, friend!');
    assert.ok(content.filter(Boolean).length > 4, 'split into small deltas');
    const finish = objs.find((o) => o.choices[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'stop');
    assert.deepEqual(finish.choices[0].delta, {});
    const usage = objs.at(-1);
    assert.deepEqual(usage.choices, []);
    assert.equal(usage.usage.total_tokens, usage.usage.prompt_tokens + usage.usage.completion_tokens);
    assert.ok(objs.some((o) => o.choices[0] && Object.keys(o.choices[0].delta).length === 0 && !o.choices[0].finish_reason), 'an empty delta is interleaved');
  });
});

test('mock-openai: no usage chunk unless stream_options.include_usage; "always"/"never" override', async () => {
  await withOpenAI({}, async (mock) => {
    const frames = sseData(await (await chat(mock, { stream: true })).text());
    assert.ok(!frames.some((f) => f.includes('"usage"')));
    mock.setBehavior({ usage: 'always' });
    assert.ok(sseData(await (await chat(mock, { stream: true })).text()).some((f) => f.includes('"usage"')));
    mock.setBehavior({ usage: 'never' });
    assert.ok(!sseData(await (await chat(mock, { stream: true, stream_options: { include_usage: true } })).text()).some((f) => f.includes('"usage"')));
  });
});

test('mock-openai: non-streaming JSON mode', async () => {
  await withOpenAI({ replies: ['Whole answer.'] }, async (mock) => {
    const res = await chat(mock, { stream: false });
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, 'Whole answer.');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.ok(body.usage.total_tokens > 0);
  });
});

test('mock-openai: dialect options change the wire format', async () => {
  await withOpenAI({ noSpaceAfterData: true, crlf: true, keepAlive: true, omitDone: false }, async (mock) => {
    const text = await (await chat(mock, { stream: true })).text();
    assert.match(text, /^data:\{/);
    assert.ok(text.includes('\r\n\r\n'));
    assert.ok(text.includes(': keep-alive'));
    assert.ok(text.trimEnd().endsWith('data:[DONE]'));
  });
});

test('mock-openai: <think> blocks and reasoning_content are emitted on request', async () => {
  await withOpenAI({ think: 'pondering', reasoningContent: 'deep thought', replies: ['Answer.'] }, async (mock) => {
    const objs = sseData(await (await chat(mock, { stream: true })).text()).slice(0, -1).map((f) => JSON.parse(f));
    const content = objs.map((o) => o.choices[0]?.delta?.content ?? '').join('');
    const reasoning = objs.map((o) => o.choices[0]?.delta?.reasoning_content ?? '').join('');
    assert.equal(content, '<think>pondering</think>\n\nAnswer.');
    assert.equal(reasoning, 'deep thought');
  });
});

test('mock-openai: sliceOffsets produce cuts inside multi-byte characters', () => {
  const frame = Buffer.from('data: {"content":"日本語😀é"}\n\n', 'utf8');
  let inside = 0;
  for (let seed = 1; seed <= 60; seed += 1) {
    const cuts = sliceOffsets(frame.length, seed);
    assert.ok(cuts.length >= 1 && cuts.length <= 2);
    assert.deepEqual(cuts, [...cuts].sort((a, b) => a - b));
    for (const c of cuts) {
      assert.ok(c > 0 && c < frame.length);
      if ((frame[c] & 0xc0) === 0x80) inside += 1;
    }
  }
  assert.ok(inside > 3, `${inside} cuts landed inside a character`);
  assert.deepEqual(sliceOffsets(3, 1), []);
});

test('mock-openai: over a raw socket the SSE bytes really arrive in several reads, some inside a UTF-8 character', async () => {
  await withOpenAI({ chunkSize: 12, replies: ['日本語のテキスト😀😀😀'.repeat(20)] }, async (mock) => {
    const reads = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi there friend' }], stream: true });
      const sock = net.connect(mock.port, '127.0.0.1');
      const chunks = [];
      sock.on('data', (c) => {
        chunks.push(c);
        if (Buffer.concat(chunks.slice(-3)).includes('[DONE]')) { sock.destroy(); resolve(chunks); }
      });
      sock.on('end', () => resolve(chunks));
      sock.on('error', reject);
      sock.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
    assert.ok(reads.length > 10, `${reads.length} reads`);
    const broken = reads.filter((c) => new TextDecoder('utf-8', { fatal: false }).decode(c).includes('�')).length;
    assert.ok(broken >= 1, 'at least one read ends or starts in the middle of a multi-byte character');
  });
});

test('mock-openai: records requests faithfully', async () => {
  await withOpenAI({}, async (mock) => {
    await fetch(`${mock.url}/v1/models?x=1`, { headers: { Authorization: 'Bearer abc', 'X-Thing': 'Yes' } });
    await chat(mock, { stream: true, temperature: 0.3 }, { Authorization: 'Bearer abc' });
    assert.equal(mock.requests.length, 2);
    const [models, completion] = mock.requests;
    assert.equal(models.method, 'GET');
    assert.equal(models.path, '/v1/models');
    assert.deepEqual(models.query, { x: '1' });
    assert.equal(models.headers.authorization, 'Bearer abc');
    assert.equal(models.headers['x-thing'], 'Yes');
    assert.equal(models.body, null);
    assert.equal(completion.method, 'POST');
    assert.equal(completion.body.temperature, 0.3);
    assert.equal(typeof completion.rawBody, 'string');
    assert.equal(completion.status, 200);
    await until(() => completion.finished);
    assert.equal(mock.chatRequests().length, 1);
    assert.equal(mock.lastChatRequest(), completion);
    assert.equal(mock.lastUserText(), 'hello there friend');
    mock.reset();
    assert.equal(mock.requests.length, 0);
  });
});

test('mock-openai: both /v1/... and bare paths are served; unknown routes are a plain 404', async () => {
  await withOpenAI({}, async (mock) => {
    assert.equal((await fetch(`${mock.url}/models`)).status, 200);
    assert.equal((await fetch(`${mock.url}/v1/models`)).status, 200);
    assert.equal((await fetch(`${mock.url}/v1/models/`)).status, 200);
    const missing = await fetch(`${mock.url}/nope`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), '404 page not found');
    assert.equal((await fetch(`${mock.url}/v1/chat/completions`)).status, 404, 'GET on the POST route');
  });
});

test('mock-openai: validation errors look like OpenAI\'s', async () => {
  await withOpenAI({}, async (mock) => {
    const noModel = await fetch(`${mock.baseUrl}/chat/completions`, { method: 'POST', headers: J, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(noModel.status, 400);
    assert.match((await noModel.json()).error.message, /model/);
    const noMessages = await fetch(`${mock.baseUrl}/chat/completions`, { method: 'POST', headers: J, body: JSON.stringify({ model: 'm' }) });
    assert.equal(noMessages.status, 400);
    const garbage = await fetch(`${mock.baseUrl}/chat/completions`, { method: 'POST', headers: J, body: '{not json' });
    assert.equal(garbage.status, 400);
    const badRole = await chat(mock, { messages: [{ role: 'robot', content: 'x' }] });
    assert.equal(badRole.status, 400);
  });
});

test('mock-openai: error injection returns the documented statuses and bodies', async () => {
  const cases = [
    ['unauthorized', 401, (b) => b.error.code === 'invalid_api_key'],
    ['forbidden', 403, (b) => b.error.type === 'permission_error'],
    ['model_not_found', 404, (b) => b.error.code === 'model_not_found'],
    ['quota', 429, (b) => b.error.type === 'insufficient_quota'],
    ['context_length', 400, (b) => b.error.code === 'context_length_exceeded'],
    ['server_error', 500, (b) => b.error.type === 'server_error'],
    ['unavailable', 503, (b) => b.error.type === 'server_error'],
  ];
  for (const [kind, status, check] of cases) {
    await withOpenAI({ failures: [kind] }, async (mock) => {
      const res = await chat(mock, { stream: true });
      assert.equal(res.status, status, kind);
      assert.ok(check(await res.json()), kind);
    });
  }
  await withOpenAI({ failures: [{ kind: 'rate_limit', retryAfter: 7 }] }, async (mock) => {
    const res = await chat(mock, { stream: true });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '7');
    assert.equal((await res.json()).error.code, 'rate_limit_exceeded');
  });
  await withOpenAI({ failures: ['not_found'] }, async (mock) => {
    const res = await chat(mock, {});
    assert.equal(res.status, 404);
    assert.equal(await res.text(), '404 page not found');
  });
  await withOpenAI({ failures: ['redirect'] }, async (mock) => {
    const res = await fetch(`${mock.baseUrl}/chat/completions`, { method: 'POST', headers: J, body: '{}', redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.ok(res.headers.get('location'));
  });
  await withOpenAI({ failures: ['html'] }, async (mock) => {
    const res = await chat(mock, {});
    assert.equal(res.status, 502);
    assert.match(res.headers.get('content-type'), /html/);
  });
});

test('mock-openai: error body flavours (openai object, ollama /v1 object, ollama native string, llama.cpp numeric code)', async () => {
  await withOpenAI({ failures: [{ kind: 'model_not_found', model: 'x:1b' }], errorStyle: 'ollama' }, async (mock) => {
    // Verified live (Ollama 0.40.1): /v1 errors are OpenAI-shaped, with Ollama's own type and null param / code.
    assert.deepEqual(await (await chat(mock, {})).json(), { error: { message: "model 'x:1b' not found", type: 'not_found_error', param: null, code: null } });
  });
  await withOpenAI({ failures: [{ kind: 'model_not_found', model: 'x:1b' }], errorStyle: 'ollama-native' }, async (mock) => {
    // The native /api/* endpoints answer {"error": "text"}.
    assert.deepEqual(await (await chat(mock, {})).json(), { error: "model 'x:1b' not found" });
  });
  await withOpenAI({ failures: ['unauthorized'], errorStyle: 'llamacpp' }, async (mock) => {
    const body = await (await chat(mock, {})).json();
    assert.equal(body.error.code, 401);
    assert.equal(typeof body.error.message, 'string');
    assert.equal(body.error.type, 'authentication_error');
  });
});

test('mock-openai: rejectParams answers 400 for max_tokens / temperature / stream_options like real servers', async () => {
  await withOpenAI({ rejectParams: ['max_tokens', 'temperature', 'stream_options'] }, async (mock) => {
    for (const [param, pattern] of [['max_tokens', /max_completion_tokens/], ['temperature', /temperature/], ['stream_options', /stream_options/]]) {
      const res = await chat(mock, { [param]: param === 'stream_options' ? { include_usage: true } : 1 });
      assert.equal(res.status, 400, param);
      assert.match((await res.json()).error.message, pattern);
    }
    assert.equal((await chat(mock, { stream: true })).status, 200, 'requests without those params pass');
  });
});

test('mock-openai: apiKey enforcement and strictModel', async () => {
  await withOpenAI({ apiKey: ['k1', 'k2'], strictModel: true, models: ['known'] }, async (mock) => {
    assert.equal((await chat(mock, { model: 'known' })).status, 401);
    assert.equal((await chat(mock, { model: 'known' }, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await chat(mock, { model: 'known' }, { Authorization: 'Bearer k2' })).status, 200);
    const unknown = await chat(mock, { model: 'other' }, { Authorization: 'Bearer k1' });
    assert.equal(unknown.status, 404);
    assert.equal((await fetch(`${mock.baseUrl}/models`)).status, 401);
    assert.equal((await fetch(`${mock.baseUrl}/models`, { headers: { Authorization: 'Bearer k1' } })).status, 200);
  });
});

test('mock-openai: failures queue semantics (order, null = succeed, times, function, persistent)', async () => {
  await withOpenAI({ failures: ['server_error', null, { kind: 'unavailable', times: 2 }] }, async (mock) => {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await chat(mock, {})).status);
    assert.deepEqual(statuses, [500, 200, 503, 503, 200, 200]);
  });
  await withOpenAI({ failures: (ctx) => (ctx.body.messages[0].content.includes('boom') ? 'server_error' : null) }, async (mock) => {
    assert.equal((await chat(mock, { messages: [{ role: 'user', content: 'boom' }] })).status, 500);
    assert.equal((await chat(mock, { messages: [{ role: 'user', content: 'fine' }] })).status, 200);
  });
  await withOpenAI({ failures: 'unauthorized' }, async (mock) => {
    for (let i = 0; i < 3; i += 1) assert.equal((await chat(mock, {})).status, 401);
    mock.setBehavior({ failures: [] });
    assert.equal((await chat(mock, {})).status, 200);
  });
});

test('mock-openai: scripted replies, rewinding on setBehavior, delay and ttfb options', async () => {
  await withOpenAI({ replies: ['one', (ctx) => `two:${ctx.index}`, { text: 'three', finishReason: 'length' }] }, async (mock) => {
    const get = async () => (await (await chat(mock, { stream: false })).json()).choices[0];
    assert.equal((await get()).message.content, 'one');
    assert.equal((await get()).message.content, 'two:1');
    const third = await get();
    assert.equal(third.message.content, 'three');
    assert.equal(third.finish_reason, 'length');
    assert.match((await get()).message.content, /^Thanks for the message/);
    mock.setBehavior({ replies: ['again'] });
    assert.equal((await get()).message.content, 'again');
  });
  await withOpenAI({ delayMs: 25, chunkSize: 5, replies: ['x'.repeat(40)] }, async (mock) => {
    const t0 = Date.now();
    await (await chat(mock, { stream: true })).text();
    assert.ok(Date.now() - t0 >= 150, `took ${Date.now() - t0} ms`);
  });
  await withOpenAI({ ttfbMs: 150 }, async (mock) => {
    const t0 = Date.now();
    await (await chat(mock, { stream: true })).text();
    assert.ok(Date.now() - t0 >= 120);
  });
});

test('mock-openai: hang never answers; close() still completes promptly and frees the port', async () => {
  const mock = await createMockOpenAI({ failures: ['hang'] });
  const ac = new AbortController();
  const pending = chat(mock, {}).catch((e) => e);
  await mock.waitForRequests(1);
  assert.equal(mock.inflight, 1);
  const t0 = Date.now();
  await mock.close();
  assert.ok(Date.now() - t0 < 2000);
  assert.ok((await pending) instanceof Error);
  await mock.close(); // idempotent
  await assert.rejects(fetch(`${mock.url}/v1/models`));
  ac.abort();
});

test('mock-openai: reset kills the connection mid-stream; stall goes silent; client abort is recorded', async () => {
  await withOpenAI({ failures: [{ kind: 'reset', after: 2 }], chunkSize: 3, replies: ['y'.repeat(100)] }, async (mock) => {
    const res = await chat(mock, { stream: true });
    await assert.rejects(res.text());
  });
  await withOpenAI({ delayMs: 20, chunkSize: 3, replies: ['z'.repeat(1000)] }, async (mock) => {
    const ac = new AbortController();
    const res = await fetch(`${mock.baseUrl}/chat/completions`, { method: 'POST', headers: J, signal: ac.signal, body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hello friend' }] }) });
    const reader = res.body.getReader();
    await reader.read();
    ac.abort();
    await mock.waitForIdle();
    assert.equal(mock.requests[0].aborted, true);
    assert.equal(mock.requests[0].finished, false);
  });
});

test('mock-openai: modelsStyle variants', async () => {
  for (const [modelsStyle, check] of [['openai', (b) => b.data[0].id], ['array', (b) => b[0].id], ['models-key', (b) => b.models[0].name], ['llamacpp', (b) => b.models[0].name && b.data[0].id]]) {
    await withOpenAI({ modelsStyle, models: ['m1'] }, async (mock) => {
      assert.equal(check(await (await fetch(`${mock.baseUrl}/models`)).json()), 'm1', modelsStyle);
    });
  }
});

test('mock-openai: Ollama endpoints (/api/version, /api/tags, /api/pull)', async () => {
  await withOpenAI({ models: ['llama3.2:3b'] }, async (mock) => {
    assert.deepEqual(await (await fetch(`${mock.url}/api/version`)).json(), { version: '0.5.7-mock' });
    const tags = await (await fetch(`${mock.url}/api/tags`)).json();
    assert.equal(tags.models[0].name, 'llama3.2:3b');
    const res = await fetch(`${mock.url}/api/pull`, { method: 'POST', body: JSON.stringify({ model: 'qwen2.5:1.5b' }) });
    assert.match(res.headers.get('content-type'), /ndjson/);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].status, 'pulling manifest');
    assert.deepEqual(lines.at(-1), { status: 'success' });
    assert.ok(lines.some((l) => l.total && l.completed === l.total));
    assert.ok((await (await fetch(`${mock.url}/api/tags`)).json()).models.some((m) => m.name === 'qwen2.5:1.5b'));
    const missing = await fetch(`${mock.url}/api/pull`, { method: 'POST', body: JSON.stringify({ name: 'nonexistent-model' }) });
    const missingLines = (await missing.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(missingLines.at(-1).error, 'pull model manifest: file does not exist');
    assert.equal((await fetch(`${mock.url}/api/pull`, { method: 'POST', body: '{}' })).status, 400);
    const single = await fetch(`${mock.url}/api/pull`, { method: 'POST', body: JSON.stringify({ model: 'x:1b', stream: false }) });
    assert.deepEqual(await single.json(), { status: 'success' });
  });
  await withOpenAI({ ollama: false }, async (mock) => {
    assert.equal((await fetch(`${mock.url}/api/version`)).status, 404);
  });
});

// ---- mock-gemini --------------------------------------------------------------------------------------------

const gen = (mock, body, { key = 'k', method = 'streamGenerateContent', model = 'gemini-2.5-flash', headers = {} } = {}) =>
  fetch(`${mock.url}/v1beta/models/${model}:${method}${method === 'streamGenerateContent' ? '?alt=sse' : ''}`, {
    method: 'POST', headers: { ...J, ...(key ? { 'x-goog-api-key': key } : {}), ...headers }, body: JSON.stringify(body),
  });
const GOOD = { contents: [{ role: 'user', parts: [{ text: 'hello there friend' }] }] };

test('mock-gemini: key validation returns the live bodies exactly', async () => {
  await withGemini({ apiKey: 'good-key' }, async (mock) => {
    const missing = await gen(mock, GOOD, { key: '' });
    assert.equal(missing.status, 403);
    assert.deepEqual(await missing.json(), MISSING_KEY_BODY);
    const invalid = await gen(mock, GOOD, { key: 'bad-key' });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), INVALID_KEY_BODY);
    assert.equal((await gen(mock, GOOD, { key: 'good-key' })).status, 200);
    const viaQuery = await fetch(`${mock.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=good-key`, { method: 'POST', headers: J, body: JSON.stringify(GOOD) });
    assert.equal(viaQuery.status, 200, 'the real service also accepts ?key= (the adapter never uses it)');
    assert.equal((await fetch(`${mock.url}/v1beta/models`)).status, 403);
    assert.equal((await fetch(`${mock.url}/v1beta/models`, { headers: { 'x-goog-api-key': 'bad' } })).status, 400);
  });
  await withGemini({}, async (mock) => {
    assert.equal((await gen(mock, GOOD, { key: 'anything' })).status, 200, 'without apiKey any non-empty key is accepted');
    assert.equal((await gen(mock, GOOD, { key: '' })).status, 403);
  });
});

test('mock-gemini: SSE frames end in CRLF CRLF, have the real shape, and carry usage on the last frame', async () => {
  await withGemini({ replies: ['Hello from Gemini, in pieces.'] }, async (mock) => {
    const res = await gen(mock, GOOD);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const raw = await res.text();
    assert.ok(raw.includes('\r\n\r\n'));
    assert.ok(!raw.includes('[DONE]'));
    const frames = raw.split('\r\n\r\n').filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, '')));
    assert.equal(frames.map((f) => f.candidates[0].content.parts[0].text).join(''), 'Hello from Gemini, in pieces.');
    const last = frames.at(-1);
    assert.equal(last.candidates[0].finishReason, 'STOP');
    assert.ok(last.usageMetadata.totalTokenCount > 0);
    assert.equal(frames[0].candidates[0].content.role, 'model');
    assert.equal(frames[0].candidates[0].finishReason, undefined);
  });
});

test('mock-gemini: generateContent (non-streaming) returns one JSON document', async () => {
  await withGemini({ replies: ['Complete.'] }, async (mock) => {
    const body = await (await gen(mock, GOOD, { method: 'generateContent' })).json();
    assert.equal(body.candidates[0].content.parts[0].text, 'Complete.');
    assert.equal(body.candidates[0].finishReason, 'STOP');
  });
});

test('mock-gemini: validates contents like the live API (may open with a model turn, must not end with one, no empty text)', async () => {
  await withGemini({}, async (mock) => {
    const msg = async (body, opts) => {
      const r = await gen(mock, body, opts);
      const text = await r.text();
      let message;
      try { message = JSON.parse(text).error?.message; } catch { /* a successful SSE answer */ }
      return [r.status, message];
    };
    const model = { role: 'model', parts: [{ text: 'x' }] };
    const user = { role: 'user', parts: [{ text: 'y' }] };
    assert.equal((await msg({ contents: [model, user] }))[0], 200, 'opening with a model turn is fine');
    assert.equal((await msg({ contents: [user, user] }))[0], 200, 'consecutive same-role turns are accepted');
    assert.deepEqual(await msg({ contents: [user, model] }), [400, 'Requests ending with a model turn are not supported.']);
    assert.deepEqual(await msg({ contents: [model] }), [400, 'Requests ending with a model turn are not supported.']);
    assert.deepEqual(await msg({ contents: [{ role: 'user', parts: [{ text: '' }] }] }), [400, 'Request has empty input.']);
    assert.match((await msg({ contents: [{ role: 'user', parts: [] }] }))[1], /must not be empty/);
    assert.match((await msg({ contents: [{ role: 'system', parts: [{ text: 'x' }] }] }))[1], /valid role/);
    assert.match((await msg({}))[1], /contents/);
    const unknown = await gen(mock, GOOD, { model: 'gemini-nope' });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.status, 'NOT_FOUND');
    const garbage = await fetch(`${mock.url}/v1beta/models/gemini-2.5-flash:generateContent`, { method: 'POST', headers: { ...J, 'x-goog-api-key': 'k' }, body: 'nope' });
    assert.equal(garbage.status, 400);
  });
  await withGemini({ strictAlternation: true }, async (mock) => {
    const user = { role: 'user', parts: [{ text: 'y' }] };
    const res = await gen(mock, { contents: [user, user] });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /alternate/);
  });
});

test('mock-gemini: rejectThinking / rejectSystemInstruction behave like the live API', async () => {
  await withGemini({ rejectThinking: ['minimal', 'budget0'], rejectSystemInstruction: /gemma/ }, async (mock) => {
    const cfg = (thinkingConfig) => ({ ...GOOD, generationConfig: { thinkingConfig } });
    const minimal = await gen(mock, cfg({ thinkingLevel: 'minimal' }));
    assert.equal(minimal.status, 400);
    assert.equal((await minimal.json()).error.message, 'Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.');
    const budget0 = await gen(mock, cfg({ thinkingBudget: 0 }));
    assert.equal(budget0.status, 400);
    assert.equal((await budget0.json()).error.message, 'Request contains an invalid argument.');
    assert.equal((await gen(mock, cfg({ thinkingLevel: 'low' }))).status, 200, 'low is accepted');
    assert.equal((await gen(mock, cfg({ thinkingBudget: 128 }))).status, 200);
    const sys = { ...GOOD, systemInstruction: { parts: [{ text: 'rules' }] } };
    const gemma = await gen(mock, sys, { model: 'gemma-3-27b-it' });
    assert.equal(gemma.status, 400);
    assert.match((await gemma.json()).error.message, /Developer instruction is not enabled/);
    assert.equal((await gen(mock, sys)).status, 200);
  });
});

test('mock-gemini: like the live service, non-key errors on the stream endpoint come back as text/event-stream with a JSON body', async () => {
  await withGemini({ apiKey: 'k', failures: ['not_found', 'invalid_key', 'model_retired'] }, async (mock) => {
    const notFound = await gen(mock, GOOD);
    assert.equal(notFound.status, 404);
    assert.match(notFound.headers.get('content-type'), /^text\/event-stream/);
    assert.equal((await notFound.json()).error.status, 'NOT_FOUND');
    const invalid = await gen(mock, GOOD);
    assert.match(invalid.headers.get('content-type'), /^application\/json/, 'key errors are plain JSON');
    const retired = await gen(mock, GOOD);
    assert.match((await retired.json()).error.message, /no longer available to new users/);
  });
});

test('mock-gemini: thinkingConsumesBudget spends tokens on thoughts: a small cap ends in MAX_TOKENS, a roomy one does not', async () => {
  await withGemini({ thinkingConsumesBudget: 300, replies: () => 'x'.repeat(2000) }, async (mock) => {
    const call = async (cap) => {
      const res = await gen(mock, { ...GOOD, generationConfig: { maxOutputTokens: cap } });
      const frames = (await res.text()).split('\r\n\r\n').filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, '')));
      return { frames, last: frames.at(-1) };
    };
    const starved = await call(200);
    assert.equal(starved.last.candidates[0].finishReason, 'MAX_TOKENS');
    assert.equal(starved.last.candidates[0].content.parts, undefined);
    assert.equal(starved.last.usageMetadata.thoughtsTokenCount, 200);
    const roomy = await call(2248);
    assert.equal(roomy.last.candidates[0].finishReason, 'STOP');
    assert.equal(roomy.last.usageMetadata.thoughtsTokenCount, 300);
    const truncated = await call(400);
    assert.equal(truncated.last.candidates[0].finishReason, 'MAX_TOKENS');
    const text = truncated.frames.flatMap((f) => (f.candidates[0].content.parts || []).map((p) => p.text)).join('');
    assert.ok(text.length > 100 && text.length < 2000, `${text.length} characters`);
  });
});

test('mock-gemini: failure kinds', async () => {
  const cases = [
    ['invalid_key', 400, 'INVALID_ARGUMENT'], ['missing_key', 403, 'PERMISSION_DENIED'], ['rate_limit', 429, 'RESOURCE_EXHAUSTED'],
    ['quota_daily', 429, 'RESOURCE_EXHAUSTED'], ['not_found', 404, 'NOT_FOUND'], ['unavailable', 503, 'UNAVAILABLE'],
    ['internal', 500, 'INTERNAL'], ['deadline', 504, 'DEADLINE_EXCEEDED'], ['region', 400, 'FAILED_PRECONDITION'], ['bad_request', 400, 'INVALID_ARGUMENT'],
  ];
  for (const [kind, status, gstatus] of cases) {
    await withGemini({ failures: [kind] }, async (mock) => {
      const res = await gen(mock, GOOD);
      assert.equal(res.status, status, kind);
      assert.equal((await res.json()).error.status, gstatus, kind);
    });
  }
  await withGemini({ failures: [{ kind: 'rate_limit', retryDelay: '3s' }] }, async (mock) => {
    const body = await (await gen(mock, GOOD)).json();
    assert.ok(body.error.details.some((d) => d['@type'].endsWith('RetryInfo') && d.retryDelay === '3s'));
    assert.ok(body.error.details.some((d) => d['@type'].endsWith('QuotaFailure')));
  });
  await withGemini({ failures: ['safety_prompt'] }, async (mock) => {
    const raw = await (await gen(mock, GOOD)).text();
    assert.equal(JSON.parse(raw.replace(/^data: /, '')).promptFeedback.blockReason, 'SAFETY');
  });
  await withGemini({ failures: ['safety_candidate'] }, async (mock) => {
    const raw = await (await gen(mock, GOOD)).text();
    assert.equal(JSON.parse(raw.replace(/^data: /, '')).candidates[0].finishReason, 'SAFETY');
  });
  await withGemini({ failures: ['max_tokens_empty'] }, async (mock) => {
    const raw = await (await gen(mock, GOOD)).text();
    const frame = JSON.parse(raw.replace(/^data: /, ''));
    assert.equal(frame.candidates[0].finishReason, 'MAX_TOKENS');
    assert.equal(frame.candidates[0].content.parts, undefined);
  });
});

test('mock-gemini: model list is realistic, paginated with opaque tokens, and rejects bad tokens', async () => {
  await withGemini({ listPageSize: 5 }, async (mock) => {
    const seen = [];
    let token = '';
    let pages = 0;
    do {
      const res = await fetch(`${mock.url}/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { headers: { 'x-goog-api-key': 'k' } });
      const body = await res.json();
      seen.push(...body.models.map((m) => m.name));
      token = body.nextPageToken || '';
      pages += 1;
      assert.ok(body.models.length <= 5);
    } while (token);
    assert.equal(pages, Math.ceil(DEFAULT_MODELS.length / 5));
    assert.deepEqual(seen, DEFAULT_MODELS.map((m) => m.name));
    assert.ok(seen.every((n) => n.startsWith('models/')));
    const bad = await fetch(`${mock.url}/v1beta/models?pageToken=garbage`, { headers: { 'x-goog-api-key': 'k' } });
    assert.equal(bad.status, 400);
    const one = await fetch(`${mock.url}/v1beta/models/gemini-2.5-flash`, { headers: { 'x-goog-api-key': 'k' } });
    assert.equal((await one.json()).name, 'models/gemini-2.5-flash');
    assert.equal((await fetch(`${mock.url}/v1beta/models/nope`, { headers: { 'x-goog-api-key': 'k' } })).status, 404);
  });
});

test('mock-gemini: records requests, supports reset/setBehavior, hang and close', async () => {
  const mock = await createMockGemini({ failures: ['hang'], replies: ['a', 'b'] });
  const pending = gen(mock, GOOD).catch((e) => e);
  await mock.waitForRequests(1);
  assert.equal(mock.generateRequests().length, 1);
  assert.equal(mock.lastGenerateRequest().headers['x-goog-api-key'], 'k');
  assert.deepEqual(mock.lastGenerateRequest().query, { alt: 'sse' });
  assert.equal(mock.lastUserText(), 'hello there friend');
  await mock.close();
  assert.ok((await pending) instanceof Error);
  assert.equal(mock.requests.length, 1);
  assert.ok(await closedPort());
});

// ---- serve.js -----------------------------------------------------------------------------------------------

test('serve.js starts both mocks, prints instructions, serves requests and exits cleanly on SIGINT', async () => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', new URL('../mocks/serve.js', import.meta.url).pathname,
    '--openai-port', '0', '--gemini-port', '0', '--delay', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    await until(() => /Streaming delay/.test(out), 8000);
    const openai = /Base URL : (http:\/\/127\.0\.0\.1:\d+\/v1)/.exec(out)[1];
    const gemini = /Base URL : (http:\/\/127\.0\.0\.1:\d+)\n/.exec(out)[1];
    assert.match(out, /Settings -> Local model/);
    assert.match(out, /Settings -> OpenAI-compatible/);
    assert.match(out, /Settings -> Gemini/);
    assert.match(out, /API key: mock-key/);
    assert.match(out, /LOCAL_LLM_BASE_URL=/);
    const res = await fetch(`${openai}/chat/completions`, { method: 'POST', headers: J, body: JSON.stringify({ model: 'llama3.2:3b', stream: false, messages: [{ role: 'system', content: 'TASK: reply\nx' }, { role: 'user', content: 'I felt tired after the long meeting.' }] }) });
    assert.match((await res.json()).choices[0].message.content, /\?$/);
    const g = await fetch(`${gemini}/v1beta/models`, { headers: { 'x-goog-api-key': 'mock-key' } });
    assert.equal(g.status, 200);
    assert.equal((await fetch(`${gemini}/v1beta/models`, { headers: { 'x-goog-api-key': 'other' } })).status, 400);
  } finally {
    child.kill('SIGINT');
  }
  const { code, signal } = await exited;
  assert.ok(code === 0 || signal === 'SIGINT', `exit ${code}/${signal}\n${out}`);
});

// ---- ergonomics for people writing tests against the mocks ---------------------------------------------------

test('mock-openai: failure specs accept aliases and { status } objects; a single string works for `replies`', async () => {
  const cases = [
    ['401', 401], ['auth', 401], ['404', 404], ['429', 429], ['500', 500], ['503', 503], ['400', 400],
    [{ status: 401 }, 401], [{ status: 404 }, 404], [{ status: 429, retryAfter: 3 }, 429], [{ status: 500 }, 500], [{ status: 503 }, 503],
    [{ status: 418, body: { error: { message: 'teapot' } } }, 418], [{ kind: 'Rate-Limit' }, 429], [{ kind: 'http', status: 502, text: 'bad gateway' }, 502],
  ];
  for (const [failure, status] of cases) {
    await withOpenAI({ failures: [failure] }, async (mock) => {
      assert.equal((await chat(mock, {})).status, status, JSON.stringify(failure));
    });
  }
  await withOpenAI({ failures: [{ status: 429, retryAfter: 3 }] }, async (mock) => {
    assert.equal((await chat(mock, {})).headers.get('retry-after'), '3');
  });
  await withOpenAI({ failures: [{ status: 429, retry_after: 4 }] }, async (mock) => {
    assert.equal((await chat(mock, {})).headers.get('retry-after'), '4');
  });
  await withOpenAI({ replies: 'just this' }, async (mock) => {
    assert.equal((await (await chat(mock, { stream: false })).json()).choices[0].message.content, 'just this');
    mock.setBehavior({ replies: 'and now this' });
    assert.equal((await (await chat(mock, { stream: false })).json()).choices[0].message.content, 'and now this');
  });
  // 'timeout' means the server never answers
  await withOpenAI({ failures: ['timeout'] }, async (mock) => {
    const ac = new AbortController();
    const pending = chat(mock, {}).catch(() => 'closed');
    await mock.waitForRequests(1);
    assert.equal(mock.inflight, 1);
    ac.abort();
    await mock.close();
    assert.equal(await pending, 'closed');
  });
});

test('mock-openai: a mistyped failure kind fails loudly instead of silently behaving normally', async () => {
  await withOpenAI({ failures: ['rate_limt'] }, async (mock) => {
    const res = await chat(mock, {});
    assert.equal(res.status, 500);
    assert.match((await res.json()).error.message, /unknown failure kind "rate_limt"/);
  });
  await withOpenAI({ modelsFailures: ['nope'] }, async (mock) => {
    const res = await fetch(`${mock.baseUrl}/models`);
    assert.equal(res.status, 500);
  });
});

test('mock-gemini: failure specs accept aliases and { status } objects; unknown kinds fail loudly', async () => {
  const cases = [['429', 429], ['auth', 400], ['404', 404], ['503', 503], ['500', 500], ['quota', 429], ['retired', 404],
    [{ status: 429 }, 429], [{ status: 503 }, 503], [{ status: 404 }, 404], [{ status: 418, body: { error: { message: 'teapot' } } }, 418], [{ kind: 'Rate-Limit' }, 429]];
  for (const [failure, status] of cases) {
    await withGemini({ failures: [failure] }, async (mock) => {
      assert.equal((await gen(mock, GOOD)).status, status, JSON.stringify(failure));
    });
  }
  await withGemini({ failures: ['safety'] }, async (mock) => {
    assert.match(await (await gen(mock, GOOD)).text(), /blockReason/);
  });
  await withGemini({ failures: ['nonsense'] }, async (mock) => {
    const res = await gen(mock, GOOD);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error.message, /unknown failure kind "nonsense"/);
  });
  await withGemini({ replies: 'only this' }, async (mock) => {
    const text = await (await gen(mock, GOOD, { method: 'generateContent' })).json();
    assert.equal(text.candidates[0].content.parts[0].text, 'only this');
  });
});
