import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DbError, openDb } from '../../src/db/index.js';
import { mergeSettings } from '../../src/settings.js';
import { entryWith, memDb, scratchDir } from './helpers.js';

const T0 = 1_760_000_000_000;

function seed(db) {
  const e1 = entryWith(db, ['I walked by the river', 'It was quiet'], { title: 'River', tags: ['walk'], emotions: ['calm'], mood: 4, date: '2026-10-01', pinned: true }, { withAssistant: true });
  const e2 = entryWith(db, ['Private thoughts'], { title: 'Secret', private: true, date: '2026-10-02' });
  const g = db.entries.create({ templateId: 'gratitude', title: 'Gratitude', date: '2026-10-03', status: 'wrapped', summary: 'Thankful.' });
  db.messages.add(g.id, { role: 'assistant', content: 'What are you grateful for?', meta: { kind: 'prompt' } });
  db.messages.add(g.id, { role: 'user', content: 'My family' });
  db.memories.create({ text: 'Lives near a river', sourceEntryId: e1.id, pinned: true });
  db.memories.create({ text: 'No source memory' });
  db.reports.create({ periodStart: '2026-09-25', periodEnd: '2026-10-01', content: 'A week.', meta: { provider: 'local', entryCount: 3 } });
  return { e1, e2, g };
}

// ---- export -----------------------------------------------------------------------------------

test('exportAll: format, nesting, order, no settings or keys', () => {
  const db = memDb();
  db.settings.set(mergeSettings(db.settings.get(), { ai: { providers: { openai: { apiKey: 'sk-MUST-NOT-LEAK-9999' } } } }).settings);
  const { e1, g } = seed(db);
  const dump = db.exportAll();
  assert.equal(dump.app, 'myjournal');
  assert.equal(dump.version, 1);
  assert.equal(typeof dump.exportedAt, 'number');
  assert.deepEqual(Object.keys(dump).sort(), ['app', 'entries', 'exportedAt', 'memories', 'reports', 'version']);
  assert.equal(dump.entries.length, 3);
  const exported = dump.entries.find((e) => e.id === e1.id);
  assert.deepEqual(exported.messages.map((m) => [m.seq, m.role]), [[0, 'user'], [1, 'assistant'], [2, 'user'], [3, 'assistant']]);
  assert.equal(exported.messages[0].entryId, e1.id);
  assert.equal(exported.wordCount, 8);
  assert.equal(exported.messageCount, 4);
  assert.deepEqual(dump.entries.find((e) => e.id === g.id).messages[0].meta, { kind: 'prompt' });
  assert.equal(dump.memories.length, 2);
  assert.equal(dump.reports.length, 1);
  const text = JSON.stringify(dump);
  assert.ok(!text.includes('MUST-NOT-LEAK'), 'settings must never be exported');
  assert.ok(!/apiKey/.test(text));
  assert.deepEqual(JSON.parse(text), dump, 'JSON round trip is lossless');
  db.close();
});

test('exportAll on an empty database', () => {
  const db = memDb();
  const dump = db.exportAll();
  assert.deepEqual([dump.entries, dump.memories, dump.reports], [[], [], []]);
  db.close();
});

test('export -> import into an empty database reproduces everything', () => {
  const src = memDb();
  seed(src);
  const dump = JSON.parse(JSON.stringify(src.exportAll()));
  const dst = memDb();
  const result = dst.importAll(dump);
  assert.deepEqual(result.imported, { entries: 3, messages: 7, memories: 2, reports: 1 });
  assert.equal(result.skipped, 0);

  const again = dst.exportAll();
  const normalise = (d) => ({ ...d, exportedAt: 0, entries: d.entries.map((e) => ({ ...e })) });
  assert.deepEqual(normalise(again), normalise(JSON.parse(JSON.stringify(src.exportAll()))));
  assert.equal(dst.search('quiet').length, 1);
  assert.equal(dst.search('secrets thoughts', { mode: 'any' }).length, 0, 'private entries stay private');
  assert.equal(dst.search('private', { includePrivate: true }).length, 1);
  assert.deepEqual(dst.search.checkConsistency().problems, []);
  src.close();
  dst.close();
});

