import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockOpenAI } from '../mocks/mock-openai.js';
import { createProvider, isOllama, pullOllamaModel } from '../../src/providers/index.js';
import { ProviderError } from '../../src/providers/errors.js';
import { closedPort, collect, fakeFetch, withServer, withTimerCheck } from './helpers.js';

async function withMock(opts, fn) {
  const mock = await createMockOpenAI(opts);
  try {
    return await fn(mock);
  } finally {
    await mock.close();
  }
}

test('isOllama: true for an Ollama server, whether the base URL has /v1 or not', async () => {
  await withMock({}, async (mock) => {
    assert.equal(await isOllama({ baseUrl: mock.baseUrl }), true);
    assert.equal(await isOllama({ baseUrl: mock.url }), true);
    assert.equal(await isOllama(mock.baseUrl), true);
    assert.equal(await isOllama(`${mock.url}/v1/`), true);
    const req = mock.requests.at(-1);
    assert.equal(req.method, 'GET');
    assert.equal(req.path, '/api/version');
  });
});

test('isOllama: false for non-Ollama servers, errors, junk, and closed ports (never throws)', async () => {
  await withMock({ ollama: false }, async (mock) => {
    assert.equal(await isOllama({ baseUrl: mock.baseUrl }), false);
  });
  assert.equal(await isOllama({ baseUrl: `http://127.0.0.1:${await closedPort()}/v1` }), false);
  assert.equal(await isOllama({ baseUrl: 'not a url ?x=1' }), false);
  assert.equal(await isOllama({}), false);
  assert.equal(await isOllama(undefined), false);
  await withServer((req, res) => { res.writeHead(200); res.end('<html>hello</html>'); }, async (url) => {
    assert.equal(await isOllama({ baseUrl: url }), false);
  });
  await withServer((req, res) => { res.writeHead(200); res.end('{"version":42}'); }, async (url) => {
    assert.equal(await isOllama({ baseUrl: url }), false);
  });
  await withServer((req, res) => { res.writeHead(500); res.end('{"version":"1"}'); }, async (url) => {
    assert.equal(await isOllama({ baseUrl: url }), false);
  });
});

test('isOllama: a server that never answers times out to false; abort rejects with AbortError', async () => {
  await withTimerCheck(assert, async () => {
    await withServer(() => { /* hang */ }, async (url) => {
      assert.equal(await isOllama({ baseUrl: url }, { timeoutMs: 100 }), false);
      const ac = new AbortController();
      const pending = isOllama({ baseUrl: url }, { signal: ac.signal, timeoutMs: 5000 });
      setTimeout(() => ac.abort(), 30);
      await assert.rejects(pending, (e) => e.name === 'AbortError' && !(e instanceof ProviderError));
      const done = new AbortController();
      done.abort();
      await assert.rejects(isOllama({ baseUrl: url }, { signal: done.signal }), (e) => e.name === 'AbortError');
    });
  });
});

test('isOllama sends the bearer token when a key is configured (Ollama behind an auth proxy)', async () => {
  const fetchFn = fakeFetch(() => new Response('{"version":"0.5.7"}', { status: 200 }));
  assert.equal(await isOllama({ baseUrl: 'http://box:11434/v1', apiKey: 'proxy-token-123' }, { fetch: fetchFn }), true);
  assert.equal(fetchFn.calls[0].init.headers.Authorization, 'Bearer proxy-token-123');
  assert.equal(fetchFn.calls[0].url, 'http://box:11434/api/version');
});

test('pullOllamaModel: streams progress objects and ends with success', async () => {
  await withMock({ models: ['llama3.2:3b'], pull: { steps: 4 } }, async (mock) => {
    const events = await collect(pullOllamaModel({ baseUrl: mock.baseUrl }, { model: 'qwen2.5:1.5b' }));
    assert.equal(events[0].status, 'pulling manifest');
    const downloads = events.filter((e) => e.total);
    assert.ok(downloads.length >= 4);
    assert.equal(downloads[0].percent, 0);
    assert.equal(downloads.at(-1).percent, 100);
    assert.deepEqual(downloads.map((e) => e.percent), [...downloads.map((e) => e.percent)].sort((a, b) => a - b), 'monotonic');
    assert.ok(downloads.every((e) => e.completed <= e.total && e.digest.startsWith('sha256:')));
    assert.equal(events.at(-1).status, 'success');
    assert.equal(events.at(-1).percent, 100);
    const rq = mock.requests.find((r) => r.path === '/api/pull');
    assert.equal(rq.method, 'POST');
    assert.deepEqual(rq.body, { model: 'qwen2.5:1.5b', name: 'qwen2.5:1.5b', stream: true });
    // the model is now visible to the OpenAI-compatible side
    const p = createProvider('local', { baseUrl: mock.baseUrl, model: 'x' });
    assert.ok((await p.listModels()).some((m) => m.id === 'qwen2.5:1.5b'));
  });
});

test('pullOllamaModel via the provider object, and with a bare-origin base URL', async () => {
  await withMock({}, async (mock) => {
    const p = createProvider('local', { baseUrl: mock.url, model: 'llama3.2:1b' });
    assert.equal(await p.isOllama(), true);
    const events = await collect(p.pullModel({ model: 'llama3.2:1b' }));
    assert.equal(events.at(-1).status, 'success');
  });
});

