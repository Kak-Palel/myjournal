import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DbError } from '../../src/db/index.js';
import { fakeClock, memDb } from './helpers.js';

const invalid = (fn, field) => assert.throws(fn, (e) => e instanceof DbError && e.code === 'invalid' && (!field || e.field === field));
const seqs = (db, id) => db.messages.list(id).map((m) => m.seq);

test('add: Message shape, seq starts at 0, order by seq', () => {
  const db = memDb();
  const e = db.entries.create();
  const a = db.messages.add(e.id, { role: 'user', content: 'Hello there', meta: { foo: 1 } });
  const b = db.messages.add(e.id, { role: 'assistant', content: 'Hi! How are you?', meta: { kind: 'reply', provider: 'gemini', model: 'gemini-flash-latest' } });
  assert.deepEqual({ ...a, id: 'x', createdAt: 0, entryId: 'e' }, { id: 'x', entryId: 'e', seq: 0, role: 'user', content: 'Hello there', createdAt: 0, meta: { foo: 1 } });
  assert.equal(a.entryId, e.id);
  assert.equal(b.seq, 1);
  assert.deepEqual(b.meta, { kind: 'reply', provider: 'gemini', model: 'gemini-flash-latest' });
  assert.deepEqual(db.messages.list(e.id).map((m) => m.id), [a.id, b.id]);
  assert.deepEqual(db.messages.get(a.id), a);
  assert.equal(db.messages.get('nope'), null);
  assert.equal(db.messages.get(undefined), null);
  assert.deepEqual(db.messages.list('nope'), []);
  db.close();
});

test('add: updates the entry wordCount (user words only), messageCount, updatedAt', () => {
  const clock = fakeClock(1_000_000, 100);
  const db = memDb({ now: clock });
  const e = db.entries.create();
  const t0 = db.entries.get(e.id).updatedAt;
  db.messages.add(e.id, { role: 'user', content: 'one two  three\nfour' });
  let got = db.entries.get(e.id);
  assert.equal(got.wordCount, 4);
  assert.equal(got.messageCount, 1);
  assert.ok(got.updatedAt > t0);
  const t1 = got.updatedAt;
  db.messages.add(e.id, { role: 'assistant', content: 'a b c d e f g h i j' });
  got = db.entries.get(e.id);
  assert.equal(got.wordCount, 4, 'assistant words are not counted');
  assert.equal(got.messageCount, 2);
  assert.ok(got.updatedAt > t1, 'assistant messages still touch updatedAt');
  db.messages.add(e.id, { role: 'user', content: 'five' });
  assert.equal(db.entries.get(e.id).wordCount, 5);
  db.close();
});

test('add: word counting handles punctuation, emoji and CJK', () => {
  const db = memDb();
  const e = db.entries.create();
  db.messages.add(e.id, { role: 'user', content: "Well-known don't — ... 😀 !!! 3.5" });
  assert.equal(db.entries.get(e.id).wordCount, 3);
  const j = db.entries.create();
  db.messages.add(j.id, { role: 'user', content: '今日は天気が良いです' });
  assert.ok(db.entries.get(j.id).wordCount >= 3, 'CJK is segmented, not counted as one word');
  db.close();
});

test('add: the user message is searchable immediately', () => {
  const db = memDb();
  const e = db.entries.create({ title: 'Plain' });
  db.messages.add(e.id, { role: 'user', content: 'Quokkas are friendly' });
  assert.deepEqual(db.search('quokka').map((h) => h.entryId), [e.id]);
  db.messages.add(e.id, { role: 'assistant', content: 'Wombats are not searchable' });
  assert.equal(db.search('wombats').length, 0, 'assistant text is not indexed');
  db.close();
});

test('add: errors', () => {
  const db = memDb();
  const e = db.entries.create();
  assert.throws(() => db.messages.add('missing', { role: 'user', content: 'x' }), (err) => err instanceof DbError && err.code === 'not_found');
  invalid(() => db.messages.add(e.id, { role: 'system', content: 'x' }), 'role');
  invalid(() => db.messages.add(e.id, { role: 'user', content: 42 }), 'content');
  invalid(() => db.messages.add(e.id, { role: 'user' }), 'content');
  invalid(() => db.messages.add(e.id, { role: 'user', content: 'x'.repeat(200_001) }), 'content');
  invalid(() => db.messages.add(e.id, { role: 'user', content: 'x', meta: 'str' }), 'meta');
  invalid(() => db.messages.add(e.id, { role: 'user', content: 'x', meta: [] }), 'meta');
  invalid(() => db.messages.add(e.id, { role: 'user', content: 'x', createdAt: 'now' }), 'createdAt');
  invalid(() => db.messages.add(e.id, { role: 'user', content: 'x', id: 'a b' }), 'id');
  invalid(() => db.messages.add(e.id, null), 'message');
  assert.equal(db.messages.list(e.id).length, 0);
  assert.equal(db.entries.get(e.id).messageCount, 0);
  db.messages.add(e.id, { role: 'user', content: 'x', id: 'dup' });
  assert.throws(() => db.messages.add(e.id, { role: 'user', content: 'y', id: 'dup' }), (err) => err.code === 'conflict');
  assert.equal(db.messages.list(e.id).length, 1);
  db.close();
});

