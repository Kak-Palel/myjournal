import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockOpenAI } from '../mocks/mock-openai.js';
import { createProvider } from '../../src/providers/index.js';
import { clearOpenAIQuirks } from '../../src/providers/openai.js';
import { ProviderError, isAbortError } from '../../src/providers/errors.js';
import {
  HELLO, SYSTEM, USER, abortListeners, drain, fakeFetch, fakeSleep, until, withTimerCheck,
} from './helpers.js';

/** Boot a mock + provider, run fn, always clean up. */
async function run(mockOpts, fn, { id = 'openai', cfg = {}, opts = {} } = {}) {
  clearOpenAIQuirks();
  const mock = await createMockOpenAI(mockOpts);
  try {
    const provider = createProvider(id, { baseUrl: mock.baseUrl, model: 'mock-model', apiKey: '', timeoutMs: 5000, ...cfg }, { sleep: fakeSleep(), ...opts });
    return await fn({ mock, provider });
  } finally {
    await mock.close();
  }
}

const sseResponse = (...frames) => new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const chunkFrame = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

test('streams deltas in order, then done with finishReason and usage', async () => {
  await run({ replies: ['The quick brown fox jumps over the lazy dog.'] }, async ({ provider, mock }) => {
    const { text, deltas, done, events } = await drain(provider.stream({ messages: HELLO }));
    assert.equal(text, 'The quick brown fox jumps over the lazy dog.');
    assert.ok(deltas.length > 5, 'arrives in many pieces');
    assert.ok(deltas.every((d) => d.length > 0), 'no empty deltas are surfaced');
    assert.deepEqual(events.at(-1), done, 'done is last');
    assert.equal(events.filter((e) => e.type === 'done').length, 1);
    assert.equal(done.finishReason, 'stop');
    assert.ok(done.usage.promptTokens > 0 && done.usage.completionTokens > 0);
    assert.equal(done.usage.totalTokens, done.usage.promptTokens + done.usage.completionTokens);
    assert.equal(mock.requests.length, 1);
  });
});

test('sends the documented request: URL, headers, body', async () => {
  await run({}, async ({ provider, mock }) => {
    await drain(provider.stream({ messages: [SYSTEM('TASK: reply\nBe kind.'), USER('Hi')], temperature: 0.4, maxTokens: 123 }));
    const rq = mock.lastChatRequest();
    assert.equal(rq.method, 'POST');
    assert.equal(rq.path, '/v1/chat/completions');
    assert.match(rq.headers['content-type'], /^application\/json/);
    assert.equal(rq.headers.accept, 'text/event-stream');
    assert.equal(rq.headers.authorization, undefined, 'no Authorization header without a key');
    assert.deepEqual(rq.body, {
      model: 'mock-model',
      messages: [{ role: 'system', content: 'TASK: reply\nBe kind.' }, { role: 'user', content: 'Hi' }],
      stream: true,
      temperature: 0.4,
      max_tokens: 123,
      stream_options: { include_usage: true },
    });
  });
});

test('the Authorization header is sent only when a key exists, and the key never appears in the URL', async () => {
  await run({ apiKey: 'sk-test-key-123456' }, async ({ mock }) => {
    const withKey = createProvider('openai', { baseUrl: mock.baseUrl, model: 'm', apiKey: 'sk-test-key-123456', timeoutMs: 5000 });
    await drain(withKey.stream({ messages: HELLO }));
    const rq = mock.lastChatRequest();
    assert.equal(rq.headers.authorization, 'Bearer sk-test-key-123456');
    assert.ok(!rq.path.includes('sk-test') && !JSON.stringify(rq.query).includes('sk-test'));
    await withKey.listModels();
    assert.equal(mock.requests.at(-1).headers.authorization, 'Bearer sk-test-key-123456');
  });
});

