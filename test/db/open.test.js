import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DbError, SCHEMA_VERSION, openDb } from '../../src/db/index.js';
import { MIGRATIONS, applyMigrations, assertWritable } from '../../src/db/schema.js';
import { createContext } from '../../src/db/context.js';
import { memDb, scratchDir } from './helpers.js';

test('openDb requires a file', () => {
  assert.throws(() => openDb(), TypeError);
  assert.throws(() => openDb({}), TypeError);
  assert.throws(() => openDb({ file: '' }), TypeError);
  assert.throws(() => openDb({ file: 42 }), TypeError);
});

test(':memory: works, is fresh each time, and close() is idempotent', () => {
  const a = memDb();
  const b = memDb();
  a.entries.create({ title: 'only in a' });
  assert.equal(a.stats().entries, 1);
  assert.equal(b.stats().entries, 0);
  assert.equal(a.file, ':memory:');
  assert.equal(a.isOpen, true);
  a.close();
  a.close();
  assert.equal(a.isOpen, false);
  b.close();
});

test('creates missing directories with 0700, the file with 0600, and uses WAL', { skip: process.platform === 'win32' }, () => {
  const t = scratchDir('perm');
  try {
    const db = openDb({ file: t.file });
    db.entries.create({ title: 'x' });
    const dir = join(t.dir, 'data');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(t.file).mode & 0o777, 0o600);
    assert.equal(db.handle.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.handle.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.ok(db.handle.prepare('PRAGMA busy_timeout').get().timeout >= 1000);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(t.file + suffix)) assert.equal(statSync(t.file + suffix).mode & 0o777, 0o600, suffix);
    }
    db.close();
  } finally {
    t.cleanup();
  }
});

