import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createAuth, createLoginLimiter, isHttpsRequest, normalizeIp, sessionCookieName } from '../../src/server/auth.js';
import { startApp } from './helpers.js';

const PASSWORD = 'correct horse battery staple';

function cookieOf(res) {
  const header = res.headers['set-cookie'];
  const line = Array.isArray(header) ? header[0] : header;
  return line ? line.split(';')[0] : '';
}

describe('auth units', () => {
  it('compares passwords without leaking length or content (digest compare)', () => {
    const auth = createAuth({ password: PASSWORD });
    assert.equal(auth.required, true);
    assert.equal(auth.verifyPassword(PASSWORD), true);
    for (const wrong of ['', 'x', PASSWORD + ' ', PASSWORD.toUpperCase(), PASSWORD.slice(1), 'x'.repeat(5000), null, undefined, 42, {}, [PASSWORD]]) {
      assert.equal(auth.verifyPassword(wrong), false, String(wrong).slice(0, 20));
    }
    assert.equal(createAuth({ password: '' }).required, false);
    assert.equal(createAuth({ password: '' }).verifyPassword(''), false, 'no password configured: nothing verifies');
  });

  it('keeps sessions server-side, expires them and caps their number', () => {
    let now = 1_000_000;
    const auth = createAuth({ password: PASSWORD, sessionTtlMs: 1000 }, { now: () => now });
    const token = auth.createSession();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(auth.hasSession(token), true);
    assert.equal(auth.hasSession(`${token}x`), false);
    assert.equal(auth.hasSession(''), false);
    now += 999;
    assert.equal(auth.hasSession(token), true);
    now += 2;
    assert.equal(auth.hasSession(token), false);
    for (let i = 0; i < 1100; i += 1) auth.createSession();
    assert.ok(auth.sessionCount <= 1000);
    const fresh = auth.createSession();
    auth.destroySession(fresh);
    assert.equal(auth.hasSession(fresh), false);
  });

  it('reads the session cookie among others', () => {
    const auth = createAuth({ password: PASSWORD });
    const token = auth.createSession();
    const req = (cookie) => ({ headers: { cookie } });
    assert.equal(auth.isAuthenticated(req(`a=1; mj_session=${token}; b=2`)), true);
    assert.equal(auth.isAuthenticated(req(`mj_session=${token}x`)), false);
    assert.equal(auth.isAuthenticated(req(`xmj_session=${token}`)), false);
    assert.equal(auth.isAuthenticated({ headers: {} }), false);
    assert.equal(createAuth({ password: '' }).isAuthenticated({ headers: {} }), true);
  });

  it('names the cookie after the port the request arrived on', () => {
    assert.equal(sessionCookieName({ socket: { localPort: 3210 } }), 'mj_session_3210');
    for (const req of [undefined, {}, { socket: {} }, { socket: { localPort: 0 } }, { socket: { localPort: 'x' } }]) {
      assert.equal(sessionCookieName(req), 'mj_session');
    }
    const auth = createAuth({ password: PASSWORD });
    const token = auth.createSession();
    const onPort = (cookie, localPort) => ({ headers: { cookie }, socket: { localPort } });
    assert.equal(auth.isAuthenticated(onPort(`mj_session_3210=${token}`, 3210)), true);
    assert.equal(auth.isAuthenticated(onPort(`mj_session_3210=${token}`, 3211)), false, 'a cookie of another port');
    assert.equal(auth.isAuthenticated(onPort(`mj_session=${token}`, 3210)), false, 'the plain name is not the port-specific one');
    assert.equal(auth.isAuthenticated(onPort(`mj_session_3211=bad; mj_session_3210=${token}`, 3210)), true);
  });

  it('reads long Cookie headers completely but not absurd ones', () => {
    const auth = createAuth({ password: PASSWORD });
    const token = auth.createSession();
    const req = (cookie) => ({ headers: { cookie } });
    assert.equal(auth.isAuthenticated(req(`${'a=b; '.repeat(3000)}mj_session=${token}`)), true, 'about 15 KB of cookies in front');
    assert.equal(auth.isAuthenticated(req(`${'x'.repeat(70_000)}; mj_session=${token}`)), false, 'beyond any header Node would accept');
  });

  it('builds cookies with the right flags', () => {
    const auth = createAuth({ password: PASSWORD, sessionTtlMs: 60_000 });
    assert.equal(auth.sessionCookie('abc'), 'mj_session=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=60');
    assert.equal(auth.sessionCookie('abc', { secure: true }), 'mj_session=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=60; Secure');
    assert.match(auth.clearCookie(), /^mj_session=; .*Max-Age=0/);
    assert.equal(isHttpsRequest({ headers: { 'x-forwarded-proto': 'https' } }), true);
    assert.equal(isHttpsRequest({ headers: { 'x-forwarded-proto': 'HTTPS, http' } }), true);
    assert.equal(isHttpsRequest({ headers: { 'x-forwarded-proto': 'http' } }), false);
    assert.equal(isHttpsRequest({ headers: {} }), false);
  });

  it('limits failures per address inside a sliding window', () => {
    let now = 0;
    const limiter = createLoginLimiter({ max: 5, windowMs: 60_000, now: () => now });
    for (let i = 0; i < 4; i += 1) {
      assert.equal(limiter.retryAfterSeconds('a'), 0);
      limiter.fail('a');
      now += 1000;
    }
    assert.equal(limiter.retryAfterSeconds('a'), 0, 'four failures are still allowed');
    limiter.fail('a');
    assert.ok(limiter.retryAfterSeconds('a') > 0);
    assert.equal(limiter.retryAfterSeconds('b'), 0, 'other addresses are unaffected');
    now += 60_000;
    assert.equal(limiter.retryAfterSeconds('a'), 0, 'the window slides');
    limiter.fail('a');
    limiter.reset('a');
    assert.equal(limiter.retryAfterSeconds('a'), 0);
  });

  it('treats IPv4-mapped IPv6 addresses as the same client', () => {
    assert.equal(normalizeIp('::ffff:10.0.0.1'), '10.0.0.1');
    assert.equal(normalizeIp('10.0.0.1'), '10.0.0.1');
    assert.equal(normalizeIp(undefined), 'unknown');
  });
});

