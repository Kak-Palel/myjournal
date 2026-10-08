// Export, import, wipe and stats.
//
// Export format (also what the importer understands):
//   { app: 'myjournal', version: 1, exportedAt, entries: [{ ...Entry, messages: [Message] }],
//     memories: [Memory], reports: [Report] }
// Settings (and therefore API keys) are never exported.
//
// The importer treats the file as hostile: every field is checked, nothing is evaluated, counts
// stored in the file are ignored, unknown fields and prototype-pollution keys are dropped.

import { ENTRY_COLUMNS, KINDS, STATUSES, toEntry } from './entries.js';
import { ROLES, toMessage } from './messages.js';
import { toMemory } from './memories.js';
import { REPORT_KINDS, toReport } from './reports.js';
import {
  DbError,
  LIMITS,
  cleanChars,
  cleanLine,
  countWords,
  exceedsChars,
  isPlainObject,
  isSafeInt,
  isTimestamp,
  isValidDate,
  isValidId,
  localDateString,
  normalizeLabels,
  normalizeMemoryText,
  sanitizeMeta,
} from './util.js';

/** Export format version written by exportAll() and the newest one importAll() accepts. */
export const EXPORT_VERSION = 1;

// Read a property of untrusted data without ever walking the prototype chain.
const own = (obj, key) => (isPlainObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined);

const MESSAGE_COLUMNS = 'id, entry_id, seq, role, content, created_at, meta';
const MEMORY_COLUMNS = 'id, text, pinned, source_entry_id, created_at, updated_at';
const REPORT_COLUMNS = 'id, kind, period_start, period_end, content, created_at, meta';

// ---- strict field parsers for imported data (return undefined when invalid) -------------------

const INVALID = Symbol('invalid');

function optionalText(value, max, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max) return INVALID;
  return cleanChars(value);
}

function optionalEnum(value, allowed, fallback) {
  if (value === undefined) return fallback;
  return typeof value === 'string' && allowed.includes(value) ? value : INVALID;
}

function optionalBool(value) {
  if (value === undefined) return 0;
  return typeof value === 'boolean' ? (value ? 1 : 0) : INVALID;
}

function optionalLabels(value, max) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return INVALID;
  return normalizeLabels(value, { max });
}

function optionalTimestamp(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return isTimestamp(value) ? value : INVALID;
}

function parseEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const id = own(raw, 'id');
  const createdAt = own(raw, 'createdAt');
  if (!isValidId(id) || !isTimestamp(createdAt)) return null;
  const moodRaw = own(raw, 'mood');
  const mood = moodRaw === undefined || moodRaw === null ? null : isSafeInt(moodRaw) && moodRaw >= 1 && moodRaw <= 5 ? moodRaw : INVALID;
  const dateRaw = own(raw, 'date');
  const templateRaw = own(raw, 'templateId');
  const entry = {
    id,
    created_at: createdAt,
    updated_at: optionalTimestamp(own(raw, 'updatedAt'), createdAt),
    entry_date: dateRaw === undefined ? localDateString(createdAt) : isValidDate(dateRaw) ? dateRaw : INVALID,
    title: optionalText(own(raw, 'title'), LIMITS.title),
    kind: optionalEnum(own(raw, 'kind'), KINDS, 'free'),
    template_id:
      templateRaw === undefined || templateRaw === null
        ? null
        : typeof templateRaw === 'string' && templateRaw.length <= LIMITS.templateId && /^[A-Za-z0-9_.:-]+$/.test(templateRaw)
          ? templateRaw
          : INVALID,
    mood,
    emotions: optionalLabels(own(raw, 'emotions'), LIMITS.emotions),
    tags: optionalLabels(own(raw, 'tags'), LIMITS.tags),
    summary: optionalText(own(raw, 'summary'), LIMITS.summary),
    status: optionalEnum(own(raw, 'status'), STATUSES, 'open'),
    private: optionalBool(own(raw, 'private')),
    pinned: optionalBool(own(raw, 'pinned')),
  };
  if (Object.values(entry).includes(INVALID)) return null;
  entry.title = cleanLine(entry.title);
  entry.emotions = JSON.stringify(entry.emotions);
  entry.tags = JSON.stringify(entry.tags);
  return entry;
}

