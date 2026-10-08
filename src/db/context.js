// Per-connection helpers shared by all repositories: cached prepared statements, plain-object
// rows, named-parameter binding and a re-entrant transaction helper.

import { DbError } from './util.js';

const MAX_CACHED_STATEMENTS = 300;

/**
 * @param {import('node:sqlite').DatabaseSync} handle
 * @param {() => number} now clock (injectable for tests)
 */
export function createContext(handle, now) {
  const cache = new Map();

  function prepare(sql) {
    let statement = cache.get(sql);
    if (statement) return statement;
    statement = handle.prepare(sql);
    // Dynamic SQL (filters, LIKE term lists) has a bounded number of shapes, but cap it anyway.
    if (cache.size >= MAX_CACHED_STATEMENTS) cache.delete(cache.keys().next().value);
    cache.set(sql, statement);
    return statement;
  }

  // node:sqlite refuses `undefined` and unknown named parameters; callers pass exactly the
  // parameters the SQL uses, and `undefined` becomes NULL.
  function bind(params) {
    if (!params) return [];
    const out = {};
    for (const key of Object.keys(params)) out[key] = params[key] === undefined ? null : params[key];
    return [out];
  }

  /** Run a write; returns { changes, lastInsertRowid }. */
  function run(sql, params) {
    return prepare(sql).run(...bind(params));
  }

  /** First row as a plain object, or null. */
  function one(sql, params) {
    const row = prepare(sql).get(...bind(params));
    return row ? { ...row } : null;
  }

  /** All rows as plain objects. */
  function all(sql, params) {
    return prepare(sql)
      .all(...bind(params))
      .map((row) => ({ ...row }));
  }

  /** First column of the first row (or undefined). */
  function scalar(sql, params) {
    const row = prepare(sql).get(...bind(params));
    return row ? Object.values(row)[0] : undefined;
  }

  // BEGIN IMMEDIATE takes the write lock up front (no upgrade deadlocks between connections);
  // nested calls use savepoints so an inner failure can be caught without losing the outer work.
  let depth = 0;

  /**
   * Run `fn` atomically. Re-entrant. If `fn` throws, everything it did is rolled back and the
   * error is rethrown.
   * @template T
   * @param {() => T} fn must be synchronous
   * @returns {T}
   */
  function tx(fn) {
    const nested = depth > 0;
    const savepoint = `sp_${depth}`;
    handle.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    depth++;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        result.then(undefined, () => {}); // the misuse error below is the one to report, not a later rejection
        throw new DbError('invalid', 'tx() callbacks must be synchronous: the transaction would commit before the promise settles');
      }
      handle.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (err) {
      try {
        if (nested) {
          handle.exec(`ROLLBACK TO ${savepoint}`);
          handle.exec(`RELEASE ${savepoint}`);
        } else {
          handle.exec('ROLLBACK');
        }
      } catch {
        // The failure may already have rolled the transaction back; the original error matters.
      }
      throw err;
    } finally {
      depth--;
    }
  }

  function close() {
    cache.clear();
  }

  return { handle, now, prepare, run, one, all, scalar, tx, close };
}
