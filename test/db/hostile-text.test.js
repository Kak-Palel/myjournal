// Text that SQLite stores differently from what JavaScript holds (NUL, lone surrogates) must be
// cleaned before it is stored AND before it is compared with the search index; and a multi-megabyte
// string in an import file must be rejected or cut without chewing through seconds and gigabytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DbError } from '../../src/db/index.js';
import { cleanLine, exceedsChars, normalizeLabels, truncateChars } from '../../src/db/util.js';
import { entryWith, memDb, rng } from './helpers.js';

const consistent = (db) => assert.deepEqual(db.search.checkConsistency().problems, []);

// ---- NUL and control characters ----------------------------------------------------------------

test('entries: NUL and control characters are removed from title, summary, tags and emotions', () => {
  const db = memDb();
  const e = db.entries.create({ title: 'ti\u0000tle\u0007!', summary: 'before\u0000after\u0001', tags: ['a\u0000b', '\u0000', 'work\u0000'], emotions: 'ca\u0000lm, \u0000' });
  assert.equal(e.title, 'title!');
  assert.equal(e.summary, 'beforeafter');
  assert.deepEqual(e.tags, ['ab', 'work']);
  assert.deepEqual(e.emotions, ['calm']);
  consistent(db);

  const u = db.entries.update(e.id, { summary: 'x\u0000y\nsecond\tline', tags: ['q\u0000r'], emotions: ['\u0000sad'] });
  assert.equal(u.summary, 'xy\nsecond\tline', 'newlines and tabs survive in summaries');
  assert.deepEqual(u.tags, ['qr']);
  assert.deepEqual(u.emotions, ['sad']);
  assert.equal(db.search('qr', { includePrivate: true }).length, 1, 'the cleaned tag is what gets indexed');
  assert.equal(db.entries.list({ tag: 'qr' }).length, 1);
  consistent(db);
  db.close();
});

test('entries: lone surrogates in labels do not make the index permanently stale', () => {
  const db = memDb();
  const e = db.entries.create({ tags: ['a\ud83db', '\ude00x'] });
  assert.deepEqual(e.tags, ['a�b', '�x']);
  consistent(db);
  db.search.reindexAll();
  consistent(db);
  db.close();
});

test('memories: NUL and control characters are removed, so exists() agrees with what is stored', () => {
  const db = memDb();
  const m = db.memories.create({ text: 'Has a sister\u0000 called Maya\u0001' });
  assert.equal(m.text, 'Has a sister called Maya');
  assert.equal(db.memories.exists('Has a sister\u0000 called Maya'), true);
  assert.equal(db.memories.exists('has a sister called maya.'), true);
  assert.equal(db.memories.create({ text: 'a \u0000 b' }).text, 'a b', 'no double space is left behind');
  assert.throws(() => db.memories.create({ text: '\u0000\u0000 ' }), (err) => err instanceof DbError && err.field === 'text');
  const u = db.memories.update(m.id, { text: 'Likes\u0000 tea' });
  assert.equal(u.text, 'Likes tea');
  assert.equal(db.memories.exists('likes tea'), true);
  db.close();
});

test('import: NUL and control characters are cleaned in titles, summaries, labels and memories', () => {
  const db = memDb();
  const result = db.importAll({
    app: 'myjournal',
    version: 1,
    entries: [
      { id: 'e1', createdAt: 1_760_000_000_000, title: 'Ti\u0000tle', summary: 'sum\u0000mary', tags: ['x\u0000y', '\u0000'], emotions: ['ca\u0000lm'] },
      { id: 'e2', createdAt: 1_760_000_000_001, tags: ['a\ud83db'] },
    ],
    memories: [{ id: 'm1', text: 'keep\u0000 this\u0002', createdAt: 1_760_000_000_000 }],
  });
  assert.deepEqual(result.imported, { entries: 2, messages: 0, memories: 1, reports: 0 });
  const e1 = db.entries.get('e1');
  assert.equal(e1.title, 'Title');
  assert.equal(e1.summary, 'summary');
  assert.deepEqual(e1.tags, ['xy']);
  assert.deepEqual(e1.emotions, ['calm']);
  assert.equal(db.memories.get('m1').text, 'keep this');
  assert.equal(db.memories.exists('keep this'), true);
  consistent(db);
  db.close();
});

test('cleanLine strips controls before collapsing whitespace and keeps ordinary text intact', () => {
  assert.equal(cleanLine('  a \u0000 b\t\n c\u000bd  '), 'a b c d');
  assert.equal(cleanLine('日本語 😀 café'), '日本語 😀 café');
  assert.equal(cleanLine('x\ud83d'), 'x�');
});

