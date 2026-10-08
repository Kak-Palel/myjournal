import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockGemini, DEFAULT_MODELS } from '../mocks/mock-gemini.js';
import { createProvider } from '../../src/providers/index.js';
import {
  bareModelId, buildGeminiContents, clearGeminiQuirks, normalizeGeminiBase, outputTokenLimit, sortGeminiModels, thinkingCandidates,
} from '../../src/providers/gemini.js';
import { ProviderError } from '../../src/providers/errors.js';
import {
  ASSISTANT, HELLO, SYSTEM, USER, abortListeners, drain, fakeFetch, fakeSleep, withTimerCheck,
} from './helpers.js';

const KEY = 'AIzaTestKey-0123456789abcdef';

async function run(mockOpts, fn, { cfg = {}, opts = {}, sleep = fakeSleep() } = {}) {
  clearGeminiQuirks();
  const mock = await createMockGemini({ apiKey: KEY, ...mockOpts });
  try {
    const provider = createProvider('gemini', { baseUrl: mock.url, model: 'gemini-flash-lite-latest', apiKey: KEY, timeoutMs: 5000, ...cfg }, { sleep, ...opts });
    return await fn({ mock, provider, sleep });
  } finally {
    await mock.close();
  }
}
const rejection = (p) => p.then(() => assert.fail('expected a rejection'), (e) => e);

// ---- pure helpers ----------------------------------------------------------------------------------------

test('buildGeminiContents: system -> systemInstruction, roles mapped, alternation guaranteed', () => {
  const out = buildGeminiContents([SYSTEM('TASK: reply'), SYSTEM('Be kind.'), USER('a'), USER('b'), ASSISTANT('c'), USER('d')]);
  assert.deepEqual(out, {
    systemInstruction: { parts: [{ text: 'TASK: reply\n\nBe kind.' }] },
    contents: [
      { role: 'user', parts: [{ text: 'a\n\nb' }] },
      { role: 'model', parts: [{ text: 'c' }] },
      { role: 'user', parts: [{ text: 'd' }] },
    ],
  });
});

test('buildGeminiContents: a leading model turn (guided-journal opening) is sent as is: no invented user turn', () => {
  const out = buildGeminiContents([SYSTEM('s'), ASSISTANT('What is on your mind?'), USER('work')]);
  assert.deepEqual(out.contents.map((c) => [c.role, c.parts[0].text]), [['model', 'What is on your mind?'], ['user', 'work']]);
});

test('buildGeminiContents: consecutive same-role turns merge; a trailing model turn is left alone (the adapter refuses to send it)', () => {
  const out = buildGeminiContents([USER('a'), ASSISTANT('b'), ASSISTANT('c')]);
  assert.deepEqual(out.contents.map((c) => [c.role, c.parts[0].text]), [['user', 'a'], ['model', 'b\n\nc']]);
});

test('buildGeminiContents: no system message -> no systemInstruction; foldSystem moves it into the first user turn', () => {
  assert.equal('systemInstruction' in buildGeminiContents([USER('hi')]), false);
  const folded = buildGeminiContents([SYSTEM('RULES'), USER('x'), ASSISTANT('y'), USER('z')], { foldSystem: true });
  assert.equal('systemInstruction' in folded, false);
  assert.equal(folded.contents[0].parts[0].text, 'RULES\n\nx');
  // conversation opening with a model turn: the instructions get a user turn of their own in front
  const opening = buildGeminiContents([SYSTEM('RULES'), ASSISTANT('open'), USER('x')], { foldSystem: true });
  assert.deepEqual(opening.contents.map((c) => [c.role, c.parts[0].text]), [['user', 'RULES'], ['model', 'open'], ['user', 'x']]);
  // whatever goes in, roles never repeat back to back
  for (const msgs of [[USER('a')], [ASSISTANT('a'), USER('b')], [USER('a'), USER('b')], [ASSISTANT('a'), ASSISTANT('b'), USER('c'), USER('d'), ASSISTANT('e')]]) {
    const { contents } = buildGeminiContents(msgs);
    for (let i = 1; i < contents.length; i += 1) assert.notEqual(contents[i].role, contents[i - 1].role);
  }
});

test('thinkingCandidates: auto sends nothing, low sends thinkingLevel low then nothing; minimal and budgets are never candidates', () => {
  assert.deepEqual(thinkingCandidates('auto'), [null]);
  assert.deepEqual(thinkingCandidates('low'), [{ thinkingLevel: 'low' }, null]);
  assert.deepEqual(thinkingCandidates(undefined), [null]);
  assert.deepEqual(thinkingCandidates('fast'), [null], 'legacy values fall back to auto');
  for (const mode of ['auto', 'low', 'x']) {
    const text = JSON.stringify(thinkingCandidates(mode));
    assert.ok(!/minimal|thinkingBudget/.test(text), mode);
  }
});

