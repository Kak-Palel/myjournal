import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_OVERHEAD_TOKENS, estimateMessagesTokens, estimateTokens } from '../../src/journal/tokens.js';

test('estimateTokens is ceil(chars / 3.5) for Latin text', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('a'), 1);
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('abcd'), 2);
  assert.equal(estimateTokens('a'.repeat(35)), 10);
  assert.equal(estimateTokens('a'.repeat(36)), 11);
  assert.equal(estimateTokens('Hello, how are you doing today?'), Math.ceil(31 / 3.5));
});

test('estimateTokens tolerates non-strings', () => {
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(12345), 0);
  assert.equal(estimateTokens({}), 0);
});

test('estimateTokens weights scripts that tokenize finely', () => {
  assert.equal(estimateTokens('日本語'), 3, 'one token per CJK character');
  assert.ok(estimateTokens('今日はとても良い天気でした') >= 12);
  assert.ok(estimateTokens('Привет, как дела у тебя сегодня?') > Math.ceil(32 / 3.5), 'Cyrillic costs more than Latin');
  assert.ok(estimateTokens('😀😀😀😀') >= 8, 'emoji cost about two tokens each');
  assert.ok(estimateTokens('안녕하세요') >= 5);
});

test('estimateTokens grows monotonically with appended text', () => {
  let text = '';
  let last = 0;
  for (const piece of ['hello ', 'wörld ', '世界 ', '😀 ', 'мир ', 'x'.repeat(20)]) {
    text += piece;
    const now = estimateTokens(text);
    assert.ok(now >= last);
    last = now;
  }
});

test('estimateMessagesTokens adds a fixed cost per message', () => {
  assert.equal(estimateMessagesTokens([]), 0);
  assert.equal(estimateMessagesTokens(undefined), 0);
  assert.equal(estimateMessagesTokens([{ content: 'a'.repeat(35) }, { content: '' }]), 10 + 2 * MESSAGE_OVERHEAD_TOKENS);
  assert.equal(estimateMessagesTokens([null, { content: 'abc' }]), 1 + 2 * MESSAGE_OVERHEAD_TOKENS);
});

test('estimateTokens is fast on large input', () => {
  const t0 = Date.now();
  estimateTokens('lorem ipsum 日本 😀 '.repeat(100_000));
  assert.ok(Date.now() - t0 < 2000);
});
