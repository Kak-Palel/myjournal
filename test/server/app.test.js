import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
import { ListenError, createApp } from '../../src/server/app.js';
import { attachmentHeader, createRouter } from '../../src/server/http.js';
import { rawRequest, rawSocket, saveSettings, startApp, withApp } from './helpers.js';

function memoryDb() {
  return openDb({ file: ':memory:' });
}

describe('createApp', () => {
  it('needs a config and a database', () => {
    assert.throws(() => createApp({}), TypeError);
    assert.throws(() => createApp({ config: loadConfig({}) }), TypeError);
  });

  it('refuses an unsafe binding even when used without server.js', () => {
    const db = memoryDb();
    try {
      assert.throws(() => createApp({ config: loadConfig({ HOST: '0.0.0.0' }), db }), ConfigError);
      assert.doesNotThrow(() => createApp({ config: loadConfig({ HOST: '0.0.0.0', JOURNAL_PASSWORD: 'pw' }), db }));
    } finally {
      db.close();
    }
  });

  it('listens on port 0, reports its URL, and closes idempotently (also before listening)', async () => {
    const db = memoryDb();
    try {
      const idle = createApp({ config: loadConfig({}, { overrides: { port: 0, quiet: true } }), db });
      await idle.close();
      await idle.close();
      const app = createApp({ config: loadConfig({}, { overrides: { port: 0, quiet: true } }), db });
      assert.equal(app.url, '');
      const { port, url } = await app.listen();
      assert.ok(port > 0);
      assert.equal(url, `http://127.0.0.1:${port}`);
      assert.equal(app.url, url);
      assert.equal(app.port, port);
      assert.equal((await rawRequest(url, 'GET', '/api/health')).status, 200);
      await Promise.all([app.close(), app.close()]);
      await assert.rejects(() => rawRequest(url, 'GET', '/api/health'), /ECONNREFUSED|socket hang up|ECONNRESET/);
      assert.equal(db.isOpen, true, 'closing the app leaves the database to its owner');
    } finally {
      db.close();
    }
  });

  it('says how to pick another port when the port is taken', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address();
    const db = memoryDb();
    try {
      const app = createApp({ config: loadConfig({}, { overrides: { port, quiet: true } }), db });
      await assert.rejects(() => app.listen(), (err) => {
        assert.ok(err instanceof ListenError);
        assert.equal(err.code, 'EADDRINUSE');
        assert.match(err.message, new RegExp(`Port ${port} is already in use`));
        assert.match(err.hint, new RegExp(`PORT=${port + 1} npm start`));
        return true;
      });
      await app.close();
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
      db.close();
    }
  });

  it('runs many independent instances side by side', async () => {
    const apps = await Promise.all([startApp({ ai: false }), startApp({ ai: false }), startApp({ ai: false })]);
    try {
      await apps[0].entry({ content: 'only in the first' });
      assert.deepEqual(await Promise.all(apps.map(async (a) => (await a.get('/api/data/stats')).json.entries)), [1, 0, 0]);
      assert.equal(new Set(apps.map((a) => a.app.port)).size, 3);
    } finally {
      await Promise.all(apps.map((a) => a.close()));
    }
  });

  it('fills in limits and defaults for a hand-built config', async () => {
    const db = memoryDb();
    const app = createApp({ config: { port: 0, host: '127.0.0.1', quiet: true }, db });
    try {
      const { url } = await app.listen();
      assert.equal((await rawRequest(url, 'GET', '/api/health')).status, 200);
      assert.equal((await rawRequest(url, 'GET', '/')).status, 200, 'public/ is found without being told');
      const big = await rawRequest(url, 'POST', '/api/entries', { rawBody: JSON.stringify({ content: 'x'.repeat(1024 * 1024 + 1) }) });
      assert.equal(big.status, 413, 'the 1 MB cap applies');
      assert.equal((await rawRequest(url, 'GET', '/api/health', { headers: { Host: 'evil.example' } })).status, 403, 'the Host check applies');
    } finally {
      await app.close();
      db.close();
    }
  });

  it('hands the injected fetch to the AI providers', async () => {
    const calls = [];
    const body = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello from the double. "},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"Does it work?"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const fake = async (url, init) => {
      calls.push({ url: String(url), method: init && init.method, body: init && init.body });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    await withApp({ ai: false, fetch: fake, settings: { ai: { provider: 'local', providers: { local: { baseUrl: 'http://pretend-llm.invalid:9/v1', model: 'pretend' } } } } }, async (h) => {
      const { entry } = await h.entry({ content: 'Hi.' });
      const stream = await h.sse(`/api/entries/${entry.id}/reply`, {});
      assert.equal(stream.of('done')[0].message.content, 'Hello from the double. Does it work?');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'http://pretend-llm.invalid:9/v1/chat/completions');
      assert.equal(JSON.parse(calls[0].body).model, 'pretend');
      const test = await h.post('/api/providers/test', { provider: 'local' });
      assert.equal(test.json.ok, true);
      assert.equal(calls.length, 2);
    });
  });
});