test('add: NUL characters are removed, unicode and emoji kept, large content ok', () => {
  const db = memDb();
  const e = db.entries.create();
  const m = db.messages.add(e.id, { role: 'user', content: 'a\u0000b 😀 日本語 Ω' });
  assert.equal(m.content, 'ab 😀 日本語 Ω');
  const big = db.messages.add(e.id, { role: 'user', content: 'word '.repeat(20_000) });
  assert.equal(big.content.length, 100_000);
  assert.equal(db.entries.get(e.id).wordCount, 20_003);
  db.close();
});

test('meta: hostile keys are removed, nesting and size are bounded', () => {
  const db = memDb();
  const e = db.entries.create();
  const hostile = JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}},"prototype":2,"ok":{"__proto__":{"deep":1},"fine":true},"list":[1,{"__proto__":1,"a":2}]}');
  const m = db.messages.add(e.id, { role: 'assistant', content: 'x', meta: hostile });
  assert.equal({}.polluted, undefined);
  assert.deepEqual(m.meta, { ok: { fine: true }, list: [1, { a: 2 }] });
  invalid(() => db.messages.add(e.id, { role: 'assistant', content: 'x', meta: { a: { b: { c: { d: { e: { f: 1 } } } } } } }), 'meta');
  invalid(() => db.messages.add(e.id, { role: 'assistant', content: 'x', meta: { big: 'x'.repeat(20_000) } }), 'meta');
  const clean = db.messages.add(e.id, { role: 'assistant', content: 'x', meta: { n: Infinity, u: undefined, f() {}, d: new Date(0) } });
  assert.deepEqual(clean.meta, { n: null, d: {} });
  db.close();
});