// ---- import: merge semantics ------------------------------------------------------------------

test('import is idempotent: a second import skips everything that exists', () => {
  const src = memDb();
  seed(src);
  const dump = JSON.parse(JSON.stringify(src.exportAll()));
  const dst = memDb();
  dst.importAll(dump);
  const before = JSON.stringify(dst.exportAll().entries);
  const second = dst.importAll(dump);
  assert.deepEqual(second.imported, { entries: 0, messages: 0, memories: 0, reports: 0 });
  assert.equal(second.skipped, 3 + 7 + 2 + 1);
  assert.equal(second.skippedDetail.existing, second.skipped);
  assert.equal(JSON.stringify(dst.exportAll().entries), before);
  src.close();
  dst.close();
});

test('import merges by id: existing records are kept as they are, new ones are added', () => {
  const dst = memDb();
  const mine = entryWith(dst, ['my local version'], { title: 'Local title' });
  const dump = {
    app: 'myjournal',
    version: 1,
    entries: [
      { id: mine.id, createdAt: T0, title: 'Overwrite attempt', messages: [{ id: 'm-over', role: 'user', content: 'overwrite', createdAt: T0 }] },
      { id: 'new-entry', createdAt: T0 + 1, title: 'Brand new', messages: [{ id: 'm-new', role: 'user', content: 'new words', createdAt: T0 + 1 }] },
    ],
  };
  const result = dst.importAll(dump);
  assert.deepEqual(result.imported, { entries: 1, messages: 1, memories: 0, reports: 0 });
  assert.equal(result.skipped, 2);
  assert.equal(dst.entries.get(mine.id).title, 'Local title');
  assert.equal(dst.messages.list(mine.id).length, 1);
  assert.equal(dst.entries.get('new-entry').title, 'Brand new');
  assert.equal(dst.entries.get('new-entry').wordCount, 2);
  assert.equal(dst.search('new words').length, 1);
  dst.close();
});

test('import: seq is normalised, order preserved, derived fields recomputed (declared counts ignored)', () => {
  const db = memDb();
  const result = db.importAll({
    app: 'myjournal',
    version: 1,
    counts: { entries: 999 },
    entryCount: 5000,
    entries: [
      {
        id: 'e1',
        createdAt: T0,
        wordCount: 12345,
        messageCount: 99,
        messages: [
          { id: 'b', seq: 7, role: 'assistant', content: 'second', createdAt: T0 + 2 },
          { id: 'a', seq: 2, role: 'user', content: 'one two three', createdAt: T0 + 1 },
          { id: 'c', seq: 7, role: 'user', content: 'four', createdAt: T0 + 3 },
          { id: 'd', role: 'user', content: 'no seq', createdAt: T0 + 4 },
        ],
      },
    ],
  });
  assert.deepEqual(result.imported, { entries: 1, messages: 4, memories: 0, reports: 0 });
  const e = db.entries.get('e1');
  assert.equal(e.wordCount, 3 + 1 + 2);
  assert.equal(e.messageCount, 4);
  assert.deepEqual(db.messages.list('e1').map((m) => [m.id, m.seq]), [['a', 0], ['b', 1], ['c', 2], ['d', 3]]);
  assert.equal(db.messages.add('e1', { role: 'user', content: 'next' }).seq, 4);
  db.close();
});

test('import: top-level messages list attaches to entries from the same file; unknown or existing parents are orphans', () => {
  const db = memDb();
  const existing = entryWith(db, ['already here'], { title: 'Existing' });
  const result = db.importAll({
    app: 'myjournal',
    entries: [{ id: 'e1', createdAt: T0 }],
    messages: [
      { id: 'f1', entryId: 'e1', role: 'user', content: 'attached', createdAt: T0 + 1 },
      { id: 'f2', entryId: 'missing-entry', role: 'user', content: 'orphan', createdAt: T0 + 2 },
      { id: 'f3', entryId: existing.id, role: 'user', content: 'to existing entry', createdAt: T0 + 3 },
      { id: 'f4', role: 'user', content: 'no entry id', createdAt: T0 + 4 },
    ],
  });
  assert.deepEqual(result.imported, { entries: 1, messages: 1, memories: 0, reports: 0 });
  assert.equal(result.skipped, 3);
  assert.equal(result.skippedDetail.orphaned, 3);
  assert.deepEqual(db.messages.list('e1').map((m) => m.content), ['attached']);
  assert.equal(db.messages.list(existing.id).length, 1);
  assert.equal(db.messages.get('f2'), null);
  db.close();
});

