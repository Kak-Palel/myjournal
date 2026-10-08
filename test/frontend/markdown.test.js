import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline } from '../../public/js/lib/markdown.js';

const text = (nodes) => nodes.map((n) => (n.t === 'text' ? n.v : n.t === 'br' ? '\n' : n.v ?? text(n.c))).join('');

test('plain text and paragraphs', () => {
  const blocks = parseMarkdown('Hello there.\n\nSecond paragraph\nsame paragraph.');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'p');
  assert.equal(text(blocks[1].inline), 'Second paragraph\nsame paragraph.');
});

test('bold, italic, code', () => {
  const nodes = parseInline('a **bold** and *it* and `x*y` end');
  assert.deepEqual(nodes.map((n) => n.t), ['text', 'strong', 'text', 'em', 'text', 'code', 'text']);
  assert.equal(nodes[5].v, 'x*y');
});

test('unbalanced markers stay literal', () => {
  assert.equal(text(parseInline('2 * 3 = 6 and **oops')), '2 * 3 = 6 and **oops');
  assert.equal(text(parseInline('snake_case_name stays')), 'snake_case_name stays');
  assert.equal(text(parseInline('a * b * c')), 'a * b * c');
});

test('links collapse to their label and never produce anchors', () => {
  const nodes = parseInline('see [the docs](https://evil.example/x) now');
  assert.equal(text(nodes), 'see the docs now');
  assert.ok(nodes.every((n) => n.t === 'text'));
});

test('HTML is just text', () => {
  const nodes = parseInline('<img src=x onerror=alert(1)> <script>alert(1)</script>');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].t, 'text');
  assert.match(nodes[0].v, /<script>/);
});

test('lists, headings, quotes, fences, rules', () => {
  const md = ['# Title', '', '- one', '- two **b**', '', '1. first', '2. second', '', '> quoted', '> more', '', '```js', 'const a = 1;', '```', '', '---'].join('\n');
  const blocks = parseMarkdown(md);
  assert.deepEqual(blocks.map((b) => b.type), ['h', 'ul', 'ol', 'quote', 'code', 'hr']);
  assert.equal(blocks[1].items.length, 2);
  assert.equal(blocks[2].start, 1);
  assert.equal(blocks[4].text, 'const a = 1;');
});

test('unterminated fence consumes the rest without throwing', () => {
  const blocks = parseMarkdown('```\nnever closed\nstill code');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'code');
});

test('pathological input stays fast and bounded', () => {
  const t0 = Date.now();
  parseMarkdown('*'.repeat(50_000));
  parseMarkdown('**a '.repeat(20_000));
  parseMarkdown('[a](b'.repeat(10_000));
  parseMarkdown('> '.repeat(5_000) + 'x');
  assert.ok(Date.now() - t0 < 2000, 'took too long');
});

test('CRLF and non-string input', () => {
  assert.equal(parseMarkdown('a\r\n\r\nb').length, 2);
  assert.deepEqual(parseMarkdown(null), []);
  assert.deepEqual(parseMarkdown(undefined), []);
});
