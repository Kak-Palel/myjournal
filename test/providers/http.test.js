import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoRetryDelay, createScope, describeUrl, networkError, oneLine, parseErrorBody, parseHttpUrl, parseRetryAfter,
  readChunks, readText, retryAfterFromHeaders, scopedFetch, sleep,
} from '../../src/providers/http.js';
import { ProviderError, isAbortError } from '../../src/providers/errors.js';
import { abortListeners, closedPort, withServer, withTimerCheck } from './helpers.js';

const CTX = { provider: 'openai', secrets: [], url: 'http://127.0.0.1:9/v1/chat/completions' };

test('parseRetryAfter: seconds, fractions, HTTP dates, garbage', () => {
  const now = Date.parse('2026-10-08T10:00:00Z');
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter('1.5'), 1500);
  assert.equal(parseRetryAfter(' 0 '), 0);
  assert.equal(parseRetryAfter(7), 7000);
  assert.equal(parseRetryAfter('Thu, 08 Oct 2026 10:00:12 GMT', now), 12000);
  assert.equal(parseRetryAfter('Thu, 08 Oct 2026 09:00:00 GMT', now), 0);
  assert.equal(parseRetryAfter('soon'), undefined);
  assert.equal(parseRetryAfter(''), undefined);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter('999999999'), 24 * 3600 * 1000);
});

test('retryAfterFromHeaders prefers retry-after-ms', () => {
  assert.equal(retryAfterFromHeaders(new Headers({ 'retry-after': '2', 'retry-after-ms': '250' })), 250);
  assert.equal(retryAfterFromHeaders(new Headers({ 'retry-after': '2' })), 2000);
  assert.equal(retryAfterFromHeaders(new Headers()), undefined);
  assert.equal(retryAfterFromHeaders(undefined), undefined);
});

test('autoRetryDelay: short 429s and any 503 only', () => {
  const e = (code, status, retryAfterMs) => new ProviderError(code, 'x', { status, retryAfterMs });
  assert.equal(autoRetryDelay(e('rate_limit', 429, 2000)), 2000);
  assert.equal(autoRetryDelay(e('rate_limit', 429, 8000)), 8000);
  assert.equal(autoRetryDelay(e('rate_limit', 429, 8001)), null);
  assert.equal(autoRetryDelay(e('rate_limit', 429), 700), 700);
  assert.equal(autoRetryDelay(e('quota', 429, 1000)), null);
  assert.equal(autoRetryDelay(e('server', 503)), 1000);
  assert.equal(autoRetryDelay(e('overloaded', 503, 3000)), 3000);
  assert.equal(autoRetryDelay(e('server', 503, 60000)), null);
  assert.equal(autoRetryDelay(e('server', 500)), null);
  assert.equal(autoRetryDelay(e('auth', 401)), null);
});

test('parseErrorBody understands the error shapes seen in the wild', () => {
  const p = parseErrorBody;
  assert.equal(p('{"error":{"message":"Bad key","type":"invalid_request_error","code":"invalid_api_key"}}').message, 'Bad key');
  assert.equal(p('{"error":{"message":"Bad key","type":"invalid_request_error","code":"invalid_api_key"}}').code, 'invalid_api_key');
  assert.equal(p('{"error":"model \'x\' not found"}').message, "model 'x' not found");
  assert.deepEqual(
    [p('{"error":{"code":400,"message":"too big","type":"exceed_context_size_error"}}').code, p('{"error":{"code":400,"message":"too big","type":"exceed_context_size_error"}}').type],
    ['400', 'exceed_context_size_error'],
  );
  assert.equal(p('{"detail":"Not Found"}').message, 'Not Found');
  assert.equal(p('{"detail":[{"msg":"field required","loc":["body"]}]}').message, 'field required');
  assert.equal(p('{"message":"top level"}').message, 'top level');
  assert.equal(p('404 page not found').message, '404 page not found');
  assert.equal(p('<!DOCTYPE html><html>x</html>').html, true);
  assert.equal(p('<html>').message, '');
  assert.equal(p('').message, '');
  assert.equal(p(undefined).message, '');
  assert.equal(p('[1,2]').message, '');
  assert.equal(p('"just a string"').message, '"just a string"');
  assert.equal(p('{"error":{"message":"  lots   of\\n whitespace "}}').message, 'lots of whitespace');
  assert.ok(p(`{"error":{"message":"${'x'.repeat(1000)}"}}`).message.length <= 300);
});

