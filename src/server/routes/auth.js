// /api/health and /api/auth/* : public routes (docs/ARCHITECTURE.md section 6).

import { isHttpsRequest, normalizeIp, sessionCookieName } from '../auth.js';
import { HttpError, badRequest } from '../http.js';

/**
 * @param {ReturnType<import('../http.js').createRouter>} router
 * @param {{ config: object, auth: ReturnType<import('../auth.js').createAuth> }} deps
 */
export function register(router, { config, auth }) {
  router.add('GET', '/health', (ctx) => ctx.json({ ok: true, version: config.version }), { public: true });

  router.add('GET', '/auth/status', (ctx) => {
    ctx.json({ required: auth.required, authenticated: auth.isAuthenticated(ctx.req) });
  }, { public: true });

  router.add('POST', '/auth/login', async (ctx) => {
    const { req } = ctx;
    const body = await ctx.readJson();
    if (!auth.required) {
      ctx.json({ ok: true });
      return;
    }
    const ip = normalizeIp(req.socket.remoteAddress);
    const wait = auth.limiter.retryAfterSeconds(ip);
    if (wait > 0) {
      throw new HttpError(429, 'rate_limited', 'Too many wrong passwords.', {
        hint: `Wait ${wait} second${wait === 1 ? '' : 's'}, then try again.`,
        headers: { 'Retry-After': String(wait) },
      });
    }
    if (typeof body.password !== 'string' || body.password === '') {
      throw badRequest('Enter your password.', { fields: { password: 'password is required.' } });
    }
    if (!auth.verifyPassword(body.password)) {
      auth.limiter.fail(ip);
      throw new HttpError(401, 'invalid_password', 'That password is not right.', { hint: 'Check for typos and caps lock, then try again.' });
    }
    auth.limiter.reset(ip);
    auth.destroySession(auth.tokenFromRequest(req)); // a new login replaces the old session
    const token = auth.createSession();
    ctx.res.setHeader('Set-Cookie', auth.sessionCookie(token, { secure: isHttpsRequest(req), name: sessionCookieName(req) }));
    ctx.json({ ok: true });
  }, { public: true });

  router.add('POST', '/auth/logout', (ctx) => {
    auth.destroySession(auth.tokenFromRequest(ctx.req));
    ctx.res.setHeader('Set-Cookie', auth.clearCookie({ secure: isHttpsRequest(ctx.req), name: sessionCookieName(ctx.req) }));
    ctx.json({ ok: true });
  }, { public: true });
}