test('tightens the mode of an existing world-readable file but leaves an existing directory alone', { skip: process.platform === 'win32' }, () => {
  const t = scratchDir('existing');
  try {
    const dir = join(t.dir, 'data');
    mkdirSync(dir, { mode: 0o755 });
    writeFileSync(t.file, '', { mode: 0o644 });
    const db = openDb({ file: t.file });
    db.close();
    assert.equal(statSync(t.file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o755, 'an existing directory is not ours to chmod');
  } finally {
    t.cleanup();
  }
});

test('reopening an existing database keeps data, schema version and settings', () => {
  const t = scratchDir('reopen');
  try {
    let db = openDb({ file: t.file });
    const e = db.entries.create({ title: 'Persisted', tags: ['a'] });
    db.messages.add(e.id, { role: 'user', content: 'Hello again world' });
    db.memories.create({ text: 'Likes tea', sourceEntryId: e.id });
    db.settings.set({ ...db.settings.get(), onboarded: true });
    assert.equal(db.handle.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    db.close();

    db = openDb({ file: t.file });
    const again = db.entries.get(e.id);
    assert.equal(again.title, 'Persisted');
    assert.equal(again.wordCount, 3);
    assert.equal(db.messages.list(e.id).length, 1);
    assert.equal(db.memories.list()[0].sourceEntryId, e.id);
    assert.equal(db.settings.get().onboarded, true);
    assert.equal(db.search('hello').length, 1);
    assert.deepEqual(db.search.checkConsistency().problems, []);
    db.close();
  } finally {
    t.cleanup();
  }
});

test('two connections to the same file see each other and do not deadlock', () => {
  const t = scratchDir('twoconn');
  try {
    const a = openDb({ file: t.file });
    const b = openDb({ file: t.file });
    const e = a.entries.create({ title: 'from a' });
    assert.equal(b.entries.get(e.id).title, 'from a');
    b.messages.add(e.id, { role: 'user', content: 'from b' });
    assert.equal(a.messages.list(e.id).length, 1);
    a.close();
    b.close();
  } finally {
    t.cleanup();
  }
});

test('a database with a NEWER user_version is refused with a clear error and left untouched', () => {
  const t = scratchDir('newer');
  try {
    let db = openDb({ file: t.file });
    db.entries.create({ title: 'precious' });
    db.close();
    const raw = new DatabaseSync(t.file);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    raw.close();
    const before = readFileSync(t.file);

    assert.throws(
      () => openDb({ file: t.file }),
      (err) => {
        assert.ok(err instanceof DbError);
        assert.equal(err.code, 'schema_too_new');
        assert.match(err.message, /newer version of MyJournal/);
        assert.match(err.message, new RegExp(`v${SCHEMA_VERSION + 5}`));
        return true;
      },
    );
    assert.deepEqual(readFileSync(t.file), before, 'file must not be modified');

    const check = new DatabaseSync(t.file);
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION + 5);
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM entries').get().n, 1);
    check.close();
  } finally {
    t.cleanup();
  }
});

test('a file that is not a database gives a clear open_failed error', () => {
  const t = scratchDir('garbage');
  try {
    mkdirSync(join(t.dir, 'data'));
    writeFileSync(t.file, 'this is definitely not a sqlite database, it is just text. '.repeat(100));
    assert.throws(
      () => openDb({ file: t.file }),
      (err) => err instanceof DbError && err.code === 'open_failed' && err.message.includes(t.file),
    );
  } finally {
    t.cleanup();
  }
});

test('assertWritable passes on a normal database and leaves no transaction or change behind', () => {
  const t = scratchDir('writable');
  try {
    const db = openDb({ file: t.file });
    db.entries.create({ title: 'kept' });
    const version = db.handle.prepare('PRAGMA user_version').get().user_version;
    assertWritable(db.handle, t.file);
    assert.equal(db.handle.isTransaction, false);
    assert.equal(db.handle.prepare('PRAGMA user_version').get().user_version, version);
    assert.equal(db.entries.count(), 1);
    db.close();
    const memory = memDb();
    assertWritable(memory.handle);
    memory.close();
  } finally {
    t.cleanup();
  }
});

test('assertWritable rejects a connection that can only read, with a clear open_failed error', () => {
  const t = scratchDir('readonly-handle');
  try {
    const db = openDb({ file: t.file });
    db.entries.create({ title: 'kept' });
    db.close();
    const readOnly = new DatabaseSync(t.file, { readOnly: true });
    assert.throws(
      () => assertWritable(readOnly, t.file),
      (err) => err instanceof DbError && err.code === 'open_failed' && /read-only/.test(err.message) && err.message.includes(t.file),
    );
    assert.equal(readOnly.prepare('SELECT COUNT(*) AS n FROM entries').get().n, 1, 'the connection is still usable for reading');
    readOnly.close();
  } finally {
    t.cleanup();
  }
});

// SQLite opens a file the process cannot write in read-only mode without complaining, and in WAL mode
// even BEGIN IMMEDIATE succeeds on it. The realistic case is a root-owned file left by `sudo npm start`,
// which a normal user can neither write nor chmod; it can only be reproduced by dropping privileges.
function runAsNobody(args) {
  const run = spawnSync('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', process.execPath, '--disable-warning=ExperimentalWarning', ...args], { encoding: 'utf8', timeout: 30_000 });
  return run;
}

test('openDb fails fast on a database file the process may not write (root-owned, opened by another user)', (ctx) => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() !== 0) {
    ctx.skip('needs root, to create a file that another user owns');
    return;
  }
  const preflight = runAsNobody(['-e', 'process.exit(0)']);
  if (preflight.error || preflight.status !== 0) {
    ctx.skip('cannot run node as an unprivileged user here (setpriv missing or node not reachable)');
    return;
  }
  const t = scratchDir('readonly-file');
  try {
    const db = openDb({ file: t.file });
    db.entries.create({ title: 'kept' });
    db.close();
    const folder = join(t.dir, 'data');
    chmodSync(t.dir, 0o755);
    chmodSync(folder, 0o777); // a writable folder: SQLite can create -wal/-shm, which is what hides the problem
    chmodSync(t.file, 0o444);
    const probe = new URL('./fixtures/open-probe.mjs', import.meta.url).pathname;
    const run = runAsNobody([probe, t.file]);
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
    assert.equal(result.opened, false, `opened a read-only database; the first write said: ${result.write}`);
    assert.equal(result.name, 'DbError');
    assert.equal(result.code, 'open_failed');
    assert.match(result.message, /read-only/);
    // the owner is not affected
    const again = openDb({ file: t.file });
    assert.equal(again.entries.count(), 1);
    again.close();
  } finally {
    t.cleanup();
  }
});

