import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DbError } from '../../src/db/index.js';
import { entryWith, fakeClock, memDb } from './helpers.js';

const throwsInvalid = (fn, field) =>
  assert.throws(fn, (err) => err instanceof DbError && err.code === 'invalid' && (field === undefined || err.field === field), `expected invalid ${field ?? ''}`);

test('create: defaults and full Entry shape', () => {
  const db = memDb();
  const e = db.entries.create();
  assert.match(e.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    { ...e, id: 'x', createdAt: 0, updatedAt: 0, date: 'd' },
    {
      id: 'x',
      createdAt: 0,
      updatedAt: 0,
      date: 'd',
      title: '',
      kind: 'free',
      templateId: null,
      mood: null,
      emotions: [],
      tags: [],
      summary: '',
      status: 'open',
      private: false,
      pinned: false,
      wordCount: 0,
      messageCount: 0,
    },
  );
  assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(e.updatedAt, e.createdAt);
  db.close();
});

test('create: templateId implies guided; explicit fields are stored', () => {
  const db = memDb();
  const g = db.entries.create({ templateId: 'rose-thorn-bud' });
  assert.equal(g.kind, 'guided');
  assert.equal(g.templateId, 'rose-thorn-bud');
  const e = db.entries.create({
    title: '  Long   day \n',
    date: '2026-10-08',
    mood: 2,
    private: true,
    pinned: true,
    summary: 'A summary.',
    status: 'wrapped',
    emotions: ['Calm', 'calm', ' Anxious '],
    tags: ['#Work', 'work', 'Home Life'],
    createdAt: 1_700_000_000_000,
  });
  assert.deepEqual(
    { title: e.title, date: e.date, mood: e.mood, private: e.private, pinned: e.pinned, summary: e.summary, status: e.status, emotions: e.emotions, tags: e.tags, createdAt: e.createdAt },
    { title: 'Long day', date: '2026-10-08', mood: 2, private: true, pinned: true, summary: 'A summary.', status: 'wrapped', emotions: ['calm', 'anxious'], tags: ['work', 'home life'], createdAt: 1_700_000_000_000 },
  );
  db.close();
});

test('create: labels respect count and length limits', () => {
  const db = memDb();
  const e = db.entries.create({
    emotions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    tags: Array.from({ length: 20 }, (_, i) => `tag${i}`),
  });
  assert.equal(e.emotions.length, 5);
  assert.equal(e.tags.length, 8);
  const long = db.entries.create({ tags: ['x'.repeat(100), 42, null, '', '   '] });
  assert.deepEqual(long.tags, ['x'.repeat(24)]);
  db.close();
});

test('create: invalid values throw DbError(invalid) with the field name', () => {
  const db = memDb();
  throwsInvalid(() => db.entries.create({ mood: 0 }), 'mood');
  throwsInvalid(() => db.entries.create({ mood: 6 }), 'mood');
  throwsInvalid(() => db.entries.create({ mood: 2.5 }), 'mood');
  throwsInvalid(() => db.entries.create({ mood: '3' }), 'mood');
  throwsInvalid(() => db.entries.create({ kind: 'weird' }), 'kind');
  throwsInvalid(() => db.entries.create({ status: 'done' }), 'status');
  throwsInvalid(() => db.entries.create({ date: '2026-02-30' }), 'date');
  throwsInvalid(() => db.entries.create({ date: '10/08/2026' }), 'date');
  throwsInvalid(() => db.entries.create({ date: 20261008 }), 'date');
  throwsInvalid(() => db.entries.create({ title: 5 }), 'title');
  throwsInvalid(() => db.entries.create({ private: 'yes' }), 'private');
  throwsInvalid(() => db.entries.create({ pinned: null }), 'pinned');
  throwsInvalid(() => db.entries.create({ templateId: 'a b' }), 'templateId');
  throwsInvalid(() => db.entries.create({ id: '__proto__' }), 'id');
  throwsInvalid(() => db.entries.create({ id: 'has space' }), 'id');
  throwsInvalid(() => db.entries.create({ createdAt: -1 }), 'createdAt');
  throwsInvalid(() => db.entries.create({ createdAt: 1.5 }), 'createdAt');
  throwsInvalid(() => db.entries.create('nope'), 'fields');
  assert.equal(db.stats().entries, 0, 'failed creates leave nothing behind');
  db.close();
});

