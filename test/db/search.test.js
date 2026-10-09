import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMatchQuery, makeSnippet, tokenize } from '../../src/db/search.js';
import { DbError } from '../../src/db/util.js';
import { entryWith, memDb, rng } from './helpers.js';

const ids = (hits) => hits.map((h) => h.entryId);

// ---- tokenizer and query builder -----------------------------------------------------------------

test('tokenize: unicode letters and digits, lowercase, distinct', () => {
  assert.deepEqual(tokenize('Hello, WORLD! hello 42 3.5 foo_bar café-au-lait'), ['hello', 'world', '42', '3', '5', 'foo', 'bar', 'café', 'au', 'lait']);
  assert.deepEqual(tokenize('Ünïcödé Ελληνικά русский 日本語 हिन्दी'), ['ünïcödé', 'ελληνικά', 'русский', '日本語', 'हिन्दी']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(undefined), []);
  assert.deepEqual(tokenize(42), []);
  assert.deepEqual(tokenize('!!! ... --- *** "" () :: ^^ ++ 😀😀'), []);
  assert.deepEqual(tokenize('\u{301}'), [], 'a lone combining mark is not a token');
});

test('tokenize: bounded token count and token length', () => {
  const many = tokenize(Array.from({ length: 500 }, (_, i) => `w${i}`).join(' '));
  assert.equal(many.length, 32);
  const [long] = tokenize('x'.repeat(10_000));
  assert.equal(long.length, 64);
  assert.ok(tokenize('word '.repeat(5000)).length === 1);
});

test('buildMatchQuery: every token quoted; all = prefix + implicit AND; any = OR of exact tokens', () => {
  assert.equal(buildMatchQuery('Quiet mornings'), '"quiet"* "mornings"*');
  assert.equal(buildMatchQuery('Quiet mornings', 'all'), '"quiet"* "mornings"*');
  assert.equal(buildMatchQuery('Quiet mornings', 'any'), '"quiet" OR "mornings"');
  assert.equal(buildMatchQuery('   '), '');
  assert.equal(buildMatchQuery('AND OR NOT NEAR'), '"and"* "or"* "not"* "near"*', 'operator words are plain words once quoted');
  assert.equal(buildMatchQuery('NOT', 'any'), '"not"');
  assert.equal(buildMatchQuery('(a OR b) NEAR/3 "c d" -e +f ^g title:h col*'), '"a"* "or"* "b"* "near"* "3"* "c"* "d"* "e"* "f"* "g"* "title"* "h"* "col"*');
  for (const q of ['"; DROP TABLE entries; --', "' OR 1=1 --", '") OR ("1"="1']) {
    const expr = buildMatchQuery(q);
    assert.ok(/^("[\p{L}\p{N}\p{M}]+"\*?( OR | )?)+$/u.test(expr), `${q} -> ${expr}`);
  }
});

// ---- searching ------------------------------------------------------------------------------------

test('search: prefix matching in all mode, every token must match', () => {
  const db = memDb();
  const a = entryWith(db, ['Walking in the quiet forest this morning']);
  const b = entryWith(db, ['Quiet evening with tea']);
  entryWith(db, ['Loud city traffic']);
  assert.deepEqual(ids(db.search('quie')).sort(), [a.id, b.id].sort());
  assert.deepEqual(ids(db.search('quiet forest')), [a.id]);
  assert.deepEqual(ids(db.search('QUIET FOR')), [a.id]);
  assert.deepEqual(ids(db.search('quiet loud')), []);
  assert.deepEqual(db.search('zebra'), []);
  db.close();
});

test('search: any mode is OR and ranks better matches first', () => {
  const db = memDb();
  const both = entryWith(db, ['work stress deadline manager anxiety']);
  const one = entryWith(db, ['stress about nothing in particular, just a long ramble about the weather and clouds']);
  entryWith(db, ['pure joy at the beach']);
  const hits = db.search('work stress deadline', { mode: 'any' });
  assert.deepEqual(ids(hits), [both.id, one.id]);
  assert.ok(hits[0].rank < hits[1].rank, 'smaller rank = better');
  assert.ok(typeof hits[0].rank === 'number' && hits[0].rank < 0);
  assert.deepEqual(ids(db.search('work stress deadline')), [both.id], 'all mode needs every word');
  db.close();
});

