// Entries repository: journaling sessions. JSON shapes are camelCase, columns snake_case.

import { randomUUID } from 'node:crypto';
import {
  DbError,
  LIMITS,
  cleanChars,
  cleanLine,
  isPlainObject,
  isTimestamp,
  isValidId,
  localDateString,
  normalizeLabels,
  parseStringArray,
  previewOf,
  truncateChars,
} from './util.js';
import { entryFilters, parseDate, parseMood } from './filters.js';

export const ENTRY_COLUMNS = `
  e.id, e.created_at, e.updated_at, e.entry_date, e.title, e.kind, e.template_id, e.mood,
  e.emotions, e.tags, e.summary, e.status, e.private, e.pinned, e.word_count,
  (SELECT COUNT(*) FROM messages m WHERE m.entry_id = e.id) AS message_count`;

const PREVIEW_COLUMN = `,
  (SELECT substr(m.content, 1, 600) FROM messages m
    WHERE m.entry_id = e.id AND m.role = 'user' ORDER BY m.seq LIMIT 1) AS preview_src`;

export const KINDS = ['free', 'guided'];
export const STATUSES = ['open', 'wrapped'];
const DEFAULT_PAGE = 30;
const MAX_PAGE = 200;
const TIE_EXTENSION = 500;

function invalid(field, message) {
  return new DbError('invalid', message, { field });
}

export function toEntry(r) {
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    date: r.entry_date,
    title: r.title,
    kind: r.kind,
    templateId: r.template_id ?? null,
    mood: r.mood ?? null,
    emotions: parseStringArray(r.emotions),
    tags: parseStringArray(r.tags),
    summary: r.summary,
    status: r.status,
    private: r.private === 1,
    pinned: r.pinned === 1,
    wordCount: r.word_count,
    messageCount: r.message_count,
  };
}

function toSummary(r) {
  return { ...toEntry(r), preview: previewOf(r.preview_src ?? '') };
}

// ---- field validation -------------------------------------------------------------------------

function parseBool(field, value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 0 || value === 1) return value;
  throw invalid(field, `${field} must be true or false`);
}

function parseEnum(field, value, allowed) {
  if (typeof value === 'string' && allowed.includes(value)) return value;
  throw invalid(field, `${field} must be one of: ${allowed.join(', ')}`);
}

function parseTemplateId(value) {
  if (value === null) return null;
  if (typeof value === 'string' && value.length > 0 && value.length <= LIMITS.templateId && /^[A-Za-z0-9_.:-]+$/.test(value)) return value;
  throw invalid('templateId', 'templateId must be a short identifier or null');
}

function parseText(field, value, max) {
  if (typeof value !== 'string') throw invalid(field, `${field} must be text`);
  return truncateChars(cleanLine(value), max);
}

function parseSummary(value) {
  if (typeof value !== 'string') throw invalid('summary', 'summary must be text');
  return truncateChars(cleanChars(value.replace(/\r\n?/g, '\n')).trim(), LIMITS.summary);
}

function parseTimestamp(field, value) {
  if (isTimestamp(value)) return value;
  throw invalid(field, `${field} must be a millisecond timestamp`);
}

/**
 * Validate and convert the fields present in `input` to column values. Only keys that are present
 * (not undefined) are returned, so the same function serves create and update.
 */
function parseFields(input, { forCreate }) {
  if (!isPlainObject(input)) throw invalid('fields', 'entry fields must be an object');
  const out = {};
  const has = (key) => input[key] !== undefined;
  if (has('title')) out.title = parseText('title', input.title, LIMITS.title);
  if (has('summary')) out.summary = parseSummary(input.summary);
  if (has('mood')) out.mood = parseMood(input.mood);
  // `date: null` on create means "not given" (clients may send explicit nulls); on update it is invalid.
  if (has('date') && !(forCreate && input.date === null)) out.entry_date = parseDate(input.date);
  if (has('kind')) out.kind = parseEnum('kind', input.kind, KINDS);
  if (has('status')) out.status = parseEnum('status', input.status, STATUSES);
  if (has('templateId')) out.template_id = parseTemplateId(input.templateId);
  if (has('private')) out.private = parseBool('private', input.private);
  if (has('pinned')) out.pinned = parseBool('pinned', input.pinned);
  if (has('emotions')) out.emotions = JSON.stringify(normalizeLabels(input.emotions, { max: LIMITS.emotions }));
  if (has('tags')) out.tags = JSON.stringify(normalizeLabels(input.tags, { max: LIMITS.tags }));
  if (has('updatedAt')) out.updated_at = parseTimestamp('updatedAt', input.updatedAt);
  if (forCreate) {
    if (has('createdAt')) out.created_at = parseTimestamp('createdAt', input.createdAt);
    if (has('id')) {
      if (!isValidId(input.id)) throw invalid('id', 'id must be a short identifier');
      out.id = input.id;
    }
  }
  return out;
}