test('create: an explicit null date means "today"; update rejects it', () => {
  const db = memDb();
  const e = db.entries.create({ date: null });
  assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
  throwsInvalid(() => db.entries.update(e.id, { date: null }), 'date');
  db.close();
});

test('create: very long titles are cut, control characters removed', () => {
  const db = memDb();
  const e = db.entries.create({ title: `${'t'.repeat(1000)}\u0000` });
  assert.equal(e.title.length, 300);
  const f = db.entries.create({ title: 'a\u0007b\nc' });
  assert.equal(f.title, 'ab c');
  db.close();
});

test('create: duplicate id is a conflict', () => {
  const db = memDb();
  db.entries.create({ id: 'fixed-id' });
  assert.throws(() => db.entries.create({ id: 'fixed-id' }), (err) => err instanceof DbError && err.code === 'conflict');
  assert.equal(db.stats().entries, 1);
  db.close();
});

test('get / update: unknown ids give null, update changes only given fields and bumps updatedAt', () => {
  const clock = fakeClock(1000, 10);
  const db = memDb({ now: clock });
  assert.equal(db.entries.get('nope'), null);
  assert.equal(db.entries.get(undefined), null);
  assert.equal(db.entries.update('nope', { title: 'x' }), null);
  const e = db.entries.create({ title: 'Before', mood: 3, tags: ['a'] });
  const u = db.entries.update(e.id, { title: 'After', pinned: true, emotions: ['Joy'] });
  assert.equal(u.title, 'After');
  assert.equal(u.pinned, true);
  assert.deepEqual(u.emotions, ['joy']);
  assert.equal(u.mood, 3);
  assert.deepEqual(u.tags, ['a']);
  assert.ok(u.updatedAt > e.updatedAt);
  assert.equal(u.createdAt, e.createdAt);
  // mood can be cleared with null
  assert.equal(db.entries.update(e.id, { mood: null }).mood, null);
  // empty patch / unknown keys change nothing and do not bump
  const same = db.entries.update(e.id, {});
  const same2 = db.entries.update(e.id, { wordCount: 99, id: 'other', createdAt: 5, messageCount: 7 });
  assert.equal(same2.updatedAt, same.updatedAt);
  assert.equal(same2.wordCount, 0);
  assert.equal(same2.id, e.id);
  assert.equal(same2.createdAt, e.createdAt);
  throwsInvalid(() => db.entries.update(e.id, { mood: 9 }), 'mood');
  assert.equal(db.entries.get(e.id).mood, null, 'a failed update changes nothing');
  db.close();
});

test('update: wrap-up style patch (summary, status, title, labels) in one call', () => {
  const db = memDb();
  const e = db.entries.create();
  const u = db.entries.update(e.id, { title: 'Tired but proud', summary: 'You finished the project.', status: 'wrapped', emotions: ['tired', 'proud'], tags: ['work'] });
  assert.deepEqual([u.title, u.summary, u.status, u.emotions, u.tags], ['Tired but proud', 'You finished the project.', 'wrapped', ['tired', 'proud'], ['work']]);
  db.close();
});