test('search: any mode matches whole tokens only (no prefixes)', () => {
  const db = memDb();
  entryWith(db, ['running every morning']);
  assert.equal(db.search('run', { mode: 'any' }).length, 0);
  assert.equal(db.search('run').length, 1, 'all mode is prefix based');
  db.close();
});

test('search: case and diacritics are ignored in both directions', () => {
  const db = memDb();
  const e = entryWith(db, ['Un café très agréable à Zürich']);
  for (const q of ['cafe', 'CAFÉ', 'tres', 'agreable', 'zurich', 'ZÜRICH', 'à']) {
    assert.deepEqual(ids(db.search(q)), [e.id], q);
  }
  db.close();
});

test('search: title, tags and emotions are searched; title ranks above body', () => {
  const db = memDb();
  const inTitle = entryWith(db, ['unrelated text about nothing'], { title: 'Lighthouse trip' });
  const inBody = entryWith(db, ['we saw a lighthouse today and it was tall']);
  const inTag = entryWith(db, ['hello'], { tags: ['lighthouse'] });
  const inEmotion = entryWith(db, ['hello again'], { emotions: ['wistful'] });
  const hits = db.search('lighthouse');
  assert.equal(hits.length, 3);
  assert.equal(hits[0].entryId, inTitle.id);
  assert.deepEqual(new Set(ids(hits)), new Set([inTitle.id, inBody.id, inTag.id]));
  assert.deepEqual(ids(db.search('wistful')), [inEmotion.id]);
  db.close();
});

test('search: index follows title / tag / emotion changes', () => {
  const db = memDb();
  const e = entryWith(db, ['plain body']);
  assert.equal(db.search('rename').length, 0);
  db.entries.update(e.id, { title: 'Rename me' });
  assert.deepEqual(ids(db.search('rename')), [e.id]);
  db.entries.update(e.id, { title: 'Other title' });
  assert.equal(db.search('rename').length, 0);
  db.entries.update(e.id, { tags: ['gardening'], emotions: ['content'] });
  assert.deepEqual(ids(db.search('gardening')), [e.id]);
  assert.deepEqual(ids(db.search('content')), [e.id]);
  db.entries.update(e.id, { tags: [], emotions: [] });
  assert.equal(db.search('gardening').length, 0);
  assert.equal(db.search('content').length, 0);
  assert.deepEqual(db.search.checkConsistency().problems, []);
  db.close();
});

test('search: excludeEntryId, includePrivate (default false), limit', () => {
  const db = memDb();
  const a = entryWith(db, ['sunrise over hills']);
  const b = entryWith(db, ['sunrise at the lake']);
  const p = entryWith(db, ['sunrise secrets'], { private: true });
  assert.deepEqual(new Set(ids(db.search('sunrise'))), new Set([a.id, b.id]));
  assert.deepEqual(new Set(ids(db.search('sunrise', { includePrivate: true }))), new Set([a.id, b.id, p.id]));
  assert.deepEqual(ids(db.search('sunrise', { excludeEntryId: a.id })), [b.id]);
  assert.equal(db.search('sunrise', { limit: 1, includePrivate: true }).length, 1);
  assert.equal(db.search('sunrise', { limit: 0, includePrivate: true }).length, 3, 'invalid limit falls back to the default');
  assert.equal(db.search('sunrise', { limit: 5000, includePrivate: true }).length, 3);
  // making an entry private removes it from default results immediately
  db.entries.update(a.id, { private: true });
  assert.deepEqual(ids(db.search('sunrise')), [b.id]);
  db.close();
});