test('deleting a middle message never renumbers; seq stays unique and ordered', () => {
  const db = memDb();
  const e = db.entries.create();
  const m = [0, 1, 2, 3, 4].map((i) => db.messages.add(e.id, { role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  assert.equal(db.messages.delete(m[2].id), true);
  assert.equal(db.messages.delete(m[2].id), false);
  assert.deepEqual(seqs(db, e.id), [0, 1, 3, 4]);
  assert.deepEqual(db.messages.list(e.id).map((x) => x.content), ['m0', 'm1', 'm3', 'm4']);
  const next = db.messages.add(e.id, { role: 'user', content: 'm5' });
  assert.equal(next.seq, 5);
  assert.deepEqual(seqs(db, e.id), [0, 1, 3, 4, 5]);
  assert.equal(db.entries.get(e.id).messageCount, 5);
  // deleting the first and the last, then appending
  db.messages.delete(m[0].id);
  db.messages.delete(next.id);
  assert.equal(db.messages.add(e.id, { role: 'user', content: 'again' }).seq, 5, 'max+1 of the remaining messages');
  assert.deepEqual(seqs(db, e.id), [1, 3, 4, 5]);
  db.close();
});

test('delete keeps wordCount and the search index consistent', () => {
  const db = memDb();
  const e = db.entries.create({ title: 'T' });
  const a = db.messages.add(e.id, { role: 'user', content: 'apples oranges' });
  const b = db.messages.add(e.id, { role: 'user', content: 'bananas' });
  assert.equal(db.entries.get(e.id).wordCount, 3);
  db.messages.delete(a.id);
  assert.equal(db.entries.get(e.id).wordCount, 1);
  assert.equal(db.search('apples').length, 0);
  assert.equal(db.search('bananas').length, 1);
  db.messages.delete(b.id);
  assert.equal(db.entries.get(e.id).wordCount, 0);
  assert.equal(db.search('bananas').length, 0);
  assert.deepEqual(db.search.checkConsistency().problems, []);
  db.close();
});

test('last / deleteLast', () => {
  const db = memDb();
  const e = db.entries.create();
  assert.equal(db.messages.last(e.id), null);
  assert.equal(db.messages.deleteLast(e.id), null);
  const a = db.messages.add(e.id, { role: 'user', content: 'question here' });
  const b = db.messages.add(e.id, { role: 'assistant', content: 'a reply', meta: { kind: 'reply' } });
  assert.deepEqual(db.messages.last(e.id), b);
  const removed = db.messages.deleteLast(e.id);
  assert.deepEqual(removed, b);
  assert.deepEqual(db.messages.last(e.id), a);
  assert.equal(db.entries.get(e.id).messageCount, 1);
  assert.equal(db.entries.get(e.id).wordCount, 2);
  // deleting the last USER message updates words and index
  db.messages.deleteLast(e.id);
  assert.equal(db.entries.get(e.id).wordCount, 0);
  assert.equal(db.search('question').length, 0);
  assert.equal(db.messages.add(e.id, { role: 'user', content: 'fresh' }).seq, 0);
  db.close();
});

test('last is the highest seq even after middle deletions; deleteLast then add reuses the seq', () => {
  const db = memDb();
  const e = db.entries.create();
  const ms = ['a', 'b', 'c'].map((c) => db.messages.add(e.id, { role: 'user', content: c }));
  db.messages.delete(ms[1].id);
  assert.equal(db.messages.last(e.id).content, 'c');
  db.messages.deleteLast(e.id);
  assert.equal(db.messages.last(e.id).content, 'a');
  assert.equal(db.messages.add(e.id, { role: 'assistant', content: 'z' }).seq, 1);
  db.close();
});

test('update: content replaces text, recounts words and reindexes', () => {
  const db = memDb();
  const e = db.entries.create();
  const m = db.messages.add(e.id, { role: 'user', content: 'tiny' });
  const u = db.messages.update(m.id, { content: 'a much longer rewritten message about pelicans' });
  assert.equal(u.content, 'a much longer rewritten message about pelicans');
  assert.equal(u.seq, m.seq);
  assert.equal(u.createdAt, m.createdAt);
  assert.equal(db.entries.get(e.id).wordCount, 7);
  assert.equal(db.search('tiny').length, 0);
  assert.equal(db.search('pelicans').length, 1);
  assert.deepEqual(db.search.checkConsistency().problems, []);
  assert.equal(db.messages.update('missing', { content: 'x' }), null);
  invalid(() => db.messages.update(m.id, { content: 5 }), 'content');
  invalid(() => db.messages.update(m.id, { meta: 'x' }), 'meta');
  invalid(() => db.messages.update(m.id, null), 'patch');
  db.close();
});

test('update: meta is merge-patched; null deletes a key; content and meta can change together', () => {
  const db = memDb();
  const e = db.entries.create();
  const m = db.messages.add(e.id, { role: 'assistant', content: 'partial te', meta: { kind: 'reply', provider: 'local', stopped: true } });
  const a = db.messages.update(m.id, { meta: { edited: true } });
  assert.deepEqual(a.meta, { kind: 'reply', provider: 'local', stopped: true, edited: true });
  const b = db.messages.update(m.id, { meta: { stopped: null }, content: 'complete text' });
  assert.deepEqual(b.meta, { kind: 'reply', provider: 'local', edited: true });
  assert.equal(b.content, 'complete text');
  assert.deepEqual(db.messages.update(m.id, {}), b, 'empty patch is a no-op');
  assert.equal(db.entries.get(e.id).wordCount, 0, 'assistant edits never change the word count');
  db.close();
});

test('update: assistant edits skip the index but still touch updatedAt', () => {
  const clock = fakeClock(5_000, 50);
  const db = memDb({ now: clock });
  const e = db.entries.create();
  const m = db.messages.add(e.id, { role: 'assistant', content: 'hello' });
  const before = db.entries.get(e.id).updatedAt;
  db.messages.update(m.id, { content: 'hello again' });
  assert.ok(db.entries.get(e.id).updatedAt > before);
  db.close();
});

test('messages are isolated per entry; seq restarts for each entry', () => {
  const db = memDb();
  const a = db.entries.create();
  const b = db.entries.create();
  db.messages.add(a.id, { role: 'user', content: 'a0' });
  db.messages.add(a.id, { role: 'user', content: 'a1' });
  const b0 = db.messages.add(b.id, { role: 'user', content: 'b0' });
  assert.equal(b0.seq, 0);
  assert.equal(db.messages.list(a.id).length, 2);
  assert.equal(db.messages.list(b.id).length, 1);
  db.close();
});

test('an exception inside add rolls back completely (no half-written entry state)', () => {
  const db = memDb();
  const e = db.entries.create();
  db.messages.add(e.id, { role: 'user', content: 'first message' });
  const before = db.entries.get(e.id);
  assert.throws(() => db.messages.add(e.id, { role: 'user', content: 'second', id: 'dup-id' }) && db.messages.add(e.id, { role: 'user', content: 'third', id: 'dup-id' }));
  const after = db.entries.get(e.id);
  assert.equal(after.messageCount, 2);
  assert.equal(after.wordCount, before.wordCount + 1);
  assert.deepEqual(db.search.checkConsistency().problems, []);
  db.close();
});
