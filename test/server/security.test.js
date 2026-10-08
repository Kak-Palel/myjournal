import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createLogger, printable } from '../../src/server/logger.js';
import { CSP, createHostMatcher, createSecurity, originMatchesHost, parseHostHeader } from '../../src/server/security.js';
import { rawRequest, rawSocket, startApp } from './helpers.js';

const EXPECTED_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function assertSecurityHeaders(res, label, { api = false } = {}) {
  const h = res.headers;
  assert.equal(h['content-security-policy'], EXPECTED_CSP, `${label}: CSP`);
  assert.equal(h['x-content-type-options'], 'nosniff', `${label}: nosniff`);
  assert.equal(h['referrer-policy'], 'no-referrer', `${label}: referrer`);
  assert.equal(h['cross-origin-opener-policy'], 'same-origin', `${label}: COOP`);
  assert.equal(h['permissions-policy'], 'microphone=(self), camera=(), geolocation=()', `${label}: permissions`);
  assert.equal(h['x-frame-options'], 'DENY', `${label}: frame`);
  if (api) assert.equal(h['cache-control'], 'no-store', `${label}: no-store`);
  for (const name of Object.keys(h)) assert.ok(!name.startsWith('access-control-'), `${label}: sent CORS header ${name}`);
}

describe('security units', () => {
  it('exports the CSP of the contract', () => {
    assert.equal(CSP, EXPECTED_CSP);
  });

  it('parses Host headers strictly', () => {
    assert.deepEqual(parseHostHeader('LocalHost:3210'), { hostname: 'localhost', port: '3210' });
    assert.deepEqual(parseHostHeader('[::1]:80'), { hostname: '[::1]', port: '80' });
    assert.deepEqual(parseHostHeader('example.com'), { hostname: 'example.com', port: '' });
    for (const bad of [undefined, '', 'a b', 'evil.com/path', 'user@evil.com', 'evil.com:99999x', 'a'.repeat(400), 'ev\nil.com']) {
      assert.equal(parseHostHeader(bad), null, String(bad));
    }
  });

  it('matches hosts against the allow-list', () => {
    const match = createHostMatcher({ host: '127.0.0.1', allowedHosts: ['journal.example.com', 'lan.example.com:8443'] });
    for (const ok of ['localhost', 'localhost:3210', '127.0.0.1:5', '[::1]:3210', 'journal.example.com', 'journal.example.com:81', 'lan.example.com:8443']) {
      assert.equal(match(ok), true, ok);
    }
    for (const bad of ['evil.com', 'localhost.evil.com', '127.0.0.2', 'lan.example.com', 'lan.example.com:9', 'journal.example.com.evil.com', undefined]) {
      assert.equal(match(bad), false, String(bad));
    }
    // A concrete bind address is allowed as a host name, a wildcard is not.
    assert.equal(createHostMatcher({ host: '192.168.1.5', allowedHosts: [] })('192.168.1.5:3210'), true);
    assert.equal(createHostMatcher({ host: '0.0.0.0', allowedHosts: [] })('0.0.0.0:3210'), false);
  });

  it('compares Origin and Host including default ports', () => {
    const headers = (host, extra = {}) => ({ host, ...extra });
    assert.equal(originMatchesHost('http://localhost:3210', headers('localhost:3210')), true);
    assert.equal(originMatchesHost('http://localhost:3210', headers('localhost:3211')), false);
    assert.equal(originMatchesHost('http://localhost', headers('localhost')), true);
    assert.equal(originMatchesHost('https://journal.example.com', headers('journal.example.com')), true);
    assert.equal(originMatchesHost('https://journal.example.com', headers('journal.example.com:443')), true);
    assert.equal(originMatchesHost('http://journal.example.com', headers('journal.example.com:443')), false);
    assert.equal(originMatchesHost('http://[::1]:3210', headers('[::1]:3210')), true);
    assert.equal(originMatchesHost('null', headers('localhost')), false);
    assert.equal(originMatchesHost('file:///x', headers('localhost')), false);
    assert.equal(originMatchesHost('https://public.example.com', headers('localhost:3210', { 'x-forwarded-host': 'public.example.com' })), true);
  });

  it('makes log text printable', () => {
    assert.equal(printable('/api/\x1b[31mred\r\nFAKE 200'), '/api/?[31mred??FAKE 200');
    assert.equal(printable('é/ü'), '?/?');
    assert.equal(printable('x'.repeat(500)).length, 163);
  });

  it('logs one line without query, headers or bodies', () => {
    const chunks = [];
    const original = process.stdout.write;
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    try {
      createLogger({}).request({ method: 'GET', path: '/api/entries', status: 200, ms: 3.4, aborted: false });
      createLogger({ quiet: true }).request({ method: 'GET', path: '/x', status: 200, ms: 1, aborted: false });
    } finally {
      process.stdout.write = original;
    }
    assert.deepEqual(chunks, ['GET /api/entries 200 3ms\n']);
  });
});