test('search: optional filters (mood, tag, from/to, pinned)', () => {
  const db = memDb();
  const a = entryWith(db, ['coffee break'], { mood: 5, tags: ['work'], date: '2026-10-01', pinned: true });
  const b = entryWith(db, ['coffee time'], { mood: 2, tags: ['home'], date: '2026-10-05' });
  assert.deepEqual(ids(db.search('coffee', { mood: 5 })), [a.id]);
  assert.deepEqual(ids(db.search('coffee', { tag: 'HOME' })), [b.id]);
  assert.deepEqual(ids(db.search('coffee', { from: '2026-10-02' })), [b.id]);
  assert.deepEqual(ids(db.search('coffee', { to: '2026-10-02' })), [a.id]);
  assert.deepEqual(ids(db.search('coffee', { pinned: true })), [a.id]);
  assert.deepEqual(ids(db.search('coffee', { pinned: false })), [b.id]);
  assert.equal(db.search('coffee', { mood: 5, tag: 'home' }).length, 0);
  db.close();
});

test('search: filters accept the same query-string values and validation as entries.list', () => {
  const db = memDb();
  const a = entryWith(db, ['coffee break'], { mood: 3, tags: ['work'], date: '2026-10-01', pinned: true });
  const b = entryWith(db, ['coffee time'], { mood: 5, tags: ['home'], date: '2026-10-05' });
  // HTTP style: every value is a string (GET /api/entries?q=coffee&mood=3&pinned=1).
  assert.deepEqual(ids(db.search('coffee', { mood: '3' })), [a.id]);
  assert.deepEqual(ids(db.search('coffee', { mood: '5' })), [b.id]);
  for (const pinned of ['1', 'true', 1, true]) assert.deepEqual(ids(db.search('coffee', { pinned })), [a.id], String(pinned));
  for (const pinned of ['0', 'false', 0, false]) assert.deepEqual(ids(db.search('coffee', { pinned })), [b.id], String(pinned));
  assert.equal(db.search('coffee', { pinned: 'maybe' }).length, 2, 'unknown flag values mean no filter, as in list()');
  assert.equal(db.search('coffee', { mood: '', tag: '', from: '', to: '', pinned: null }).length, 2);
  assert.equal(db.search('coffee', { tag: '   ' }).length, 2, 'a blank tag is no filter');
  assert.equal(db.entries.list({ tag: '   ' }).length, 2, 'same for list()');
  assert.deepEqual(ids(db.search('coffee', { mood: '3', pinned: '1', tag: ' WORK ', from: '2026-10-01', to: '2026-10-01' })), [a.id]);
  // search and list agree for every combination
  for (const options of [{ mood: '3' }, { mood: 5 }, { pinned: '1' }, { pinned: 'false' }, { tag: 'Home' }, { from: '2026-10-02' }, { to: '2026-10-02' }]) {
    assert.deepEqual(
      ids(db.search('coffee', options)).sort(),
      db.entries.list(options).map((e) => e.id).sort(),
      JSON.stringify(options),
    );
  }
  // Malformed filters are an error, never a silently unfiltered (or empty) result.
  const bad = [
    [{ mood: 'happy' }, 'mood'],
    [{ mood: '9' }, 'mood'],
    [{ mood: 0 }, 'mood'],
    [{ mood: 2.5 }, 'mood'],
    [{ from: 'garbage' }, 'date'],
    [{ to: '2026-02-30' }, 'date'],
    [{ from: 20261001 }, 'date'],
    [{ tag: ['work'] }, 'tag'],
    [{ tag: { $ne: 1 } }, 'tag'],
    [{ tag: 7 }, 'tag'],
  ];
  for (const [options, field] of bad) {
    const check = (err) => err instanceof DbError && err.code === 'invalid' && err.field === field;
    assert.throws(() => db.search('coffee', options), check, JSON.stringify(options));
    assert.throws(() => db.search('!!!', options), check, `${JSON.stringify(options)} with an empty query`);
    assert.throws(() => db.search('日記', options), check, `${JSON.stringify(options)} with a substring query`);
  }
  db.close();
});