function parseMessage(raw, parentId) {
  if (!isPlainObject(raw)) return null;
  const id = own(raw, 'id');
  const role = own(raw, 'role');
  const content = own(raw, 'content');
  const createdAt = own(raw, 'createdAt');
  if (!isValidId(id) || !ROLES.includes(role) || typeof content !== 'string' || !isTimestamp(createdAt)) return null;
  if (content.length > LIMITS.messageContent) return null;
  // A message that names a different entry than the one it is filed under is corrupt.
  const declared = own(raw, 'entryId');
  if (declared !== undefined && declared !== parentId) return null;
  const seq = own(raw, 'seq');
  let meta;
  try {
    meta = sanitizeMeta(own(raw, 'meta'));
  } catch {
    return null;
  }
  return {
    id,
    role,
    content: content.replaceAll('\u0000', ''),
    created_at: createdAt,
    meta: JSON.stringify(meta),
    order: isSafeInt(seq) && seq >= 0 ? seq : Number.POSITIVE_INFINITY,
  };
}

function parseMemory(raw) {
  if (!isPlainObject(raw)) return null;
  const id = own(raw, 'id');
  const textRaw = own(raw, 'text');
  const createdAt = own(raw, 'createdAt');
  if (!isValidId(id) || typeof textRaw !== 'string' || !isTimestamp(createdAt)) return null;
  // Same rules as memories.create(); the raw size is checked first because collapsing whitespace in
  // a multi-megabyte string takes seconds.
  if (textRaw.length > LIMITS.memoryRaw) return null;
  const text = cleanLine(textRaw);
  if (text === '' || exceedsChars(text, LIMITS.memoryText)) return null;
  const pinned = optionalBool(own(raw, 'pinned'));
  const updatedAt = optionalTimestamp(own(raw, 'updatedAt'), createdAt);
  const source = own(raw, 'sourceEntryId');
  if (pinned === INVALID || updatedAt === INVALID) return null;
  if (source !== undefined && source !== null && typeof source !== 'string') return null;
  return { id, text, text_norm: normalizeMemoryText(text), pinned, source: source ?? null, created_at: createdAt, updated_at: updatedAt };
}

function parseReport(raw) {
  if (!isPlainObject(raw)) return null;
  const id = own(raw, 'id');
  const kind = optionalEnum(own(raw, 'kind'), REPORT_KINDS, 'weekly');
  const start = own(raw, 'periodStart');
  const end = own(raw, 'periodEnd');
  const content = own(raw, 'content');
  const createdAt = own(raw, 'createdAt');
  if (!isValidId(id) || kind === INVALID || !isValidDate(start) || !isValidDate(end) || end < start) return null;
  if (typeof content !== 'string' || content.trim() === '' || content.length > LIMITS.reportContent) return null;
  if (!isTimestamp(createdAt)) return null;
  let meta;
  try {
    meta = sanitizeMeta(own(raw, 'meta'));
  } catch {
    return null;
  }
  return {
    id,
    kind,
    period_start: start,
    period_end: end,
    content: content.replaceAll('\u0000', ''),
    created_at: createdAt,
    meta: JSON.stringify(meta),
  };
}

function checkEnvelope(json) {
  if (!isPlainObject(json)) {
    throw new DbError('invalid_import', 'This file is not a MyJournal export (expected a JSON object).');
  }
  const app = own(json, 'app');
  if (app !== undefined && app !== 'myjournal') {
    throw new DbError('invalid_import', 'This file was not exported by MyJournal.');
  }
  const version = own(json, 'version');
  if (version !== undefined) {
    if (!isSafeInt(version) || version < 1) throw new DbError('invalid_import', 'The export has an invalid version number.');
    if (version > EXPORT_VERSION) {
      throw new DbError('invalid_import', `This export (format v${version}) comes from a newer MyJournal than this one understands (v${EXPORT_VERSION}).`);
    }
  }
  let sections = 0;
  for (const key of ['entries', 'messages', 'memories', 'reports']) {
    const value = own(json, key);
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new DbError('invalid_import', `The export's "${key}" must be a list.`);
    sections++;
  }
  if (sections === 0 && app !== 'myjournal') {
    throw new DbError('invalid_import', 'This file does not look like a MyJournal export (no entries, memories or reports found).');
  }
}

/**
 * @param {ReturnType<import('./context.js').createContext>} ctx
 * @param {ReturnType<import('./search.js').createSearch>} search
 */