describe('security matrix (real server)', () => {
  let h;
  const logged = [];
  const errors = [];
  before(async () => {
    h = await startApp({ config: { logger: { request: (info) => logged.push(info), error: (message, err) => errors.push({ message, err }) } } });
  });
  after(() => h.close());

  it('sends the security headers on every kind of response', async () => {
    const entry = (await h.entry({ content: 'hello' })).entry;
    const big = '{"x":"' + 'a'.repeat(1024 * 1024 + 10) + '"}';
    const first = await h.get('/');
    const cases = [
      ['200 json', h.get('/api/health'), true],
      ['404 api', h.get('/api/nope'), true],
      ['404 entry', h.get('/api/entries/doesnotexist'), true],
      ['405', h.post('/api/health', {}), true],
      ['403 csrf', h.request('POST', '/api/entries', { body: {}, csrf: false }), true],
      ['403 origin', h.request('POST', '/api/entries', { body: {}, headers: { Origin: 'http://evil.example' } }), true],
      ['403 host', h.get('/api/health', { headers: { Host: 'evil.example' } }), true],
      ['400 json', h.request('POST', '/api/entries', { rawBody: '{nope' }), true],
      ['413', h.request('POST', '/api/entries', { rawBody: big }), true],
      ['400 bad query', h.get('/api/entries?limit=abc'), true],
      ['download', h.get(`/api/entries/${entry.id}/export.md`), true],
      ['export json', h.get('/api/data/export?format=json'), true],
      ['static html', h.get('/'), false],
      ['static css', h.get('/css/base.css'), false],
      ['static js', h.get('/js/app.js'), false],
      ['spa fallback', h.get('/entry/abc'), false],
      ['static 404', h.get('/missing.js'), false],
      ['static 400', h.get('/%2e%2e/package.json'), false],
      ['static 405', h.request('POST', '/', { body: {} }), false],
      ['304', h.get('/', { headers: { 'If-None-Match': first.headers.etag } }), false],
      ['HEAD', h.request('HEAD', '/'), false],
    ];
    for (const [label, promise, api] of cases) assertSecurityHeaders(await promise, label, { api });
  });

  it('sends the security headers on an SSE stream and on requests Node itself rejects', async () => {
    const entry = (await h.entry({ content: 'I feel fine today.' })).entry;
    const stream = await h.sse(`/api/entries/${entry.id}/reply`, {});
    assert.equal(stream.status, 200);
    assert.match(stream.headers['content-type'], /^text\/event-stream; charset=utf-8$/);
    assert.equal(stream.headers['cache-control'], 'no-store');
    assert.equal(stream.headers['x-accel-buffering'], 'no');
    assert.equal(stream.headers['content-security-policy'], EXPECTED_CSP);
    assert.equal(stream.headers['x-content-type-options'], 'nosniff');

    const garbage = await rawSocket(h.url, 'THIS IS NOT HTTP\r\n\r\n');
    assert.match(garbage, /^HTTP\/1\.1 400 Bad Request/);
    assert.ok(garbage.includes(`Content-Security-Policy: ${EXPECTED_CSP}`));
    assert.match(garbage, /X-Content-Type-Options: nosniff/i);
    assert.match(garbage, /"code":"bad_request"/);
    assert.doesNotMatch(garbage, /Access-Control/i);
  });

  it('enforces the Host allow-list while no password is set', async () => {
    for (const host of [`localhost:${h.app.port}`, `127.0.0.1:${h.app.port}`, `[::1]:${h.app.port}`, 'localhost']) {
      const res = await h.get('/api/health', { headers: { Host: host } });
      assert.equal(res.status, 200, host);
    }
    for (const host of ['evil.example', `evil.example:${h.app.port}`, '127.0.0.2', 'localhost.evil.example', '10.0.0.5']) {
      const res = await h.get('/api/health', { headers: { Host: host } });
      assert.equal(res.status, 403, host);
      assert.equal(res.json.error.code, 'forbidden_host');
    }
    const page = await h.get('/', { headers: { Host: 'rebind.example' } });
    assert.equal(page.status, 403);
    assert.doesNotMatch(page.text, /<html/i);
  });

  it('refuses a request without a Host header (HTTP/1.0 style)', async () => {
    const text = await rawSocket(h.url, 'GET /api/health HTTP/1.0\r\n\r\n');
    assert.match(text, /^HTTP\/1\.[01] 403/);
    assert.match(text, /forbidden_host/);
  });

  it('allows extra hosts from JOURNAL_ALLOWED_HOSTS', async () => {
    const other = await startApp({ ai: false, config: { allowedHosts: ['journal.example.com', 'lan.example.com:8443'] } });
    try {
      assert.equal((await other.get('/api/health', { headers: { Host: 'journal.example.com' } })).status, 200);
      assert.equal((await other.get('/api/health', { headers: { Host: 'lan.example.com:8443' } })).status, 200);
      assert.equal((await other.get('/api/health', { headers: { Host: 'lan.example.com:80' } })).status, 403);
      assert.equal((await other.get('/api/health', { headers: { Host: 'other.example.com' } })).status, 403);
    } finally {
      await other.close();
    }
  });

  it('requires X-MyJournal: 1 on every non-GET API request', async () => {
    for (const [method, path] of [['POST', '/api/entries'], ['PUT', '/api/settings'], ['PATCH', '/api/entries/x'], ['DELETE', '/api/entries/x'], ['POST', '/api/memories/clear'], ['POST', '/api/data/wipe']]) {
      const res = await h.request(method, path, { body: {}, csrf: false });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.json.error.code, 'forbidden_origin');
    }
    const wrongValue = await h.request('POST', '/api/entries', { body: {}, headers: { 'X-MyJournal': 'yes' } });
    assert.equal(wrongValue.status, 403);
    assert.equal((await h.request('POST', '/api/entries', { body: {} })).status, 201);
    // GET needs no header
    assert.equal((await h.get('/api/memories')).status, 200);
  });

  it('refuses cross-origin Origin headers and accepts the matching one', async () => {
    const port = h.app.port;
    const refuse = async (origin, extra = {}) => {
      const res = await h.request('POST', '/api/entries', { body: {}, headers: { Origin: origin, ...extra } });
      assert.equal(res.status, 403, origin);
      assert.equal(res.json.error.code, 'forbidden_origin');
    };
    await refuse('http://evil.example');
    await refuse(`http://localhost:${port + 1}`); // another local app
    await refuse(`https://localhost:${port}`.replace('https', 'ftp'));
    await refuse('null');
    await refuse('not a url');
    await refuse(`http://localhost:${port}`, { 'Sec-Fetch-Site': 'cross-site' });
    const same = await h.request('POST', '/api/entries', { body: {}, headers: { Origin: `http://127.0.0.1:${port}` } });
    assert.equal(same.status, 201);
    const viaProxy = await h.request('POST', '/api/entries', { body: {}, headers: { Origin: 'https://journal.example.com', 'X-Forwarded-Host': 'journal.example.com' } });
    assert.equal(viaProxy.status, 201);
    // A foreign Origin on a GET is harmless (no CORS headers are sent, so the page cannot read it).
    const get = await h.get('/api/health', { headers: { Origin: 'http://evil.example' } });
    assert.equal(get.status, 200);
    assert.equal(get.headers['access-control-allow-origin'], undefined);
  });

  it('answers CORS preflights without granting anything', async () => {
    const res = await h.request('OPTIONS', '/api/entries', {
      csrf: false,
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-myjournal' },
    });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET, HEAD, POST');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers['access-control-allow-headers'], undefined);
  });

  it('answers 405 with an Allow header', async () => {
    const cases = [
      ['DELETE', '/api/health', 'GET, HEAD'],
      ['GET', '/api/auth/login', 'POST'],
      ['PUT', '/api/entries', 'GET, HEAD, POST'],
      ['POST', '/api/entries/abc', 'GET, HEAD, PATCH, DELETE'],
      ['GET', '/api/memories/clear', 'POST'],
      ['POST', '/api/settings', 'GET, HEAD, PUT'],
      ['GET', '/api/entries/abc/reply', 'POST'],
    ];
    for (const [method, path, allow] of cases) {
      const res = await h.request(method, path, { body: method === 'GET' ? undefined : {} });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.allow, allow, `${method} ${path}`);
      assert.equal(res.json.error.code, 'method_not_allowed');
    }
    const staticPost = await h.request('POST', '/index.html', { body: {} });
    assert.equal(staticPost.status, 405);
    assert.equal(staticPost.headers.allow, 'GET, HEAD');
  });

  it('answers unknown API addresses with a JSON 404', async () => {
    for (const path of ['/api', '/api/', '/api/nope', '/api/entries/a/b/c/d', '/api/insights', '/api/..', '/api/auth']) {
      const res = await h.get(path);
      assert.equal(res.status, 404, path);
      assert.equal(res.json.error.code, 'not_found', path);
      assert.match(res.headers['content-type'], /application\/json/);
    }
    assert.equal((await h.request('POST', '/api/nope', { body: {} })).status, 404);
    const badEscape = await h.get('/api/entries/%ZZ');
    assert.equal(badEscape.status, 400);
    // "/apix" is not below /api: it is an ordinary app route
    const apix = await h.get('/apix');
    assert.equal(apix.status, 200);
    assert.match(apix.headers['content-type'], /text\/html/);
  });

  it('refuses malformed JSON, scalars and arrays where an object is expected', async () => {
    for (const rawBody of ['{nope', '', 'undefined', '{"a":', '[1,2]', '"text"', '42', 'null']) {
      const res = await h.request('POST', '/api/entries', { rawBody });
      if (rawBody === '') {
        assert.equal(res.status, 201, 'an empty body is an empty object');
        continue;
      }
      assert.equal(res.status, 400, JSON.stringify(rawBody));
      assert.equal(res.json.error.code, 'bad_request');
    }
    const settings = await h.request('PUT', '/api/settings', { rawBody: '[1]' });
    assert.equal(settings.status, 400);
    assert.equal(settings.json.error.code, 'invalid_settings');
    const bom = await h.request('POST', '/api/entries', { rawBody: '\uFEFF{"content":"with a byte order mark"}' });
    assert.equal(bom.status, 201);
  });

  it('caps request bodies at 1 MB (and 413 does not depend on the content type)', async () => {
    const pad = (n) => JSON.stringify({ junk: 'x'.repeat(n) });
    const ok = await h.request('PUT', '/api/settings', { rawBody: pad(900 * 1024) });
    assert.equal(ok.status, 200, 'unknown keys are dropped, a body just under 1 MB is fine');
    const tooBig = await h.request('PUT', '/api/settings', { rawBody: pad(1024 * 1024 + 1) });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.json.error.code, 'payload_too_large');
    assert.equal(tooBig.headers.connection, 'close');
    const textType = await h.request('POST', '/api/entries', { rawBody: pad(1100 * 1024), headers: { 'Content-Type': 'text/plain' } });
    assert.equal(textType.status, 413);
  });

  it('caps chunked bodies without a Content-Length too', async () => {
    const chunk = 'x'.repeat(64 * 1024);
    const chunks = Array.from({ length: 20 }, () => `${chunk.length.toString(16)}\r\n${chunk}\r\n`).join('');
    const text = await rawSocket(h.url, `POST /api/entries HTTP/1.1\r\nHost: localhost\r\nX-MyJournal: 1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunks}0\r\n\r\n`);
    assert.match(text, /^HTTP\/1\.1 413/);
    assert.match(text, /payload_too_large/);
  });

  it('refuses a huge Content-Length before reading the body', async () => {
    const text = await rawSocket(h.url, `POST /api/entries HTTP/1.1\r\nHost: localhost\r\nX-MyJournal: 1\r\nContent-Type: application/json\r\nContent-Length: ${50 * 1024 * 1024}\r\nConnection: close\r\n\r\n{`);
    assert.match(text, /^HTTP\/1\.1 413/);
  });

  it('rejects every path traversal variant on the static side', async () => {
    const mustReject = [
      '/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/%2e%2e%2fpackage.json', '/%2E%2E/package.json',
      '/%252e%252e/package.json', '/%252e%252e%252fpackage.json', '/..%5cpackage.json', '/..%5Cpackage.json', '/js/..%2f..%2fpackage.json',
      '/js/../../package.json', '/%00', '/js/app.js%00.png', '/js%00/app.js', '//etc/passwd', '/js//app.js', '/./js/app.js',
      '/js/./app.js', '/C:/windows/win.ini', '/js/app.js::$DATA', '/%2e%2e/%2e%2e/%2e%2e/etc/passwd', '/css/%2e%2e/%2e%2e/etc/passwd',
      '/.env', '/.git/config', '/js/.hidden', '/%2eenv', '/js/%2e%2e%2f%2e%2e%2fsrc/config.js', '/..;/package.json', '/%c0%ae%c0%ae/package.json',
      '/js/app.js%2f..%2f..%2fpackage.json', '/%5c..%5cpackage.json', '/\\..\\package.json',
    ];
    for (const path of mustReject) {
      const res = await rawRequest(h.url, 'GET', path);
      assert.ok([400, 404].includes(res.status), `${JSON.stringify(path)} -> ${res.status}`);
      assert.doesNotMatch(res.text, /"name": ?"myjournal"|root:x:|createApp/, path);
      assert.match(res.headers['content-type'], /json/, path);
    }
    // an absolute-looking path is just a name below public/: unknown, so the app shell, never a system file
    const etc = await h.get('/etc/passwd');
    assert.doesNotMatch(etc.text, /root:/);
    for (const path of ['/etc/passwd', '/etc/shadow.conf']) {
      const res = await h.get(path);
      assert.doesNotMatch(res.text, /root:/);
    }
    assert.equal((await h.get('/js/app.js')).status, 200, 'the normal path still works');
  });

  it('never leaks stack traces or internal messages', async () => {
    const original = h.db.settings.get;
    h.db.settings.get = () => { throw new Error('secret-internal /home/someone/file.js:12:3'); };
    try {
      const res = await h.get('/api/settings');
      assert.equal(res.status, 500);
      assert.equal(res.json.error.code, 'internal_error');
      assert.doesNotMatch(res.text, /secret-internal|\.js:\d|at .*\(/);
    } finally {
      h.db.settings.get = original;
    }
    assert.ok(errors.some((e) => /secret-internal/.test(String(e.err && e.err.message))), 'the cause is logged for the operator');
  });

  it('logs one line per request without query strings', async () => {
    logged.length = 0;
    await h.get('/api/entries?q=my+very+private+words&limit=5');
    await h.get('/api/health');
    await h.get('/api/nope');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lines = logged.map((l) => `${l.method} ${l.path} ${l.status}`);
    assert.deepEqual(lines, ['GET /api/entries 200', 'GET /api/health 200', 'GET /api/nope 404']);
    assert.ok(!JSON.stringify(logged).includes('private'));
    for (const info of logged) assert.deepEqual(Object.keys(info).sort(), ['aborted', 'method', 'ms', 'path', 'status']);
  });
});

