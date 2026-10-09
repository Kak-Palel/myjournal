// A model (or whatever answers at the configured address) can send anything. The parsers that read its text must take
// time proportional to its length: a 40,000-character line of `*` once kept the single-threaded server busy for 17 s
// (and a 1 MB answer for hours), because several regexes retry from every position of a long run of one character.
// Each input below took seconds to hours before the fix and takes a few milliseconds now; the budget is generous.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanReply, parseMemoryLines, parseMeta, stripThinking } from '../../src/journal/tasks.js';
import { firstSentences, normalizeLabels, splitSentences } from '../../src/journal/text.js';
import { dropSecondQuestion } from '../../src/server/generation.js';

const BUDGET_MS = 2000;

function within(fn, what) {
  const started = performance.now();
  const result = fn();
  const took = performance.now() - started;
  assert.ok(took < BUDGET_MS, `${what} took ${Math.round(took)} ms (budget ${BUDGET_MS} ms)`);
  return result;
}

describe('hostile model output is parsed in linear time', () => {
  it('parseMeta: a huge line of emphasis marks', () => {
    for (const mark of ['*', '_', '**']) {
      const out = within(() => parseMeta(mark.repeat(40_000), { userText: 'I felt calm today.', firstMessage: 'I felt calm today.' }), `parseMeta(${mark} x 40000)`);
      assert.equal(typeof out.title, 'string');
      assert.equal(out.summary, 'I felt calm today.', 'falls back to the person\'s own text');
    }
    within(() => parseMeta(`Title: ${'*'.repeat(40_000)}`, { userText: 'x' }), 'parseMeta(Title + stars)');
    within(() => parseMeta(`${' '.repeat(40_000)}?`, { userText: 'x' }), 'parseMeta(spaces)');
  });

  it('parseMeta: a megabyte of text still reads the labelled lines at the top', () => {
    const answer = `Title: A calm walk\nSummary: A slow walk in the rain.\nEmotions: calm\nTags: walking\n${'*'.repeat(1_000_000)}`;
    const out = within(() => parseMeta(answer, { userText: 'I walked in the rain.' }), 'parseMeta(1 MB)');
    assert.equal(out.title, 'A calm walk');
    assert.equal(out.summary, 'A slow walk in the rain.');
    assert.deepEqual(out.emotions, ['calm']);
    assert.deepEqual(out.tags, ['walking']);
  });

  it('parseMemoryLines: one long word, long runs of punctuation and of spaces', () => {
    for (const text of ['a'.repeat(120_000), `- ${'a'.repeat(120_000)}`, `x${'_'.repeat(120_000)}y`, `x${'.'.repeat(120_000)}y`, `x${' '.repeat(120_000)}y`, '1.'.repeat(60_000)]) {
      assert.deepEqual(within(() => parseMemoryLines(text, { userText: 'I live in Leeds.' }), `parseMemoryLines(${text.slice(0, 8)}...)`), []);
    }
    // thousands of bullet lines: only the first few are looked at
    const many = '- Works as a nurse in Leeds\n'.repeat(50_000);
    assert.deepEqual(within(() => parseMemoryLines(many, { userText: 'I work as a nurse in Leeds.' }), 'parseMemoryLines(50000 bullets)'), ['Works as a nurse in Leeds']);
  });

  it('cleanReply and stripThinking: thousands of unclosed reasoning tags, a long run of spaces', () => {
    assert.equal(within(() => cleanReply('<thought>'.repeat(111_111)), 'cleanReply(<thought> x 111111)'), '');
    assert.equal(within(() => cleanReply('<think x'.repeat(125_000)), 'cleanReply(<think x x 125000)'), '<think x'.repeat(125_000).trim());
    assert.equal(within(() => stripThinking(`Hello. ${'<think>'.repeat(100_000)}`), 'stripThinking'), 'Hello. ');
    const spaced = `x${' '.repeat(100_000)}y`;
    assert.equal(within(() => cleanReply(spaced), 'cleanReply(spaces)'), spaced);
    within(() => cleanReply(`${'*'.repeat(10)}${' '.repeat(100_000)}z`), 'cleanReply(role prefix lookalike)');
  });

  it('splitSentences, firstSentences and normalizeLabels: long runs of closing quotes, brackets and punctuation', () => {
    for (const run of ['"', '”', ']', ')', "'"]) {
      assert.equal(within(() => splitSentences(run.repeat(100_000)).length, `splitSentences(${run} x 100000)`), 1);
      within(() => firstSentences(run.repeat(100_000)), `firstSentences(${run} x 100000)`);
    }
    for (const run of ['.', '"', '*', '_', '-']) {
      within(() => normalizeLabels(`x${run.repeat(100_000)}y`), `normalizeLabels(${run} x 100000)`);
    }
    assert.deepEqual(within(() => normalizeLabels(`  ..."Calm"... ,  #work!! `), 'normalizeLabels'), ['calm', 'work']);
  });

  it('dropSecondQuestion: a reply whose last paragraph is a huge run of quotes', () => {
    const reply = `Are you ok?\n\n${'"'.repeat(100_000)}?`;
    const out = within(() => dropSecondQuestion(cleanReply(reply)), 'dropSecondQuestion(quotes)');
    assert.equal(typeof out, 'string');
    const spaced = `Are you ok?\n\n${' '.repeat(100_000)}?`;
    within(() => dropSecondQuestion(cleanReply(spaced)), 'dropSecondQuestion(spaces)');
  });
});

describe('the bounded parsers still read normal answers', () => {
  it('stripThinking keeps its behaviour', () => {
    assert.equal(stripThinking('a<think>x</think>b<THINKING attr="1">y</Thinking >c'), 'abc');
    assert.equal(stripThinking('<think>a<thought>b</think>c</thought>d'), 'd'); // the lone closing tag clears what precedes it
    assert.equal(stripThinking('keep <think>never closed'), 'keep ');
    assert.equal(stripThinking('<thinking>one</think>still open'), '');
    assert.equal(stripThinking('x</think>y'), 'y');
    assert.equal(stripThinking('<thinker>not a tag</thinker>'), '<thinker>not a tag</thinker>');
    assert.equal(stripThinking(42), '');
  });

  it('a label with many bullets and marks in front is still read, a wildly over-long prefix is not', () => {
    assert.equal(parseMeta('> **Title**: A calm walk', { userText: 'x' }).title, 'A calm walk');
    assert.equal(parseMeta('1. **Title:** A calm walk', { userText: 'x' }).title, 'A calm walk');
    assert.equal(parseMeta('- - - Title: A calm walk', { userText: 'x' }).title, 'A calm walk');
  });

  it('closing quotes still end a sentence', () => {
    assert.deepEqual(splitSentences('He said "stop." Then he left. (Really.) Yes.'), ['He said "stop."', 'Then he left.', '(Really.)', 'Yes.']);
  });

  it('a long first line is cut for the title and memory jobs', () => {
    const out = parseMeta(`Summary: ${'word '.repeat(5_000)}`, { userText: 'I felt calm today.' });
    assert.ok(out.summary.length <= 280, `summary length ${out.summary.length}`);
  });
});