test('delete: removes entry, messages and search row; unknown id returns false', () => {
  const db = memDb();
  const e = entryWith(db, ['alpha text', 'beta text'], { title: 'Doomed' });
  const keep = entryWith(db, ['alpha survivor'], { title: 'Keeper' });
  assert.equal(db.search('alpha').length, 2);
  assert.equal(db.entries.delete(e.id), true);
  assert.equal(db.entries.delete(e.id), false);
  assert.equal(db.entries.delete(undefined), false);
  assert.equal(db.entries.get(e.id), null);
  assert.deepEqual(db.messages.list(e.id), []);
  assert.deepEqual(db.search('alpha').map((h) => h.entryId), [keep.id]);
  assert.equal(db.handle.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  assert.deepEqual(db.search.checkConsistency().problems, []);
  db.close();
});

test('delete: memories keep existing but lose their source (ON DELETE SET NULL)', () => {
  const db = memDb();
  const e = db.entries.create({ title: 'Source' });
  const m = db.memories.create({ text: 'Has a sister called Maya', sourceEntryId: e.id });
  assert.equal(m.sourceEntryId, e.id);
  db.entries.delete(e.id);
  const after = db.memories.list();
  assert.equal(after.length, 1);
  assert.equal(after[0].text, 'Has a sister called Maya');
  assert.equal(after[0].sourceEntryId, null);
  db.close();
});

test('list: newest first, preview, messageCount, defaults include private', () => {
  const db = memDb();
  const a = entryWith(db, ['first   entry\n\nwith   odd   spacing'], { title: 'A' }, { withAssistant: true });
  const b = entryWith(db, ['second entry'], { title: 'B', private: true });
  const c = db.entries.create({ title: 'C no messages', templateId: 'gratitude' });
  db.messages.add(c.id, { role: 'assistant', content: 'What are you grateful for?' });
  db.messages.add(c.id, { role: 'user', content: 'My dog' });
  const rows = db.entries.list();
  assert.deepEqual(rows.map((r) => r.title), ['C no messages', 'B', 'A']);
  assert.equal(rows[2].preview, 'first entry with odd spacing');
  assert.equal(rows[2].messageCount, 2);
  assert.equal(rows[0].preview, 'My dog', 'preview is the first USER message, not the assistant opening');
  assert.equal(rows[1].private, true);
  assert.deepEqual(db.entries.list({ includePrivate: false }).map((r) => r.title), ['C no messages', 'A']);
  assert.equal(a.messageCount, 2);
  assert.equal(b.wordCount, 2);
  db.close();
});

test('list: preview is capped near 160 characters and never splits emoji', () => {
  const db = memDb();
  entryWith(db, ['😀'.repeat(400)]);
  entryWith(db, ['word '.repeat(100)]);
  const [long, emoji] = db.entries.list();
  assert.ok(long.preview.length <= 162 && long.preview.endsWith('…'));
  assert.ok(Array.from(emoji.preview).length <= 161);
  assert.ok(!/[\ud800-\udbff]$/.test(emoji.preview.replace(/…$/, '')), 'no dangling surrogate');
  db.close();
});

test('list: filters mood, tag (exact), from/to (inclusive), pinned', () => {
  const db = memDb();
  const mk = (title, extra) => db.entries.create({ title, ...extra });
  mk('d1', { date: '2026-10-01', mood: 1, tags: ['work'] });
  mk('d2', { date: '2026-10-02', mood: 2, tags: ['work', 'home'], pinned: true });
  mk('d3', { date: '2026-10-03', mood: 3, tags: ['homework'] });
  mk('d4', { date: '2026-10-04', mood: 3, tags: [] });
  const titles = (opts) => db.entries.list(opts).map((e) => e.title).sort();
  assert.deepEqual(titles({ mood: 3 }), ['d3', 'd4']);
  assert.deepEqual(titles({ mood: '3' }), ['d3', 'd4']);
  assert.deepEqual(titles({ tag: 'work' }), ['d1', 'd2'], 'exact match: "homework" is not "work"');
  assert.deepEqual(titles({ tag: ' WORK ' }), ['d1', 'd2']);
  assert.deepEqual(titles({ tag: 'wor' }), []);
  assert.deepEqual(titles({ tag: 'home' }), ['d2']);
  assert.deepEqual(titles({ from: '2026-10-02', to: '2026-10-03' }), ['d2', 'd3']);
  assert.deepEqual(titles({ from: '2026-10-04' }), ['d4']);
  assert.deepEqual(titles({ to: '2026-10-01' }), ['d1']);
  assert.deepEqual(titles({ pinned: true }), ['d2']);
  assert.deepEqual(titles({ pinned: '1' }), ['d2']);
  assert.deepEqual(titles({ pinned: false }), ['d1', 'd3', 'd4']);
  assert.deepEqual(titles({ mood: 3, tag: 'homework', from: '2026-10-03', to: '2026-10-03' }), ['d3']);
  assert.deepEqual(titles({ tag: '"; DROP TABLE entries; --' }), []);
  throwsInvalid(() => db.entries.list({ mood: 9 }), 'mood');
  throwsInvalid(() => db.entries.list({ from: 'yesterday' }), 'date');
  throwsInvalid(() => db.entries.list({ before: 'abc' }), 'before');
  assert.equal(db.entries.list({ limit: 'junk' }).length, 4);
  db.close();
});

test('list: tag filter ignores tags that only look similar inside JSON', () => {
  const db = memDb();
  db.entries.create({ title: 'quote', tags: ['say "hi"'] });
  db.entries.create({ title: 'comma', tags: ['a,b'] });
  assert.deepEqual(db.entries.list({ tag: 'say "hi"' }).map((e) => e.title), ['quote']);
  assert.deepEqual(db.entries.list({ tag: 'a' }).map((e) => e.title), []);
  assert.deepEqual(db.entries.list({ tag: 'a,b' }).map((e) => e.title), ['comma']);
  db.close();
});

test('list: limit is clamped to 1..200', () => {
  const db = memDb();
  for (let i = 0; i < 5; i++) db.entries.create({ title: `e${i}` });
  assert.equal(db.entries.list({ limit: 2 }).length, 2);
  assert.equal(db.entries.list({ limit: 0 }).length, 5, '0 falls back to the default');
  assert.equal(db.entries.list({ limit: -3 }).length, 5);
  assert.equal(db.entries.list({ limit: 10_000 }).length, 5);
  db.close();
});

test('pagination with before is stable and complete when timestamps are unique', () => {
  const db = memDb();
  for (let i = 0; i < 25; i++) db.entries.create({ title: `e${i}` });
  const seen = [];
  let before;
  for (let guard = 0; guard < 20; guard++) {
    const rows = db.entries.list({ limit: 10, before });
    if (rows.length === 0) break;
    seen.push(...rows.map((r) => r.title));
    before = rows.at(-1).createdAt;
  }
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25);
  assert.equal(seen[0], 'e24');
  assert.equal(seen[24], 'e0');
  db.close();
});