test('search: options object is optional and tolerant', () => {
  const db = memDb();
  entryWith(db, ['anything']);
  assert.equal(db.search('anything', undefined).length, 1);
  assert.equal(db.search('anything', null).length, 1);
  assert.equal(db.search('anything', { mode: 'bogus' }).length, 1);
  assert.deepEqual(db.search(undefined), []);
  assert.deepEqual(db.search(null), []);
  assert.deepEqual(db.search(12345), []);
  assert.deepEqual(db.search({}), []);
  db.close();
});

test('search: empty or operator-only input returns no rows and never throws', () => {
  const db = memDb();
  entryWith(db, ['something to find'], { title: 'Findable' });
  for (const q of ['', '   ', '\n\t', '"', '""', '"" ""', '*', '**', '()', '(', ')', ':', '::', '-', '--', '+', '^', '~', '"*"', '(*)', '- - -', '"(', ')"', ': :', '* * *', '\\', '\\"', '%', '_', '[]', '{}', ';', '--;']) {
    assert.deepEqual(db.search(q), [], JSON.stringify(q));
    assert.deepEqual(db.search(q, { mode: 'any' }), [], JSON.stringify(q));
  }
  db.close();
});

test('search: quote characters and FTS syntax inside real words never break the query', () => {
  const db = memDb();
  const e = entryWith(db, ['He said "hello" and left. AND then OR NOT near (the) door: title* -x +y']);
  for (const q of ['"hello"', 'hello AND', 'AND', 'OR', 'NOT', 'NEAR', 'near(the', '(the)', 'door:', 'title*', 'hello"world', '"hello', 'hello"']) {
    const hits = db.search(q);
    assert.ok(Array.isArray(hits), q);
  }
  assert.deepEqual(ids(db.search('"hello"')), [e.id]);
  assert.deepEqual(ids(db.search('AND')), [e.id], 'operator words are searchable as words');
  assert.deepEqual(ids(db.search('NOT near')), [e.id]);
  db.close();
});

test('search: SQL injection strings are inert', () => {
  const db = memDb();
  const e = entryWith(db, ['Robert and Tables']);
  const attacks = [
    "'; DROP TABLE entries; --",
    '" ; DELETE FROM messages ; --',
    "') OR 1=1 --",
    "x' UNION SELECT * FROM settings --",
    '1; ATTACH DATABASE \'/etc/passwd\' AS pwn; --',
    '`; PRAGMA writable_schema=1; --',
    '\u0000; DROP TABLE entries',
  ];
  for (const attack of attacks) {
    for (const mode of ['all', 'any']) {
      assert.ok(Array.isArray(db.search(attack, { mode, includePrivate: true })));
      assert.ok(Array.isArray(db.search(attack, { excludeEntryId: attack, mode })));
      assert.ok(Array.isArray(db.search(attack, { tag: attack, mode })));
    }
  }
  assert.equal(db.stats().entries, 1);
  assert.deepEqual(ids(db.search('robert')), [e.id]);
  db.close();
});

test('search: 10,000-character and single-token inputs do not crash and stay fast', () => {
  const db = memDb();
  const e = entryWith(db, ['alpha beta gamma delta']);
  const t0 = Date.now();
  for (const q of ['alpha '.repeat(2000), 'x'.repeat(10_000), `${'alpha '.repeat(1500)}${'"(*'.repeat(1000)}`, Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' '), '😀'.repeat(5000), '日本語'.repeat(3000)]) {
    for (const mode of ['all', 'any']) assert.ok(Array.isArray(db.search(q, { mode })));
  }
  assert.ok(Date.now() - t0 < 5000, 'long queries must be bounded');
  assert.deepEqual(ids(db.search('alpha '.repeat(2000), { mode: 'any' })), [e.id]);
  db.close();
});