// DNS rebinding: a page on evil.example whose name is switched to 127.0.0.1 reaches the server as "same origin".
// The user's session cookie is not sent to evil.example, so against a password-protected journal the only thing
// left for the page to do is guess the password. The Host allow-list takes that away on a loopback bind.
describe('Host allow-list with a password', () => {
  const PASSWORD = 'correct horse battery staple';
  const REBOUND = { Host: 'attacker.example', Origin: 'http://attacker.example' };
  let locked;
  before(async () => { locked = await startApp({ ai: false, config: { password: PASSWORD } }); });
  after(async () => { await locked.close(); });

  it('is on whenever the server only listens on a loopback address', () => {
    assert.equal(createSecurity({ host: '127.0.0.1', password: 'x' }).hostCheckEnabled, true);
    assert.equal(createSecurity({ host: 'localhost', password: 'x' }).hostCheckEnabled, true);
    assert.equal(createSecurity({ host: '::1', password: 'x' }).hostCheckEnabled, true);
    assert.equal(createSecurity({ host: '127.0.0.1', password: '' }).hostCheckEnabled, true);
    assert.equal(createSecurity({ host: '0.0.0.0', password: '', insecureAllowNoAuth: true }).hostCheckEnabled, true);
    // Beyond this computer a password is the protection: the journal cannot know which names reach it.
    assert.equal(createSecurity({ host: '0.0.0.0', password: 'x' }).hostCheckEnabled, false);
    assert.equal(createSecurity({ host: '192.168.1.20', password: 'x' }).hostCheckEnabled, false);
  });

  it('refuses a rebound name before the login, the API or the pages can be reached', async () => {
    for (const [method, path] of [['GET', '/api/health'], ['GET', '/api/auth/status'], ['POST', '/api/auth/login'], ['GET', '/'], ['GET', '/api/entries']]) {
      const res = await locked.request(method, path, { body: method === 'POST' ? { password: PASSWORD } : undefined, headers: REBOUND });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.json.error.code, 'forbidden_host');
      assert.equal(res.headers['set-cookie'], undefined, 'no session is ever handed out');
    }
  });

  it('cannot be used to lock the owner out or to count guesses', async () => {
    for (let i = 0; i < 12; i += 1) {
      const res = await locked.request('POST', '/api/auth/login', { body: { password: `guess ${i}` }, headers: REBOUND });
      assert.equal(res.status, 403);
    }
    const real = await locked.request('POST', '/api/auth/login', { body: { password: PASSWORD } });
    assert.equal(real.status, 200, 'the failed rebound guesses did not use up the rate limit');
  });

  it('still accepts the loopback names and says how to allow a proxy name', async () => {
    const port = locked.app.port;
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'localhost']) {
      assert.equal((await locked.get('/api/health', { headers: { Host: host } })).status, 200, host);
    }
    const refused = await locked.get('/api/health', { headers: REBOUND });
    assert.match(refused.json.error.hint, /JOURNAL_ALLOWED_HOSTS/);
    assert.doesNotMatch(refused.json.error.hint, /JOURNAL_PASSWORD/, 'a password does not lift the check on a loopback bind');
  });

  it('lets a reverse proxy on the same machine through once its name is in JOURNAL_ALLOWED_HOSTS', async () => {
    const proxied = await startApp({ ai: false, config: { password: PASSWORD, allowedHosts: ['journal.example.com'] } });
    try {
      assert.equal((await proxied.get('/api/health', { headers: { Host: 'journal.example.com' } })).status, 200);
      const login = await proxied.request('POST', '/api/auth/login', {
        body: { password: PASSWORD },
        headers: { Host: 'journal.example.com', Origin: 'https://journal.example.com', 'X-Forwarded-Proto': 'https' },
      });
      assert.equal(login.status, 200);
      assert.equal((await proxied.get('/api/health', { headers: REBOUND })).status, 403);
    } finally {
      await proxied.close();
    }
  });

  it('leaves a password-protected journal on a LAN address reachable under any name', async () => {
    const lan = await startApp({ ai: false, config: { host: '0.0.0.0', password: PASSWORD } });
    try {
      const direct = `http://127.0.0.1:${lan.app.port}`;
      const res = await rawRequest(direct, 'GET', '/api/health', { headers: { Host: 'journal.lan' } });
      assert.equal(res.status, 200);
      const withoutPassword = await rawRequest(direct, 'GET', '/api/entries', { headers: { Host: 'journal.lan' } });
      assert.equal(withoutPassword.status, 401, 'the password still guards the data');
    } finally {
      await lan.close();
    }
  });
});
