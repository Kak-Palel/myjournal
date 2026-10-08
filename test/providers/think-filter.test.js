import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThinkFilter, stripThinkBlocks } from '../../src/providers/think-filter.js';

/** Run the filter over `chunks`; returns the joined output, the per-push outputs and the end() result. */
function run(chunks) {
  const f = createThinkFilter();
  const pieces = chunks.map((c) => f.push(c));
  const tail = f.end();
  return { text: pieces.join('') + tail.text, pieces, unterminated: tail.unterminated, visible: f.hasVisibleText };
}

/** Every way of cutting `s` into two chunks, plus one char at a time. */
function* splits(s) {
  yield [s];
  for (let i = 0; i <= s.length; i += 1) yield [s.slice(0, i), s.slice(i)];
  yield Array.from(s);
}

const CASES = [
  // [name, input, expected visible text, expected unterminated]
  ['plain text', 'Hello, world.', 'Hello, world.', false],
  ['simple block', '<think>reasoning here</think>Answer', 'Answer', false],
  ['whitespace after a removed block is trimmed', '<think>r</think>\n\n  Answer', 'Answer', false],
  ['whitespace before a block is kept, after it trimmed', 'Before <think>x</think> after', 'Before after', false],
  ['<thinking> and <reasoning>', '<thinking>a</thinking>B <reasoning>c</reasoning>D', 'B D', false],
  ['case-insensitive tags', '<THINK>x</Think>Y', 'Y', false],
  ['two blocks', '<think>a</think>X<think>b</think>Y', 'XY', false],
  ['block in the middle of a sentence', 'I think <think>hmm</think>so.', 'I think so.', false],
  ['inequality in prose', 'a < b and c > d', 'a < b and c > d', false],
  ['less-than-three', 'I <3 this', 'I <3 this', false],
  ['shift operator', '1 << 2 is 4', '1 << 2 is 4', false],
  ['html-ish text that is not a think tag', 'Use <b>bold</b> and <thinker>x</thinker> and <think-tank>.', 'Use <b>bold</b> and <thinker>x</thinker> and <think-tank>.', false],
  ['tag-like with attributes is not a think tag', '<think foo="1">x</think>', '<think foo="1">x</think>', false],
  ['prefix of a tag at the very end of the stream', 'maybe <thi', 'maybe <thi', false],
  ['lone < at the end of the stream', 'x <', 'x <', false],
  ['complete open tag name without > at the end', 'x <think', 'x <think', false],
  ['< before a real block', '<<think>x</think>y', '<y', false],
  ['stray closing tag is left alone', 'a </think> b', 'a </think> b', false],
  ['</thinking> inside a <think> block does not close it', '<think></thinking>still thinking</think>done', 'done', false],
  ['first close wins over a nested open', '<think>a<think>b</think>c', 'c', false],
  ['emoji and CJK around a block', '日本語 😀<think>考え</think>😀 end', '日本語 😀😀 end', false],
  ['unterminated block, nothing before', '<think>never closed', '', true],
  ['unterminated block after text', 'Intro <think>never closed', 'Intro ', true],
  ['empty block', '<think></think>Hi', 'Hi', false],
  ['only whitespace after block at end', '<think>x</think>   ', '', false],
];

for (const [name, input, expected, unterminated] of CASES) {
  test(`think filter: ${name} (identical at every split)`, () => {
    for (const chunks of splits(input)) {
      const r = run(chunks);
      assert.equal(r.text, expected, `chunks ${JSON.stringify(chunks)}`);
      assert.equal(r.unterminated, unterminated, `unterminated for ${JSON.stringify(chunks)}`);
    }
  });
}

test('a possible tag prefix is held back and released on mismatch', () => {
  const f = createThinkFilter();
  assert.equal(f.push('Hi <reasonin'), 'Hi ');
  assert.equal(f.push('x there'), '<reasoninx there');
  const g = createThinkFilter();
  assert.equal(g.push('<thi'), '');
  assert.equal(g.push('nk>hidden</thi'), '');
  assert.equal(g.push('nk>shown'), 'shown');
  assert.equal(g.end().text, '');
});

test('at most a few characters are ever held back', () => {
  const f = createThinkFilter();
  const out = f.push('word <reasoning');
  assert.equal(out, 'word ');
  assert.equal('<reasoning'.length, 10);
  assert.equal(f.end().text, '<reasoning');
});

test('a long run of hidden reasoning does not accumulate memory-visible output', () => {
  const f = createThinkFilter();
  assert.equal(f.push('<think>'), '');
  for (let i = 0; i < 1000; i += 1) assert.equal(f.push('blah blah '), '');
  assert.equal(f.push('</think>ok'), 'ok');
});

test('hasVisibleText reflects non-whitespace output only', () => {
  const f = createThinkFilter();
  assert.equal(f.hasVisibleText, false);
  f.push('  \n');
  assert.equal(f.hasVisibleText, false);
  f.push('x');
  assert.equal(f.hasVisibleText, true);
  const g = createThinkFilter();
  g.push('<think>only thoughts');
  assert.equal(g.inThink, true);
  assert.equal(g.end().unterminated, true);
  assert.equal(g.hasVisibleText, false);
});

test('an emoji split across two chunks is never emitted as a lone surrogate', () => {
  const f = createThinkFilter();
  const first = f.push('hi \ud83d');
  assert.equal(first, 'hi ');
  assert.equal(f.push('\ude00 there'), '😀 there');
  const g = createThinkFilter();
  assert.equal(g.push('x\ud83d'), 'x');
  assert.equal(g.end().text, '\ud83d'); // never completed: released at the end rather than lost
});

test('every output piece is well-formed unicode however the emoji text is chunked', () => {
  const text = '😀a😀<think>💭</think>😀b';
  for (const chunks of splits(text)) {
    const f = createThinkFilter();
    for (const c of chunks) assert.ok(f.push(c).isWellFormed());
    assert.ok(f.end().text.isWellFormed());
  }
});

test('stripThinkBlocks one-shot helper', () => {
  assert.equal(stripThinkBlocks('<think>x</think>\nHello'), 'Hello');
  assert.equal(stripThinkBlocks('no tags < here'), 'no tags < here');
  assert.equal(stripThinkBlocks('a <think>unterminated'), 'a ');
  assert.equal(stripThinkBlocks(undefined), '');
});