const INDEXED_FIELDS = ['title', 'tags', 'emotions'];

// `before` is a createdAt (number or numeric string), optionally paired with `beforeId`; the
// combined form "<createdAt>:<id>" (see page().nextCursor) is accepted too.
function parseCursor(before, beforeId) {
  if (before === undefined || before === null || before === '') return null;
  let ms = before;
  let id = typeof beforeId === 'string' && beforeId ? beforeId : null;
  if (typeof before === 'string') {
    const m = /^(\d{1,16}):(.+)$/.exec(before);
    if (m) {
      ms = m[1];
      id = id ?? m[2];
    }
  }
  const n = Number(ms);
  if (!Number.isFinite(n)) throw invalid('before', 'before must be a millisecond timestamp');
  return { before: n, beforeId: id };
}

function clampLimit(value, fallback = DEFAULT_PAGE) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_PAGE);
}

/**
 * @param {ReturnType<import('./context.js').createContext>} ctx
 * @param {ReturnType<import('./search.js').createSearch>} search
 */
export function createEntries(ctx, search) {
  function get(id) {
    if (typeof id !== 'string') return null;
    const row = ctx.one(`SELECT ${ENTRY_COLUMNS} FROM entries e WHERE e.id = :id`, { id });
    return row ? toEntry(row) : null;
  }

  function exists(id) {
    return typeof id === 'string' && ctx.scalar('SELECT 1 FROM entries WHERE id = :id', { id }) === 1;
  }

  /**
   * Create an entry. Only the fields you pass are set; the rest get defaults
   * (kind 'free', or 'guided' when a templateId is given; date = today in server local time).
   * `wordCount` and `messageCount` are derived and cannot be set.
   * @param {{ id?: string, createdAt?: number, updatedAt?: number, date?: string, title?: string,
   *   kind?: 'free'|'guided', templateId?: string|null, mood?: number|null, emotions?: string[],
   *   tags?: string[], summary?: string, status?: 'open'|'wrapped', private?: boolean, pinned?: boolean }} [fields]
   * @returns {object} the Entry
   * @throws {DbError} code 'invalid' for bad values, 'conflict' if the id exists
   */
  function create(fields = {}) {
    const parsed = parseFields(fields, { forCreate: true });
    const createdAt = parsed.created_at ?? ctx.now();
    const row = {
      id: parsed.id ?? randomUUID(),
      created_at: createdAt,
      updated_at: parsed.updated_at ?? createdAt,
      entry_date: parsed.entry_date ?? localDateString(createdAt),
      title: parsed.title ?? '',
      kind: parsed.kind ?? (parsed.template_id ? 'guided' : 'free'),
      template_id: parsed.template_id ?? null,
      mood: parsed.mood ?? null,
      emotions: parsed.emotions ?? '[]',
      tags: parsed.tags ?? '[]',
      summary: parsed.summary ?? '',
      status: parsed.status ?? 'open',
      private: parsed.private ?? 0,
      pinned: parsed.pinned ?? 0,
    };
    return ctx.tx(() => {
      try {
        ctx.run(
          `INSERT INTO entries (id, created_at, updated_at, entry_date, title, kind, template_id, mood,
             emotions, tags, summary, status, private, pinned)
           VALUES (:id, :created_at, :updated_at, :entry_date, :title, :kind, :template_id, :mood,
             :emotions, :tags, :summary, :status, :private, :pinned)`,
          row,
        );
      } catch (err) {
        if (/UNIQUE constraint failed: entries\.id/.test(String(err && err.message))) {
          throw new DbError('conflict', `An entry with id ${row.id} already exists`, { field: 'id', cause: err });
        }
        throw err;
      }
      search.reindexEntry(row.id, []);
      return get(row.id);
    });
  }

  /**
   * Change metadata of an entry. Accepts title, summary, mood, date, kind, status, templateId,
   * private, pinned, emotions, tags (and updatedAt); other keys are ignored. Bumps `updatedAt`
   * unless the patch sets it. Message-derived fields (wordCount) are not patchable.
   * @param {string} id
   * @param {object} patch
   * @returns {object|null} the updated Entry, or null if there is no such entry
   * @throws {DbError} code 'invalid' for bad values
   */
  function update(id, patch = {}) {
    const changes = parseFields(patch, { forCreate: false });
    return ctx.tx(() => {
      const current = ctx.one('SELECT * FROM entries WHERE id = :id', { id });
      if (!current) return null;
      const keys = Object.keys(changes).filter((k) => k !== 'updated_at');
      if (keys.length === 0 && changes.updated_at === undefined) return get(id);
      const next = { ...current, ...changes };
      next.updated_at = changes.updated_at ?? Math.max(ctx.now(), current.updated_at);
      ctx.run(
        `UPDATE entries SET updated_at = :updated_at, entry_date = :entry_date, title = :title, kind = :kind,
           template_id = :template_id, mood = :mood, emotions = :emotions, tags = :tags, summary = :summary,
           status = :status, private = :private, pinned = :pinned
         WHERE id = :id`,
        {
          id,
          updated_at: next.updated_at,
          entry_date: next.entry_date,
          title: next.title,
          kind: next.kind,
          template_id: next.template_id,
          mood: next.mood,
          emotions: next.emotions,
          tags: next.tags,
          summary: next.summary,
          status: next.status,
          private: next.private,
          pinned: next.pinned,
        },
      );
      if (keys.some((k) => INDEXED_FIELDS.includes(k))) search.reindexEntry(id);
      return get(id);
    });
  }

  /**
   * Delete an entry with its messages and search row. Memories that came from it are kept and
   * lose their `sourceEntryId`. The words of the entry are purged from the search index too, so
   * deleting something really removes it from the file (see search.purge()).
   * @returns {boolean} whether an entry was deleted
   */
  function remove(id) {
    if (typeof id !== 'string') return false;
    return ctx.tx(() => {
      search.removeEntry(id);
      const deleted = ctx.run('DELETE FROM entries WHERE id = :id', { id }).changes > 0;
      if (deleted) search.purge();
      return deleted;
    });
  }

  // Shared by list() and page(): builds the WHERE clause for filters + cursor.
  function listRows(options, limit) {
    const o = options ?? {};
    const filters = entryFilters(o);
    const where = [...filters.where];
    const params = { limit, ...filters.params };
    if (o.includePrivate === false) where.push('e.private = 0');
    const cursor = parseCursor(o.before, o.beforeId);
    if (cursor) {
      params.before = cursor.before;
      if (cursor.beforeId) {
        params.beforeId = cursor.beforeId;
        where.push('(e.created_at < :before OR (e.created_at = :before AND e.id < :beforeId))');
      } else {
        where.push('e.created_at < :before');
      }
    }
    const sql = `SELECT ${ENTRY_COLUMNS}${PREVIEW_COLUMN} FROM entries e
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.created_at DESC, e.id DESC LIMIT :limit`;
    return ctx.all(sql, params).map(toSummary);
  }

  /**
   * Newest first, stable even when several entries share a timestamp (order is created_at, id).
   * Pass `before` (a createdAt) to continue after a page; add `beforeId` (the last entry's id) to be
   * exact when timestamps can collide. See page() for a ready-made cursor.
   * @param {{ limit?: number, before?: number, beforeId?: string, mood?: number, tag?: string,
   *   from?: string, to?: string, pinned?: boolean, includePrivate?: boolean }} [options]
   *   `from`/`to`: inclusive `YYYY-MM-DD` on the entry date; `tag`: exact (case-insensitive) match;
   *   `includePrivate` defaults to true; `limit` defaults to 30 (max 200).
   * @returns {object[]} EntrySummary[] (Entry + `preview`)
   * @throws {DbError} code 'invalid' for malformed filters
   */
  function list(options = {}) {
    return listRows(options, clampLimit(options?.limit));
  }

  /**
   * Like list(), plus the cursor for the next page: `nextBefore` (last entry's createdAt),
   * `nextBeforeId` (its id) and `nextCursor` (both in one string, accepted as `before`). All are
   * null when there are no more entries.
   *
   * Entries with an identical createdAt are never split across pages when the client only sends
   * `before` (the HTTP API's numeric cursor): the page grows by the size of the tie group (at most
   * 500 extra rows) instead. With `beforeId`/`nextCursor` pages are exact in any case.
   * @returns {{ entries: object[], nextBefore: number|null, nextBeforeId: string|null, nextCursor: string|null }}
   */
  function page(options = {}) {
    const limit = clampLimit(options?.limit);
    const probe = listRows(options, limit + 1);
    let entries = probe.slice(0, limit);
    let hasMore = probe.length > limit;
    if (hasMore && probe[limit - 1].createdAt === probe[limit].createdAt) {
      const boundary = probe[limit - 1].createdAt;
      const wide = listRows(options, limit + TIE_EXTENSION + 1);
      let end = limit;
      while (end < wide.length && end < limit + TIE_EXTENSION && wide[end].createdAt === boundary) end++;
      entries = wide.slice(0, end);
      hasMore = wide.length > end;
    }
    const last = entries.at(-1);
    const next = hasMore && last ? last : null;
    return {
      entries,
      nextBefore: next ? next.createdAt : null,
      nextBeforeId: next ? next.id : null,
      nextCursor: next ? `${next.createdAt}:${next.id}` : null,
    };
  }

  /**
   * EntrySummary for specific ids, in the order given (unknown ids are skipped). Used to turn
   * search hits into list rows.
   * @param {string[]} ids at most 500 are looked at
   */
  function summariesFor(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const wanted = ids.filter((id) => typeof id === 'string').slice(0, 500);
    const rows = ctx.all(
      `SELECT ${ENTRY_COLUMNS}${PREVIEW_COLUMN} FROM entries e
       WHERE e.id IN (SELECT value FROM json_each(:ids))`,
      { ids: JSON.stringify(wanted) },
    );
    const byId = new Map(rows.map((r) => [r.id, toSummary(r)]));
    return wanted.map((id) => byId.get(id)).filter(Boolean);
  }

  /**
   * Minimal rows for statistics and weekly reports; no messages are loaded.
   * Ordered by entry date, then creation time.
   * @param {{ from?: string, to?: string, includePrivate?: boolean }} [options] includePrivate defaults to true
   * @returns {{ id: string, date: string, mood: number|null, emotions: string[], tags: string[],
   *   wordCount: number, status: string, private: boolean, title: string, summary: string, createdAt: number }[]}
   */
  function rowsForInsights(options = {}) {
    const o = options ?? {};
    const where = [];
    const params = {};
    if (o.from) {
      params.from = parseDate(o.from);
      where.push('entry_date >= :from');
    }
    if (o.to) {
      params.to = parseDate(o.to);
      where.push('entry_date <= :to');
    }
    if (o.includePrivate === false) where.push('private = 0');
    const rows = ctx.all(
      `SELECT id, entry_date, mood, emotions, tags, word_count, status, private, title, summary, created_at
       FROM entries ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY entry_date, created_at, id`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      date: r.entry_date,
      mood: r.mood ?? null,
      emotions: parseStringArray(r.emotions),
      tags: parseStringArray(r.tags),
      wordCount: r.word_count,
      status: r.status,
      private: r.private === 1,
      title: r.title,
      summary: r.summary,
      createdAt: r.created_at,
    }));
  }

  /** @returns {number} total number of entries */
  function count() {
    return ctx.scalar('SELECT COUNT(*) FROM entries');
  }

  return { create, get, exists, update, delete: remove, list, page, summariesFor, rowsForInsights, count };
}