test('parseErrorBody unwraps the JSON error document Ollama nests inside its own message string (verified live) and reads llama.cpp\'s token counts', () => {
  const inner = { error: { code: 400, message: 'request (6063 tokens) exceeds the available context size (4096 tokens), try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 6063, n_ctx: 4096 } };
  const ollama = parseErrorBody(JSON.stringify({ error: { message: JSON.stringify(inner), type: 'invalid_request_error', param: null, code: null } }));
  assert.equal(ollama.message, 'request (6063 tokens) exceeds the available context size (4096 tokens), try increasing it');
  assert.equal(ollama.promptTokens, 6063);
  assert.equal(ollama.contextTokens, 4096);
  assert.equal(ollama.type, 'invalid_request_error');
  const llama = parseErrorBody(JSON.stringify(inner));
  assert.equal(llama.message, inner.error.message);
  assert.equal(llama.promptTokens, 6063);
  assert.equal(llama.contextTokens, 4096);
  assert.equal(llama.type, 'exceed_context_size_error');
  // a message that merely starts with a brace but is not an error document stays as it is
  assert.equal(parseErrorBody('{"error":{"message":"{not json at all"}}').message, '{not json at all');
  assert.equal(parseErrorBody('{"error":{"message":"{\\"unrelated\\":1}"}}').message, '{"unrelated":1}');
  // plain errors have no counts
  assert.deepEqual([parseErrorBody('{"error":{"message":"x"}}').promptTokens, parseErrorBody('{"error":{"message":"x"}}').contextTokens], [0, 0]);
});

test('a local first-byte timeout explains that giving up cancels the model load (verified live on Ollama) and points at the timeout setting', async () => {
  const mk = (provider) => createScope({ firstByteMs: 5, ctx: { provider, secrets: [], url: 'http://127.0.0.1:11434/v1/chat/completions' } });
  const local = mk('local');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const err = local.fail(new Error('aborted'));
  local.close(true);
  assert.equal(err.code, 'timeout');
  assert.match(err.hint, /cancels that load/);
  assert.match(err.hint, /Settings > General/);
  const remote = mk('openai');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const err2 = remote.fail(new Error('aborted'));
  remote.close(true);
  assert.equal(err2.code, 'timeout');
  assert.ok(!/cancels that load/.test(err2.hint), 'hosted services are not told about model loading');
});

test('networkError classifies fetch failures and always names the URL tried', () => {
  const mk = (code, message) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message || code), { code }) });
  const cases = [
    ['ECONNREFUSED', 'network', /Tried http:\/\/127\.0\.0\.1:9\/v1\/chat\/completions/],
    ['ENOTFOUND', 'network', /Check the address/],
    ['EAI_AGAIN', 'network', /online/],
    ['ECONNRESET', 'network', /Tried/],
    ['UND_ERR_SOCKET', 'network', /Tried/],
    ['UND_ERR_HEADERS_TIMEOUT', 'timeout', /./],
    ['UND_ERR_BODY_TIMEOUT', 'timeout', /./],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'network', /certificate|NODE_EXTRA_CA_CERTS/],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'network', /NODE_EXTRA_CA_CERTS/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'network', /NODE_EXTRA_CA_CERTS/],
    ['ERR_INVALID_URL', 'bad_base_url', /./],
    ['EWHATEVER', 'network', /Tried/],
  ];
  for (const [code, expected, hint] of cases) {
    const err = networkError(mk(code), CTX);
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, expected, code);
    assert.match(err.hint, hint, code);
    assert.equal(err.provider, 'openai');
  }
  assert.equal(networkError(new TypeError('fetch failed', { cause: new Error('bad port') }), CTX).code, 'bad_base_url');
  assert.equal(networkError(new TypeError('fetch failed', { cause: new Error('unknown scheme') }), CTX).code, 'bad_base_url');
  assert.equal(networkError(new TypeError('Request cannot be constructed from a URL that includes credentials: http://u:p@h'), CTX).code, 'bad_base_url');
  assert.equal(networkError(new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }), CTX).code, 'network');
});

