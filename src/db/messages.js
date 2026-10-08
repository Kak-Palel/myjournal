// Messages repository. Messages are append-only in numbering: `seq` is assigned as max+1 and is
// never renumbered, so deleting a middle message leaves a gap but keeps order and uniqueness.

import { randomUUID } from 'node:crypto';
import { DbError, LIMITS, countWords, isTimestamp, isValidId, mergeMeta, parseObject, sanitizeMeta } from './util.js';

export const ROLES = ['user', 'assistant'];

function invalid(field, message) {
  return new DbError('invalid', message, { field });
}

export function toMessage(r) {
  return {
    id: r.id,
    entryId: r.entry_id,
    seq: r.seq,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    meta: parseObject(r.meta),
  };
}

function checkContent(content) {
  if (typeof content !== 'string') throw invalid('content', 'content must be text');
  if (content.length > LIMITS.messageContent) {
    throw invalid('content', `content is longer than ${LIMITS.messageContent} characters`);
  }
  // NUL breaks C-string handling in a few places downstream; it is never meaningful in prose.
  return content.includes('\u0000') ? content.replaceAll('\u0000', '') : content;
}

/**
 * @param {ReturnType<import('./context.js').createContext>} ctx
 * @param {ReturnType<import('./search.js').createSearch>} search
 */
export function createMessages(ctx, search) {
  const COLUMNS = 'id, entry_id, seq, role, content, created_at, meta';

  function get(id) {
    if (typeof id !== 'string') return null;
    const row = ctx.one(`SELECT ${COLUMNS} FROM messages WHERE id = :id`, { id });
    return row ? toMessage(row) : null;
  }

  function list(entryId) {
    return ctx.all(`SELECT ${COLUMNS} FROM messages WHERE entry_id = :entryId ORDER BY seq`, { entryId }).map(toMessage);
  }

  function last(entryId) {
    const row = ctx.one(`SELECT ${COLUMNS} FROM messages WHERE entry_id = :entryId ORDER BY seq DESC LIMIT 1`, { entryId });
    return row ? toMessage(row) : null;
  }

  // Everything an entry derives from its messages: word count (user words), updated_at and the
  // search row. Assistant-only changes cannot affect words or the index, so they skip the rewrite.
  function refresh(entryId, userTextChanged) {
    const now = ctx.now();
    if (!userTextChanged) {
      ctx.run('UPDATE entries SET updated_at = MAX(updated_at, :now) WHERE id = :entryId', { now, entryId });
      return;
    }
    const parts = ctx
      .all("SELECT content FROM messages WHERE entry_id = :entryId AND role = 'user' ORDER BY seq", { entryId })
      .map((r) => r.content);
    const wordCount = parts.reduce((sum, text) => sum + countWords(text), 0);
    ctx.run('UPDATE entries SET word_count = :wordCount, updated_at = MAX(updated_at, :now) WHERE id = :entryId', {
      wordCount,
      now,
      entryId,
    });
    search.reindexEntry(entryId, parts);
  }

  /**
   * Append a message to an entry.
   * Assigns `seq` (max + 1, starting at 0) and refreshes the entry's wordCount (words in user
   * messages), updatedAt and search row, all in one transaction.
   * @param {string} entryId
   * @param {{ role: 'user'|'assistant', content: string, meta?: object, createdAt?: number, id?: string }} input
   * @returns {object} the Message
   * @throws {DbError} 'not_found' if the entry does not exist, 'invalid' for bad input
   */
  function add(entryId, input) {
    if (!input || typeof input !== 'object') throw invalid('message', 'message must be an object');
    if (!ROLES.includes(input.role)) throw invalid('role', `role must be one of: ${ROLES.join(', ')}`);
    const content = checkContent(input.content);
    const meta = sanitizeMeta(input.meta);
    if (input.createdAt !== undefined && !isTimestamp(input.createdAt)) throw invalid('createdAt', 'createdAt must be a millisecond timestamp');
    if (input.id !== undefined && !isValidId(input.id)) throw invalid('id', 'id must be a short identifier');
    const id = input.id ?? randomUUID();
    return ctx.tx(() => {
      if (!ctx.scalar('SELECT 1 FROM entries WHERE id = :entryId', { entryId })) {
        throw new DbError('not_found', `Entry ${entryId} does not exist`, { field: 'entryId' });
      }
      const seq = ctx.scalar('SELECT COALESCE(MAX(seq), -1) + 1 FROM messages WHERE entry_id = :entryId', { entryId });
      try {
        ctx.run(
          'INSERT INTO messages (id, entry_id, seq, role, content, created_at, meta) VALUES (:id, :entryId, :seq, :role, :content, :createdAt, :meta)',
          { id, entryId, seq, role: input.role, content, createdAt: input.createdAt ?? ctx.now(), meta: JSON.stringify(meta) },
        );
      } catch (err) {
        if (/UNIQUE constraint failed: messages\.id/.test(String(err && err.message))) {
          throw new DbError('conflict', `A message with id ${id} already exists`, { field: 'id', cause: err });
        }
        throw err;
      }
      refresh(entryId, input.role === 'user');
      return get(id);
    });
  }

  /**
   * Edit a message. `content` replaces the text; `meta` is merge-patched into the existing meta
   * (a `null` value deletes that key). Neither sets `meta.edited` for you.
   * @param {string} id
   * @param {{ content?: string, meta?: object }} patch
   * @returns {object|null} the updated Message, or null if it does not exist
   */
  function update(id, patch = {}) {
    if (!patch || typeof patch !== 'object') throw invalid('patch', 'patch must be an object');
    const content = patch.content === undefined ? undefined : checkContent(patch.content);
    const metaPatch = patch.meta === undefined ? undefined : sanitizeMeta(patch.meta);
    return ctx.tx(() => {
      const current = get(id);
      if (!current) return null;
      if (content === undefined && metaPatch === undefined) return current;
      const nextContent = content ?? current.content;
      const nextMeta = metaPatch === undefined ? current.meta : mergeMeta(current.meta, metaPatch);
      ctx.run('UPDATE messages SET content = :content, meta = :meta WHERE id = :id', {
        id,
        content: nextContent,
        meta: JSON.stringify(nextMeta),
      });
      refresh(current.entryId, current.role === 'user' && nextContent !== current.content);
      return get(id);
    });
  }

  function removeRow(message) {
    ctx.run('DELETE FROM messages WHERE id = :id', { id: message.id });
    refresh(message.entryId, message.role === 'user');
  }

  /**
   * Delete one message. Other messages keep their `seq`.
   * @returns {boolean} whether a message was deleted
   */
  function remove(id) {
    return ctx.tx(() => {
      const message = get(id);
      if (!message) return false;
      removeRow(message);
      return true;
    });
  }

  /**
   * Delete the message with the highest seq (used when regenerating a reply).
   * @returns {object|null} the deleted Message, or null if the entry has none
   */
  function deleteLast(entryId) {
    return ctx.tx(() => {
      const message = last(entryId);
      if (!message) return null;
      removeRow(message);
      return message;
    });
  }

  return { add, get, list, last, update, delete: remove, deleteLast };
}
