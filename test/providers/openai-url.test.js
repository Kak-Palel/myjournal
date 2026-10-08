import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseUrl, ollamaRoot } from '../../src/providers/openai.js';
import { ProviderError } from '../../src/providers/errors.js';

// [input, expected] for the `openai` provider
const OPENAI_TABLE = [
  ['https://api.openai.com/v1', 'https://api.openai.com/v1'],
  ['https://api.openai.com/v1/', 'https://api.openai.com/v1'],
  ['https://api.openai.com/v1///', 'https://api.openai.com/v1'],
  ['https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1'],
  ['https://api.openai.com/v1/chat/completions/', 'https://api.openai.com/v1'],
  ['https://api.openai.com/v1/Chat/Completions', 'https://api.openai.com/v1'],
  ['  https://api.openai.com/v1  ', 'https://api.openai.com/v1'],
  ['https://api.openai.com', 'https://api.openai.com/v1'],
  ['https://api.openai.com/', 'https://api.openai.com/v1'],
  ['api.openai.com', 'https://api.openai.com/v1'],
  ['HTTPS://API.OPENAI.COM/v1', 'https://api.openai.com/v1'],
  ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1'],
  ['https://openrouter.ai/api/v1/chat/completions', 'https://openrouter.ai/api/v1'],
  ['https://api.groq.com/openai/v1/', 'https://api.groq.com/openai/v1'],
  ['https://api.together.xyz/v1', 'https://api.together.xyz/v1'],
  ['https://api.deepseek.com', 'https://api.deepseek.com'], // /v1 is optional there: do not invent it for unknown hosts
  ['https://my-proxy.example.com/openai', 'https://my-proxy.example.com/openai'],
  ['https://example.com:8443/v1', 'https://example.com:8443/v1'],
  ['https://example.com:443/v1', 'https://example.com/v1'],
  ['https://example.com/v1#section', 'https://example.com/v1'],
  ['https://example.com/v1?', 'https://example.com/v1'], // an empty query string is harmless
  ['http://localhost:8080/v1', 'http://localhost:8080/v1'],
  ['localhost:8080/v1', 'http://localhost:8080/v1'],
  ['192.168.1.20:8000/v1', 'http://192.168.1.20:8000/v1'],
  ['my-box.local:8000/v1', 'http://my-box.local:8000/v1'],
  ['http://[::1]:8080/v1', 'http://[::1]:8080/v1'],
  ['http://[::1]:8080/v1/chat/completions', 'http://[::1]:8080/v1'],
  ['https://example.com/a%20b/v1', 'https://example.com/a%20b/v1'],
];

// [input, expected] for the `local` provider: a bare host gets /v1
const LOCAL_TABLE = [
  ['http://localhost:11434', 'http://localhost:11434/v1'],
  ['http://localhost:11434/', 'http://localhost:11434/v1'],
  ['http://localhost:11434//', 'http://localhost:11434/v1'],
  ['http://localhost:11434/v1', 'http://localhost:11434/v1'],
  ['http://localhost:11434/v1/', 'http://localhost:11434/v1'],
  ['http://localhost:11434/v1/chat/completions', 'http://localhost:11434/v1'],
  ['http://localhost:11434/chat/completions', 'http://localhost:11434/v1'],
  ['localhost:11434', 'http://localhost:11434/v1'],
  ['localhost', 'http://localhost/v1'],
  ['http://localhost:80', 'http://localhost/v1'],
  ['http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1'],
  ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/v1'],
  ['http://[::1]:11434', 'http://[::1]:11434/v1'],
  ['http://[::1]:11434/', 'http://[::1]:11434/v1'],
  ['http://[::1]:11434/v1/', 'http://[::1]:11434/v1'],
  ['[::1]:11434', 'http://[::1]:11434/v1'],
  ['http://[fe80::1]:11434', 'http://[fe80::1]:11434/v1'],
  ['http://host.docker.internal:11434', 'http://host.docker.internal:11434/v1'],
  ['https://ollama.example.com', 'https://ollama.example.com/v1'],
  ['https://ollama.example.com/ollama/v1', 'https://ollama.example.com/ollama/v1'],
  ['http://localhost:11434/api', 'http://localhost:11434/api'], // native path: left alone, the 404 hint explains
  ['example.com', 'http://example.com/v1'], // local servers default to http when no scheme is given
];

test('normalizeBaseUrl: openai table', () => {
  for (const [input, expected] of OPENAI_TABLE) {
    assert.equal(normalizeBaseUrl(input, { local: false }), expected, `openai: ${input}`);
  }
});

test('normalizeBaseUrl: local table', () => {
  for (const [input, expected] of LOCAL_TABLE) {
    assert.equal(normalizeBaseUrl(input, { local: true }), expected, `local: ${input}`);
  }
});

test('normalizeBaseUrl is idempotent', () => {
  for (const [, expected] of OPENAI_TABLE) assert.equal(normalizeBaseUrl(expected), expected);
  for (const [, expected] of LOCAL_TABLE) assert.equal(normalizeBaseUrl(expected, { local: true }), expected);
});

test('normalizeBaseUrl rejects query strings, credentials, other schemes and garbage with bad_base_url', () => {
  const bad = [
    '', '   ', undefined, null, 5, {}, 'https://api.openai.com/v1?api-version=2024-01-01', 'http://localhost:11434?x=1',
    'http://user:pass@localhost:11434/v1', 'https://:pass@host/v1', 'ftp://host/v1', 'file:///etc/passwd', 'javascript:alert(1)',
    'data:text/plain,hi', 'ws://host/v1', 'http://', 'https://exa mple.com/v1', 'not a url at all', 'http://localhost:99999/v1',
  ];
  for (const input of bad) {
    for (const local of [false, true]) {
      assert.throws(
        () => normalizeBaseUrl(input, { local }),
        (e) => e instanceof ProviderError && e.code === 'bad_base_url' && e.provider === (local ? 'local' : 'openai'),
        `${String(input)} (local=${local})`,
      );
    }
  }
});

test('rejected addresses never echo credentials or query values in the error', () => {
  for (const input of ['http://admin:hunter2@localhost:11434/v1', 'https://host/v1?key=sk-secret-value']) {
    try {
      normalizeBaseUrl(input);
      assert.fail('should throw');
    } catch (e) {
      const text = JSON.stringify(e);
      assert.ok(!text.includes('hunter2') && !text.includes('sk-secret-value'), text);
    }
  }
});

test('ollamaRoot strips /v1', () => {
  assert.equal(ollamaRoot('http://localhost:11434/v1'), 'http://localhost:11434');
  assert.equal(ollamaRoot('http://localhost:11434'), 'http://localhost:11434');
  assert.equal(ollamaRoot('https://x.example.com/ollama/v1'), 'https://x.example.com/ollama');
  assert.equal(ollamaRoot('http://[::1]:11434/v1'), 'http://[::1]:11434');
});