test('outputTokenLimit: requested + 2048 of room for thoughts, at most 8192, never below the request', () => {
  assert.equal(outputTokenLimit(700), 2748);
  assert.equal(outputTokenLimit(16), 2064);
  assert.equal(outputTokenLimit(6144), 8192);
  assert.equal(outputTokenLimit(7000), 8192);
  assert.equal(outputTokenLimit(8192), 8192);
  assert.equal(outputTokenLimit(9000), 9000);
  assert.equal(outputTokenLimit(699.9), 2747);
  for (const bad of [undefined, null, 0, -5, NaN, 'x', Infinity]) assert.equal(outputTokenLimit(bad), undefined, String(bad));
});

test('normalizeGeminiBase and bareModelId', () => {
  const table = [
    ['https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com'],
    ['https://generativelanguage.googleapis.com/', 'https://generativelanguage.googleapis.com'],
    ['https://generativelanguage.googleapis.com/v1beta', 'https://generativelanguage.googleapis.com'],
    ['https://generativelanguage.googleapis.com/v1beta/', 'https://generativelanguage.googleapis.com'],
    ['https://generativelanguage.googleapis.com/v1', 'https://generativelanguage.googleapis.com'],
    ['https://generativelanguage.googleapis.com/v1beta/models', 'https://generativelanguage.googleapis.com'],
    ['generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com'],
    ['https://proxy.example.com/gemini/v1beta', 'https://proxy.example.com/gemini'],
    ['http://127.0.0.1:11501', 'http://127.0.0.1:11501'],
    ['localhost:11501', 'http://localhost:11501'],
    ['http://[::1]:11501/', 'http://[::1]:11501'],
  ];
  for (const [input, expected] of table) assert.equal(normalizeGeminiBase(input), expected, input);
  for (const bad of ['', 'ftp://x', 'https://x.com?key=SECRET', 'https://user:pw@x.com', undefined]) {
    assert.throws(() => normalizeGeminiBase(bad), (e) => e.code === 'bad_base_url' && e.provider === 'gemini', String(bad));
  }
  assert.equal(bareModelId('models/gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(bareModelId(' gemini-x '), 'gemini-x');
  assert.equal(bareModelId(undefined), '');
});

test('sortGeminiModels: -latest aliases first (alphabetical), then ids descending', () => {
  const ids = ['gemini-2.0-flash', 'gemini-pro-latest', 'gemini-2.5-pro', 'gemini-flash-latest', 'gemini-1.5-flash', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-10-x'];
  assert.deepEqual(sortGeminiModels(ids.map((id) => ({ id, label: id }))).map((m) => m.id), [
    'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest',
    'gemini-10-x', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash',
  ]);
});

test('sortGeminiModels: Gemma models go after every Gemini model (alphabetically "gemma" would beat "gemini")', () => {
  // Live: with a plain descending sort gemma-4-31b-it was offered above gemini-3.8-flash in the picker.
  const ids = ['gemma-4-26b-a4b-it', 'gemini-2.5-pro', 'gemma-4-31b-it', 'gemini-3.8-flash', 'gemma-3-27b-it', 'gemini-flash-lite-latest', 'gemma-latest'];
  assert.deepEqual(sortGeminiModels(ids.map((id) => ({ id, label: id }))).map((m) => m.id), [
    'gemini-flash-lite-latest', 'gemma-latest',
    'gemini-3.8-flash', 'gemini-2.5-pro',
    'gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'gemma-3-27b-it',
  ]);
});

// ---- requests ---------------------------------------------------------------------------------------------

test('request shape: URL, alt=sse, header-only key, body (default model, thinking auto)', async () => {
  await run({}, async ({ provider, mock }) => {
    await drain(provider.stream({ messages: [SYSTEM('TASK: reply\nrules'), USER('hello')], temperature: 0.5, maxTokens: 321 }));
    const rq = mock.lastGenerateRequest();
    assert.equal(rq.method, 'POST');
    assert.equal(rq.path, '/v1beta/models/gemini-flash-lite-latest:streamGenerateContent');
    assert.deepEqual(rq.query, { alt: 'sse' });
    assert.equal(rq.headers['x-goog-api-key'], KEY);
    assert.match(rq.headers['content-type'], /^application\/json/);
    assert.ok(!JSON.stringify(rq.query).includes(KEY) && !rq.path.includes(KEY) && !rq.rawBody.includes(KEY), 'the key only travels in the header');
    assert.deepEqual(rq.body, {
      systemInstruction: { parts: [{ text: 'TASK: reply\nrules' }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { temperature: 0.5, maxOutputTokens: 321 + 2048 },
    });
  });
});

test('no x-goog-api-key header without a key; model ids: models/ prefix stripped, unusual characters encoded', async () => {
  await run({ strictModel: false }, async ({ mock }) => {
    const p = createProvider('gemini', { baseUrl: mock.url, model: 'models/gemma-3 27b/it', timeoutMs: 3000 });
    await rejection(drain(p.stream({ messages: HELLO })));
    const rq = mock.requests.at(-1);
    assert.equal(rq.headers['x-goog-api-key'], undefined);
    assert.equal(rq.path, '/v1beta/models/gemma-3%2027b%2Fit:streamGenerateContent');
  });
});

test('thinking auto (default): no thinkingConfig, and maxOutputTokens = requested + 2048 (cap 8192, never below the request)', async () => {
  await run({}, async ({ provider, mock }) => {
    const sent = async (maxTokens) => {
      await drain(provider.stream({ messages: HELLO, maxTokens }));
      return mock.lastGenerateRequest().body.generationConfig;
    };
    assert.deepEqual(await sent(700), { maxOutputTokens: 2748 });
    assert.deepEqual(await sent(5000), { maxOutputTokens: 7048 });
    assert.deepEqual(await sent(7000), { maxOutputTokens: 8192 });
    assert.deepEqual(await sent(9000), { maxOutputTokens: 9000 });
    assert.deepEqual(await sent(undefined), {}, 'no cap requested: none sent');
  });
});

test('thinking low: thinkingConfig { thinkingLevel: "low" } plus the same output headroom', async () => {
  await run({}, async ({ provider, mock }) => {
    await drain(provider.stream({ messages: HELLO, maxTokens: 700 }));
    assert.deepEqual(mock.lastGenerateRequest().body.generationConfig, { maxOutputTokens: 2748, thinkingConfig: { thinkingLevel: 'low' } });
  }, { cfg: { thinking: 'low', model: 'gemini-flash-latest' } });
});

test('thinking: minimal and thinkingBudget are NEVER sent, whatever the model, mode or fallback path', async () => {
  const models = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-3.8-flash', 'gemma-3-27b-it'];
  for (const thinking of ['auto', 'low', 'fast', 'default', undefined]) {
    for (const model of models) {
      await run({ strictModel: false, rejectThinking: true }, async ({ provider, mock }) => {
        await drain(provider.stream({ messages: HELLO, maxTokens: 300 }));
        await provider.test();
        for (const rq of mock.generateRequests()) {
          assert.ok(!/minimal|thinkingBudget/i.test(rq.rawBody), `${model}/${thinking}: ${rq.rawBody}`);
        }
      }, { cfg: { model, thinking } });
    }
  }
});

test('thinking low rejected (400 mentioning thinking) -> one retry without it; remembered per model', async () => {
  await run({ rejectThinking: ['thinkingLevel'] }, async ({ provider, mock }) => {
    await drain(provider.stream({ messages: HELLO, maxTokens: 400 }));
    assert.deepEqual(mock.generateRequests().map((x) => x.body.generationConfig.thinkingConfig), [{ thinkingLevel: 'low' }, undefined]);
    assert.equal(mock.generateRequests()[1].body.generationConfig.maxOutputTokens, 2448, 'still has room for thoughts');
    await drain(provider.stream({ messages: HELLO }));
    assert.equal(mock.generateRequests().length, 3, 'same instance: straight to the working configuration');
    const fresh = createProvider('gemini', { baseUrl: mock.url, model: 'gemini-flash-lite-latest', apiKey: KEY, thinking: 'low', timeoutMs: 3000 });
    await drain(fresh.stream({ messages: HELLO }));
    assert.equal(mock.generateRequests().length, 4, 'a new instance for the same model also remembers');
    const other = createProvider('gemini', { baseUrl: mock.url, model: 'gemini-flash-latest', apiKey: KEY, thinking: 'low', timeoutMs: 3000 });
    await drain(other.stream({ messages: HELLO }));
    assert.equal(mock.generateRequests().length, 6, 'another model starts from scratch (low, then without)');
  }, { cfg: { thinking: 'low' } });
});

test('the live bare "Request contains an invalid argument." also drops thinking, but only when thinking was sent', async () => {
  const invalid = { kind: 'bad_request', message: 'Request contains an invalid argument.', times: 1 };
  await run({ failures: [invalid] }, async ({ provider, mock }) => {
    await drain(provider.stream({ messages: HELLO }));
    assert.deepEqual(mock.generateRequests().map((x) => x.body.generationConfig.thinkingConfig), [{ thinkingLevel: 'low' }, undefined]);
  }, { cfg: { thinking: 'low' } });
  await run({ failures: [{ ...invalid, times: 5 }] }, async ({ provider, mock }) => {
    const err = await rejection(drain(provider.stream({ messages: HELLO })));
    assert.equal(err.code, 'bad_request');
    assert.equal(mock.generateRequests().length, 1, 'auto mode sends no thinking, so there is nothing to blame and nothing to retry');
  });
});

test('a genuine bad request in low mode costs one extra attempt, then the real error; nothing is remembered from a failure', async () => {
  await run({ failures: [{ kind: 'bad_request', message: 'Request contains an invalid argument.', times: 9 }] }, async ({ provider, mock }) => {
    const err = await rejection(drain(provider.stream({ messages: HELLO })));
    assert.equal(err.code, 'bad_request');
    assert.equal(mock.generateRequests().length, 2);
    mock.setBehavior({ failures: [] });
    const fresh = createProvider('gemini', { baseUrl: mock.url, model: 'gemini-flash-lite-latest', apiKey: KEY, thinking: 'low', timeoutMs: 3000 });
    await drain(fresh.stream({ messages: HELLO }));
    assert.deepEqual(mock.lastGenerateRequest().body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  }, { cfg: { thinking: 'low' } });
});

test('Gemma-style models that reject systemInstruction: it is folded into the first user turn, once, and remembered', async () => {
  await run({ rejectSystemInstruction: /gemma/ }, async ({ provider, mock }) => {
    await drain(provider.stream({ messages: [SYSTEM('RULES: be brief'), ASSISTANT('Hello?'), USER('hi')] }));
    const [first, second] = mock.generateRequests().map((x) => x.body);
    assert.ok(first.systemInstruction);
    assert.equal('systemInstruction' in second, false);
    assert.deepEqual(second.contents.map((c) => [c.role, c.parts[0].text]), [['user', 'RULES: be brief'], ['model', 'Hello?'], ['user', 'hi']]);
    await drain(provider.stream({ messages: [SYSTEM('RULES'), USER('again')] }));
    assert.equal(mock.generateRequests().length, 3);
    assert.equal(mock.lastGenerateRequest().body.contents[0].parts[0].text, 'RULES\n\nagain');
  }, { cfg: { model: 'gemma-3-27b-it' } });
});

test('gemma-4 style models accept systemInstruction as is', async () => {
  await run({ strictModel: false }, async ({ provider, mock }) => {
    await drain(provider.stream({ messages: [SYSTEM('RULES'), USER('hi')] }));
    assert.equal(mock.generateRequests().length, 1);
    assert.deepEqual(mock.lastGenerateRequest().body.systemInstruction, { parts: [{ text: 'RULES' }] });
  }, { cfg: { model: 'gemma-4-31b-it' } });
});

test('turn rules: the adapter sends valid conversations (merged, may open with a model turn) and refuses to send one that ends with a model turn', async () => {
  await run({ strictAlternation: true }, async ({ provider, mock }) => {
    for (const messages of [[USER('a')], [ASSISTANT('open'), USER('b')], [USER('a'), USER('b')], [ASSISTANT('a'), ASSISTANT('b'), USER('c'), USER('d')]]) {
      const r = await drain(provider.stream({ messages }));
      assert.ok(r.text.length > 0, JSON.stringify(messages));
    }
    const sent = mock.generateRequests().map((x) => x.body.contents.map((c) => c.role));
    assert.deepEqual(sent, [['user'], ['model', 'user'], ['user'], ['model', 'user']]);
    const before = mock.requests.length;
    for (const messages of [[USER('a'), ASSISTANT('b')], [ASSISTANT('only an opening prompt')], [SYSTEM('s'), USER('a'), ASSISTANT('b'), ASSISTANT('c')]]) {
      const err = await rejection(drain(provider.stream({ messages })));
      assert.ok(err instanceof ProviderError && err.code === 'bad_request', JSON.stringify(messages));
      assert.match(err.message, /nothing to reply to/);
    }
    assert.equal(mock.requests.length, before, 'no request is made for a conversation the API would refuse');
  });
});

test('empty messages are dropped; nothing left -> bad_request without a request', async () => {
  await run({}, async ({ provider, mock }) => {
    const r = await drain(provider.stream({ messages: [USER('   '), USER('real question here'), ASSISTANT('')] }));
    assert.ok(r.text.length > 0);
    assert.equal(mock.lastGenerateRequest().body.contents.length, 1);
    await assert.rejects(drain(provider.stream({ messages: [USER(''), USER('  ')] })), (e) => e.code === 'bad_request');
    assert.equal(mock.generateRequests().length, 1);
  });
});

// ---- streaming --------------------------------------------------------------------------------------------

test('streams deltas in order with CRLF-framed SSE, then done with usage', async () => {
  await run({ replies: ['Gemini says hello, in several pieces, over a CRLF framed stream.'] }, async ({ provider }) => {
    const r = await drain(provider.stream({ messages: HELLO }));
    assert.equal(r.text, 'Gemini says hello, in several pieces, over a CRLF framed stream.');
    assert.ok(r.deltas.length >= 3);
    assert.equal(r.done.finishReason, 'stop');
    assert.ok(r.done.usage.promptTokens > 0 && r.done.usage.completionTokens > 0);
  });
});

test('unicode survives awkward chunking and byte slicing', async () => {
  const reply = 'Ça va ? 日本語 😀👍🏽 — émoji\nnew line';
  for (const chunkSize of [1, 3, 0]) {
    await run({ chunkSize, replies: [reply] }, async ({ provider }) => {
      const r = await drain(provider.stream({ messages: HELLO }));
      assert.equal(r.text, reply);
      assert.ok(r.deltas.every((d) => d.isWellFormed()));
    });
  }
});

test('thought parts are never emitted', async () => {
  await run({ thoughts: 'SECRET INNER MONOLOGUE', replies: ['The answer only.'] }, async ({ provider }) => {
    const r = await drain(provider.stream({ messages: HELLO }));
    assert.equal(r.text, 'The answer only.');
  });
});

test('<think> blocks inside Gemini text are stripped too (Gemma-style models)', async () => {
  await run({ replies: ['<think>hmm</think>\nVisible.'] }, async ({ provider }) => {
    assert.equal((await drain(provider.stream({ messages: HELLO }))).text, 'Visible.');
  });
});

test('JSON array answer (proxy ignoring alt=sse) is handled', async () => {
  await run({ failures: ['json_array'], replies: ['Array body answer here.'] }, async ({ provider }) => {
    assert.equal((await drain(provider.stream({ messages: HELLO }))).text, 'Array body answer here.');
  });
});

test('a truncated JSON event in the middle is skipped', async () => {
  await run({ failures: [{ kind: 'malformed', after: 1 }], replies: ['Alpha beta gamma delta epsilon zeta eta theta.'] }, async ({ provider }) => {
    assert.equal((await drain(provider.stream({ messages: HELLO }))).text, 'Alpha beta gamma delta epsilon zeta eta theta.');
  });
});

test('chat() drains the stream', async () => {
  await run({ replies: ['  Padded.  '] }, async ({ provider }) => {
    const r = await provider.chat({ messages: HELLO });
    assert.equal(r.text, 'Padded.');
    assert.equal(r.finishReason, 'stop');
    assert.ok(r.usage);
  });
});

test('finishReason mapping: MAX_TOKENS -> length (with text), SAFETY after text -> content_filter, text is kept', async () => {
  await run({ replies: [{ text: 'Cut off here', finishReason: 'MAX_TOKENS' }, { text: 'Started then blocked', finishReason: 'SAFETY' }] }, async ({ provider }) => {
    const a = await drain(provider.stream({ messages: HELLO }));
    assert.equal(a.text, 'Cut off here');
    assert.equal(a.done.finishReason, 'length');
    const b = await drain(provider.stream({ messages: HELLO }));
    assert.equal(b.text, 'Started then blocked');
    assert.equal(b.done.finishReason, 'content_filter');
  });
});

// ---- blocks and empty answers ------------------------------------------------------------------------------

test('safety blocks with no text -> blocked, with the journaling-specific hint', async () => {
  for (const kind of ['safety_prompt', 'safety_candidate', 'recitation']) {
    await run({ failures: [kind] }, async ({ provider }) => {
      const err = await rejection(drain(provider.stream({ messages: HELLO })));
      assert.ok(err instanceof ProviderError, kind);
      assert.equal(err.code, 'blocked', kind);
      assert.match(err.message, /declined/);
      assert.match(err.hint, /safety filters/);
      assert.match(err.hint, /rephras|switch/);
    });
  }
});

test('MAX_TOKENS with no text -> empty with the thinking hint (chat), but fine for test()', async () => {
  await run({ failures: ['max_tokens_empty', 'max_tokens_empty'] }, async ({ provider }) => {
    const err = await rejection(provider.chat({ messages: HELLO }));
    assert.equal(err.code, 'empty');
    assert.match(err.hint, /thinking/);
    const t = await provider.test();
    assert.equal(t.ok, true);
    assert.equal(t.sample, '');
  });
});

test('a model that only produced thoughts, or nothing at all -> empty', async () => {
  await run({ failures: ['thought_only', 'empty'] }, async ({ provider }) => {
    assert.equal((await rejection(provider.chat({ messages: HELLO }))).code, 'empty');
    assert.equal((await rejection(provider.chat({ messages: HELLO }))).code, 'empty');
  });
});

test('thoughts count against the output cap (as live): the +2048 headroom keeps the answer from being starved or truncated', async () => {
  const reply = 'A fairly long and thoughtful answer. '.repeat(40); // ~1500 characters, ~370 tokens
  await run({ thinkingConsumesBudget: 300, replies: [reply] }, async ({ provider, mock }) => {
    const r = await provider.chat({ messages: HELLO, maxTokens: 100 });
    assert.equal(r.text, reply.trim(), 'complete, not cut off');
    assert.equal(r.finishReason, 'stop');
    assert.equal(mock.lastGenerateRequest().body.generationConfig.maxOutputTokens, 2148);
  });
  // the same mock with a cap that does NOT have the headroom shows the failure the headroom prevents
  await run({ thinkingConsumesBudget: 300 }, async ({ mock }) => {
    const res = await fetch(`${mock.url}/v1beta/models/gemini-flash-lite-latest:streamGenerateContent?alt=sse`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello there my friend' }] }], generationConfig: { maxOutputTokens: 200 } }),
    });
    const frames = (await res.text()).split('\r\n\r\n').filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, '')));
    assert.equal(frames.at(-1).candidates[0].finishReason, 'MAX_TOKENS');
    assert.equal(frames.at(-1).candidates[0].content.parts, undefined);
  });
});

// ---- abort / timeouts / concurrency -------------------------------------------------------------------------

test('abort mid-stream -> AbortError, upstream cancelled, nothing leaks', async () => {
  await withTimerCheck(assert, async () => {
    await run({ delayMs: 20, chunkSize: 4, replies: ['q'.repeat(2000)] }, async ({ provider, mock }) => {
      const ac = new AbortController();
      let n = 0;
      await assert.rejects(async () => {
        for await (const ev of provider.stream({ messages: HELLO, signal: ac.signal })) if (ev.type === 'delta' && ++n === 2) ac.abort();
      }, (e) => e.name === 'AbortError' && !(e instanceof ProviderError));
      assert.equal(abortListeners(ac.signal), 0);
      await mock.waitForIdle();
      assert.equal(mock.requests[0].aborted, true);
    });
  });
});

test('abort before start makes no request, for every method', async () => {
  await run({}, async ({ provider, mock }) => {
    const ac = new AbortController();
    ac.abort();
    for (const call of [() => drain(provider.stream({ messages: HELLO, signal: ac.signal })), () => provider.chat({ messages: HELLO, signal: ac.signal }), () => provider.listModels({ signal: ac.signal }), () => provider.test({ signal: ac.signal })]) {
      await assert.rejects(call(), (e) => e.name === 'AbortError');
    }
    assert.equal(mock.requests.length, 0);
  });
});

test('first-byte timeout and idle timeout', async () => {
  await withTimerCheck(assert, async () => {
    await run({ failures: ['hang'] }, async ({ provider, mock }) => {
      const err = await rejection(drain(provider.stream({ messages: HELLO, timeoutMs: 120 })));
      assert.equal(err.code, 'timeout');
      await mock.waitForIdle();
    });
    await run({ failures: [{ kind: 'stall', after: 1 }], chunkSize: 5 }, async ({ provider }) => {
      const seen = [];
      await assert.rejects(async () => {
        for await (const ev of provider.stream({ messages: HELLO })) if (ev.type === 'delta') seen.push(ev.text);
      }, (e) => e.code === 'timeout' && /middle of the reply/.test(e.message));
      assert.ok(seen.length >= 1);
    }, { opts: { idleTimeoutMs: 150 } });
  });
});

test('connection reset mid-stream -> network; error object inside the stream -> overloaded; no retry after output', async () => {
  await run({ failures: [{ kind: 'reset', after: 2 }], chunkSize: 5 }, async ({ provider, mock }) => {
    await assert.rejects(drain(provider.stream({ messages: HELLO })), (e) => e.code === 'network');
    assert.equal(mock.generateRequests().length, 1);
  });
  await run({ failures: [{ kind: 'error_in_stream', after: 1 }], chunkSize: 5 }, async ({ provider, mock }) => {
    await assert.rejects(drain(provider.stream({ messages: HELLO })), (e) => e.code === 'overloaded');
    assert.equal(mock.generateRequests().length, 1);
  });
});

test('two parallel streams', async () => {
  await run({ delayMs: 3, chunkSize: 6 }, async ({ provider, mock }) => {
    const [a, b] = await Promise.all([
      drain(provider.stream({ messages: [SYSTEM('TASK: reply'), USER('I felt really proud of my sister today.')] })),
      drain(provider.stream({ messages: [SYSTEM('TASK: reply'), USER('Work was stressful and I barely slept.')] })),
    ]);
    assert.match(a.text, /proud of my sister|of my sister today|felt really proud/);
    assert.match(b.text, /Work was stressful|barely slept|stressful and I/);
    assert.equal(mock.generateRequests().length, 2);
  });
});

// ---- listModels -------------------------------------------------------------------------------------------

test('listModels: filters non-chat models, strips models/, labels, sorts', async () => {
  await run({}, async ({ provider, mock }) => {
    const models = await provider.listModels();
    assert.deepEqual(models.map((m) => m.id), [
      'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest',
      'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemma-3-27b-it',
    ]);
    assert.equal(models[0].label, 'Gemini Flash Latest');
    const rq = mock.requests.at(-1);
    assert.equal(rq.path, '/v1beta/models');
    assert.equal(rq.query.pageSize, '1000');
    assert.equal(rq.headers['x-goog-api-key'], KEY);
    assert.equal(rq.query.key, undefined);
  });
});

test('listModels: excluded families, generateContent filter, missing method field kept', async () => {
  const mk = (id, methods, extra = {}) => ({ name: `models/${id}`, displayName: extra.displayName, ...(methods ? { supportedGenerationMethods: methods } : {}) });
  const models = [
    mk('gemini-chat-a', ['generateContent']), mk('gemini-chat-b', ['countTokens']), mk('gemini-chat-c', undefined, { displayName: 'Chat C' }),
    mk('text-embedding-9', ['generateContent']), mk('gemini-aqa', ['generateContent']), mk('imagen-9', ['generateContent']), mk('veo-9', ['generateContent']),
    mk('tts-9', ['generateContent']), mk('gemini-x-image-preview', ['generateContent']), mk('gemini-live-9', ['generateContent']),
    mk('gemini-audio-9', ['generateContent']), mk('gemini-robotics-9', ['generateContent']), mk('gemini-computer-use-9', ['generateContent']),
    mk('learnlm-9', ['generateContent']), { name: 'models/gemini-chat-a', supportedGenerationMethods: ['generateContent'] }, { nope: true }, null,
  ];
  await run({ models }, async ({ provider }) => {
    const out = await provider.listModels();
    assert.deepEqual(out.map((m) => m.id).sort(), ['gemini-chat-a', 'gemini-chat-c']);
    assert.equal(out.find((m) => m.id === 'gemini-chat-c').label, 'Chat C');
    assert.equal(out.find((m) => m.id === 'gemini-chat-a').label, 'gemini-chat-a', 'label falls back to the id');
  });
});

test('listModels: allow-list ^(gemini|gemma)- then the contract exclusions (omni, customtools, banana, transcribe, lyria, ...)', async () => {
  const mk = (id) => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] });
  const ids = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemma-4-31b-it', 'gemini-pro-latest',
    'gemini-omni-flash-preview', 'gemini-3.1-pro-preview-customtools', 'gemini-nano-banana-2.1', 'gemini-3.5-transcribe', 'lyria-3-clip-preview',
    'antigravity-preview-latest', 'deep-research-pro-preview-12-2025', 'nano-banana-pro-preview', 'gemini-embedding-001', 'models-without-prefix',
    'gemini-3.1-flash-tts-preview', 'gemini-3.1-flash-image', 'gemini-3.8-live', 'gemini-robotics-er-2-preview'];
  await run({ models: ids.map(mk) }, async ({ provider }) => {
    assert.deepEqual((await provider.listModels()).map((m) => m.id), ['gemini-flash-latest', 'gemini-pro-latest', 'gemini-3.8-flash', 'gemma-4-31b-it']);
  });
});

