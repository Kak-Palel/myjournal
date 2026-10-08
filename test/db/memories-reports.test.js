import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DbError } from '../../src/db/index.js';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/settings.js';
import { memDb, scratchDir } from './helpers.js';
import { openDb } from '../../src/db/index.js';

const invalid = (fn, field) => assert.throws(fn, (e) => e instanceof DbError && e.code === 'invalid' && (!field || e.field === field));

// ---- memories ----------------------------------------------------------------------------------

test('memories: create / get shape, defaults', () => {
  const db = memDb();
  const m = db.memories.create({ text: '  Has a younger sister   called Maya ' });
  assert.deepEqual({ ...m, id: 'x', createdAt: 0, updatedAt: 0 }, { id: 'x', text: 'Has a younger sister called Maya', pinned: false, sourceEntryId: null, createdAt: 0, updatedAt: 0 });
  assert.equal(m.createdAt, m.updatedAt);
  assert.deepEqual(db.memories.get(m.id), m);
  assert.equal(db.memories.get('nope'), null);
  db.close();
});

test('memories: list is pinned first, then newest first', () => {
  const db = memDb();
  const a = db.memories.create({ text: 'old' });
  const b = db.memories.create({ text: 'pinned old', pinned: true });
  const c = db.memories.create({ text: 'new' });
  const d = db.memories.create({ text: 'pinned new', pinned: true });
  assert.deepEqual(db.memories.list().map((m) => m.text), ['pinned new', 'pinned old', 'new', 'old']);
  assert.ok([a, b, c, d].every((m) => m.id));
  db.close();
});

test('memories: validation (empty, too long, wrong types) and boundary of 300 characters', () => {
  const db = memDb();
  invalid(() => db.memories.create({ text: '' }), 'text');
  invalid(() => db.memories.create({ text: '   \n ' }), 'text');
  invalid(() => db.memories.create({ text: 5 }), 'text');
  invalid(() => db.memories.create({}), 'text');
  invalid(() => db.memories.create(null), 'memory');
  invalid(() => db.memories.create({ text: 'x'.repeat(301) }), 'text');
  invalid(() => db.memories.create({ text: 'ok', pinned: 'yes' }), 'pinned');
  invalid(() => db.memories.create({ text: 'ok', sourceEntryId: 5 }), 'sourceEntryId');
  assert.equal(db.memories.create({ text: 'y'.repeat(300) }).text.length, 300);
  assert.equal(db.memories.create({ text: '😀'.repeat(300) }).text, '😀'.repeat(300), '300 code points, not UTF-16 units');
  invalid(() => db.memories.create({ text: '😀'.repeat(301) }), 'text');
  db.close();
});

test('memories.exists is case, whitespace and trailing-punctuation insensitive', () => {
  const db = memDb();
  db.memories.create({ text: 'Has a sister called Maya.' });
  db.memories.create({ text: '  Works at a   Bakery  ' });
  for (const same of ['has a sister called maya', 'HAS A SISTER CALLED MAYA!!', '  has  a sister\tcalled Maya… ', '- Has a sister called Maya', '"Has a sister called Maya."']) {
    assert.equal(db.memories.exists(same), true, same);
  }
  assert.equal(db.memories.exists('works at a bakery'), true);
  assert.equal(db.memories.exists('Has a brother called Maya'), false);
  assert.equal(db.memories.exists('Has a sister'), false, 'prefix is not a duplicate');
  assert.equal(db.memories.exists(''), false);
  assert.equal(db.memories.exists('...'), false);
  assert.equal(db.memories.exists(undefined), false);
  db.close();
});

test('memories.exists follows edits and deletions', () => {
  const db = memDb();
  const m = db.memories.create({ text: 'Likes tea' });
  assert.equal(db.memories.exists('likes tea'), true);
  db.memories.update(m.id, { text: 'Likes coffee' });
  assert.equal(db.memories.exists('likes tea'), false);
  assert.equal(db.memories.exists('Likes COFFEE.'), true);
  db.memories.delete(m.id);
  assert.equal(db.memories.exists('likes coffee'), false);
  db.close();
});

test('memories: update text / pinned, null for unknown id, no-op patch', () => {
  const db = memDb();
  const m = db.memories.create({ text: 'a' });
  const u = db.memories.update(m.id, { pinned: true });
  assert.equal(u.pinned, true);
  assert.equal(u.text, 'a');
  assert.ok(u.updatedAt >= m.updatedAt);
  assert.equal(db.memories.update(m.id, { text: 'b' }).pinned, true, 'pinned survives a text edit');
  assert.deepEqual(db.memories.update(m.id, {}), db.memories.get(m.id));
  assert.equal(db.memories.update('missing', { text: 'x' }), null);
  invalid(() => db.memories.update(m.id, { text: '' }), 'text');
  invalid(() => db.memories.update(m.id, { pinned: 1 }), 'pinned');
  assert.equal(db.memories.get(m.id).text, 'b');
  db.close();
});