test('networkError: a port that fetch refuses ("bad port") is reported as a blocked port, not as an invalid address', () => {
  for (const provider of ['local', 'openai', 'gemini']) {
    const err = networkError(new TypeError('fetch failed', { cause: new Error('bad port') }),
      { provider, secrets: [], url: 'http://127.0.0.1:6000/v1/chat/completions' });
    assert.ok(err instanceof ProviderError);
    assert.equal(err.provider, provider);
    assert.equal(err.code, 'bad_base_url', 'the address is what has to change');
    assert.equal(err.message, 'That port is blocked.');
    assert.doesNotMatch(err.message + err.hint, /not valid/i, 'no longer the generic "server address is not valid"');
    assert.match(err.hint, /Node, like web browsers, refuses to connect to a fixed list of ports/);
    assert.match(err.hint, /port 6000 is on it/);
    assert.match(err.hint, /Start the model server on another port/);
  }
  // other messages that used to share the branch keep the generic answer
  const generic = networkError(new TypeError('fetch failed', { cause: new Error('unknown scheme') }), CTX);
  assert.equal(generic.message, 'The server address is not valid.');
  // an unparseable URL still gives a sensible hint
  const odd = networkError(new TypeError('fetch failed', { cause: new Error('bad port') }), { provider: 'local', secrets: [], url: 'nonsense' });
  assert.equal(odd.message, 'That port is blocked.');
  assert.match(odd.hint, /6000 and 10080/);
});

test('a real fetch() to a blocked port (6000, 10080) ends in the clear message without any connection attempt', async () => {
  const { createProvider } = await import('../../src/providers/index.js');
  for (const port of [6000, 10080]) {
    const provider = createProvider('local', { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', timeoutMs: 2000 });
    const err = await provider.test().then(() => assert.fail('expected a rejection'), (e) => e);
    assert.equal(err.code, 'bad_base_url', String(port));
    assert.equal(err.message, 'That port is blocked.');
    assert.match(err.hint, new RegExp(`port ${port} is on it`));
  }
});

test('networkError for the local provider reminds the user to start the server', () => {
  const err = networkError(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }),
    { provider: 'local', secrets: [], url: 'http://localhost:11434/v1/chat/completions?key=SECRET' });
  assert.match(err.hint, /ollama serve/);
  assert.match(err.hint, /localhost:11434\/v1\/chat\/completions/);
  assert.ok(!err.hint.includes('SECRET'), 'query strings never appear in hints');
});

test('describeUrl strips credentials, query and fragment', () => {
  assert.equal(describeUrl('https://user:pw@example.com:8443/a/b?key=1#frag'), 'https://example.com:8443/a/b');
  assert.equal(describeUrl('not a url'), '(invalid address)');
  assert.equal(oneLine('  a\n\n b   c '), 'a b c');
});

test('parseHttpUrl accepts forgiving input and rejects the dangerous kind', () => {
  const ok = (raw, opts, expectedHref) => assert.equal(parseHttpUrl(raw, { provider: 'openai', ...opts }).href, expectedHref, raw);
  ok('https://api.openai.com/v1', {}, 'https://api.openai.com/v1');
  ok('localhost:11434/v1', {}, 'http://localhost:11434/v1');
  ok('192.168.1.20:8080', {}, 'http://192.168.1.20:8080/');
  ok('api.example.com/v1', {}, 'https://api.example.com/v1');
  ok('example.com', { preferHttp: true }, 'http://example.com/');
  ok('http://[::1]:11434/v1', {}, 'http://[::1]:11434/v1');
  ok('[::1]:11434', {}, 'http://[::1]:11434/');
  ok('https://example.com/v1#frag', {}, 'https://example.com/v1#frag');
  for (const bad of ['', '   ', undefined, null, 42, 'ftp://x.com', 'file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c',
    'http://user:pw@host/v1', 'https://host/v1?api-version=1', 'http://', 'http://exa mple.com', '://x']) {
    assert.throws(() => parseHttpUrl(bad, { provider: 'openai' }), (e) => e instanceof ProviderError && e.code === 'bad_base_url', String(bad));
  }
  try {
    parseHttpUrl('http://user:hunter2@host/v1', { provider: 'openai' });
  } catch (e) {
    assert.ok(!JSON.stringify(e).includes('hunter2'), 'credentials in the URL are never echoed');
  }
});