test('page(): cursor pagination is stable and complete even when many entries share a timestamp', () => {
  const db = memDb();
  const ids = new Set();
  for (let i = 0; i < 37; i++) {
    // Only three distinct timestamps, so most pages cut through a group of equal createdAt values.
    const e = db.entries.create({ title: `e${i}`, createdAt: 1_700_000_000_000 + (i % 3) * 1000 });
    ids.add(e.id);
  }
  for (const limit of [1, 2, 5, 7, 36, 37, 100]) {
    const seen = [];
    let cursor = {};
    for (let guard = 0; guard < 100; guard++) {
      const page = db.entries.page({ limit, ...cursor });
      seen.push(...page.entries.map((e) => e.id));
      if (page.nextBefore === null) {
        assert.equal(page.nextBeforeId, null);
        break;
      }
      assert.ok(page.entries.length >= limit, 'only the last page may be short');
      cursor = { before: page.nextBefore, beforeId: page.nextBeforeId };
    }
    assert.equal(seen.length, 37, `limit ${limit}: every entry exactly once`);
    assert.equal(new Set(seen).size, 37, `limit ${limit}: no duplicates`);
    assert.deepEqual(new Set(seen), ids);
    // global order is (createdAt desc, id desc)
    const rows = seen.map((id) => db.entries.get(id));
    for (let i = 1; i < rows.length; i++) {
      const [p, q] = [rows[i - 1], rows[i]];
      assert.ok(p.createdAt > q.createdAt || (p.createdAt === q.createdAt && p.id > q.id), 'ordering');
    }
  }
  db.close();
});