describe('password protection (real server)', () => {
  let h;
  before(async () => {
    h = await startApp({ ai: false, config: { password: PASSWORD, loginMaxFailures: 5, loginWindowMs: 60_000 } });
  });
  after(() => h.close());

  const login = (password, options) => h.post('/api/auth/login', { password }, options);

  it('reports the state publicly and hides everything else until sign-in', async () => {
    assert.deepEqual((await h.get('/api/auth/status')).json, { required: true, authenticated: false });
    assert.deepEqual((await h.get('/api/health')).json, { ok: true, version: h.config.version });
    for (const [method, path] of [['GET', '/api/settings'], ['GET', '/api/entries'], ['POST', '/api/entries'], ['GET', '/api/memories'], ['GET', '/api/data/export'],
      ['GET', '/api/nope'], ['GET', '/api/providers'], ['POST', '/api/data/wipe'], ['GET', '/api/insights/overview']]) {
      const res = await h.request(method, path, { body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.json.error.code, 'unauthorized');
    }
    const staticFile = await h.get('/js/app.js');
    assert.equal(staticFile.status, 200, 'static files stay public');
    assert.equal((await h.get('/')).status, 200);
  });

  it('still enforces the Host allow-list of a loopback bind (DNS rebinding); see security.test.js', async () => {
    const res = await h.get('/api/health', { headers: { Host: 'journal.lan.example:8080' } });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'forbidden_host');
  });

  it('rejects a wrong password with 401 invalid_password and no cookie', async () => {
    const res = await login('nope');
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, 'invalid_password');
    assert.equal(res.headers['set-cookie'], undefined);
  });

  it('answers 400 (not 401) for a malformed login and does not count it as a failed guess', async () => {
    for (const body of [{}, { password: 42 }, { password: '' }, { password: null }]) {
      const res = await h.post('/api/auth/login', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await h.request('POST', '/api/auth/login', { rawBody: '{oops' })).status, 400);
  });

  it('signs in with the right password and sets a strict HttpOnly cookie', async () => {
    const res = await login(PASSWORD);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    const line = [].concat(res.headers['set-cookie'])[0];
    assert.match(line, new RegExp(`^mj_session_${h.app.port}=[A-Za-z0-9_-]{43};`), 'named after the port, see sessionCookieName');
    assert.match(line, /; HttpOnly/);
    assert.match(line, /; SameSite=Strict/);
    assert.match(line, /; Path=\//);
    assert.match(line, /; Max-Age=2592000/);
    assert.doesNotMatch(line, /Secure/, 'plain HTTP must not get a Secure cookie');

    const cookie = cookieOf(res);
    assert.deepEqual((await h.get('/api/auth/status', { headers: { Cookie: cookie } })).json, { required: true, authenticated: true });
    const settings = await h.get('/api/settings', { headers: { Cookie: cookie } });
    assert.equal(settings.status, 200);
    const created = await h.request('POST', '/api/entries', { body: { content: 'signed in' }, headers: { Cookie: cookie } });
    assert.equal(created.status, 201);
    const forged = await h.get('/api/settings', { headers: { Cookie: `mj_session_${h.app.port}=forged` } });
    assert.equal(forged.status, 401);
  });

  it('marks the cookie Secure only behind an HTTPS proxy', async () => {
    const res = await login(PASSWORD, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(res.status, 200);
    assert.match([].concat(res.headers['set-cookie'])[0], /; Secure$/);
  });

  it('signs out: the old cookie stops working and the cookie is cleared', async () => {
    const cookie = cookieOf(await login(PASSWORD));
    assert.equal((await h.get('/api/settings', { headers: { Cookie: cookie } })).status, 200);
    const out = await h.post('/api/auth/logout', {}, { headers: { Cookie: cookie } });
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, { ok: true });
    assert.match([].concat(out.headers['set-cookie'])[0], new RegExp(`^mj_session_${h.app.port}=; .*Max-Age=0`));
    assert.equal((await h.get('/api/settings', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await h.post('/api/auth/logout', {})).status, 200, 'logging out twice is fine');
  });

  // Regression: the cookie was ignored once the Cookie header passed 8192 bytes, although Node accepts 16 KiB.
  // Other apps on localhost share the cookie jar, so a few big cookies of theirs made login succeed and every
  // following request answer 401.
  it('finds the session cookie in a long Cookie header', async () => {
    const cookie = cookieOf(await login(PASSWORD));
    for (const junk of [9000, 15000]) {
      const header = `other=${'x'.repeat(junk)}; ${cookie}`;
      assert.ok(header.length > 8192, 'longer than the old limit');
      const res = await h.get('/api/settings', { headers: { Cookie: header } });
      assert.equal(res.status, 200, `${junk} bytes of other cookies in front`);
    }
    const last = await h.get('/api/auth/status', { headers: { Cookie: `${cookie}; other=${'y'.repeat(15000)}` } });
    assert.deepEqual(last.json, { required: true, authenticated: true });
  });

  // Regression: cookies are shared between the ports of one host name, so two journals on localhost:3210 and
  // localhost:3211 kept replacing each other's cookie and signing each other out.
  it('keeps two journals on different ports from signing each other out', async () => {
    const other = await startApp({ ai: false, config: { password: PASSWORD } });
    try {
      assert.notEqual(other.app.port, h.app.port);
      const mine = cookieOf(await login(PASSWORD));
      const theirs = cookieOf(await other.post('/api/auth/login', { password: PASSWORD }));
      assert.notEqual(mine.split('=')[0], theirs.split('=')[0], 'different cookie names');
      const jar = `${mine}; ${theirs}`; // what a browser sends to both, because it does not separate ports
      assert.equal((await h.get('/api/settings', { headers: { Cookie: jar } })).status, 200);
      assert.equal((await other.get('/api/settings', { headers: { Cookie: jar } })).status, 200);
      assert.equal((await h.get('/api/settings', { headers: { Cookie: theirs } })).status, 401, 'the other journal\'s cookie is not a session here');
      // Signing out of one leaves the other signed in.
      await other.post('/api/auth/logout', {}, { headers: { Cookie: jar } });
      assert.equal((await other.get('/api/settings', { headers: { Cookie: jar } })).status, 401);
      assert.equal((await h.get('/api/settings', { headers: { Cookie: jar } })).status, 200);
    } finally {
      await other.close();
    }
  });

  it('replaces the previous session on a new login', async () => {
    const first = cookieOf(await login(PASSWORD));
    const second = cookieOf(await login(PASSWORD, { headers: { Cookie: first } }));
    assert.notEqual(first, second);
    assert.equal((await h.get('/api/settings', { headers: { Cookie: first } })).status, 401);
    assert.equal((await h.get('/api/settings', { headers: { Cookie: second } })).status, 200);
  });

  it('keeps the CSRF header requirement on login', async () => {
    const res = await h.request('POST', '/api/auth/login', { body: { password: PASSWORD }, csrf: false });
    assert.equal(res.status, 403);
  });

  it('limits login failures to 5 per minute and then answers 429 even for the right password', async () => {
    const fresh = await startApp({ ai: false, config: { password: PASSWORD } });
    try {
      for (let i = 0; i < 5; i += 1) {
        const res = await fresh.post('/api/auth/login', { password: `wrong-${i}` });
        assert.equal(res.status, 401, `attempt ${i + 1}`);
      }
      const blocked = await fresh.post('/api/auth/login', { password: 'wrong-6' });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.json.error.code, 'rate_limited');
      assert.ok(Number(blocked.headers['retry-after']) >= 1);
      assert.match(blocked.json.error.hint, /second/);
      const right = await fresh.post('/api/auth/login', { password: PASSWORD });
      assert.equal(right.status, 429, 'the correct password does not unlock early');
      assert.equal(right.headers['set-cookie'], undefined);
    } finally {
      await fresh.close();
    }
  });

  it('allows everything and reports no sign-in when no password is set', async () => {
    const open = await startApp({ ai: false });
    try {
      assert.deepEqual((await open.get('/api/auth/status')).json, { required: false, authenticated: true });
      const res = await open.post('/api/auth/login', { password: 'anything' });
      assert.equal(res.status, 200);
      assert.equal(res.headers['set-cookie'], undefined);
      assert.equal((await open.get('/api/entries')).status, 200);
    } finally {
      await open.close();
    }
  });
});