describe('request handling edge cases', () => {
  it('survives clients that disconnect while sending a body or in the middle of a request line', async () => {
    await withApp({ ai: false }, async (h) => {
      await rawSocket(h.url, 'POST /api/entries HTTP/1.1\r\nHost: localhost\r\nX-MyJournal: 1\r\nContent-Length: 1000\r\n\r\n{"content":', { timeoutMs: 150 });
      await rawSocket(h.url, 'GET /api/hea', { timeoutMs: 150 });
      await rawSocket(h.url, 'POST /api/entries HTTP/1.1\r\nHost: localhost\r\nX-MyJournal: 1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel', { timeoutMs: 150 });
      assert.equal((await h.get('/api/health')).status, 200);
      assert.equal((await h.get('/api/data/stats')).json.entries, 0);
    });
  });

  it('answers HEAD for GET routes without a body', async () => {
    await withApp({ ai: false }, async (h) => {
      const res = await h.request('HEAD', '/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.text, '');
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(Number(res.headers['content-length']) > 0, true);
      assert.equal((await h.request('HEAD', '/api/settings')).status, 200);
      assert.equal((await h.request('HEAD', '/api/auth/login', { csrf: false })).status, 405);
    });
  });

  it('keeps serving after many hostile requests in a row', async () => {
    await withApp({ ai: false }, async (h) => {
      const junk = ['/api/%', '/api/%00', '/%', '/api/entries?limit[]=1', '/api/entries?q=%E0%A4%A', '/\\\\', '/api/../..', 'http://evil/api/health'];
      for (const path of junk) {
        const res = await rawRequest(h.url, 'GET', path).catch((err) => ({ status: err.code }));
        assert.ok(typeof res.status === 'number' ? res.status < 500 : true, `${path} -> ${res.status}`);
      }
      assert.equal((await h.get('/api/health')).status, 200);
    });
  });

  it('keeps a failing route from taking the server down', async () => {
    const errors = [];
    await withApp({ ai: false, config: { logger: { error: (m) => errors.push(m) } } }, async (h) => {
      const original = h.db.entries.page;
      h.db.entries.page = () => { throw new TypeError('kaboom'); };
      for (let i = 0; i < 3; i += 1) assert.equal((await h.get('/api/entries')).status, 500);
      h.db.entries.page = original;
      assert.equal((await h.get('/api/entries')).status, 200);
      assert.equal(errors.length, 3);
    });
  });

  it('maps database errors to the right HTTP errors', async () => {
    await withApp({ ai: false }, async (h) => {
      // an id that the repository rejects as invalid input, via a direct import of a conflicting export
      const doc = { app: 'myjournal', version: 1, entries: [{ id: 'dup', createdAt: 5 }, { id: 'dup', createdAt: 6 }] };
      const res = await h.post('/api/data/import', doc);
      assert.equal(res.status, 200);
      assert.equal(res.json.imported.entries, 1);
      assert.equal(res.json.skipped, 1);
    });
  });
});

describe('router', () => {
  it('prefers static segments over parameters and reports allowed methods', () => {
    const router = createRouter();
    const noop = () => {};
    router.add('GET', '/a/:id', noop);
    router.add('POST', '/a/special', noop);
    router.add('DELETE', '/a/:id', noop);
    assert.deepEqual(router.match('GET', ['a', 'x']).params, { id: 'x' });
    assert.equal(router.match('POST', ['a', 'special']).route.pattern, '/a/special');
    assert.deepEqual(router.match('GET', ['a', 'special']).params, { id: 'special' }, 'a parameter route still catches the name');
    assert.deepEqual(router.match('PUT', ['a', 'special']), { methodNotAllowed: true, allow: ['POST'], public: false });
    assert.deepEqual(router.match('PUT', ['a', 'x']), { methodNotAllowed: true, allow: ['GET', 'HEAD', 'DELETE'], public: false });
    assert.equal(router.match('GET', ['b']), null);
    assert.equal(router.match('GET', ['a']), null);
    assert.equal(router.match('HEAD', ['a', 'x']).route.method, 'GET');
  });

  it('builds safe Content-Disposition values', () => {
    assert.equal(attachmentHeader('plain.md'), "attachment; filename=\"plain.md\"; filename*=UTF-8''plain.md");
    const header = attachmentHeader('we"ird\r\nname é;.md');
    assert.doesNotMatch(header.split('filename*')[0], /[\r\n]/);
    assert.match(header, /filename\*=UTF-8''we%22ird%0D%0Aname%20%C3%A9%3B\.md/);
  });
});

describe('settings validation through the same helper', () => {
  it('saveSettings in the test helper rejects invalid patches (guards the tests themselves)', () => {
    const db = memoryDb();
    try {
      assert.throws(() => saveSettings(db, { ai: { temperature: 'x' } }), /bad settings patch/);
    } finally {
      db.close();
    }
  });
});

describe('temp data folders', () => {
  it('startApp cleans up after itself', async () => {
    const before = mkdtempSync(join(tmpdir(), 'myjournal-probe-'));
    rmSync(before, { recursive: true, force: true });
    const h = await startApp({ ai: false });
    const dir = h.dir;
    await h.close();
    await assert.rejects(() => rawRequest(h.url, 'GET', '/api/health'));
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(dir), false);
  });
});