test('page(): numeric-only cursors (HTTP style) never skip entries that share a timestamp', () => {
  const db = memDb();
  for (let i = 0; i < 31; i++) db.entries.create({ title: `e${i}`, createdAt: 2_000_000_000_000 + (i % 4) * 1000 });
  for (const limit of [1, 2, 3, 5, 8, 30]) {
    const seen = [];
    let before;
    for (let guard = 0; guard < 100; guard++) {
      const page = db.entries.page({ limit, before });
      seen.push(...page.entries.map((e) => e.id));
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
    assert.equal(seen.length, 31, `limit ${limit}`);
    assert.equal(new Set(seen).size, 31, `limit ${limit}: no duplicates`);
  }
  db.close();
});

test('page(): the combined nextCursor string works as `before`', () => {
  const db = memDb();
  for (let i = 0; i < 9; i++) db.entries.create({ title: `e${i}`, createdAt: 3_000_000_000_000 });
  const seen = [];
  let before;
  for (let guard = 0; guard < 20; guard++) {
    const page = db.entries.page({ limit: 2, before });
    seen.push(...page.entries.map((e) => e.id));
    if (!page.nextCursor) break;
    before = page.nextCursor;
    assert.match(before, /^\d+:.+/);
  }
  assert.equal(new Set(seen).size, 9);
  db.close();
});

test('page(): nextBefore is null on exact multiples and for empty results', () => {
  const db = memDb();
  assert.deepEqual(db.entries.page({ limit: 5 }), { entries: [], nextBefore: null, nextBeforeId: null, nextCursor: null });
  for (let i = 0; i < 4; i++) db.entries.create();
  const p = db.entries.page({ limit: 4 });
  assert.equal(p.entries.length, 4);
  assert.equal(p.nextBefore, null);
  const q = db.entries.page({ limit: 3 });
  assert.equal(q.entries.length, 3);
  assert.equal(q.nextBefore, q.entries.at(-1).createdAt);
  db.close();
});

test('page(): filters apply to the cursor too', () => {
  const db = memDb();
  for (let i = 0; i < 12; i++) db.entries.create({ title: `e${i}`, mood: i % 2 ? 4 : 2, createdAt: 5_000 + i });
  const first = db.entries.page({ limit: 4, mood: 4 });
  const second = db.entries.page({ limit: 4, mood: 4, before: first.nextBefore, beforeId: first.nextBeforeId });
  const all = [...first.entries, ...second.entries];
  assert.equal(all.length, 6);
  assert.ok(all.every((e) => e.mood === 4));
  assert.equal(new Set(all.map((e) => e.id)).size, 6);
  assert.equal(second.nextBefore, null);
  db.close();
});

test('summariesFor returns summaries in the requested order and skips unknown ids', () => {
  const db = memDb();
  const a = entryWith(db, ['aaa text'], { title: 'A' });
  const b = entryWith(db, ['bbb text'], { title: 'B' });
  const rows = db.entries.summariesFor([b.id, 'missing', a.id, 42]);
  assert.deepEqual(rows.map((r) => [r.title, r.preview]), [['B', 'bbb text'], ['A', 'aaa text']]);
  assert.deepEqual(db.entries.summariesFor([]), []);
  assert.deepEqual(db.entries.summariesFor('nope'), []);
  db.close();
});

test('rowsForInsights returns minimal rows without messages, filtered and ordered', () => {
  const db = memDb();
  entryWith(db, ['one two three'], { date: '2026-10-03', mood: 4, emotions: ['calm'], tags: ['x'], title: 'T3', summary: 'S3', status: 'wrapped' });
  entryWith(db, ['four'], { date: '2026-10-01', private: true, title: 'T1' });
  entryWith(db, ['five six'], { date: '2026-10-02', title: 'T2' });
  const all = db.entries.rowsForInsights({});
  assert.deepEqual(all.map((r) => r.title), ['T1', 'T2', 'T3']);
  assert.deepEqual(Object.keys(all[2]).sort(), ['createdAt', 'date', 'emotions', 'id', 'mood', 'private', 'status', 'summary', 'tags', 'title', 'wordCount']);
  assert.deepEqual(
    { ...all[2], id: 'id', createdAt: 0 },
    { id: 'id', date: '2026-10-03', mood: 4, emotions: ['calm'], tags: ['x'], wordCount: 3, status: 'wrapped', private: false, title: 'T3', summary: 'S3', createdAt: 0 },
  );
  assert.deepEqual(db.entries.rowsForInsights({ includePrivate: false }).map((r) => r.title), ['T2', 'T3']);
  assert.deepEqual(db.entries.rowsForInsights({ from: '2026-10-02', to: '2026-10-02' }).map((r) => r.title), ['T2']);
  assert.deepEqual(db.entries.rowsForInsights().length, 3);
  throwsInvalid(() => db.entries.rowsForInsights({ from: 'x' }), 'date');
  db.close();
});

test('entries.count and exists', () => {
  const db = memDb();
  const e = db.entries.create();
  assert.equal(db.entries.count(), 1);
  assert.equal(db.entries.exists(e.id), true);
  assert.equal(db.entries.exists('nope'), false);
  assert.equal(db.entries.exists(null), false);
  db.close();
});

test('unicode titles and tags round trip', () => {
  const db = memDb();
  const e = db.entries.create({ title: 'Café ☕ 日記 😀', tags: ['日記', 'ÉCOLE'], emotions: ['été'] });
  const got = db.entries.get(e.id);
  assert.equal(got.title, 'Café ☕ 日記 😀');
  assert.deepEqual(got.tags, ['日記', 'école']);
  assert.deepEqual(db.entries.list({ tag: '日記' }).map((x) => x.id), [e.id]);
  db.close();
});