test('import: nested message naming a different entry is skipped', () => {
  const db = memDb();
  const result = db.importAll({
    entries: [
      {
        id: 'e1',
        createdAt: T0,
        messages: [
          { id: 'ok', entryId: 'e1', role: 'user', content: 'fine', createdAt: T0 },
          { id: 'bad', entryId: 'someone-else', role: 'user', content: 'wrong parent', createdAt: T0 },
        ],
      },
    ],
    app: 'myjournal',
  });
  assert.deepEqual(result.imported, { entries: 1, messages: 1, memories: 0, reports: 0 });
  assert.equal(result.skipped, 1);
  db.close();
});

test('import: memories keep sourceEntryId only when that entry exists after the import', () => {
  const db = memDb();
  db.importAll({
    app: 'myjournal',
    entries: [{ id: 'e1', createdAt: T0 }],
    memories: [
      { id: 'm1', text: 'with source', createdAt: T0, sourceEntryId: 'e1' },
      { id: 'm2', text: 'dangling source', createdAt: T0, sourceEntryId: 'nope' },
      { id: 'm3', text: 'no source', createdAt: T0, pinned: true, updatedAt: T0 + 5 },
    ],
  });
  const byId = Object.fromEntries(db.memories.list().map((m) => [m.id, m]));
  assert.equal(byId.m1.sourceEntryId, 'e1');
  assert.equal(byId.m2.sourceEntryId, null);
  assert.equal(byId.m3.pinned, true);
  assert.equal(byId.m3.updatedAt, T0 + 5);
  assert.equal(db.memories.exists('WITH SOURCE'), true);
  db.close();
});

test('import is atomic: a failure midway leaves the database untouched', () => {
  const db = memDb();
  entryWith(db, ['keep me'], { title: 'Keep' });
  const before = JSON.stringify(db.exportAll().entries);
  // Make the second entry blow up inside SQLite: a reserved message id collides with an existing one only at insert time.
  db.handle.exec("CREATE TRIGGER boom BEFORE INSERT ON messages WHEN NEW.content = 'EXPLODE' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.throws(() =>
    db.importAll({
      app: 'myjournal',
      entries: [
        { id: 'e1', createdAt: T0, messages: [{ id: 'm1', role: 'user', content: 'fine', createdAt: T0 }] },
        { id: 'e2', createdAt: T0, messages: [{ id: 'm2', role: 'user', content: 'EXPLODE', createdAt: T0 }] },
      ],
    }),
  /boom/);
  assert.equal(JSON.stringify(db.exportAll().entries), before);
  assert.deepEqual(db.search.checkConsistency().problems, []);
  db.close();
});

// ---- import: hostile input ------------------------------------------------------------------------

test('import rejects things that are not exports at all', () => {
  const db = memDb();
  const rejects = (value, pattern) => assert.throws(() => db.importAll(value), (err) => err instanceof DbError && err.code === 'invalid_import' && (!pattern || pattern.test(err.message)), JSON.stringify(value));
  rejects(null);
  rejects(undefined);
  rejects('string');
  rejects(42);
  rejects([]);
  rejects([{ id: 'x' }]);
  rejects({});
  rejects({ foo: 'bar' });
  rejects({ app: 'otherapp', entries: [] }, /not exported by MyJournal/);
  rejects({ app: 'myjournal', version: 2, entries: [] }, /newer/);
  rejects({ app: 'myjournal', version: 0, entries: [] });
  rejects({ app: 'myjournal', version: '1', entries: [] });
  rejects({ app: 'myjournal', entries: 'lots' }, /"entries" must be a list/);
  rejects({ app: 'myjournal', entries: { length: 1e9 } });
  rejects({ app: 'myjournal', memories: {} });
  rejects({ app: 'myjournal', reports: 5 });
  rejects({ entries: [], memories: 'x' });
  assert.equal(db.stats().entries, 0);
  assert.deepEqual(db.importAll({ app: 'myjournal' }).imported, { entries: 0, messages: 0, memories: 0, reports: 0 }, 'an empty export is fine');
  assert.deepEqual(db.importAll({ entries: [] }).imported.entries, 0);
  db.close();
});