test('memories: delete and clear', () => {
  const db = memDb();
  const a = db.memories.create({ text: 'a' });
  db.memories.create({ text: 'b' });
  db.memories.create({ text: 'c' });
  assert.equal(db.memories.delete(a.id), true);
  assert.equal(db.memories.delete(a.id), false);
  assert.equal(db.memories.delete(undefined), false);
  assert.equal(db.memories.clear(), 2);
  assert.equal(db.memories.clear(), 0);
  assert.deepEqual(db.memories.list(), []);
  db.close();
});

test('memories: sourceEntryId is kept, nulled when the entry is deleted, and nulled when it does not exist', () => {
  const db = memDb();
  const e = db.entries.create();
  const m = db.memories.create({ text: 'from entry', sourceEntryId: e.id });
  assert.equal(m.sourceEntryId, e.id);
  assert.equal(db.memories.create({ text: 'ghost', sourceEntryId: 'not-an-entry' }).sourceEntryId, null);
  db.entries.delete(e.id);
  assert.equal(db.memories.get(m.id).sourceEntryId, null);
  assert.equal(db.memories.get(m.id).text, 'from entry');
  db.close();
});

test('memories: SQL-looking text is stored verbatim', () => {
  const db = memDb();
  const text = `Robert'); DROP TABLE memories;-- "quoted" 100% _under_`;
  const m = db.memories.create({ text });
  assert.equal(db.memories.get(m.id).text, text);
  assert.equal(db.memories.exists(text), true);
  db.close();
});

// ---- reports -----------------------------------------------------------------------------------

test('reports: create / list newest first / get / delete', () => {
  const db = memDb();
  const a = db.reports.create({ periodStart: '2026-09-25', periodEnd: '2026-10-01', content: 'First week', meta: { provider: 'gemini', model: 'm', entryCount: 5 } });
  const b = db.reports.create({ kind: 'weekly', periodStart: '2026-10-02', periodEnd: '2026-10-08', content: '**Second** week\n\n- bullet' });
  assert.deepEqual({ ...a, id: 'x', createdAt: 0 }, { id: 'x', kind: 'weekly', periodStart: '2026-09-25', periodEnd: '2026-10-01', content: 'First week', createdAt: 0, meta: { provider: 'gemini', model: 'm', entryCount: 5 } });
  assert.deepEqual(b.meta, {});
  assert.deepEqual(db.reports.list().map((r) => r.id), [b.id, a.id]);
  assert.deepEqual(db.reports.get(a.id), a);
  assert.equal(db.reports.get('nope'), null);
  assert.equal(db.reports.delete(a.id), true);
  assert.equal(db.reports.delete(a.id), false);
  assert.equal(db.reports.delete(null), false);
  assert.deepEqual(db.reports.list().map((r) => r.id), [b.id]);
  db.close();
});

test('reports: validation', () => {
  const db = memDb();
  const ok = { periodStart: '2026-10-02', periodEnd: '2026-10-08', content: 'text' };
  invalid(() => db.reports.create({ ...ok, kind: 'daily' }), 'kind');
  invalid(() => db.reports.create({ ...ok, periodStart: '2026-13-01' }), 'periodStart');
  invalid(() => db.reports.create({ ...ok, periodEnd: 'x' }), 'periodEnd');
  invalid(() => db.reports.create({ ...ok, periodEnd: '2026-10-01' }), 'periodEnd');
  invalid(() => db.reports.create({ ...ok, content: '' }), 'content');
  invalid(() => db.reports.create({ ...ok, content: '   ' }), 'content');
  invalid(() => db.reports.create({ ...ok, content: 'x'.repeat(100_001) }), 'content');
  invalid(() => db.reports.create({ ...ok, meta: 'x' }), 'meta');
  invalid(() => db.reports.create(undefined), 'report');
  assert.equal(db.reports.list().length, 0);
  assert.equal(db.reports.create({ ...ok, periodEnd: '2026-10-02' }).periodEnd, '2026-10-02', 'single-day period is fine');
  db.close();
});

// ---- settings store ----------------------------------------------------------------------------