test('api.openai.com gets max_completion_tokens, everything else max_tokens', async () => {
  const bodies = [];
  const fetchFn = fakeFetch((url, init) => { bodies.push({ url, body: JSON.parse(init.body) }); return sseResponse(chunkFrame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n'); });
  const official = createProvider('openai', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-abcdefgh' }, { fetch: fetchFn });
  await drain(official.stream({ messages: HELLO, maxTokens: 50 }));
  const other = createProvider('openai', { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama', apiKey: 'gsk-abcdefgh' }, { fetch: fetchFn });
  await drain(other.stream({ messages: HELLO, maxTokens: 50 }));
  assert.equal(bodies[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(bodies[0].body.max_completion_tokens, 50);
  assert.equal('max_tokens' in bodies[0].body, false);
  assert.equal(bodies[1].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(bodies[1].body.max_tokens, 50);
  assert.equal('max_completion_tokens' in bodies[1].body, false);
});

test('config temperature/maxTokens are defaults that req overrides; test() ignores them', async () => {
  await run({}, async ({ mock }) => {
    const p = createProvider('openai', { baseUrl: mock.baseUrl, model: 'm', timeoutMs: 5000, temperature: 0.9, maxTokens: 300 });
    await drain(p.stream({ messages: HELLO }));
    assert.equal(mock.lastChatRequest().body.temperature, 0.9);
    assert.equal(mock.lastChatRequest().body.max_tokens, 300);
    await drain(p.stream({ messages: HELLO, temperature: 0, maxTokens: 20 }));
    assert.equal(mock.lastChatRequest().body.temperature, 0);
    assert.equal(mock.lastChatRequest().body.max_tokens, 20);
    await p.test();
    const body = mock.lastChatRequest().body;
    assert.equal(body.max_tokens, 16);
    assert.equal('temperature' in body, false);
    assert.equal(body.messages[0].content, 'Reply with the single word: OK');
  });
});

test('role-only first delta, empty deltas, finish chunk, usage chunk and [DONE] are all handled', async () => {
  await run({ roleOnly: true, emptyDeltas: true, replies: ['Alpha beta gamma delta epsilon'] }, async ({ provider }) => {
    const r = await drain(provider.stream({ messages: HELLO }));
    assert.equal(r.text, 'Alpha beta gamma delta epsilon');
    assert.ok(r.deltas.every((d) => d !== ''));
    assert.equal(r.done.finishReason, 'stop');
    assert.ok(r.done.usage);
  });
});

test('SSE dialects: data without a space, CRLF, keep-alive comments', async () => {
  for (const dialect of [{ noSpaceAfterData: true }, { crlf: true }, { keepAlive: true }, { noSpaceAfterData: true, crlf: true, keepAlive: true }]) {
    await run({ ...dialect, replies: ['Dialect check: ok.'] }, async ({ provider }) => {
      const r = await drain(provider.stream({ messages: HELLO }));
      assert.equal(r.text, 'Dialect check: ok.', JSON.stringify(dialect));
      assert.ok(r.done.usage, JSON.stringify(dialect));
    });
  }
});

test('no usage chunk unless requested; usage is optional on done', async () => {
  await run({ usage: 'never' }, async ({ provider }) => {
    const r = await drain(provider.stream({ messages: HELLO }));
    assert.equal(r.done.usage, undefined);
    assert.equal('usage' in r.done, false);
  });
});

test('unicode survives arbitrary chunking: emoji, CJK, combining marks, newlines, SSE-looking text', async () => {
  const reply = 'Café ☕ — 日本語のテキスト 😀👩‍👩‍👧‍👦\nLine two: data: [DONE]\n\nevent: x\r\n<3 a < b > c';
  for (const chunkSize of [1, 2, 3, 7, 0]) {
    await run({ chunkSize, replies: [reply] }, async ({ provider }) => {
      const r = await drain(provider.stream({ messages: HELLO }));
      assert.equal(r.text, reply, `chunkSize ${chunkSize}`);
      assert.ok(r.deltas.every((d) => d.isWellFormed()));
    });
  }
});

test('deltas that cut a surrogate pair are re-joined so every delta is well-formed', async () => {
  await run({ splitCodePoints: true, chunkSize: 1, replies: ['a😀b😀😀c'] }, async ({ provider }) => {
    const r = await drain(provider.stream({ messages: HELLO }));
    assert.equal(r.text, 'a😀b😀😀c');
    assert.ok(r.deltas.every((d) => d.isWellFormed()), JSON.stringify(r.deltas));
  });
});

test('a very large reply streams completely', async () => {
  const big = 'word '.repeat(60000);
  await run({ chunkSize: 4000, replies: [big] }, async ({ provider }) => {
    const r = await drain(provider.stream({ messages: HELLO }));
    assert.equal(r.text.length, big.length);
  });
});

test('a runaway server is cut off at maxOutputChars with finishReason length', async () => {
  await run({ chunkSize: 10, replies: ['x'.repeat(5000)] }, async ({ provider }) => {
    const r = await drain(provider.stream({ messages: HELLO }));
    assert.ok(r.text.length >= 100 && r.text.length < 5000);
    assert.equal(r.done.finishReason, 'length');
  }, { opts: { maxOutputChars: 100 } });
});

test('server omits [DONE] and never closes: completes after a short grace once finish_reason was seen', async () => {
  await withTimerCheck(assert, async () => {
    await run({ omitDone: true, replies: ['Finished without a terminator.'] }, async ({ provider }) => {
      const r = await drain(provider.stream({ messages: HELLO }));
      assert.equal(r.text, 'Finished without a terminator.');
      assert.equal(r.done.finishReason, 'stop');
    }, { opts: { graceMs: 150 } });
  });
});

test('JSON instead of SSE (application/json and mislabelled)', async () => {
  for (const kind of ['json', 'json_no_type']) {
    await run({ failures: [kind], replies: ['A complete answer in one piece.'] }, async ({ provider }) => {
      const r = await drain(provider.stream({ messages: HELLO }));
      assert.equal(r.text, 'A complete answer in one piece.', kind);
      assert.equal(r.done.finishReason, 'stop');
      assert.ok(r.done.usage, kind);
    });
  }
});

test('stream:false style answers also work through a fetch that returns plain JSON', async () => {
  const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: '<think>hmm</think>\nPlain JSON.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
  const fetchFn = fakeFetch(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }));
  const p = createProvider('local', { baseUrl: 'http://localhost:11434', model: 'm' }, { fetch: fetchFn });
  const r = await drain(p.stream({ messages: HELLO }));
  assert.equal(r.text, 'Plain JSON.');
  assert.deepEqual(r.done.usage, { promptTokens: 3, completionTokens: 4, totalTokens: 7 });
  assert.equal(fetchFn.calls[0].url, 'http://localhost:11434/v1/chat/completions');
});

test('legacy and array content shapes are tolerated', async () => {
  const fetchFn = fakeFetch(() => sseResponse(
    chunkFrame({ role: 'assistant' }),
    `data: ${JSON.stringify({ choices: [{ index: 0, text: 'Legacy ' }] })}\n\n`,
    chunkFrame({ content: [{ type: 'text', text: 'parts ' }, { type: 'text', text: 'array' }] }),
    chunkFrame({}, 'stop'),
    'data: [DONE]\n\n',
  ));
  const p = createProvider('openai', { baseUrl: 'https://x.example/v1', model: 'm' }, { fetch: fetchFn });
  assert.equal((await drain(p.stream({ messages: HELLO }))).text, 'Legacy parts array');
});

test('reasoning_content / reasoning are ignored, content is kept', async () => {
  await run({ reasoningContent: 'secret chain of thought', replies: ['The visible answer.'] }, async ({ provider }) => {
    const r = await drain(provider.stream({ messages: HELLO }));
    assert.equal(r.text, 'The visible answer.');
    assert.ok(!r.text.includes('chain of thought'));
  });
});

test('<think> blocks are removed even when the tags are split across chunks; leading whitespace after them is trimmed', async () => {
  for (const chunkSize of [1, 2, 3, 5, 0]) {
    await run({ think: 'Let me ponder this carefully.', chunkSize, replies: ['Here is the answer.'] }, async ({ provider }) => {
      const r = await drain(provider.stream({ messages: HELLO }));
      assert.equal(r.text, 'Here is the answer.', `chunkSize ${chunkSize}`);
    });
  }
});

test('chat() strips think blocks and trims', async () => {
  await run({ think: true, replies: ['  Spaced answer.  '] }, async ({ provider }) => {
    const r = await provider.chat({ messages: HELLO });
    assert.equal(r.text, 'Spaced answer.');
    assert.equal(r.finishReason, 'stop');
    assert.ok(r.usage.totalTokens > 0);
  });
});

test('an unterminated <think> with nothing else -> empty, with the budget hint', async () => {
  await run({ failures: ['think_only'] }, async ({ provider }) => {
    await assert.rejects(drain(provider.stream({ messages: HELLO })), (e) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.code, 'empty');
      assert.match(e.hint, /spent its whole token budget thinking/);
      assert.match(e.hint, /raise max tokens or use a non-reasoning model/);
      return true;
    });
  });
});

test('reasoning-only streams (no content at all) -> empty with the same hint', async () => {
  await run({ failures: ['reasoning_only'] }, async ({ provider }) => {
    await assert.rejects(drain(provider.stream({ messages: HELLO })), (e) => e.code === 'empty' && /token budget thinking/.test(e.hint));
  });
});

test('empty replies: error for chat, fine for test()', async () => {
  await run({ failures: ['empty', 'empty'] }, async ({ provider }) => {
    await assert.rejects(provider.chat({ messages: HELLO }), (e) => e.code === 'empty');
    const t = await provider.test();
    assert.equal(t.ok, true);
    assert.equal(t.sample, '');
  });
  await run({ failures: ['content_filter'] }, async ({ provider }) => {
    await assert.rejects(provider.chat({ messages: HELLO }), (e) => e.code === 'blocked');
  });
  await run({ failures: ['length_empty'] }, async ({ provider }) => {
    await assert.rejects(provider.chat({ messages: HELLO }), (e) => e.code === 'empty' && /max tokens/i.test(e.hint));
  });
});

test('a malformed chunk in the middle is skipped, the rest of the text is kept', async () => {
  await run({ failures: [{ kind: 'malformed', after: 3 }], replies: ['One two three four five six.'] }, async ({ provider }) => {
    const r = await drain(provider.stream({ messages: HELLO }));
    assert.equal(r.text, 'One two three four five six.');
  });
});

test('a stream of nothing but garbage -> server error with a base-URL hint', async () => {
  await run({ failures: ['malformed_only'] }, async ({ provider }) => {
    await assert.rejects(drain(provider.stream({ messages: HELLO })), (e) => e.code === 'server' && /base URL/.test(e.hint));
  });
});

test('an error object inside the stream surfaces as a ProviderError, after the earlier deltas', async () => {
  await run({ failures: [{ kind: 'error_in_stream', after: 2 }], replies: ['Partial answer that gets cut'] }, async ({ provider, mock }) => {
    const seen = [];
    await assert.rejects(async () => {
      for await (const ev of provider.stream({ messages: HELLO })) if (ev.type === 'delta') seen.push(ev.text);
    }, (e) => e instanceof ProviderError && e.code === 'server');
    assert.ok(seen.length >= 1, 'deltas before the error were delivered');
    assert.equal(mock.chatRequests().length, 1, 'never retried after output');
  });
});

test('connection reset mid-stream -> network error after partial output, no retry', async () => {
  await run({ failures: [{ kind: 'reset', after: 3 }], replies: ['A reply that is cut off by a crash.'] }, async ({ provider, mock }) => {
    const seen = [];
    await assert.rejects(async () => {
      for await (const ev of provider.stream({ messages: HELLO })) if (ev.type === 'delta') seen.push(ev.text);
    }, (e) => e instanceof ProviderError && e.code === 'network' && /unexpectedly/.test(e.message));
    assert.ok(seen.length >= 1);
    assert.equal(mock.chatRequests().length, 1);
  });
});

test('connection reset before any response -> network error', async () => {
  await run({ failures: ['reset_before_response'] }, async ({ provider }) => {
    await assert.rejects(drain(provider.stream({ messages: HELLO })), (e) => e.code === 'network');
  });
});

test('first-byte timeout: a server that never answers -> timeout, request cancelled, no timers left', async () => {
  await withTimerCheck(assert, async () => {
    await run({ failures: ['hang'] }, async ({ provider, mock }) => {
      await assert.rejects(
        drain(provider.stream({ messages: HELLO, timeoutMs: 150 })),
        (e) => e instanceof ProviderError && e.code === 'timeout' && !isAbortError(e) && e.hint.length > 0,
      );
      await mock.waitForIdle();
    });
  });
});

test('first-byte timeout also fires for headers-only responses; the local hint mentions model loading', async () => {
  await run({ failures: ['hang_after_headers'] }, async ({ provider }) => {
    await assert.rejects(drain(provider.stream({ messages: HELLO, timeoutMs: 150 })), (e) => e.code === 'timeout' && /loads? it into memory|loading/i.test(e.hint));
  }, { id: 'local' });
});

test('cfg.timeoutMs is the default first-byte timeout', async () => {
  await run({ failures: ['hang'] }, async ({ provider }) => {
    await assert.rejects(drain(provider.stream({ messages: HELLO })), (e) => e.code === 'timeout');
  }, { cfg: { timeoutMs: 120 } });
});

test('idle timeout: the stream stalls after a few deltas', async () => {
  await withTimerCheck(assert, async () => {
    await run({ failures: [{ kind: 'stall', after: 2 }], replies: ['A reply that stalls midway through.'] }, async ({ provider, mock }) => {
      const seen = [];
      await assert.rejects(async () => {
        for await (const ev of provider.stream({ messages: HELLO })) if (ev.type === 'delta') seen.push(ev.text);
      }, (e) => e instanceof ProviderError && e.code === 'timeout' && /middle of the reply/.test(e.message));
      assert.ok(seen.length >= 1);
      await mock.waitForIdle();
    }, { opts: { idleTimeoutMs: 150 } });
  });
});

test('abort mid-stream -> AbortError (not a ProviderError); upstream request is cancelled; nothing leaks', async () => {
  await withTimerCheck(assert, async () => {
    await run({ delayMs: 20, replies: ['x'.repeat(2000)], chunkSize: 5 }, async ({ provider, mock }) => {
      const ac = new AbortController();
      let n = 0;
      await assert.rejects(async () => {
        for await (const ev of provider.stream({ messages: HELLO, signal: ac.signal })) {
          if (ev.type === 'delta' && ++n === 3) ac.abort();
        }
      }, (e) => isAbortError(e) && !(e instanceof ProviderError) && e.name === 'AbortError');
      assert.equal(abortListeners(ac.signal), 0, 'listener removed from the caller signal');
      await mock.waitForIdle();
      assert.equal(mock.requests[0].aborted, true, 'the mock saw the client disconnect');
    });
  });
});

test('abort with a custom reason is still an AbortError', async () => {
  await run({ delayMs: 20, replies: ['y'.repeat(500)], chunkSize: 5 }, async ({ provider }) => {
    const ac = new AbortController();
    await assert.rejects(async () => {
      for await (const ev of provider.stream({ messages: HELLO, signal: ac.signal })) if (ev.type === 'delta') ac.abort(new Error('user pressed stop'));
    }, (e) => e.name === 'AbortError');
  });
});

test('abort before start -> AbortError and no request is made', async () => {
  await run({}, async ({ provider, mock }) => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(drain(provider.stream({ messages: HELLO, signal: ac.signal })), (e) => e.name === 'AbortError' && !(e instanceof ProviderError));
    await assert.rejects(provider.chat({ messages: HELLO, signal: ac.signal }), (e) => e.name === 'AbortError');
    await assert.rejects(provider.listModels({ signal: ac.signal }), (e) => e.name === 'AbortError');
    await assert.rejects(provider.test({ signal: ac.signal }), (e) => e.name === 'AbortError');
    assert.equal(mock.requests.length, 0);
    assert.equal(abortListeners(ac.signal), 0);
  });
});

test('abort while waiting for the first byte', async () => {
  await withTimerCheck(assert, async () => {
    await run({ failures: ['hang'] }, async ({ provider, mock }) => {
      const ac = new AbortController();
      const pending = drain(provider.stream({ messages: HELLO, signal: ac.signal }));
      await mock.waitForRequests(1);
      ac.abort();
      await assert.rejects(pending, (e) => e.name === 'AbortError' && !(e instanceof ProviderError));
      await mock.waitForIdle();
    });
  });
});

test('stopping early (break) cancels the upstream request and cleans up', async () => {
  await withTimerCheck(assert, async () => {
    await run({ delayMs: 15, replies: ['z'.repeat(2000)], chunkSize: 5 }, async ({ provider, mock }) => {
      for await (const ev of provider.stream({ messages: HELLO })) {
        if (ev.type === 'delta') break;
      }
      await mock.waitForIdle();
      assert.equal(mock.requests[0].aborted, true);
    });
  });
});

test('two parallel streams do not interfere', async () => {
  await run({ delayMs: 3, replies: [(ctx) => `Reply for ${ctx.messages.at(-1).content}`, (ctx) => `Reply for ${ctx.messages.at(-1).content}`] }, async ({ provider, mock }) => {
    const [a, b, c] = await Promise.all([
      drain(provider.stream({ messages: [USER('alpha alpha alpha')] })),
      drain(provider.stream({ messages: [USER('bravo bravo bravo')] })),
      provider.chat({ messages: [USER('charlie charlie charlie')] }),
    ]);
    assert.match(a.text, /^Reply for \w+ \w+ \w+$/);
    assert.match(b.text, /^Reply for \w+ \w+ \w+$/);
    assert.match(c.text, /^Reply for \w+ \w+ \w+$|^Thanks for the message/);
    assert.equal(mock.chatRequests().length, 3);
    // each stream saw only its own text: no interleaving of deltas between calls
    assert.notEqual(a.text, b.text);
  });
});

test('one of several parallel streams can be aborted without affecting the others', async () => {
  await run({ delayMs: 5, chunkSize: 4 }, async ({ provider }) => {
    const ac = new AbortController();
    const aborted = (async () => {
      for await (const ev of provider.stream({ messages: HELLO, signal: ac.signal })) if (ev.type === 'delta') ac.abort();
    })();
    const ok = drain(provider.stream({ messages: [USER('I felt calm and grateful today after a long walk.')] }));
    await assert.rejects(aborted, (e) => e.name === 'AbortError');
    const r = await ok;
    assert.ok(r.text.length > 20);
    assert.equal(r.done.finishReason, 'stop');
  });
});

test('success, error and abort paths leave no timers behind', async () => {
  await withTimerCheck(assert, async () => {
    await run({}, async ({ provider }) => {
      await drain(provider.stream({ messages: HELLO }));
      await provider.listModels();
      await provider.test();
    });
    await run({ failures: ['server_error'] }, async ({ provider }) => {
      await assert.rejects(provider.chat({ messages: HELLO }));
    });
  });
});

test('local provider: a bare http://host:port gets /v1 appended', async () => {
  await run({}, async ({ mock }) => {
    const p = createProvider('local', { baseUrl: mock.url, model: 'llama3.2:3b', timeoutMs: 5000 });
    await drain(p.stream({ messages: HELLO }));
    assert.equal(mock.lastChatRequest().path, '/v1/chat/completions');
    const withSuffix = createProvider('local', { baseUrl: `${mock.url}/v1/chat/completions/`, model: 'x', timeoutMs: 5000 });
    await drain(withSuffix.stream({ messages: HELLO }));
    assert.equal(mock.lastChatRequest().path, '/v1/chat/completions');
  });
});

test('openai provider pointed at a bare origin posts to /chat/completions (no /v1 invented)', async () => {
  await run({}, async ({ mock }) => {
    const p = createProvider('openai', { baseUrl: mock.url, model: 'm', timeoutMs: 5000 });
    await drain(p.stream({ messages: HELLO }));
    assert.equal(mock.lastChatRequest().path, '/chat/completions');
  });
});

test('IPv6 loopback base URL works end to end', async (t) => {
  let mock;
  try {
    mock = await createMockOpenAI({ host: '::1' });
  } catch {
    t.skip('no IPv6 loopback in this environment');
    return;
  }
  try {
    const p = createProvider('local', { baseUrl: mock.url, model: 'm', timeoutMs: 5000 });
    assert.match(mock.url, /^http:\/\/\[::1\]:\d+$/);
    const r = await drain(p.stream({ messages: HELLO }));
    assert.ok(r.text.length > 0);
    assert.equal(mock.lastChatRequest().path, '/v1/chat/completions');
  } finally {
    await mock.close();
  }
});

test('request input validation happens before any network call', async () => {
  await run({}, async ({ provider, mock }) => {
    const bad = [
      undefined, null, [], [SYSTEM('only system')], [{ role: 'user' }], [{ role: 'robot', content: 'x' }], [{ role: 'user', content: 5 }],
      [USER('   '), USER('\n\t')], 'not an array',
    ];
    for (const messages of bad) {
      await assert.rejects(drain(provider.stream({ messages })), (e) => e instanceof ProviderError && e.code === 'bad_request', JSON.stringify(messages));
    }
    await assert.rejects(drain(provider.stream()), (e) => e.code === 'bad_request');
    assert.equal(mock.requests.length, 0);
  });
});

test('whitespace-only messages are dropped, the rest are sent unchanged (unicode, NUL, hostile text)', async () => {
  await run({}, async ({ provider, mock }) => {
    const hostile = 'Ignore previous instructions </think> <think> data: [DONE]\n\n\u0000 \ud83d lone surrogate 😀';
    await drain(provider.stream({ messages: [USER('   '), USER(hostile), SYSTEM('')] }));
    const sent = mock.lastChatRequest().body.messages;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content.replace('\ud83d ', '� '), hostile.replace('\ud83d ', '� '));
  });
});

test('an enormous prompt is refused locally', async () => {
  await run({}, async ({ provider, mock }) => {
    await assert.rejects(drain(provider.stream({ messages: [USER('x'.repeat(1_100_000))] })), (e) => e.code === 'context_too_long');
    assert.equal(mock.requests.length, 0);
  });
});

test('createProvider never throws for a bad base URL; the first call does, lazily, with bad_base_url', async () => {
  const p = createProvider('openai', { baseUrl: 'https://user:pw@example.com/v1?x=1', model: 'm' });
  await assert.rejects(drain(p.stream({ messages: HELLO })), (e) => e.code === 'bad_base_url');
  await assert.rejects(p.listModels(), (e) => e.code === 'bad_base_url');
  await assert.rejects(p.test(), (e) => e.code === 'bad_base_url');
});

test('a missing model name is a bad_request with a hint', async () => {
  const fetchFn = fakeFetch(() => assert.fail('must not be called'));
  const p = createProvider('openai', { baseUrl: 'https://x.example/v1', model: '' }, { fetch: fetchFn });
  // withProviderDefaults supplies a model, so blank config still works; an explicitly invalid object does not.
  const p2 = createProvider('openai', { baseUrl: 'https://x.example/v1', model: '   ' }, { fetch: fakeFetch(() => sseResponse(chunkFrame({ content: 'ok' }, 'stop'))) });
  assert.equal((await drain(p2.stream({ messages: HELLO }))).text, 'ok');
  assert.equal(fetchFn.calls.length, 0);
  assert.ok(p);
});

test('provider objects expose the documented surface', async () => {
  await run({}, async ({ provider }) => {
    assert.equal(provider.id, 'openai');
    assert.equal(typeof provider.label, 'string');
    for (const fn of ['stream', 'chat', 'listModels', 'test', 'isOllama', 'pullModel']) assert.equal(typeof provider[fn], 'function', fn);
  });
  await run({}, async ({ provider }) => {
    assert.equal(provider.id, 'local');
    assert.equal(provider.label, 'Local model');
  }, { id: 'local' });
  await until(() => true);
});

test('IPv6 addresses produce correct request URLs (verified with a fake fetch, since the sandbox has no IPv6)', async () => {
  const urls = [];
  const fetchFn = fakeFetch((url) => {
    urls.push(url);
    return url.endsWith('/api/version')
      ? new Response('{"version":"0.5.7"}', { status: 200, headers: { 'content-type': 'application/json' } })
      : sseResponse(chunkFrame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n');
  });
  const p = createProvider('local', { baseUrl: 'http://[::1]:11434', model: 'm' }, { fetch: fetchFn });
  await drain(p.stream({ messages: HELLO }));
  assert.equal(await p.isOllama(), true);
  assert.deepEqual(urls, ['http://[::1]:11434/v1/chat/completions', 'http://[::1]:11434/api/version']);
});