test('import skips every kind of invalid entry and counts it', () => {
  const db = memDb();
  const good = { id: 'good', createdAt: T0 };
  const bad = [
    null,
    42,
    'str',
    [],
    {},
    { createdAt: T0 },
    { id: 'no-created' },
    { id: '', createdAt: T0 },
    { id: 'has space', createdAt: T0 },
    { id: 'x'.repeat(101), createdAt: T0 },
    { id: 12, createdAt: T0 },
    { id: '__proto__', createdAt: T0 },
    { id: 'constructor', createdAt: T0 },
    { id: 'prototype', createdAt: T0 },
    { id: 'e-neg', createdAt: -1 },
    { id: 'e-float', createdAt: 1.5 },
    { id: 'e-str', createdAt: '1760000000000' },
    { id: 'e-huge', createdAt: 1e20 },
    { id: 'e-nan', createdAt: NaN },
    { id: 'e-upd', createdAt: T0, updatedAt: 'x' },
    { id: 'e-date', createdAt: T0, date: '2026-02-31' },
    { id: 'e-date2', createdAt: T0, date: 20261008 },
    { id: 'e-title', createdAt: T0, title: 5 },
    { id: 'e-title2', createdAt: T0, title: 'x'.repeat(301) },
    { id: 'e-sum', createdAt: T0, summary: 'x'.repeat(2001) },
    { id: 'e-kind', createdAt: T0, kind: 'secret' },
    { id: 'e-status', createdAt: T0, status: 'deleted' },
    { id: 'e-mood0', createdAt: T0, mood: 0 },
    { id: 'e-mood6', createdAt: T0, mood: 6 },
    { id: 'e-moodf', createdAt: T0, mood: 2.5 },
    { id: 'e-moods', createdAt: T0, mood: '3' },
    { id: 'e-tags', createdAt: T0, tags: 'work' },
    { id: 'e-tags2', createdAt: T0, tags: [1, 2] },
    { id: 'e-emo', createdAt: T0, emotions: { a: 1 } },
    { id: 'e-priv', createdAt: T0, private: 'yes' },
    { id: 'e-pin', createdAt: T0, pinned: 1 },
    { id: 'e-tpl', createdAt: T0, templateId: 'a b' },
    { id: 'e-tpl2', createdAt: T0, templateId: 7 },
    { id: 'e-msgs', createdAt: T0, messages: 'many' },
    { id: 'e-msgs2', createdAt: T0, messages: { length: 1 } },
  ];
  const result = db.importAll({ app: 'myjournal', entries: [good, ...bad, { ...good }] });
  assert.deepEqual(result.imported, { entries: 1, messages: 0, memories: 0, reports: 0 });
  assert.equal(result.skipped, bad.length + 1, 'every bad entry plus the duplicate of "good"');
  assert.deepEqual(db.entries.list().map((e) => e.id), ['good']);
  db.close();
});