test('search: fuzz (random punctuation, FTS operators, unicode, SQL) never throws; generated MATCH expressions always parse', () => {
  const db = memDb();
  entryWith(db, ['The quick brown fox, 日本語のテキスト 😀 café Zürich'], { title: 'Fuzz target', tags: ['fox'] });
  entryWith(db, ['another entry with words and NEAR AND OR NOT'], { emotions: ['calm'] });
  const rand = rng(20261008);
  const operators = ['AND', 'OR', 'NOT', 'NEAR', 'NEAR/2', '^', '"', '""', '(', ')', '*', ':', '-', '+', 'title:', 'body:', 'tags:', '{title body}:', 'entry_id:', "'", ';', '--', '/*', '*/', '%', '_', '\\', '\u0000', '\u{301}', '\ud83d', '\u{200D}', '\u{FEFF}'];
  const fragments = ['fox', 'quick', 'café', 'ZÜRICH', '日本', '😀', '👨\u{200D}👩\u{200D}👧', 'x', '0', '١٢٣', 'ß', 'İstanbul', 'ǅ', 'हिन्दी', 'สวัสดี', '한국어', "O'Brien", 'a_b', 'drop table', ...operators];
  const randomChar = () => String.fromCodePoint(rand.int(3) === 0 ? rand.int(0x2fff) : rand.int(3) === 0 ? 0x1f300 + rand.int(0x400) : 32 + rand.int(95));
  const checkExpression = db.handle.prepare('SELECT COUNT(*) AS n FROM entry_search WHERE entry_search MATCH ?');
  for (let i = 0; i < 1500; i++) {
    let q = '';
    const parts = rand.int(12);
    for (let p = 0; p < parts; p++) q += (rand.int(3) === 0 ? randomChar() : rand.pick(fragments)) + (rand.int(4) === 0 ? '' : ' ');
    for (const mode of ['all', 'any']) {
      const hits = db.search(q, { mode, includePrivate: true, limit: 5 });
      assert.ok(Array.isArray(hits), JSON.stringify(q));
      for (const h of hits) {
        assert.equal(typeof h.entryId, 'string');
        assert.equal(typeof h.rank, 'number');
        assert.equal(typeof h.snippet, 'string');
        assert.ok(h.snippet.length <= 160, 'snippet too long');
      }
      const expr = buildMatchQuery(q, mode);
      if (expr) assert.ok(checkExpression.get(expr).n >= 0, `FTS rejected ${expr}`);
    }
  }
  assert.equal(db.stats().entries, 2);
  db.close();
});

test('search: CJK words inside a run are found through the substring fallback', () => {
  const db = memDb();
  const a = entryWith(db, ['今日は日記を書きました。天気が良かったです。']);
  const b = entryWith(db, ['明日は仕事です']);
  assert.deepEqual(ids(db.search('日記')), [a.id], 'infix of a CJK run');
  assert.deepEqual(ids(db.search('天気')), [a.id]);
  assert.deepEqual(ids(db.search('今日')), [a.id], 'prefix of a run');
  assert.deepEqual(ids(db.search('は')).sort(), [a.id, b.id].sort());
  assert.deepEqual(ids(db.search('日記 書き')), [a.id], 'all mode: both substrings');
  assert.deepEqual(ids(db.search('日記 仕事', { mode: 'any' })).sort(), [a.id, b.id].sort());
  assert.deepEqual(db.search('存在しない'), []);
  const hit = db.search('日記')[0];
  assert.ok(hit.snippet.includes('日記'));
  db.close();
});

test('search: CJK mixed with Latin words, Korean and Thai', () => {
  const db = memDb();
  const mixed = entryWith(db, ['Meeting about 東京タワー plans with Sam']);
  const ko = entryWith(db, ['오늘은 일기를 썼다']);
  const th = entryWith(db, ['วันนี้ฉันไปตลาด']);
  assert.deepEqual(ids(db.search('東京')), [mixed.id]);
  assert.deepEqual(ids(db.search('meeting')), [mixed.id]);
  assert.deepEqual(ids(db.search('일기')), [ko.id]);
  assert.deepEqual(ids(db.search('ตลาด')), [th.id]);
  db.close();
});