test('pullOllamaModel: unknown model -> model_not_found; error mid-download -> server with Ollama\'s words', async () => {
  await withMock({}, async (mock) => {
    const seen = [];
    await assert.rejects(async () => {
      for await (const ev of pullOllamaModel({ baseUrl: mock.baseUrl }, { model: 'nonexistent:1b' })) seen.push(ev);
    }, (e) => e instanceof ProviderError && e.code === 'model_not_found' && /ollama\.com\/library/.test(e.hint) && e.provider === 'local');
    assert.equal(seen[0].status, 'pulling manifest');
  });
  await withMock({ pull: { failMidway: true, steps: 4 } }, async (mock) => {
    await assert.rejects(collect(pullOllamaModel({ baseUrl: mock.baseUrl }, { model: 'llama3.2:3b' })),
      (e) => e.code === 'server' && /no space left on device/.test(e.message) && /disk space/.test(e.hint));
  });
});

test('pullOllamaModel: a download that just stops is a network error that explains resuming', async () => {
  await withMock({ pull: { truncate: true } }, async (mock) => {
    await assert.rejects(collect(pullOllamaModel({ baseUrl: mock.baseUrl }, { model: 'llama3.2:3b' })), (e) => e.code === 'network' && /resumes/.test(e.hint));
  });
});

test('pullOllamaModel: HTTP errors and non-Ollama servers', async () => {
  await withMock({ ollama: false }, async (mock) => {
    await assert.rejects(collect(pullOllamaModel({ baseUrl: mock.baseUrl }, { model: 'llama3.2:3b' })), (e) => e instanceof ProviderError && e.code === 'bad_base_url');
  });
  await withServer((req, res) => { res.writeHead(500); res.end('{"error":"boom"}'); }, async (url) => {
    await assert.rejects(collect(pullOllamaModel({ baseUrl: url }, { model: 'llama3.2:3b' })), (e) => e.code === 'server' && /boom/.test(e.message));
  });
  const port = await closedPort();
  await assert.rejects(collect(pullOllamaModel({ baseUrl: `http://127.0.0.1:${port}` }, { model: 'llama3.2:3b' })), (e) => e.code === 'network' && /ollama serve/.test(e.hint));
});

test('pullOllamaModel validates the model name before any request', async () => {
  const fetchFn = fakeFetch(() => assert.fail('no request expected'));
  for (const model of ['', '   ', undefined, 'a b', 'x'.repeat(300), 'rm -rf /;', 'a\nb', '../../etc', '<script>']) {
    await assert.rejects(collect(pullOllamaModel({ baseUrl: 'http://localhost:11434/v1' }, { model, fetch: fetchFn })),
      (e) => e instanceof ProviderError && e.code === 'bad_request', String(model));
  }
  for (const model of ['llama3.2:3b', 'hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M', 'library/gemma2:2b', 'user/model@sha256']) {
    const f = fakeFetch(() => new Response('{"status":"success"}\n', { status: 200 }));
    const out = await collect(pullOllamaModel({ baseUrl: 'http://localhost:11434/v1' }, { model, fetch: f }));
    assert.equal(out.at(-1).status, 'success', model);
  }
});

test('pullOllamaModel: abort mid-download -> AbortError and the server sees the disconnect', async () => {
  await withTimerCheck(assert, async () => {
    await withMock({ pull: { delayMs: 40, steps: 50 } }, async (mock) => {
      const ac = new AbortController();
      let n = 0;
      await assert.rejects(async () => {
        for await (const ev of pullOllamaModel({ baseUrl: mock.baseUrl }, { model: 'llama3.2:3b', signal: ac.signal })) {
          if (ev.total && ++n === 2) ac.abort();
        }
      }, (e) => e.name === 'AbortError' && !(e instanceof ProviderError));
      await mock.waitForIdle();
      assert.equal(mock.requests.at(-1).aborted, true);
    });
  });
});

test('pullOllamaModel: idle timeout when progress stops', async () => {
  await withServer((req, res) => { res.writeHead(200); res.write('{"status":"pulling manifest"}\n'); }, async (url) => {
    await assert.rejects(collect(pullOllamaModel({ baseUrl: url }, { model: 'llama3.2:3b', idleTimeoutMs: 120 })), (e) => e.code === 'timeout');
  });
});

test('progress lines are parsed even if split mid-line and mid-character by the network', async () => {
  const payload = '{"status":"pulling manifest 🦙"}\n{"status":"pulling abc","digest":"sha256:abc","total":200,"completed":50}\n{"status":"success"}\n';
  const bytes = new TextEncoder().encode(payload);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3));
      controller.close();
    },
  });
  const fetchFn = fakeFetch(() => new Response(body, { status: 200 }));
  const out = await collect(pullOllamaModel({ baseUrl: 'http://localhost:11434' }, { model: 'm', fetch: fetchFn }));
  assert.deepEqual(out.map((e) => e.status), ['pulling manifest 🦙', 'pulling abc', 'success']);
  assert.equal(out[1].percent, 25);
});
