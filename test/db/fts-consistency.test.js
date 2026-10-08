import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.js';
import { entryWith, memDb, rng, scratchDir } from './helpers.js';

function assertConsistent(db, label = '') {
  const report = db.search.checkConsistency();
  assert.deepEqual(report.problems, [], `${label}: ${report.problems.join('; ')}`);
  assert.equal(report.entries, report.indexed, `${label}: one search row per entry`);
}

// Ground truth: what a brute-force scan over the repositories says about a word.
function bruteForce(db, word) {
  const needle = word.toLowerCase();
  const out = new Set();
  for (const row of db.entries.rowsForInsights({})) {
    const entry = db.entries.get(row.id);
    const text = [entry.title, ...entry.tags, ...entry.emotions, ...db.messages.list(row.id).filter((m) => m.role === 'user').map((m) => m.content)].join(' ').toLowerCase();
    if (text.split(/[^\p{L}\p{N}]+/u).some((w) => w === needle)) out.add(row.id);
  }
  return out;
}

test('consistency: single operations keep the index in sync', () => {
  const db = memDb();
  assertConsistent(db, 'empty');
  const e = db.entries.create({ title: 'Alpha' });
  assertConsistent(db, 'create');
  const m1 = db.messages.add(e.id, { role: 'user', content: 'first' });
  assertConsistent(db, 'add user');
  const m2 = db.messages.add(e.id, { role: 'assistant', content: 'reply' });
  assertConsistent(db, 'add assistant');
  db.messages.update(m1.id, { content: 'edited' });
  assertConsistent(db, 'update user');
  db.messages.update(m2.id, { content: 'edited reply' });
  assertConsistent(db, 'update assistant');
  db.entries.update(e.id, { title: 'Beta', tags: ['t'], emotions: ['e'] });
  assertConsistent(db, 'metadata');
  db.messages.deleteLast(e.id);
  assertConsistent(db, 'deleteLast');
  db.messages.delete(m1.id);
  assertConsistent(db, 'delete');
  db.entries.delete(e.id);
  assertConsistent(db, 'entry delete');
  assert.equal(db.handle.prepare('SELECT COUNT(*) AS n FROM entry_search').get().n, 0);
  db.close();
});

test('consistency: rolled back transactions leave the index untouched', () => {
  const db = memDb();
  const e = entryWith(db, ['stable text']);
  assert.throws(() =>
    db.tx(() => {
      db.messages.add(e.id, { role: 'user', content: 'phantom words' });
      db.entries.update(e.id, { title: 'Phantom title' });
      db.entries.create({ title: 'Phantom entry' });
      throw new Error('abort');
    }),
  );
  assert.equal(db.search('phantom').length, 0);
  assert.equal(db.search('stable').length, 1);
  assertConsistent(db, 'after rollback');
  db.close();
});

test('consistency: random operation sequences always match a brute-force scan', () => {
  const db = memDb();
  const rand = rng(77);
  const words = ['apple', 'banana', 'cherry', 'delta', 'écho', 'fjord', 'golf', '日本語', 'hotel', 'india'];
  const sentence = () => Array.from({ length: 1 + rand.int(6) }, () => rand.pick(words)).join(' ');
  const live = [];
  for (let step = 0; step < 600; step++) {
    const op = rand.int(10);
    if (op === 0 || live.length === 0) {
      live.push(db.entries.create({ title: rand.int(2) ? sentence() : '', tags: [rand.pick(words)], date: '2026-10-08' }).id);
    } else if (op <= 3) {
      const id = rand.pick(live);
      db.messages.add(id, { role: rand.int(3) ? 'user' : 'assistant', content: sentence() });
    } else if (op === 4) {
      const id = rand.pick(live);
      const msgs = db.messages.list(id);
      if (msgs.length) db.messages.update(rand.pick(msgs).id, { content: sentence() });
    } else if (op === 5) {
      const id = rand.pick(live);
      const msgs = db.messages.list(id);
      if (msgs.length) db.messages.delete(rand.pick(msgs).id);
    } else if (op === 6) {
      db.messages.deleteLast(rand.pick(live));
    } else if (op === 7) {
      db.entries.update(rand.pick(live), { title: sentence(), tags: [rand.pick(words), rand.pick(words)], emotions: [rand.pick(words)] });
    } else if (op === 8 && live.length > 3) {
      const idx = rand.int(live.length);
      db.entries.delete(live[idx]);
      live.splice(idx, 1);
    } else if (op === 9) {
      db.entries.update(rand.pick(live), { private: rand.int(2) === 1, pinned: rand.int(2) === 1 });
    }
    if (step % 100 === 99) assertConsistent(db, `step ${step}`);
  }
  assertConsistent(db, 'end');
  for (const word of words.filter((w) => !/[^\x00-\x7f]/.test(w))) {
    const expected = bruteForce(db, word);
    const got = new Set(db.search(word, { mode: 'any', includePrivate: true, limit: 100 }).map((h) => h.entryId));
    assert.deepEqual(got, expected, `search("${word}") disagrees with a full scan`);
  }
  db.close();
});