test('settings.get returns defaults on a fresh database, as a fresh copy each time', () => {
  const db = memDb();
  const a = db.settings.get();
  assert.deepEqual(a, DEFAULT_SETTINGS);
  a.profile.name = 'mutated';
  assert.equal(db.settings.get().profile.name, '');
  db.close();
});

test('settings.exists() is false until the first save, false again after a wipe with settings, and ignores unreadable documents', () => {
  const t = scratchDir('settings-exists');
  try {
    let db = openDb({ file: t.file });
    assert.equal(db.settings.exists(), false, 'a fresh database has no settings document');
    db.settings.get(); // reading does not create one
    assert.equal(db.settings.exists(), false);
    db.settings.set({ onboarded: true });
    assert.equal(db.settings.exists(), true);
    db.close();
    db = openDb({ file: t.file });
    assert.equal(db.settings.exists(), true, 'survives a reopen');
    db.wipe();
    assert.equal(db.settings.exists(), true, 'a wipe keeps the settings by default');
    db.wipe({ includeSettings: true });
    assert.equal(db.settings.exists(), false, 'and a wipe with settings makes the install fresh again');
    // an unreadable document does not count: the install is treated as fresh until the next save repairs it
    db.handle.prepare("INSERT INTO settings (key, value) VALUES ('app', ?)").run('{not json');
    assert.equal(db.settings.exists(), false);
    db.handle.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run('"a string"');
    assert.equal(db.settings.exists(), false);
    db.settings.set({ onboarded: true });
    assert.equal(db.settings.exists(), true);
    db.close();
  } finally {
    t.cleanup();
  }
});

test('settings.set / get round trip with normalisation', () => {
  const db = memDb();
  const { settings } = mergeSettings(db.settings.get(), { onboarded: true, profile: { name: 'Sam' }, ai: { provider: 'local', providers: { openai: { apiKey: 'sk-secretkey-1234' } } } });
  const stored = db.settings.set(settings);
  assert.deepEqual(stored, settings);
  assert.deepEqual(db.settings.get(), settings);
  const sloppy = db.settings.set({ onboarded: 'maybe', ai: { temperature: 50, evil: true } });
  assert.equal(sloppy.onboarded, false);
  assert.equal(sloppy.ai.temperature, 2);
  assert.equal(Object.hasOwn(sloppy.ai, 'evil'), false);
  db.close();
});

test('settings.set keeps a saved key when the new document has no apiKey property, clears it when apiKey is explicit', () => {
  const db = memDb();
  db.settings.set(mergeSettings(db.settings.get(), { ai: { providers: { gemini: { apiKey: 'AIza-saved-key-0001' } } } }).settings);
  // a "public" document (no apiKey anywhere) must not wipe the key
  db.settings.set({ onboarded: true, ai: { providers: { gemini: { model: 'gemini-x', apiKeySet: false } } } });
  assert.equal(db.settings.get().ai.providers.gemini.apiKey, 'AIza-saved-key-0001');
  assert.equal(db.settings.get().ai.providers.gemini.model, 'gemini-x');
  db.settings.set({ ai: { providers: { gemini: { apiKey: '' } } } });
  assert.equal(db.settings.get().ai.providers.gemini.apiKey, '');
  db.close();
});

test('settings.get survives a corrupt stored document', () => {
  const db = memDb();
  db.handle.prepare("INSERT INTO settings (key, value) VALUES ('app', ?)").run('{not json');
  assert.deepEqual(db.settings.get(), DEFAULT_SETTINGS);
  db.handle.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run('"a string"');
  assert.deepEqual(db.settings.get(), DEFAULT_SETTINGS);
  db.settings.set({ onboarded: true });
  assert.equal(db.settings.get().onboarded, true);
  db.close();
});

test('settings persist across reopen; wipe keeps them unless asked', () => {
  const t = scratchDir('settings');
  try {
    let db = openDb({ file: t.file });
    db.settings.set(mergeSettings(db.settings.get(), { onboarded: true, ai: { providers: { openai: { apiKey: 'sk-persist-0000' } } } }).settings);
    db.entries.create({ title: 'x' });
    db.close();
    db = openDb({ file: t.file });
    assert.equal(db.settings.get().ai.providers.openai.apiKey, 'sk-persist-0000');
    db.wipe();
    assert.equal(db.settings.get().onboarded, true);
    assert.equal(db.stats().entries, 0);
    db.wipe({ includeSettings: true });
    assert.deepEqual(db.settings.get(), DEFAULT_SETTINGS);
    db.close();
  } finally {
    t.cleanup();
  }
});
