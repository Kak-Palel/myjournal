// Schema and migrations. The schema version lives in PRAGMA user_version; each migration runs
// in its own immediate transaction, so a crash never leaves a half-migrated database.

import { MIN_NODE } from '../server/node-version.js'; // import-free on purpose: it is the one place that names the supported Node.js
import { DbError } from './util.js';

const V1 = `
-- rid is an explicit rowid alias: it never changes (not even on VACUUM) and doubles as the
-- rowid of the matching entry_search row, which makes index updates O(log n).
CREATE TABLE IF NOT EXISTS entries (
  rid         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  entry_date  TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'free' CHECK (kind IN ('free', 'guided')),
  template_id TEXT,
  mood        INTEGER CHECK (mood IS NULL OR mood BETWEEN 1 AND 5),
  emotions    TEXT NOT NULL DEFAULT '[]',
  tags        TEXT NOT NULL DEFAULT '[]',
  summary     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'wrapped')),
  private     INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1)),
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  word_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS entries_created ON entries (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS entries_date ON entries (entry_date);

-- UNIQUE (entry_id, seq) also provides the (entry_id, seq) index used for ordering.
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',
  UNIQUE (entry_id, seq)
);

-- source_entry_id becomes NULL when its entry is deleted: the fact outlives the entry.
-- text_norm is the dedupe key (see normalizeMemoryText).
CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  text            TEXT NOT NULL,
  text_norm       TEXT NOT NULL,
  pinned          INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  source_entry_id TEXT REFERENCES entries (id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_norm ON memories (text_norm);
CREATE INDEX IF NOT EXISTS memories_source ON memories (source_entry_id);

CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  content      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  meta         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS reports_created ON reports (created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- FTS tables have no foreign keys: the repositories keep this in sync inside the same
-- transaction (see search.js). rowid = entries.rid.
CREATE VIRTUAL TABLE IF NOT EXISTS entry_search USING fts5(
  entry_id UNINDEXED, title, body, tags,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
`;

/**
 * Ordered, contiguous migrations. Never edit a shipped migration; append a new one.
 * @type {{ version: number, up: (handle: import('node:sqlite').DatabaseSync) => void }[]}
 */
export const MIGRATIONS = [
  {
    version: 1,
    up(handle) {
      try {
        handle.exec(V1);
      } catch (err) {
        if (/fts5/i.test(String(err && err.message))) {
          throw new DbError(
            'no_fts5',
            `The SQLite inside this Node.js (v${process.versions.node}) has no FTS5 full-text search, which MyJournal needs. `
              + `Use Node.js ${MIN_NODE.major}.${MIN_NODE.minor} or newer (not 23.x), or 24 or newer.`,
            { cause: err },
          );
        }
        throw err;
      }
    },
  },
];

/** Schema version this build creates and understands. */
export const SCHEMA_VERSION = MIGRATIONS.at(-1).version;

function readVersion(handle) {
  return Number(handle.prepare('PRAGMA user_version').get().user_version);
}

function tooNew(found, supported) {
  return new DbError(
    'schema_too_new',
    `This journal database was written by a newer version of MyJournal (schema v${found}; this version understands up to v${supported}). ` +
      'Update MyJournal, or point JOURNAL_DATA_DIR at a different folder. The database was not modified.',
  );
}

/** Throw a clear error if the database was created by a newer build. Read-only. */
export function assertNotNewer(handle, migrations = MIGRATIONS) {
  const supported = migrations.at(-1).version;
  const found = readVersion(handle);
  if (found > supported) throw tooNew(found, supported);
  return found;
}

const SQLITE_READONLY = 8; // primary result code; extended codes (e.g. READONLY_DBMOVED) keep it in the low byte

function isReadOnlyError(err) {
  const code = typeof err?.errcode === 'number' ? err.errcode & 0xff : 0;
  return code === SQLITE_READONLY || /readonly|read-only/i.test(String(err?.message));
}

/**
 * Fail fast if the database can only be read. SQLite silently opens a file the process may not
 * write (for instance a root-owned file left by one `sudo npm start`) in read-only mode, and the
 * first save of a journal entry would then fail at request time instead of at startup.
 *
 * It really writes a page and rolls back: in WAL mode BEGIN IMMEDIATE alone succeeds on a read-only
 * file (the lock lives in the shared-memory file), only an actual page write notices. Waits for a
 * concurrent writer to finish (busy timeout).
 * @param {import('node:sqlite').DatabaseSync} handle
 * @param {string} [where] path shown in the message
 * @throws {DbError} code 'open_failed' when the database is read-only
 */
export function assertWritable(handle, where = 'the journal database') {
  let began = false;
  try {
    handle.exec('BEGIN IMMEDIATE');
    began = true;
    handle.exec(`PRAGMA user_version = ${readVersion(handle)}`);
  } catch (err) {
    if (began) {
      try {
        handle.exec('ROLLBACK');
      } catch {
        // already rolled back by SQLite
      }
    }
    if (!isReadOnlyError(err)) throw err;
    throw new DbError(
      'open_failed',
      `The journal database (${where}) is read-only, so nothing could be saved. Check the owner and permissions of the file and its folder ` +
        '(a root-owned file left behind by an earlier run with sudo is a common cause).',
      { cause: err },
    );
  }
  handle.exec('ROLLBACK');
}

/**
 * Bring the database up to the latest schema. Safe to call from several processes at once: the
 * version is re-read inside the write lock.
 * @param {import('node:sqlite').DatabaseSync} handle
 * @param {typeof MIGRATIONS} [migrations] overridable for tests
 * @returns {number} the schema version after migrating
 * @throws {DbError} code 'schema_too_new' when the file is from a newer build
 */
export function applyMigrations(handle, migrations = MIGRATIONS) {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migrations must be numbered 1..n without gaps (found ${m.version} at position ${i + 1})`);
  });
  const latest = migrations.at(-1).version;
  let current = assertNotNewer(handle, migrations);
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    handle.exec('BEGIN IMMEDIATE');
    try {
      const seen = readVersion(handle);
      if (seen > latest) throw tooNew(seen, latest);
      if (seen < migration.version) {
        migration.up(handle);
        handle.exec(`PRAGMA user_version = ${migration.version}`);
      }
      handle.exec('COMMIT');
    } catch (err) {
      try {
        handle.exec('ROLLBACK');
      } catch {
        // already rolled back by SQLite
      }
      throw err;
    }
    current = migration.version;
  }
  return current;
}