test('search: emoji-only queries fall back to substring matching; punctuation-only does not', () => {
  const db = memDb();
  const happy = entryWith(db, ['Great day 😀 with friends']);
  const family = entryWith(db, ['Dinner with 👨\u{200D}👩\u{200D}👧 tonight']);
  entryWith(db, ['No pictures here']);
  assert.deepEqual(ids(db.search('😀')), [happy.id]);
  assert.deepEqual(ids(db.search('👨\u{200D}👩\u{200D}👧')), [family.id]);
  assert.deepEqual(ids(db.search('😀 👨\u{200D}👩\u{200D}👧', { mode: 'any' })).sort(), [happy.id, family.id].sort());
  assert.deepEqual(ids(db.search('😀 👨\u{200D}👩\u{200D}👧', { mode: 'all' })), []);
  assert.deepEqual(db.search('🙈'), []);
  assert.deepEqual(db.search('?!'), []);
  db.close();
});

test('search: LIKE wildcards can never reach the substring stage', () => {
  const db = memDb();
  entryWith(db, ['100% sure 日記_test']);
  entryWith(db, ['something else']);
  for (const q of ['%', '_', '%%', '\\', '100%', '%日記']) {
    const hits = db.search(q);
    assert.ok(hits.length <= 1, `${q} must not match everything`);
  }
  assert.deepEqual(db.search('%'), []);
  db.close();
});

test('search: results are deduplicated and limited across the FTS and substring stages', () => {
  const db = memDb();
  for (let i = 0; i < 6; i++) entryWith(db, [`今日の日記 number${i}`]);
  const hits = db.search('日記', { limit: 4 });
  assert.equal(hits.length, 4);
  assert.equal(new Set(ids(hits)).size, 4);
  db.close();
});

// ---- snippets -------------------------------------------------------------------------------------

test('makeSnippet: short text is returned whole, whitespace collapsed', () => {
  assert.equal(makeSnippet('  A   short\n\ntext ', ['short']), 'A short text');
  assert.equal(makeSnippet('', ['x']), '');
  assert.equal(makeSnippet(null, ['x']), '');
});

test('makeSnippet: at most 160 characters, centred on the first match, with ellipses', () => {
  const filler = 'lorem ipsum dolor sit amet '.repeat(40);
  const text = `${filler}NEEDLE appears here ${filler}`;
  const snippet = makeSnippet(text, ['needle']);
  assert.ok(snippet.length <= 160, String(snippet.length));
  assert.ok(snippet.includes('NEEDLE'));
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'));
  const at = snippet.indexOf('NEEDLE');
  assert.ok(at > 20 && at < 100, `match should be roughly centred, was at ${at}`);

  const early = makeSnippet(`NEEDLE ${filler}`, ['needle']);
  assert.ok(early.startsWith('NEEDLE') && early.endsWith('…') && early.length <= 160);
  const late = makeSnippet(`${filler}NEEDLE`, ['needle']);
  assert.ok(late.endsWith('NEEDLE') && late.startsWith('…') && late.length <= 160);
  const tail = makeSnippet(`${filler}ending with NEEDLE`, ['needle']);
  assert.ok(tail.length > 140 && tail.length <= 160, `a match at the very end still gets a full window (${tail.length})`);
  const none = makeSnippet(filler, ['absent']);
  assert.ok(none.startsWith('lorem') && none.endsWith('…') && none.length <= 160);
  assert.ok(makeSnippet(filler, []).length <= 160);
});

test('makeSnippet: prefix and diacritic-insensitive matching, earliest term wins', () => {
  const text = `${'padding word '.repeat(30)}the Café opened ${'padding word '.repeat(30)} zebra`;
  const s = makeSnippet(text, ['cafe']);
  assert.ok(s.includes('Café'));
  const first = makeSnippet(`${'x '.repeat(100)}alpha ${'y '.repeat(100)}omega`, ['omega', 'alpha']);
  assert.ok(first.includes('alpha') && !first.includes('omega'));
});

test('makeSnippet: never adds markup, never splits surrogate pairs, handles huge text', () => {
  const emoji = '😀'.repeat(500);
  const s = makeSnippet(`${emoji} needle ${emoji}`, ['needle']);
  assert.ok(s.length <= 160);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(s) && !/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s), 'lone surrogate');
  const text = 'a <b>bold</b> [x] **y** word '.repeat(50);
  const t = makeSnippet(text, ['bold']);
  assert.ok(!t.includes('\u0001') && t.length <= 160);
  const huge = makeSnippet(`${'word '.repeat(400_000)}needle`, ['needle']);
  assert.ok(huge.length <= 160 && huge.includes('needle'));
  const cjk = makeSnippet(`${'今日は'.repeat(200)}日記${'今日は'.repeat(200)}`, ['日記']);
  assert.ok(cjk.includes('日記') && cjk.length <= 160);
});

