import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capitalize, cleanText, extractKeywords, firstSentences, firstWords, normalizeLabels, oneLine, splitSentences, truncate, truncateMiddle, wordCount,
} from '../../src/journal/text.js';

const lone = (s) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

test('wordCount: plain, punctuation, hyphens and empties', () => {
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('   \n\t '), 0);
  assert.equal(wordCount('Hello world'), 2);
  assert.equal(wordCount("don't stop-believing, ok?"), 3);
  assert.equal(wordCount('well-known - fact'), 2, 'a lone dash is not a word');
  assert.equal(wordCount('a\nb\r\nc\td'), 4);
  assert.equal(wordCount(null), 0);
  assert.equal(wordCount(42), 0);
});

test('wordCount: unicode, emoji and CJK', () => {
  assert.equal(wordCount('Über naïve café résumé'), 4);
  assert.equal(wordCount('привет мир'), 2);
  assert.equal(wordCount('😀 😀'), 0, 'emoji alone are not words');
  assert.equal(wordCount('great 😀 day'), 2);
  assert.ok(wordCount('今日は天気がいい') >= 3, 'Japanese is segmented, not one word');
  assert.ok(wordCount('我今天很开心') >= 2);
  assert.equal(wordCount('hello 世界'), 2);
});

test('truncate: short text untouched, long text ends with an ellipsis within the limit', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdef', 5), 'abcd…');
  assert.equal(truncate('abcdef', 6), 'abcdef');
  assert.equal(truncate('abcdef', 1), '…');
  assert.equal(truncate('abc', 0), '');
  assert.equal(truncate('abc', -3), '');
  assert.equal(truncate(undefined, 5), '');
  assert.equal(truncate('hello world', 8, '...'), 'hello...');
});

test('truncate never splits a surrogate pair', () => {
  const s = '😀'.repeat(50);
  for (let max = 1; max < 12; max += 1) {
    const out = truncate(s, max);
    assert.ok(!lone(out), `lone surrogate at max=${max}`);
    assert.ok(Array.from(out).length <= max);
  }
  assert.equal(truncate('a😀b', 3), 'a😀b');
  assert.equal(truncate('a😀bc', 3), 'a😀…');
  const family = '👨‍👩‍👧'.repeat(10); // zero-width joiners: may be cut between code points, but never mid-surrogate
  for (let max = 1; max < 15; max += 1) assert.ok(!lone(truncate(family, max)));
});

test('truncateMiddle keeps head and tail and respects the limit', () => {
  const text = `${'a'.repeat(100)}${'b'.repeat(100)}`;
  const out = truncateMiddle(text, 40);
  assert.ok(Array.from(out).length <= 40);
  assert.ok(out.startsWith('aaaa'));
  assert.ok(out.endsWith('bbbb'));
  assert.ok(out.includes('[…]'));
  assert.equal(truncateMiddle('short', 40), 'short');
  assert.equal(truncateMiddle('abcdef', 0), '');
  const emoji = '😀'.repeat(200);
  for (const max of [5, 9, 10, 31, 77]) {
    const cut = truncateMiddle(emoji, max);
    assert.ok(!lone(cut), `lone surrogate at ${max}`);
    assert.ok(Array.from(cut).length <= max);
  }
});

test('firstWords cuts at a word boundary and collapses whitespace', () => {
  assert.equal(firstWords('  I   had a\n long day at work today  ', 20), 'I had a long day at');
  assert.equal(firstWords('Short', 20), 'Short');
  assert.equal(firstWords('One two three four', 9), 'One two');
  assert.equal(firstWords('One two three four', 9, { ellipsis: true }), 'One two…');
  assert.equal(firstWords('Hello, world, again and again', 13), 'Hello, world');
  assert.equal(firstWords('', 10), '');
  assert.equal(firstWords('abc', 0), '');
  const noSpaces = '今日はとても良い天気でした'.repeat(5);
  assert.ok(Array.from(firstWords(noSpaces, 10)).length <= 10);
  assert.ok(!lone(firstWords('😀'.repeat(40), 7)));
  assert.equal(firstWords('supercalifragilisticexpialidocious', 10), 'supercalif');
});

test('normalizeLabels: case, dedupe, hashes, quotes, limits', () => {
  assert.deepEqual(normalizeLabels(['Calm', ' calm ', '#Work', '"Tired"', 'x'.repeat(40)], { max: 5, maxLen: 24 }), ['calm', 'work', 'tired', 'x'.repeat(24)]);
  assert.deepEqual(normalizeLabels('Calm, tired;  anxious\nhappy', { max: 3 }), ['calm', 'tired', 'anxious']);
  assert.deepEqual(normalizeLabels([1, null, {}, 'ok'], { max: 5 }), ['ok']);
  assert.deepEqual(normalizeLabels(undefined, { max: 5 }), []);
  assert.deepEqual(normalizeLabels(['a', 'b', 'c'], { max: 2 }), ['a', 'b']);
  assert.deepEqual(normalizeLabels(['  ', '...', '#'], { max: 5 }), []);
  assert.deepEqual(normalizeLabels(['Über', 'ÜBER', 'naïve'], { max: 5 }), ['über', 'naïve']);
  assert.ok(!lone(normalizeLabels(['😀'.repeat(30)], { max: 1, maxLen: 5 })[0] || ''));
});