export function createPortability(ctx, search) {
  /**
   * Everything the user wrote, as a JSON-serialisable object (no settings, no API keys).
   * @returns {{ app: 'myjournal', version: number, exportedAt: number, entries: object[], memories: object[], reports: object[] }}
   */
  function exportAll() {
    const messagesByEntry = new Map();
    for (const row of ctx.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages ORDER BY entry_id, seq`).all()) {
      const message = toMessage(row);
      const list = messagesByEntry.get(message.entryId);
      if (list) list.push(message);
      else messagesByEntry.set(message.entryId, [message]);
    }
    const entries = ctx
      .all(`SELECT ${ENTRY_COLUMNS} FROM entries e ORDER BY e.created_at, e.id`)
      .map((row) => ({ ...toEntry(row), messages: messagesByEntry.get(row.id) ?? [] }));
    return {
      app: 'myjournal',
      version: EXPORT_VERSION,
      exportedAt: ctx.now(),
      entries,
      memories: ctx.all(`SELECT ${MEMORY_COLUMNS} FROM memories ORDER BY created_at, id`).map(toMemory),
      reports: ctx.all(`SELECT ${REPORT_COLUMNS} FROM reports ORDER BY created_at, id`).map(toReport),
    };
  }

  /**
   * Merge an export into this journal. Existing ids are skipped (never overwritten); invalid or
   * orphaned records are skipped and counted. All or nothing: a database error rolls everything back.
   *
   * Messages are only imported together with an entry that is new in this import; a message that
   * points at a missing entry, or whose declared `entryId` differs from the entry it sits under,
   * is skipped. Messages may be nested in their entry (the export format) or listed top-level
   * with an `entryId`.
   *
   * @param {unknown} json parsed JSON (untrusted)
   * @returns {{ imported: { entries: number, messages: number, memories: number, reports: number },
   *   skipped: number, skippedDetail: { existing: number, invalid: number, orphaned: number } }}
   * @throws {DbError} code 'invalid_import' when the document is not a MyJournal export at all
   */
  function importAll(json) {
    checkEnvelope(json);
    return ctx.tx(() => runImport(json));
  }

  function runImport(json) {
    const result = {
      imported: { entries: 0, messages: 0, memories: 0, reports: 0 },
      skipped: 0,
      skippedDetail: { existing: 0, invalid: 0, orphaned: 0 },
    };
    const skip = (kind, n = 1) => {
      result.skipped += n;
      result.skippedDetail[kind] += n;
    };
    const idExists = (table, id) => ctx.scalar(`SELECT 1 FROM ${table} WHERE id = :id`, { id }) === 1;

    const seenEntries = new Set();
    const seenMessages = new Set();
    // entry id -> { userParts, nextSeq } for entries created by this import
    const created = new Map();

    const insertMessages = (entryId, parsed) => {
      parsed.sort((a, b) => a.order - b.order || a.created_at - b.created_at);
      const state = created.get(entryId);
      for (const message of parsed) {
        ctx.run(
          `INSERT INTO messages (id, entry_id, seq, role, content, created_at, meta)
           VALUES (:id, :entryId, :seq, :role, :content, :createdAt, :meta)`,
          { id: message.id, entryId, seq: state.nextSeq++, role: message.role, content: message.content, createdAt: message.created_at, meta: message.meta },
        );
        if (message.role === 'user') state.userParts.push(message.content);
        result.imported.messages++;
      }
    };

    const acceptMessages = (rawList, parentId) => {
      const accepted = [];
      for (const raw of rawList) {
        const message = parseMessage(raw, parentId);
        if (!message || seenMessages.has(message.id)) {
          skip('invalid');
          continue;
        }
        seenMessages.add(message.id);
        if (idExists('messages', message.id)) {
          skip('existing');
          continue;
        }
        accepted.push(message);
      }
      return accepted;
    };

    for (const raw of own(json, 'entries') ?? []) {
      const nestedRaw = own(raw, 'messages');
      const nested = nestedRaw === undefined ? [] : Array.isArray(nestedRaw) ? nestedRaw : null;
      const entry = nested === null ? null : parseEntry(raw);
      if (!entry || seenEntries.has(entry.id)) {
        skip('invalid');
        skip('orphaned', nested ? nested.length : 0);
        continue;
      }
      seenEntries.add(entry.id);
      if (idExists('entries', entry.id)) {
        skip('existing');
        skip('existing', nested.length);
        continue;
      }
      ctx.run(
        `INSERT INTO entries (id, created_at, updated_at, entry_date, title, kind, template_id, mood,
           emotions, tags, summary, status, private, pinned)
         VALUES (:id, :created_at, :updated_at, :entry_date, :title, :kind, :template_id, :mood,
           :emotions, :tags, :summary, :status, :private, :pinned)`,
        entry,
      );
      created.set(entry.id, { userParts: [], nextSeq: 0 });
      result.imported.entries++;
      insertMessages(entry.id, acceptMessages(nested, entry.id));
    }

    // Top-level message lists must point at an entry this import created.
    const flat = own(json, 'messages');
    if (Array.isArray(flat)) {
      const byEntry = new Map();
      for (const raw of flat) {
        const entryId = own(raw, 'entryId');
        if (typeof entryId !== 'string' || !created.has(entryId)) {
          skip('orphaned');
          continue;
        }
        const accepted = acceptMessages([raw], entryId);
        if (accepted.length === 0) continue;
        const list = byEntry.get(entryId);
        if (list) list.push(...accepted);
        else byEntry.set(entryId, accepted);
      }
      for (const [entryId, parsed] of byEntry) insertMessages(entryId, parsed);
    }

    // Derived data of the new entries: word count and the search row.
    for (const [entryId, state] of created) {
      const words = state.userParts.reduce((sum, text) => sum + countWords(text), 0);
      ctx.run('UPDATE entries SET word_count = :words WHERE id = :id', { words, id: entryId });
      search.reindexEntry(entryId, state.userParts);
    }

    const seenMemories = new Set();
    for (const raw of own(json, 'memories') ?? []) {
      const memory = parseMemory(raw);
      if (!memory || seenMemories.has(memory.id)) {
        skip('invalid');
        continue;
      }
      seenMemories.add(memory.id);
      if (idExists('memories', memory.id)) {
        skip('existing');
        continue;
      }
      const source = memory.source !== null && idExists('entries', memory.source) ? memory.source : null;
      ctx.run(
        `INSERT INTO memories (id, text, text_norm, pinned, source_entry_id, created_at, updated_at)
         VALUES (:id, :text, :text_norm, :pinned, :source, :created_at, :updated_at)`,
        { ...memory, source },
      );
      result.imported.memories++;
    }

    const seenReports = new Set();
    for (const raw of own(json, 'reports') ?? []) {
      const report = parseReport(raw);
      if (!report || seenReports.has(report.id)) {
        skip('invalid');
        continue;
      }
      seenReports.add(report.id);
      if (idExists('reports', report.id)) {
        skip('existing');
        continue;
      }
      ctx.run(
        `INSERT INTO reports (id, kind, period_start, period_end, content, created_at, meta)
         VALUES (:id, :kind, :period_start, :period_end, :content, :created_at, :meta)`,
        report,
      );
      result.imported.reports++;
    }
    return result;
  }

  /**
   * Delete all entries, messages, memories and reports (and settings, including API keys, when
   * `includeSettings` is true). The search index is purged and the file compacted afterwards, so
   * neither the deleted text nor its words linger in free pages, index segments or the write-ahead log.
   * @param {{ includeSettings?: boolean }} [options]
   */
  function wipe({ includeSettings = false } = {}) {
    ctx.tx(() => {
      ctx.run('DELETE FROM entry_search');
      ctx.run('DELETE FROM messages');
      ctx.run('DELETE FROM memories');
      ctx.run('DELETE FROM reports');
      ctx.run('DELETE FROM entries');
      ctx.run("DELETE FROM sqlite_sequence WHERE name = 'entries'");
      if (includeSettings) ctx.run('DELETE FROM settings');
      // Deleting rows leaves every indexed word behind in old FTS5 segments; merge them away.
      search.purge();
    });
    // Best effort: VACUUM is impossible inside an outer transaction and pointless on :memory:.
    for (const sql of ['VACUUM', 'PRAGMA wal_checkpoint(TRUNCATE)']) {
      try {
        ctx.handle.exec(sql);
      } catch {
        // the data is already deleted; compaction is a bonus
      }
    }
  }

  /**
   * Row counts and the logical database size.
   * @returns {{ entries: number, messages: number, memories: number, reports: number, dbBytes: number }}
   */
  function stats() {
    const count = (table) => Number(ctx.scalar(`SELECT COUNT(*) FROM ${table}`));
    const pages = Number(ctx.handle.prepare('PRAGMA page_count').get().page_count);
    const pageSize = Number(ctx.handle.prepare('PRAGMA page_size').get().page_size);
    return {
      entries: count('entries'),
      messages: count('messages'),
      memories: count('memories'),
      reports: count('reports'),
      dbBytes: pages * pageSize,
    };
  }

  return { exportAll, importAll, wipe, stats };
}