test('import skips every kind of invalid message, memory and report', () => {
  const db = memDb();
  const messages = [
    null,
    5,
    {},
    { id: 'm-role', role: 'system', content: 'x', createdAt: T0 },
    { id: 'm-role2', role: 'ASSISTANT', content: 'x', createdAt: T0 },
    { id: 'm-content', role: 'user', content: 5, createdAt: T0 },
    { id: 'm-content2', role: 'user', createdAt: T0 },
    { id: 'm-long', role: 'user', content: 'x'.repeat(200_001), createdAt: T0 },
    { id: 'm-time', role: 'user', content: 'x', createdAt: 'now' },
    { id: 'm-time2', role: 'user', content: 'x', createdAt: -5 },
    { id: 'bad id', role: 'user', content: 'x', createdAt: T0 },
    { role: 'user', content: 'no id', createdAt: T0 },
    { id: 'm-meta', role: 'user', content: 'x', createdAt: T0, meta: 'string' },
    { id: 'm-meta2', role: 'user', content: 'x', createdAt: T0, meta: [] },
    { id: 'm-meta3', role: 'user', content: 'x', createdAt: T0, meta: { big: 'x'.repeat(20_000) } },
    { id: 'm-ok', role: 'user', content: 'valid', createdAt: T0 },
    { id: 'm-ok', role: 'user', content: 'duplicate id', createdAt: T0 },
  ];
  const memories = [
    null,
    { id: 'mem-text', createdAt: T0, text: '' },
    { id: 'mem-text2', createdAt: T0, text: '   ' },
    { id: 'mem-text3', createdAt: T0, text: 7 },
    { id: 'mem-long', createdAt: T0, text: 'x'.repeat(301) },
    { id: 'mem-time', createdAt: 'x', text: 'ok' },
    { id: 'mem-pin', createdAt: T0, text: 'ok', pinned: 'true' },
    { id: 'mem-src', createdAt: T0, text: 'ok', sourceEntryId: 5 },
    { id: 'mem-upd', createdAt: T0, text: 'ok', updatedAt: -1 },
    { text: 'no id', createdAt: T0 },
    { id: 'mem-ok', createdAt: T0, text: 'valid memory' },
    { id: 'mem-ok', createdAt: T0, text: 'duplicate id' },
  ];
  const reports = [
    null,
    { id: 'r-kind', kind: 'daily', periodStart: '2026-10-01', periodEnd: '2026-10-07', content: 'x', createdAt: T0 },
    { id: 'r-date', periodStart: '2026-10-32', periodEnd: '2026-10-07', content: 'x', createdAt: T0 },
    { id: 'r-order', periodStart: '2026-10-08', periodEnd: '2026-10-07', content: 'x', createdAt: T0 },
    { id: 'r-content', periodStart: '2026-10-01', periodEnd: '2026-10-07', content: '', createdAt: T0 },
    { id: 'r-content2', periodStart: '2026-10-01', periodEnd: '2026-10-07', content: 5, createdAt: T0 },
    { id: 'r-long', periodStart: '2026-10-01', periodEnd: '2026-10-07', content: 'x'.repeat(100_001), createdAt: T0 },
    { id: 'r-time', periodStart: '2026-10-01', periodEnd: '2026-10-07', content: 'x' },
    { id: 'r-meta', periodStart: '2026-10-01', periodEnd: '2026-10-07', content: 'x', createdAt: T0, meta: 5 },
    { id: 'r-ok', periodStart: '2026-10-01', periodEnd: '2026-10-07', content: 'valid report', createdAt: T0 },
    { id: 'r-ok', periodStart: '2026-10-01', periodEnd: '2026-10-07', content: 'dup', createdAt: T0 },
  ];
  const result = db.importAll({ app: 'myjournal', entries: [{ id: 'e1', createdAt: T0, messages }], memories, reports });
  assert.deepEqual(result.imported, { entries: 1, messages: 1, memories: 1, reports: 1 });
  assert.equal(result.skipped, messages.length - 1 + memories.length - 1 + reports.length - 1);
  assert.deepEqual(db.messages.list('e1').map((m) => m.id), ['m-ok']);
  assert.deepEqual(db.memories.list().map((m) => m.id), ['mem-ok']);
  assert.deepEqual(db.reports.list().map((r) => r.id), ['r-ok']);
  db.close();
});

