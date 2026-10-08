// SQLite persistence for MyJournal (node:sqlite, no dependencies).
//
//   const db = openDb({ file: './data/journal.db' });   // or ':memory:'
//   db.entries / db.messages / db.memories / db.reports / db.settings / db.search(...)
//
// Everything is synchronous. Multi-step changes happen inside transactions; use db.tx(fn) to group
// your own steps. See docs/ARCHITECTURE.md section 11 for the contract.

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createContext } from './context.js';
import { createEntries } from './entries.js';
import { createMemories } from './memories.js';
import { createMessages } from './messages.js';
import { createPortability } from './portability.js';
import { createReports } from './reports.js';
import { SCHEMA_VERSION, applyMigrations, assertNotNewer, assertWritable } from './schema.js';
import { createSearch } from './search.js';
import { createSettingsStore } from './settings-store.js';
import { DbError } from './util.js';

export { DbError, SCHEMA_VERSION };

const BUSY_TIMEOUT_MS = 5000;

// Create the directory (0700) and the file (0600) ourselves so the journal is never, even briefly,
// readable by other users. chmod can fail on exotic filesystems (FAT, some network mounts); the
// journal still works there, so failures are tolerated.
function prepareFile(file) {
  const dir = dirname(file);
  const dirExisted = existsSync(dir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new DbError('open_failed', `Could not create the data folder ${dir}: ${err.message}`, { cause: err });
  }
  if (!dirExisted) tryChmod(dir, 0o700);
  try {
    closeSync(openSync(file, 'a', 0o600));
  } catch {
    // SQLite will report a meaningful error when it tries to open the path
  }
  tryChmod(file, 0o600);
}

function tryChmod(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {
    // tolerated, see prepareFile
  }
}

function configure(handle, inMemory) {
  handle.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  handle.exec('PRAGMA foreign_keys = ON');
  // Deleted entries should not linger in free pages of a privacy-focused journal.
  handle.exec('PRAGMA secure_delete = ON');
  if (!inMemory) {
    // WAL lets readers and the writer coexist. synchronous stays at its default (FULL) on purpose:
    // a committed journal entry must survive a power cut.
    handle.exec('PRAGMA journal_mode = WAL');
  }
}

/**
 * Open (creating if needed) the journal database and migrate it to the current schema.
 *
 * @param {{ file: string, now?: () => number }} options
 *   `file`: path, or ':memory:'. The parent directory is created with mode 0700 and the file with
 *   0600. `now`: clock returning epoch milliseconds (tests inject a fake one).
 * @returns {ReturnType<typeof buildDb>} the database handle with the repositories of ARCHITECTURE section 11
 * @throws {DbError} 'schema_too_new' when the file was written by a newer MyJournal (it is left
 *   untouched); 'open_failed' when SQLite cannot open it or it cannot be written (not a database,
 *   read-only file, permissions, ...)
 */
export function openDb({ file, now = Date.now } = {}) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new TypeError('openDb({ file }) needs a file path or ":memory:"');
  }
  const inMemory = file === ':memory:';
  const path = inMemory ? file : resolve(file);
  if (!inMemory) prepareFile(path);

  let handle;
  try {
    handle = new DatabaseSync(path);
  } catch (err) {
    throw new DbError('open_failed', `Could not open the journal database at ${path}: ${err.message}`, { cause: err });
  }
  try {
    handle.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    assertNotNewer(handle); // before any write, including switching to WAL
    configure(handle, inMemory);
    assertWritable(handle, path);
    applyMigrations(handle);
  } catch (err) {
    try {
      handle.close();
    } catch {
      // ignore
    }
    if (err instanceof DbError) throw err;
    throw new DbError('open_failed', `Could not open the journal database at ${path}: ${err.message}`, { cause: err });
  }
  return buildDb(handle, path, now);
}

function buildDb(handle, path, now) {
  const ctx = createContext(handle, now);
  const search = createSearch(ctx);
  const entries = createEntries(ctx, search);
  const messages = createMessages(ctx, search);
  const memories = createMemories(ctx);
  const reports = createReports(ctx);
  const settings = createSettingsStore(ctx);
  const portability = createPortability(ctx, search);

  // Self-heal: if the index and the entries ever disagree in size (crash while developing, manual
  // edits), rebuild it once at startup instead of serving wrong search results.
  const entryCount = ctx.scalar('SELECT COUNT(*) FROM entries');
  if (entryCount !== ctx.scalar('SELECT COUNT(*) FROM entry_search')) search.reindexAll();

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    // Housekeeping must never make shutdown hang behind another connection's lock.
    const steps = [
      () => handle.exec('PRAGMA busy_timeout = 250'),
      // Words of edited or deleted text would otherwise stay readable in old index segments.
      () => search.purgeIfStale(),
      () => handle.exec('PRAGMA optimize'),
      () => handle.exec('PRAGMA wal_checkpoint(TRUNCATE)'),
    ];
    for (const step of steps) {
      try {
        step();
      } catch {
        // another connection may hold the file; closing must still succeed
      }
    }
    ctx.close();
    handle.close();
  }

  return {
    /** Absolute path of the database file, or ':memory:'. */
    file: path,
    entries,
    messages,
    memories,
    reports,
    settings,
    /** Full-text search; also carries reindexAll(), checkConsistency(), ... See search.js. */
    search,
    exportAll: portability.exportAll,
    importAll: portability.importAll,
    wipe: portability.wipe,
    stats: portability.stats,
    /** Run `fn` in a transaction (re-entrant; synchronous callbacks only). */
    tx: ctx.tx,
    /** Escape hatch for tests and diagnostics: the underlying DatabaseSync. */
    handle,
    get isOpen() {
      return !closed;
    },
    close,
  };
}
