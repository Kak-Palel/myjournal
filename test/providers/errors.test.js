import { test } from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import {
  ERROR_CODES, ProviderError, abortError, errorFactory, errorPayload, isAbortError, redactSecrets, sanitizeCause,
} from '../../src/providers/errors.js';

test('ProviderError carries code, hint, status, retryAfterMs and provider', () => {
  const err = new ProviderError('rate_limit', 'Slow down', { hint: 'wait', status: 429, retryAfterMs: 1500.4, provider: 'gemini' });
  assert.equal(err.name, 'ProviderError');
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'rate_limit');
  assert.equal(err.message, 'Slow down');
  assert.equal(err.hint, 'wait');
  assert.equal(err.status, 429);
  assert.equal(err.retryAfterMs, 1500);
  assert.equal(err.provider, 'gemini');
});

test('every documented code is accepted; anything else becomes unknown', () => {
  for (const code of ERROR_CODES) assert.equal(new ProviderError(code, 'x').code, code);
  assert.equal(ERROR_CODES.length, 15);
  assert.equal(new ProviderError('nonsense', 'x').code, 'unknown');
});

test('toJSON includes the message and omits unset fields', () => {
  const json = JSON.parse(JSON.stringify(new ProviderError('auth', 'Nope', { provider: 'openai' })));
  assert.deepEqual(json, { name: 'ProviderError', code: 'auth', message: 'Nope', provider: 'openai' });
});

test('the API key is scrubbed from message, hint, detail and cause', () => {
  const key = 'sk-live-ABCDEF1234567890';
  const cause = Object.assign(new Error(`connect failed for ${key}`), { code: 'ECONNRESET', headers: { authorization: `Bearer ${key}` } });
  const err = new ProviderError('network', `bad ${key}`, { hint: `try ${key}`, detail: `echo ${key} and ${encodeURIComponent(key)}`, cause, secrets: [key] });
  const everything = JSON.stringify(err) + err.stack + util.inspect(err, { depth: 6 }) + err.message;
  assert.ok(!everything.includes(key), everything);
  assert.ok(!everything.includes('Bearer'), 'raw headers on the cause are never copied');
  assert.equal(err.cause.code, 'ECONNRESET');
  assert.ok(err.message.includes('[redacted]'));
});

test('short secrets are only scrubbed from upstream text, so static hints about `ollama serve` survive', () => {
  const err = new ProviderError('network', 'Is it running?', { hint: 'Start it with `ollama serve`.', detail: 'server said ollama', secrets: ['ollama'] });
  assert.equal(err.hint, 'Start it with `ollama serve`.');
  assert.equal(err.detail, 'server said [redacted]');
});

test('redactSecrets ignores tiny or non-string secrets and non-string text', () => {
  assert.equal(redactSecrets('abc abc', ['abc']), 'abc abc');
  assert.equal(redactSecrets('abcd abcd', ['abcd']), '[redacted] [redacted]');
  assert.equal(redactSecrets('hello', [undefined, null, 42]), 'hello');
  assert.equal(redactSecrets(undefined, ['abcdefgh']), undefined);
  assert.equal(redactSecrets('hello', undefined), 'hello');
});

test('sanitizeCause keeps only name, message and code, and bounds depth', () => {
  const deep = new Error('a', { cause: new Error('b', { cause: new Error('c', { cause: new Error('d') }) }) });
  const out = sanitizeCause(deep, []);
  assert.deepEqual(Object.keys(out).sort(), ['cause', 'message', 'name']);
  assert.equal(out.cause.cause.message, 'c');
  assert.equal(out.cause.cause.cause, undefined);
  assert.equal(sanitizeCause(undefined, []), undefined);
  assert.deepEqual(sanitizeCause('plain string', []), { name: 'Error', message: 'plain string' });
});

test('abortError is an AbortError and not a ProviderError', () => {
  const err = abortError();
  assert.equal(err.name, 'AbortError');
  assert.ok(isAbortError(err));
  assert.ok(!(err instanceof ProviderError));
  assert.ok(!isAbortError(new ProviderError('timeout', 'x')));
  assert.ok(!isAbortError(null));
});

test('errorFactory stamps provider and secrets', () => {
  const fail = errorFactory('local', ['supersecretkey']);
  const err = fail('auth', 'rejected supersecretkey');
  assert.equal(err.provider, 'local');
  assert.ok(!err.message.includes('supersecretkey'));
});

test('errorPayload gives code/message/hint for ProviderErrors and a generic body otherwise', () => {
  assert.deepEqual(errorPayload(new ProviderError('quota', 'Out', { hint: 'Pay' })), { code: 'quota', message: 'Out', hint: 'Pay' });
  assert.deepEqual(errorPayload(new ProviderError('quota', 'Out')), { code: 'quota', message: 'Out' });
  const generic = errorPayload(new TypeError('secret internals'));
  assert.equal(generic.code, 'unknown');
  assert.ok(!generic.message.includes('secret'));
});