test('import ignores prototype-pollution keys everywhere and never pollutes Object.prototype', () => {
  const db = memDb();
  const json = JSON.parse(`{
    "__proto__": { "polluted": "top" },
    "constructor": { "prototype": { "polluted": "ctor" } },
    "prototype": { "polluted": "proto" },
    "app": "myjournal", "version": 1,
    "entries": [{
      "__proto__": { "polluted": "entry", "title": "hijacked" },
      "constructor": "x", "prototype": "y",
      "id": "e1", "createdAt": ${T0}, "title": "Real title",
      "messages": [{
        "__proto__": { "role": "assistant", "polluted": "msg" },
        "id": "m1", "role": "user", "content": "hello", "createdAt": ${T0},
        "meta": { "__proto__": { "polluted": "meta" }, "constructor": { "prototype": { "polluted": "meta2" } }, "prototype": 1, "kind": "reply", "nested": { "__proto__": { "polluted": "deep" }, "ok": true } }
      }]
    }],
    "memories": [{ "__proto__": { "polluted": "mem", "text": "hijacked" }, "id": "mem1", "text": "A real memory", "createdAt": ${T0} }],
    "reports": [{ "__proto__": { "polluted": "rep" }, "id": "r1", "periodStart": "2026-10-01", "periodEnd": "2026-10-07", "content": "Report", "createdAt": ${T0}, "meta": { "__proto__": { "polluted": "rmeta" }, "entryCount": 2 } }]
  }`);
  const result = db.importAll(json);
  assert.deepEqual(result.imported, { entries: 1, messages: 1, memories: 1, reports: 1 });
  for (const probe of [{}, [], Object.prototype, Object.create(null)]) assert.equal(probe.polluted, undefined);
  assert.equal(db.entries.get('e1').title, 'Real title');
  assert.equal(db.memories.list()[0].text, 'A real memory');
  assert.deepEqual(db.messages.get('m1').meta, { kind: 'reply', nested: { ok: true } });
  assert.deepEqual(db.reports.list()[0].meta, { entryCount: 2 });
  assert.equal(db.messages.get('m1').role, 'user');
  // what was stored contains none of the dangerous keys
  const raw = JSON.stringify(db.handle.prepare('SELECT meta FROM messages').all()) + JSON.stringify(db.handle.prepare('SELECT meta FROM reports').all());
  assert.ok(!/__proto__|constructor|prototype/.test(raw), raw);
  db.close();
});

test('import: HTML and SQL in text are stored verbatim and stay inert; huge arrays of junk are fine', () => {
  const db = memDb();
  const evil = `<script>alert(1)</script> '); DROP TABLE entries; -- "quoted"`;
  const junk = Array.from({ length: 3000 }, (_, i) => (i % 3 === 0 ? null : i % 3 === 1 ? { id: `bad id ${i}` } : { id: `ok${i}`, createdAt: T0 + i }));
  const result = db.importAll({
    app: 'myjournal',
    entries: [{ id: 'evil', createdAt: T0, title: evil, tags: [evil], messages: [{ id: 'evil-m', role: 'user', content: evil, createdAt: T0 }] }, ...junk],
  });
  assert.equal(result.imported.entries, 1 + 1000);
  assert.equal(db.entries.get('evil').title, evil.replace(/\s+/g, ' '));
  assert.equal(db.messages.get('evil-m').content, evil);
  assert.equal(db.stats().entries, 1001);
  db.close();
});

test('import: messages with NUL are cleaned, unicode survives', () => {
  const db = memDb();
  db.importAll({ app: 'myjournal', entries: [{ id: 'u', createdAt: T0, title: 'Café 日記 😀', messages: [{ id: 'um', role: 'user', content: 'a\u0000b 😀 日本語', createdAt: T0 }] }] });
  assert.equal(db.messages.get('um').content, 'ab 😀 日本語');
  assert.equal(db.entries.get('u').title, 'Café 日記 😀');
  assert.equal(db.search('日記').length, 1);
  db.close();
});

test('import: tags and emotions are normalised and capped; kind/status/flags default sensibly', () => {
  const db = memDb();
  db.importAll({ app: 'myjournal', entries: [{ id: 'l', createdAt: T0, tags: ['A', 'a', ' B ', ...Array.from({ length: 20 }, (_, i) => `t${i}`)], emotions: ['  CALM  ', 'x'.repeat(100)] }] });
  const e = db.entries.get('l');
  assert.equal(e.tags.length, 8);
  assert.deepEqual(e.tags.slice(0, 2), ['a', 'b']);
  assert.deepEqual(e.emotions, ['calm', 'x'.repeat(24)]);
  assert.deepEqual([e.kind, e.status, e.private, e.pinned, e.mood, e.templateId, e.summary, e.title], ['free', 'open', false, false, null, null, '', '']);
  assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
  db.close();
});

// ---- wipe -----------------------------------------------------------------------------------------

