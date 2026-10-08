// Memories: short durable facts about the user. Always visible, editable and deletable.

import { randomUUID } from 'node:crypto';
import { DbError, LIMITS, cleanLine, exceedsChars, isTimestamp, isValidId, normalizeMemoryText } from './util.js';

function invalid(field, message) {
  return new DbError('invalid', message, { field });
}

export function toMemory(r) {
  return {
    id: r.id,
    text: r.text,
    pinned: r.pinned === 1,
    sourceEntryId: r.source_entry_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** One clean line (control characters removed, whitespace collapsed); empty or over-long text is rejected, never cut. */
function parseText(value) {
  if (typeof value !== 'string') throw invalid('text', 'text must be a string');
  const tooLong = () => invalid('text', `A memory can be at most ${LIMITS.memoryText} characters`);
  // Check the raw size first: collapsing whitespace in a huge string is slow.
  if (value.length > LIMITS.memoryRaw) throw tooLong();
  const text = cleanLine(value);
  if (text === '') throw invalid('text', 'A memory cannot be empty');
  if (exceedsChars(text, LIMITS.memoryText)) throw tooLong();
  return text;
}

function parsePinned(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw invalid('pinned', 'pinned must be true or false');
}

/**
 * @param {ReturnType<import('./context.js').createContext>} ctx
 */
export function createMemories(ctx) {
  const COLUMNS = 'id, text, pinned, source_entry_id, created_at, updated_at';

  function get(id) {
    if (typeof id !== 'string') return null;
    const row = ctx.one(`SELECT ${COLUMNS} FROM memories WHERE id = :id`, { id });
    return row ? toMemory(row) : null;
  }

  /** Pinned first, then newest first. */
  function list() {
    return ctx.all(`SELECT ${COLUMNS} FROM memories ORDER BY pinned DESC, created_at DESC, id DESC`).map(toMemory);
  }

  /**
   * Does a memory with the same meaning-ish text exist? Ignores case, repeated spaces and trailing
   * punctuation ("Has a sister called Maya." equals "has a sister  called maya").
   * @param {string} text
   */
  function exists(text) {
    const key = normalizeMemoryText(text);
    if (key === '') return false;
    return ctx.scalar('SELECT 1 FROM memories WHERE text_norm = :key LIMIT 1', { key }) === 1;
  }

  /**
   * Store a memory. Duplicates are allowed here (check exists() first when extracting).
   * A `sourceEntryId` that no longer exists is stored as null.
   * @param {{ text: string, pinned?: boolean, sourceEntryId?: string|null, id?: string, createdAt?: number }} input
   * @returns {object} the Memory
   * @throws {DbError} 'invalid' for empty / over-long text
   */
  function create(input) {
    if (!input || typeof input !== 'object') throw invalid('memory', 'memory must be an object');
    const text = parseText(input.text);
    const pinned = input.pinned === undefined ? 0 : parsePinned(input.pinned);
    if (input.id !== undefined && !isValidId(input.id)) throw invalid('id', 'id must be a short identifier');
    if (input.createdAt !== undefined && !isTimestamp(input.createdAt)) throw invalid('createdAt', 'createdAt must be a millisecond timestamp');
    const sourceEntryId = input.sourceEntryId ?? null;
    if (sourceEntryId !== null && typeof sourceEntryId !== 'string') throw invalid('sourceEntryId', 'sourceEntryId must be an id or null');
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? ctx.now();
    return ctx.tx(() => {
      const source = sourceEntryId !== null && ctx.scalar('SELECT 1 FROM entries WHERE id = :id', { id: sourceEntryId }) === 1 ? sourceEntryId : null;
      ctx.run(
        `INSERT INTO memories (id, text, text_norm, pinned, source_entry_id, created_at, updated_at)
         VALUES (:id, :text, :norm, :pinned, :source, :createdAt, :createdAt)`,
        { id, text, norm: normalizeMemoryText(text), pinned, source, createdAt },
      );
      return get(id);
    });
  }

  /**
   * @param {string} id
   * @param {{ text?: string, pinned?: boolean }} patch
   * @returns {object|null} the updated Memory, or null if it does not exist
   */
  function update(id, patch = {}) {
    if (!patch || typeof patch !== 'object') throw invalid('patch', 'patch must be an object');
    const text = patch.text === undefined ? undefined : parseText(patch.text);
    const pinned = patch.pinned === undefined ? undefined : parsePinned(patch.pinned);
    return ctx.tx(() => {
      const current = get(id);
      if (!current) return null;
      if (text === undefined && pinned === undefined) return current;
      const nextText = text ?? current.text;
      ctx.run('UPDATE memories SET text = :text, text_norm = :norm, pinned = :pinned, updated_at = MAX(updated_at, :now) WHERE id = :id', {
        id,
        text: nextText,
        norm: normalizeMemoryText(nextText),
        pinned: pinned ?? (current.pinned ? 1 : 0),
        now: ctx.now(),
      });
      return get(id);
    });
  }

  /** @returns {boolean} whether a memory was deleted */
  function remove(id) {
    if (typeof id !== 'string') return false;
    return ctx.run('DELETE FROM memories WHERE id = :id', { id }).changes > 0;
  }

  /** Delete every memory. @returns {number} how many were removed */
  function clear() {
    return Number(ctx.run('DELETE FROM memories').changes);
  }

  return { list, get, create, update, delete: remove, clear, exists };
}