test('createScope: an already-aborted signal throws AbortError and registers nothing', () => {
  const ac = new AbortController();
  ac.abort();
  assert.throws(() => createScope({ signal: ac.signal, firstByteMs: 1000, ctx: CTX }), (e) => isAbortError(e) && !(e instanceof ProviderError));
  assert.equal(abortListeners(ac.signal), 0);
});

test('createScope: close() removes the listener and clears the timer', async () => {
  await withTimerCheck(assert, async () => {
    const ac = new AbortController();
    const scope = createScope({ signal: ac.signal, firstByteMs: 60_000, ctx: CTX });
    assert.equal(abortListeners(ac.signal), 1);
    scope.touch();
    scope.close();
    assert.equal(abortListeners(ac.signal), 0);
    ac.abort(); // no effect after close
    assert.equal(scope.signal.aborted, false);
  });
});

test('createScope: caller abort aborts the fetch signal and maps to AbortError', () => {
  const ac = new AbortController();
  const scope = createScope({ signal: ac.signal, firstByteMs: 60_000, ctx: CTX });
  ac.abort();
  assert.equal(scope.signal.aborted, true);
  assert.ok(isAbortError(scope.fail(new Error('whatever'))));
  assert.ok(!(scope.fail(new Error('whatever')) instanceof ProviderError));
  scope.close();
});

test('first-byte timeout: the server never answers -> ProviderError timeout, nothing left behind', async () => {
  await withTimerCheck(assert, async () => {
    await withServer(() => { /* never respond */ }, async (url) => {
      const ac = new AbortController();
      const scope = createScope({ signal: ac.signal, firstByteMs: 80, ctx: { ...CTX, url } });
      try {
        await assert.rejects(
          scopedFetch(fetch, url, { method: 'GET' }, scope),
          (e) => e instanceof ProviderError && e.code === 'timeout' && /did not answer within/.test(e.message),
        );
      } finally {
        scope.close(true);
      }
      assert.equal(abortListeners(ac.signal), 0);
    });
  });
});

test('first-byte timeout also covers headers that arrive but a body that never starts', async () => {
  await withTimerCheck(assert, async () => {
    await withServer((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); }, async (url) => {
      const scope = createScope({ firstByteMs: 100, ctx: { ...CTX, url } });
      try {
        const res = await scopedFetch(fetch, url, { method: 'GET' }, scope);
        await assert.rejects(async () => { for await (const _ of readChunks(res, scope)) { /* nothing arrives */ } }, (e) => e.code === 'timeout');
      } finally {
        scope.close(true);
      }
    });
  });
});

test('idle timeout: the stream goes quiet after the first chunk', async () => {
  await withTimerCheck(assert, async () => {
    await withServer((req, res) => { res.writeHead(200); res.write('first'); }, async (url) => {
      const scope = createScope({ firstByteMs: 5000, idleMs: 120, ctx: { ...CTX, url } });
      const seen = [];
      try {
        const res = await scopedFetch(fetch, url, {}, scope);
        await assert.rejects(async () => { for await (const c of readChunks(res, scope)) seen.push(new TextDecoder().decode(c)); },
          (e) => e instanceof ProviderError && e.code === 'timeout' && /in the middle of the reply/.test(e.message));
      } finally {
        scope.close(true);
      }
      assert.deepEqual(seen, ['first']);
    });
  });
});