test('wipe removes everything, keeps settings by default, resets for reuse', () => {
  const db = memDb();
  db.settings.set(mergeSettings(db.settings.get(), { onboarded: true }).settings);
  seed(db);
  db.wipe();
  assert.deepEqual(db.stats(), { ...db.stats(), entries: 0, messages: 0, memories: 0, reports: 0 });
  assert.equal(db.settings.get().onboarded, true);
  assert.deepEqual(db.exportAll().entries, []);
  db.wipe({ includeSettings: true });
  assert.equal(db.settings.get().onboarded, false);
  seed(db);
  assert.equal(db.stats().entries, 3);
  assert.deepEqual(db.search.checkConsistency().problems, []);
  db.close();
});

test('wipe actually removes the text from the database file and its WAL', () => {
  const t = scratchDir('wipe');
  try {
    const marker = 'zxqvmarkerphrase-wipe-me';
    const db = openDb({ file: t.file });
    for (let i = 0; i < 20; i++) entryWith(db, [`${marker} number ${i}`], { title: `${marker} title`, tags: [marker] });
    db.memories.create({ text: `${marker} memory` });
    db.reports.create({ periodStart: '2026-10-01', periodEnd: '2026-10-07', content: `${marker} report` });
    db.wipe();
    const dir = join(t.dir, 'data');
    for (const name of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, name));
      assert.ok(!bytes.includes(marker), `${name} still contains wiped text`);
    }
    db.close();
    for (const name of readdirSync(dir)) {
      assert.ok(!readFileSync(join(dir, name)).includes(marker), `${name} still contains wiped text after close`);
    }
  } finally {
    t.cleanup();
  }
});

// The FTS5 index keeps every word of deleted rows in old segments unless it is purged, so these tests
// look for single lowercase tokens (what the index stores), not for whole phrases.
function leftovers(dir, tokens) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, name)).toString('latin1');
    for (const token of tokens) if (bytes.includes(token)) found.push(`${name}: ${token}`);
  }
  return found;
}

function bigJournal(db, prefix, count = 40) {
  for (let i = 0; i < count; i++) {
    entryWith(db, [`my diary says ${prefix}body${i} and ${prefix}shared number ${i}`], { title: `${prefix}title${i}`, tags: [`${prefix}tag${i}`] });
  }
}

test('wipe also purges every indexed word from the database file and its WAL', () => {
  const t = scratchDir('wipewords');
  try {
    const db = openDb({ file: t.file });
    const dir = join(t.dir, 'data');
    bigJournal(db, 'zyxq');
    db.memories.create({ text: 'zyxqmemory fact' });
    const tokens = ['zyxqbody', 'zyxqshared', 'zyxqtitle', 'zyxqtag', 'zyxqmemory'];
    assert.ok(leftovers(dir, tokens).length > 0, 'sanity: the words are in the files before the wipe');
    db.wipe();
    assert.deepEqual(leftovers(dir, tokens), [], 'after wipe, journal still open');
    // fresh content written after a wipe is purged by the next wipe as well (index structure differs)
    bigJournal(db, 'qwvk', 3);
    db.wipe();
    assert.deepEqual(leftovers(dir, ['qwvkbody', 'qwvkshared', 'qwvktitle', 'qwvktag']), [], 'second wipe');
    assert.deepEqual(db.search.checkConsistency().problems, []);
    db.close();
    assert.deepEqual(leftovers(dir, tokens), [], 'after close');
  } finally {
    t.cleanup();
  }
});

test('deleting an entry purges its words from the search index, not only its text', () => {
  const t = scratchDir('deletewords');
  try {
    const db = openDb({ file: t.file });
    const dir = join(t.dir, 'data');
    bigJournal(db, 'keepr', 12);
    const doomed = entryWith(db, ['quokkaflorbs confession'], { title: 'Doomed Title', tags: ['verysecrettag'] });
    const tokens = ['quokkaflorbs', 'confession', 'doomed', 'verysecrettag'];
    db.entries.delete(doomed.id);
    // Without closing: move everything out of the WAL, then look at the database file itself.
    db.handle.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.deepEqual(leftovers(dir, tokens), [], 'deleted entry words must not linger in the index');
    assert.ok(leftovers(dir, ['keeprbody0']).length > 0, 'other entries stay indexed');
    assert.equal(db.search('quokkaflorbs', { includePrivate: true }).length, 0);
    assert.equal(db.search('keeprtitle3').length, 1);
    assert.deepEqual(db.search.checkConsistency().problems, []);
    db.close();
    assert.deepEqual(leftovers(dir, tokens), [], 'after close');
  } finally {
    t.cleanup();
  }
});