test('fuzz: hostile characters in any text field never leave the index inconsistent', () => {
  const db = memDb();
  const next = rng(20261008);
  const pool = ['a', 'b', 'é', '日', '😀', ' ', ',', '#', '\u0000', '\u0001', '\u0007', '\u007f', '\ud83d', '\ude00', '\u200b', '\u0301', '\t', '\n', '\u000b', '"', "'", '%'];
  const text = () => Array.from({ length: Math.floor(next() * 14) }, () => pool[Math.floor(next() * pool.length)]).join('');
  const list = () => Array.from({ length: Math.floor(next() * 4) }, text);
  for (let i = 0; i < 300; i++) {
    const e = db.entries.create({ title: text(), summary: text(), tags: list(), emotions: next() < 0.5 ? list() : text() });
    db.messages.add(e.id, { role: 'user', content: text() || 'x' });
    if (next() < 0.5) db.entries.update(e.id, { tags: list(), title: text(), summary: text() });
    if (next() < 0.3) db.memories.create({ text: `m${text()}` });
    if (next() < 0.2) db.entries.delete(e.id);
  }
  db.importAll({
    app: 'myjournal',
    entries: Array.from({ length: 100 }, (_, i) => ({ id: `imp-${i}`, createdAt: 1_760_000_000_000 + i, title: text(), summary: text(), tags: list(), emotions: list(), messages: [] })),
    memories: Array.from({ length: 50 }, (_, i) => ({ id: `impm-${i}`, createdAt: 1_760_000_000_000 + i, text: `m${text()}` })),
  });
  consistent(db);
  for (const memory of db.memories.list()) assert.equal(db.memories.exists(memory.text), true, JSON.stringify(memory.text));
  for (const entry of db.entries.list({ limit: 200 })) {
    for (const label of [...entry.tags, ...entry.emotions]) {
      assert.ok(!/[\u0000-\u0008\u000e-\u001f\u007f]/.test(label) && label === label.toWellFormed(), JSON.stringify(label));
    }
  }
  db.close();
});

// ---- huge strings ------------------------------------------------------------------------------

const fast = (label, fn, maxMs = 1500) => {
  const t = performance.now();
  const result = fn();
  const took = performance.now() - t;
  assert.ok(took < maxMs, `${label} took ${took.toFixed(0)} ms (limit ${maxMs})`);
  return result;
};

test('truncateChars / exceedsChars are exact and cheap on huge input', () => {
  assert.equal(truncateChars('abc', 5), 'abc');
  assert.equal(truncateChars('abcdef', 3), 'abc');
  assert.equal(truncateChars('a' + '😀'.repeat(100), 3), 'a😀😀', 'never splits a surrogate pair');
  assert.equal(truncateChars('😀'.repeat(100), 5), '😀'.repeat(5));
  assert.equal(truncateChars('x'.repeat(31) + '😀'.repeat(10), 32), 'x'.repeat(31) + '😀');
  assert.equal(exceedsChars('😀'.repeat(300), 300), false, '300 emoji are 300 characters');
  assert.equal(exceedsChars('😀'.repeat(301), 300), true);
  assert.equal(exceedsChars('x'.repeat(300), 300), false);
  assert.equal(exceedsChars('x'.repeat(301), 300), true);
  const huge = 'x'.repeat(30_000_000);
  assert.equal(fast('truncateChars', () => truncateChars(huge, 24)), 'x'.repeat(24));
  assert.equal(fast('exceedsChars', () => exceedsChars(huge, 300)), true);
});

test('normalizeLabels: a huge label is cut quickly; ordinary labels behave as before', () => {
  const huge = fast('no whitespace', () => normalizeLabels(['x'.repeat(30_000_000)], { max: 8 }));
  assert.deepEqual(huge, ['x'.repeat(24)]);
  const spaced = fast('lots of whitespace', () => normalizeLabels(['a b '.repeat(5_000_000)], { max: 8 }));
  assert.deepEqual(spaced, ['a b a b a b a b a b a b']);
  assert.deepEqual(normalizeLabels(['  ##Work  Stuff ', 'work stuff', '#', 'CALM', 7, null], { max: 5 }), ['work stuff', 'calm']);
  assert.deepEqual(normalizeLabels('a, b ,A,,c', { max: 2 }), ['a', 'b']);
  assert.deepEqual(normalizeLabels(['x'.repeat(40)], { max: 5, maxLen: 10 }), ['x'.repeat(10)]);
});

test('import: a giant memory text or tag is rejected / cut in milliseconds, not seconds', () => {
  const db = memDb();
  const spaced = 'a '.repeat(10_000_000);
  const result = fast('giant memory', () => db.importAll({ app: 'myjournal', memories: [{ id: 'm1', text: spaced, createdAt: 1 }] }));
  assert.deepEqual(result.imported, { entries: 0, messages: 0, memories: 0, reports: 0 });
  assert.equal(result.skipped, 1);
  const plain = fast('giant plain memory', () => db.importAll({ app: 'myjournal', memories: [{ id: 'm2', text: 'x'.repeat(30_000_000), createdAt: 1 }] }));
  assert.equal(plain.skippedDetail.invalid, 1);

  const tag = fast('giant tag', () => db.importAll({ app: 'myjournal', entries: [{ id: 'e1', createdAt: 1, tags: ['t'.repeat(30_000_000), spaced] }] }));
  assert.equal(tag.imported.entries, 1);
  assert.deepEqual(db.entries.get('e1').tags, ['t'.repeat(24), 'a a a a a a a a a a a a']);
  consistent(db);
  db.close();
});

test('memories.create rejects an over-long raw text without scanning it', () => {
  const db = memDb();
  for (const text of ['x'.repeat(5000), `${' '.repeat(5000)}short`, 'a '.repeat(2_000_000)]) {
    assert.throws(() => fast('create', () => db.memories.create({ text })), (err) => err instanceof DbError && err.code === 'invalid' && err.field === 'text');
  }
  assert.equal(db.memories.create({ text: `${' '.repeat(300)}padded${' '.repeat(300)}` }).text, 'padded', 'ordinary padding is fine');
  assert.equal(db.memories.create({ text: '😀'.repeat(300) }).text.length, 600);
  entryWith(db, ['unrelated'], {});
  db.close();
});