test('the idle clock is paused while the consumer is busy (slow consumers do not cause timeouts)', async () => {
  await withTimerCheck(assert, async () => {
    await withServer((req, res) => {
      res.writeHead(200);
      res.write('one');
      setTimeout(() => { res.write('two'); res.end(); }, 30);
    }, async (url) => {
      const scope = createScope({ firstByteMs: 5000, idleMs: 150, ctx: { ...CTX, url } });
      const seen = [];
      try {
        const res = await scopedFetch(fetch, url, {}, scope);
        for await (const c of readChunks(res, scope)) {
          seen.push(new TextDecoder().decode(c));
          await new Promise((r) => setTimeout(r, 400)); // much longer than idleMs
        }
      } finally {
        scope.close();
      }
      assert.equal(seen.join(''), 'onetwo');
    });
  });
});

test('caller abort while reading the body -> AbortError (not ProviderError) and the server sees the disconnect', async () => {
  await withTimerCheck(assert, async () => {
    let serverClosed = false;
    await withServer((req, res) => {
      res.writeHead(200);
      res.write('chunk');
      res.on('close', () => { serverClosed = true; });
    }, async (url) => {
      const ac = new AbortController();
      const scope = createScope({ signal: ac.signal, firstByteMs: 5000, ctx: { ...CTX, url } });
      try {
        const res = await scopedFetch(fetch, url, {}, scope);
        await assert.rejects(async () => {
          for await (const _ of readChunks(res, scope)) ac.abort();
        }, (e) => isAbortError(e) && !(e instanceof ProviderError));
      } finally {
        scope.close(true);
      }
      for (let i = 0; i < 100 && !serverClosed; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.ok(serverClosed, 'upstream request was cancelled');
    });
  });
});

test('abandoning the chunk iterator cancels the body', async () => {
  let serverClosed = false;
  await withServer((req, res) => {
    res.writeHead(200);
    res.write('chunk');
    res.on('close', () => { serverClosed = true; });
  }, async (url) => {
    const scope = createScope({ firstByteMs: 5000, ctx: { ...CTX, url } });
    const res = await scopedFetch(fetch, url, {}, scope);
    for await (const _ of readChunks(res, scope)) break;
    scope.close(true);
    for (let i = 0; i < 100 && !serverClosed; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(serverClosed);
  });
});

test('connection refused -> network error naming the URL', async () => {
  const port = await closedPort();
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;
  const scope = createScope({ firstByteMs: 5000, ctx: { ...CTX, url } });
  try {
    await assert.rejects(scopedFetch(fetch, url, {}, scope), (e) => e.code === 'network' && e.hint.includes(`127.0.0.1:${port}`));
  } finally {
    scope.close();
  }
});

test('scopedFetch never follows redirects (a POST would silently become a GET)', async () => {
  let init;
  const scope = createScope({ firstByteMs: 5000, ctx: CTX });
  await scopedFetch(async (u, i) => { init = i; return new Response('x'); }, 'http://x.test/', { method: 'POST' }, scope);
  scope.close();
  assert.equal(init.redirect, 'manual');
  assert.equal(init.method, 'POST');
});

test('readText: whole body, truncation and size limit', async () => {
  await withServer((req, res) => { res.writeHead(200); res.end('héllo wörld '.repeat(100)); }, async (url) => {
    const get = async (opts) => {
      const scope = createScope({ firstByteMs: 5000, ctx: { ...CTX, url } });
      try {
        const res = await scopedFetch(fetch, url, {}, scope);
        return await readText(res, scope, opts.max, opts);
      } finally {
        scope.close();
      }
    };
    const full = await get({ max: 1 << 20 });
    assert.equal(full.length, 'héllo wörld '.repeat(100).length);
    const cut = await get({ max: 50, truncate: true });
    assert.ok(cut.length > 0 && cut.length <= 50);
    await assert.rejects(get({ max: 50 }), (e) => e instanceof ProviderError && e.code === 'server');
  });
});

test('sleep resolves, can be aborted, and leaves no timer or listener behind', async () => {
  await withTimerCheck(assert, async () => {
    const ac = new AbortController();
    await sleep(5, ac.signal);
    assert.equal(abortListeners(ac.signal), 0);
    const p = sleep(60_000, ac.signal);
    ac.abort();
    await assert.rejects(p, (e) => isAbortError(e));
    await assert.rejects(sleep(10, ac.signal), (e) => isAbortError(e));
  });
});

test('an API key that cannot be put in a header gives a friendly auth error that does not quote the key', async () => {
  const { createProvider } = await import('../../src/providers/index.js');
  for (const [provider, base] of [['openai', 'https://api.openai.com/v1'], ['local', 'http://localhost:11434/v1'], ['gemini', 'https://generativelanguage.googleapis.com']]) {
    for (const key of ['sk-abc\ndef-123456', 'sk-€uro-smart-“quote”-123456', 'sk-nul\u0000-secret-987654']) {
      // The real undici fetch is used, which validates header values before any connection is attempted.
      const p = createProvider(provider, { baseUrl: base, model: 'm', apiKey: key, timeoutMs: 2000 });
      const err = await p.listModels().then(() => assert.fail('should reject'), (e) => e);
      assert.ok(err instanceof ProviderError, `${provider}: ${err}`);
      assert.equal(err.code, 'auth', `${provider}: ${err.message}`);
      assert.match(err.message, /characters that cannot be sent/);
      const text = JSON.stringify(err) + err.stack + (err.cause ? 'HAS_CAUSE' : '');
      assert.ok(!text.includes('HAS_CAUSE'), 'the cause quotes the header value, so it is dropped');
      for (const part of ['abc', 'def-123456', 'smart', 'secret-987654', 'nul']) assert.ok(!text.includes(part), `${part} leaked`);
    }
  }
});

test('timers keep the event loop alive: a fetch that never settles still ends in a timeout error and a clean exit', async () => {
  const { execFile } = await import('node:child_process');
  const script = `
    import { createProvider } from ${JSON.stringify(new URL('../../src/providers/index.js', import.meta.url).href)};
    const never = () => new Promise(() => {});           // no socket, no handle: only our timer can end this
    const p = createProvider('openai', { baseUrl: 'https://x.example/v1', model: 'm' }, { fetch: never });
    try {
      for await (const _ of p.stream({ messages: [{ role: 'user', content: 'hello' }], timeoutMs: 150 })) {}
    } catch (e) { console.log(e.code); }
  `;
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 15000 }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
  });
  assert.equal(out.trim(), 'timeout');
});