test('applyMigrations upgrades step by step and records the version', () => {
  const handle = new DatabaseSync(':memory:');
  const log = [];
  const migrations = [
    { version: 1, up: (h) => (log.push(1), h.exec('CREATE TABLE a (x)')) },
    { version: 2, up: (h) => (log.push(2), h.exec('ALTER TABLE a ADD COLUMN y')) },
  ];
  assert.equal(applyMigrations(handle, migrations.slice(0, 1)), 1);
  assert.equal(applyMigrations(handle, migrations), 2);
  assert.equal(applyMigrations(handle, migrations), 2, 'second run is a no-op');
  assert.deepEqual(log, [1, 2]);
  assert.equal(handle.prepare('PRAGMA user_version').get().user_version, 2);
  handle.close();
});

test('a failing migration rolls back completely and leaves the old version', () => {
  const handle = new DatabaseSync(':memory:');
  const migrations = [
    { version: 1, up: (h) => h.exec('CREATE TABLE a (x)') },
    {
      version: 2,
      up: (h) => {
        h.exec('CREATE TABLE b (x)');
        throw new Error('boom');
      },
    },
  ];
  assert.throws(() => applyMigrations(handle, migrations), /boom/);
  assert.equal(handle.prepare('PRAGMA user_version').get().user_version, 1);
  const tables = handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(tables.includes('a'));
  assert.ok(!tables.includes('b'));
  handle.close();
});

test('migrations must be numbered without gaps; newer detection works through applyMigrations', () => {
  const handle = new DatabaseSync(':memory:');
  assert.throws(() => applyMigrations(handle, [{ version: 2, up() {} }]), /without gaps/);
  handle.exec('PRAGMA user_version = 99');
  assert.throws(() => applyMigrations(handle, MIGRATIONS), (err) => err.code === 'schema_too_new');
  handle.close();
});

test('shipped schema: tables, indexes and FTS table exist', () => {
  const db = memDb();
  const names = db.handle.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  for (const name of ['entries', 'messages', 'memories', 'reports', 'settings', 'entry_search', 'entries_created', 'entries_date']) {
    assert.ok(names.includes(name), `${name} missing`);
  }
  db.close();
});

test('tx: commits, rolls back on error, is re-entrant with savepoints', () => {
  const db = memDb();
  const before = db.stats().entries;
  assert.throws(
    () =>
      db.tx(() => {
        db.entries.create({ title: 'rolled back' });
        throw new Error('nope');
      }),
    /nope/,
  );
  assert.equal(db.stats().entries, before);

  const result = db.tx(() => {
    db.entries.create({ title: 'outer' });
    try {
      db.tx(() => {
        db.entries.create({ title: 'inner failing' });
        throw new Error('inner');
      });
    } catch {
      // the outer transaction continues
    }
    db.tx(() => db.entries.create({ title: 'inner ok' }));
    return 'done';
  });
  assert.equal(result, 'done');
  assert.deepEqual(db.entries.list().map((e) => e.title).sort(), ['inner ok', 'outer']);

  // an error in the outer transaction after a successful inner one rolls back both
  assert.throws(() =>
    db.tx(() => {
      db.tx(() => db.entries.create({ title: 'inner committed into outer' }));
      throw new Error('outer fails');
    }),
  );
  assert.equal(db.entries.list().length, 2);
  // the connection is usable afterwards
  db.entries.create({ title: 'still works' });
  assert.equal(db.entries.list().length, 3);
  db.close();
});

test('tx rejects async callbacks instead of committing early', async () => {
  const db = memDb();
  assert.throws(() => db.tx(async () => db.entries.create({ title: 'x' })), (err) => err.code === 'invalid');
  assert.equal(db.stats().entries, 0, 'work done before the rejection is rolled back');
  db.entries.create({ title: 'ok afterwards' });
  db.close();
});

test('prepared statement cache is bounded', () => {
  const db = memDb();
  const ctx = createContext(db.handle, Date.now);
  for (let i = 0; i < 700; i++) ctx.one(`SELECT ${i} AS n`);
  assert.equal(ctx.one('SELECT 5 AS n').n, 5);
  db.close();
});

test('stats counts rows and reports a size', () => {
  const db = memDb();
  const e = db.entries.create({ title: 'a' });
  db.messages.add(e.id, { role: 'user', content: 'x y z' });
  db.memories.create({ text: 'fact' });
  db.reports.create({ periodStart: '2026-10-01', periodEnd: '2026-10-07', content: 'report' });
  const s = db.stats();
  assert.deepEqual({ ...s, dbBytes: s.dbBytes > 0 }, { entries: 1, messages: 1, memories: 1, reports: 1, dbBytes: true });
  db.close();
});