test('search results carry plain-text snippets from the right entry text', () => {
  const db = memDb();
  const filler = 'sentence about nothing in particular. '.repeat(30);
  const e = entryWith(db, [`${filler}The heron stood still by the river.${filler}`]);
  const [hit] = db.search('heron');
  assert.equal(hit.entryId, e.id);
  assert.ok(hit.snippet.includes('heron'));
  assert.ok(hit.snippet.length <= 160);
  // match only in the title: the snippet falls back to the start of the body
  const t = entryWith(db, ['The body says something else entirely'], { title: 'Zeppelin' });
  const [th] = db.search('zeppelin');
  assert.equal(th.entryId, t.id);
  assert.ok(th.snippet.startsWith('The body'));
  // entry without user text: the snippet is the title
  const bare = db.entries.create({ title: 'Only a title: Gazebo' });
  const [bh] = db.search('gazebo');
  assert.equal(bh.entryId, bare.id);
  assert.equal(bh.snippet, 'Only a title: Gazebo');
  db.close();
});

test('multi-message entries: all user messages are searchable, joined in order', () => {
  const db = memDb();
  const e = db.entries.create();
  db.messages.add(e.id, { role: 'user', content: 'first thoughts about marmalade' });
  db.messages.add(e.id, { role: 'assistant', content: 'Tell me about pineapples' });
  db.messages.add(e.id, { role: 'user', content: 'second thoughts about harbours' });
  assert.deepEqual(ids(db.search('marmalade harbours')), [e.id]);
  assert.deepEqual(db.search('pineapples'), []);
  db.close();
});

test('search offset pages through the ranked hits: pages join up with no gaps and no repeats', () => {
  const db = memDb();
  const made = Array.from({ length: 23 }, (_, i) => entryWith(db, [`my work day number ${i} with some work to do`], { title: `Entry ${i}` }));
  const everything = ids(db.search('work', { limit: 100 }));
  assert.equal(everything.length, 23);
  assert.deepEqual([...everything].sort(), made.map((e) => e.id).sort());
  const pages = [];
  for (let offset = 0; offset < 30; offset += 10) pages.push(ids(db.search('work', { limit: 10, offset })));
  assert.deepEqual(pages.map((p) => p.length), [10, 10, 3]);
  assert.deepEqual(pages.flat(), everything, 'the same order as one big search');
  assert.deepEqual(db.search('work', { limit: 10, offset: 23 }), [], 'past the end');
  assert.deepEqual(ids(db.search('work', { limit: 10, offset: 'abc' })), everything.slice(0, 10), 'junk offsets mean none');
  assert.deepEqual(ids(db.search('work', { limit: 10, offset: -4 })), everything.slice(0, 10));
  db.close();
});

test('search offset also pages the substring stage (CJK) and respects filters', () => {
  const db = memDb();
  for (let i = 0; i < 12; i += 1) entryWith(db, [`今日は仕事が忙しかった ${i}`], { title: `Day ${i}`, mood: i % 2 === 0 ? 4 : 2 });
  const all = ids(db.search('仕事', { limit: 100 }));
  assert.equal(all.length, 12);
  assert.deepEqual([...ids(db.search('仕事', { limit: 5, offset: 0 })), ...ids(db.search('仕事', { limit: 5, offset: 5 })), ...ids(db.search('仕事', { limit: 5, offset: 10 }))], all);
  const happy = ids(db.search('仕事', { limit: 100, mood: 4 }));
  assert.equal(happy.length, 6);
  assert.deepEqual([...ids(db.search('仕事', { limit: 4, mood: 4 })), ...ids(db.search('仕事', { limit: 4, offset: 4, mood: 4 }))], happy);
  db.close();
});