test('listModels follows nextPageToken, but at most 5 pages', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `models/gemini-test-${String(i).padStart(2, '0')}`, supportedGenerationMethods: ['generateContent'] }));
  await run({ models: many, listPageSize: 4 }, async ({ provider, mock }) => {
    const out = await provider.listModels();
    const listRequests = mock.requests.filter((r) => r.path === '/v1beta/models');
    assert.equal(listRequests.length, 5, 'capped at five pages');
    assert.equal(listRequests[0].query.pageToken, undefined);
    assert.ok(listRequests.slice(1).every((r) => r.query.pageToken));
    assert.equal(out.length, 20);
  });
  await run({ models: many.slice(0, 10), listPageSize: 4 }, async ({ provider, mock }) => {
    const out = await provider.listModels();
    assert.equal(mock.requests.filter((r) => r.path === '/v1beta/models').length, 3);
    assert.equal(out.length, 10);
    assert.deepEqual(out.map((m) => m.id), many.slice(0, 10).map((m) => m.name.slice(7)).reverse());
  });
});

test('listModels: duplicates across pages are collapsed; a bad second page is an error', async () => {
  await run({ models: [...DEFAULT_MODELS, ...DEFAULT_MODELS], listPageSize: 5 }, async ({ provider }) => {
    const ids = (await provider.listModels()).map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

test('listModels errors: bad key, no key, not a Gemini endpoint, address problems', async () => {
  await run({}, async ({ mock }) => {
    const bad = createProvider('gemini', { baseUrl: mock.url, model: 'm', apiKey: 'wrong-key-0000000', timeoutMs: 3000 });
    const e1 = await rejection(bad.listModels());
    assert.equal(e1.code, 'auth');
    assert.equal(e1.status, 400);
    const none = createProvider('gemini', { baseUrl: mock.url, model: 'm', apiKey: '', timeoutMs: 3000 });
    const e2 = await rejection(none.listModels());
    assert.equal(e2.code, 'auth');
    assert.equal(e2.status, 403);
  });
  const junk = createProvider('gemini', { baseUrl: 'https://x.example', model: 'm', apiKey: KEY }, {
    fetch: fakeFetch(() => new Response('{"hello":1}', { status: 200, headers: { 'content-type': 'application/json' } })),
  });
  assert.equal((await rejection(junk.listModels())).code, 'bad_base_url');
  await run({ modelsFailures: ['rate_limit'] }, async ({ provider, sleep }) => {
    // 12s > 8s: surfaced, not retried
    const err = await rejection(provider.listModels());
    assert.equal(err.code, 'rate_limit');
    assert.equal(sleep.waits.length, 0);
  });
});

// ---- test() ----------------------------------------------------------------------------------------------

test('test(): ok/model/latency/sample from a tiny request', async () => {
  await run({ replies: ['OK'] }, async ({ provider, mock }) => {
    const r = await provider.test();
    assert.deepEqual(Object.keys(r).sort(), ['latencyMs', 'model', 'ok', 'sample']);
    assert.equal(r.ok, true);
    assert.equal(r.model, 'gemini-flash-lite-latest');
    assert.equal(r.sample, 'OK');
    const body = mock.lastGenerateRequest().body;
    assert.equal(body.generationConfig.maxOutputTokens, 16 + 2048, 'tiny, but with room for thoughts');
    assert.equal('temperature' in body.generationConfig, false);
    assert.equal(body.contents[0].parts[0].text, 'Reply with the single word: OK');
  });
});

test('test(): strips a models/ prefix from the reported model, fails with mapped errors', async () => {
  await run({}, async ({ mock }) => {
    const p = createProvider('gemini', { baseUrl: mock.url, model: 'models/gemini-2.5-flash', apiKey: KEY, timeoutMs: 3000 });
    assert.equal((await p.test()).model, 'gemini-2.5-flash');
    const missing = createProvider('gemini', { baseUrl: mock.url, model: 'gemini-nope', apiKey: KEY, timeoutMs: 3000 });
    const err = await rejection(missing.test());
    assert.equal(err.code, 'model_not_found');
    assert.match(err.hint, /Load models/);
  });
});

test('createProvider("gemini") never throws for a bad base URL; calls do', async () => {
  const p = createProvider('gemini', { baseUrl: 'https://x.com?key=SECRETSECRET', model: 'm', apiKey: KEY });
  await assert.rejects(p.listModels(), (e) => e.code === 'bad_base_url' && !JSON.stringify(e).includes('SECRETSECRET'));
  await assert.rejects(p.test(), (e) => e.code === 'bad_base_url');
  await assert.rejects(drain(p.stream({ messages: HELLO })), (e) => e.code === 'bad_base_url');
});