test('fetch doubles that ignore their signal cannot hang a call: caller abort and timeouts still end it', async () => {
  const { createProvider } = await import('../../src/providers/index.js');
  const never = () => new Promise(() => {});
  await withTimerCheck(assert, async () => {
    const p = createProvider('openai', { baseUrl: 'https://x.example/v1', model: 'm' }, { fetch: never });
    const ac = new AbortController();
    const pending = p.chat({ messages: [{ role: 'user', content: 'hi there' }], signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(pending, (e) => e.name === 'AbortError' && !(e instanceof ProviderError));
    assert.equal(abortListeners(ac.signal), 0);
    await assert.rejects(p.chat({ messages: [{ role: 'user', content: 'hi there' }], timeoutMs: 40 }), (e) => e.code === 'timeout' && /within 1 second\./.test(e.message));
  });
  // a response whose body stream ignores cancellation: the idle timeout still fires
  await withTimerCheck(assert, async () => {
    const stuckBody = new ReadableStream({ pull() { return new Promise(() => {}); } });
    const fetchFn = async () => new Response(stuckBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const p = createProvider('openai', { baseUrl: 'https://x.example/v1', model: 'm' }, { fetch: fetchFn, idleTimeoutMs: 60 });
    await assert.rejects(p.chat({ messages: [{ role: 'user', content: 'hi there' }], timeoutMs: 80 }), (e) => e.code === 'timeout');
  });
});