test('extractKeywords: stopwords, ranking, limits, languages', () => {
  const text = 'Today I felt really stressed about the project deadline at work. The project is late and my manager keeps asking about the deadline.';
  const kw = extractKeywords(text, { max: 4 });
  assert.deepEqual(kw.slice(0, 2), ['project', 'deadline']);
  assert.ok(!kw.includes('the') && !kw.includes('about') && !kw.includes('today'));
  assert.ok(kw.length <= 4);
  assert.deepEqual(extractKeywords('', { max: 5 }), []);
  assert.deepEqual(extractKeywords('the and of to in', { max: 5 }), []);
  assert.deepEqual(extractKeywords('123 4567 $$$ ... 2026', { max: 5 }), []);
  assert.deepEqual(extractKeywords(null), []);
  assert.deepEqual(extractKeywords('mi hermana Carmen y el trabajo nuevo, el trabajo me cansa', { max: 3 }), ['trabajo', 'hermana', 'carmen']);
  assert.ok(extractKeywords('Ich habe heute mit meiner Schwester über die Arbeit gesprochen').includes('schwester'));
  assert.ok(!extractKeywords('Ich habe heute mit meiner Schwester über die Arbeit gesprochen').includes('die'));
  assert.ok(extractKeywords('Nous avons parlé de ma soeur et du travail').includes('soeur'));
  assert.ok(extractKeywords("Maya's birthday party").includes('maya'), 'possessive s is stripped');
});

test('extractKeywords: ties keep first appearance, max is clamped, huge input is bounded', () => {
  assert.deepEqual(extractKeywords('zebra apple mango', { max: 3 }), ['zebra', 'apple', 'mango']);
  assert.equal(extractKeywords('alpha beta gamma delta', { max: 0 }).length >= 1, true);
  assert.equal(extractKeywords('alpha beta gamma delta', { max: 1 }).length, 1);
  const t0 = Date.now();
  const kw = extractKeywords('word '.repeat(5) + 'gardening '.repeat(300_000), { max: 3 });
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(kw.includes('gardening'));
});

test('extractKeywords: CJK is segmented', () => {
  const kw = extractKeywords('今日は友達と公園で散歩をしました。公園はとてもきれいでした。', { max: 5 });
  assert.ok(kw.length > 0);
  assert.ok(kw.every((w) => Array.from(w).length >= 2));
});

test('splitSentences and firstSentences', () => {
  assert.deepEqual(splitSentences('One. Two! Three? Four'), ['One.', 'Two!', 'Three?', 'Four']);
  assert.deepEqual(splitSentences('Dr. Lee called. I answered.'), ['Dr. Lee called.', 'I answered.']);
  assert.deepEqual(splitSentences('line one\nline two'), ['line one', 'line two']);
  assert.deepEqual(splitSentences('今日は晴れ。明日は雨。'), ['今日は晴れ。', '明日は雨。']);
  assert.deepEqual(splitSentences(''), []);
  assert.equal(firstSentences('Ugh. I really did not want to go to the meeting today. Then lunch.', { minChars: 40 }), 'Ugh. I really did not want to go to the meeting today.');
  assert.equal(firstSentences('A long enough first sentence to stand alone. Second.', { minChars: 10 }), 'A long enough first sentence to stand alone.');
  assert.ok(Array.from(firstSentences('x'.repeat(500), { maxChars: 50 })).length <= 50);
  assert.equal(firstSentences('', {}), '');
});

test('cleanText keeps joiners and direction marks (Persian, Indic, emoji families) but strips other invisible characters', () => {
  const persian = 'کتاب‌خانه'; // ZWNJ is part of the spelling
  assert.equal(cleanText(persian), persian);
  assert.equal(oneLine(`  ${persian}  `), persian);
  const hindi = 'क्‍ष';
  assert.equal(cleanText(hindi), hindi);
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
  assert.equal(cleanText(family), family);
  assert.equal(cleanText('a‎b‏c'), 'a‎b‏c', 'LRM / RLM');
  assert.equal(cleanText('a​b⁠c﻿d‪e‮f⁤g'), 'abcdefg', 'zero-width space, word joiner, BOM, bidi overrides');
  assert.deepEqual(normalizeLabels(['کتاب‌خانه']), ['کتاب‌خانه']);
});

test('cleanText, oneLine and capitalize', () => {
  assert.equal(cleanText('a\r\nb\u0000c​d\u0007'), 'a\nbcd');
  assert.equal(cleanText(5), '');
  assert.equal(oneLine('  a \n\t b  '), 'a b');
  assert.equal(capitalize('élan'), 'Élan');
  assert.equal(capitalize('😀 hi'), '😀 hi');
  assert.equal(capitalize(''), '');
});