test('close() purges the words of edited and deleted messages and retitled entries', () => {
  const t = scratchDir('editwords');
  try {
    const db = openDb({ file: t.file });
    const dir = join(t.dir, 'data');
    bigJournal(db, 'stayr', 12);
    const e = entryWith(db, ['first xylophonic secret', 'second marimbaish secret'], { title: 'Whistlebox', tags: ['glockenspiel'] });
    const [first] = db.messages.list(e.id);
    db.messages.update(first.id, { content: 'first rewritten text' });
    db.messages.deleteLast(e.id);
    db.entries.update(e.id, { title: 'Plain title', tags: ['plain'] });
    const tokens = ['xylophonic', 'marimbaish', 'whistlebox', 'glockenspiel'];
    db.close();
    assert.deepEqual(leftovers(dir, tokens), []);
    const again = openDb({ file: t.file });
    assert.equal(again.search('rewritten').length, 1);
    assert.equal(again.search('xylophonic').length, 0);
    assert.deepEqual(again.search.checkConsistency().problems, []);
    again.close();
  } finally {
    t.cleanup();
  }
});

test('deleting an entry overwrites its text (secure_delete)', () => {
  const t = scratchDir('securedelete');
  try {
    const marker = 'qjxkdeletedmarker-secure';
    const db = openDb({ file: t.file });
    const e = entryWith(db, [`${marker} words words words`], { title: marker });
    entryWith(db, ['unrelated survivor'], { title: 'Survivor' });
    db.entries.delete(e.id);
    db.close();
    const dir = join(t.dir, 'data');
    for (const name of readdirSync(dir)) assert.ok(!readFileSync(join(dir, name)).includes(marker), `${name} still contains deleted text`);
  } finally {
    t.cleanup();
  }
});

// secure_delete zeroes the freed pages, but they sit in the write-ahead log (and the old index words in old segments) until a
// checkpoint: a deleted entry stayed readable in journal.db until the server stopped cleanly, and in journal.db-wal after a crash.
test('scrub() makes just-deleted text unreadable in the files at once, without closing', () => {
  const t = scratchDir('scrub');
  try {
    const db = openDb({ file: t.file });
    const dir = join(t.dir, 'data');
    bigJournal(db, 'scrubq', 30);
    const doomed = entryWith(db, ['my diary says scrubzdoomedbody and scrubzdoomedshared'], { title: 'scrubztitle', tags: ['scrubztag'] });
    const memory = db.memories.create({ text: 'scrubzdoomed memory' });
    const report = db.reports.create({ periodStart: '2026-10-01', periodEnd: '2026-10-07', content: 'scrubzdoomed report' });
    db.handle.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // everything is now in the main file
    const tokens = ['scrubzdoomedbody', 'scrubzdoomedshared', 'scrubztitle', 'scrubztag', 'scrubzdoomed memory', 'scrubzdoomed report'];
    assert.equal(leftovers(dir, tokens).length >= 4, true, 'the setup must put the text in the file');

    db.entries.delete(doomed.id);
    db.memories.delete(memory.id);
    db.reports.delete(report.id);
    assert.ok(leftovers(dir, tokens).length > 0, 'before scrub() the deleted text is still in the file (that is what scrub() fixes)');

    db.scrub();
    assert.deepEqual(leftovers(dir, tokens), []);
    assert.equal(db.search('scrubq').length > 0, true, 'the index of the other entries still works');
    assert.deepEqual(db.search.checkConsistency().problems, []);
    db.close();
  } finally {
    t.cleanup();
  }
});

test('scrub() is harmless on an in-memory database and inside nothing', () => {
  const db = memDb();
  entryWith(db, ['hello']);
  assert.doesNotThrow(() => db.scrub());
  db.close();
});