test('consistency: reindexAll repairs a damaged index (missing, stale and orphan rows) and word counts', () => {
  const db = memDb();
  const a = entryWith(db, ['alpha words here'], { title: 'A' });
  const b = entryWith(db, ['beta words here'], { title: 'B' });
  entryWith(db, ['gamma words here'], { title: 'C' });
  assertConsistent(db, 'baseline');

  // damage: remove a row, make another stale, add an orphan, corrupt a cached word count
  db.handle.exec(`DELETE FROM entry_search WHERE entry_id = '${a.id}'`);
  db.handle.exec(`UPDATE entry_search SET body = 'stale nonsense' WHERE entry_id = '${b.id}'`);
  db.handle.exec(`INSERT INTO entry_search (rowid, entry_id, title, body, tags) VALUES (99999, 'ghost', 'ghost', 'ghost body', '')`);
  db.handle.exec(`UPDATE entries SET word_count = 999 WHERE id = '${b.id}'`);
  const problems = db.search.checkConsistency().problems;
  assert.ok(problems.some((p) => p.includes('stale word count')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('no search row')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('stale body')));
  assert.ok(problems.some((p) => p.includes('orphan')));
  assert.equal(db.search('ghost', { includePrivate: true }).length, 0, 'orphans never surface because they join to no entry');

  assert.equal(db.search.reindexAll(), 3);
  assertConsistent(db, 'repaired');
  assert.equal(db.entries.get(b.id).wordCount, 3);
  assert.equal(db.search('alpha').length, 1);
  assert.equal(db.search('stale').length, 0);
  assert.equal(db.search('beta').length, 1);
  assert.equal(db.search('ghost').length, 0);
  db.close();
});

test('consistency: the index is rebuilt automatically at open when its size disagrees', () => {
  const t = scratchDir('selfheal');
  try {
    let db = openDb({ file: t.file });
    entryWith(db, ['persisted words'], { title: 'One' });
    entryWith(db, ['more persisted words'], { title: 'Two' });
    db.handle.exec('DELETE FROM entry_search');
    assert.equal(db.search('persisted').length, 0, 'damage is real');
    db.close();
    db = openDb({ file: t.file });
    assert.equal(db.search('persisted').length, 2);
    assertConsistent(db, 'after reopen');
    db.close();
  } finally {
    t.cleanup();
  }
});

test('consistency: import, export round trip and wipe', () => {
  const src = memDb();
  entryWith(src, ['moonlight sonata', 'second thought'], { title: 'Music', tags: ['piano'] }, { withAssistant: true });
  entryWith(src, ['river walk'], { title: 'Walk', emotions: ['peaceful'] });
  const dump = JSON.parse(JSON.stringify(src.exportAll()));

  const dst = memDb();
  entryWith(dst, ['existing words'], { title: 'Existing' });
  dst.importAll(dump);
  assertConsistent(dst, 'after import');
  assert.equal(dst.search('moonlight').length, 1);
  assert.equal(dst.search('piano').length, 1);
  assert.equal(dst.search('peaceful').length, 1);
  assert.equal(dst.search('existing').length, 1);

  dst.wipe();
  assertConsistent(dst, 'after wipe');
  assert.equal(dst.search('moonlight').length, 0);
  assert.equal(dst.handle.prepare('SELECT COUNT(*) AS n FROM entry_search').get().n, 0);
  // the database is fully usable after a wipe
  entryWith(dst, ['fresh start'], { title: 'New' });
  assert.equal(dst.search('fresh').length, 1);
  assertConsistent(dst, 'after reuse');
  src.close();
  dst.close();
});

test('consistency: word counts equal the sum over user messages after every kind of change', () => {
  const db = memDb();
  const e = db.entries.create();
  const check = () => {
    const expected = db.messages
      .list(e.id)
      .filter((m) => m.role === 'user')
      .reduce((n, m) => n + m.content.split(/\s+/).filter(Boolean).length, 0);
    assert.equal(db.entries.get(e.id).wordCount, expected);
  };
  const a = db.messages.add(e.id, { role: 'user', content: 'one two three' });
  check();
  const b = db.messages.add(e.id, { role: 'assistant', content: 'x y z w' });
  check();
  db.messages.add(e.id, { role: 'user', content: 'four five' });
  check();
  db.messages.update(a.id, { content: 'just one' });
  check();
  db.messages.delete(b.id);
  check();
  db.messages.deleteLast(e.id);
  check();
  db.close();
});
