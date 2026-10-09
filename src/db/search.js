// Full-text search over entries (SQLite FTS5) and the code that keeps the index in sync.
//
// entry_search has one row per entry, rowid = entries.rid:
//   title = entry title, body = text of the *user* messages, tags = tags + emotions.
// FTS tables cannot have foreign keys, so every repository that changes something indexed calls
// reindexEntry()/removeEntry() inside the same transaction.
//
// Raw user text never reaches MATCH: it is reduced to unicode letter/digit tokens and each token is
// emitted as a double-quoted string (see buildMatchQuery).

import { entryFilters } from './filters.js';
import { countWords, truncateChars } from './util.js';

const MAX_QUERY_TOKENS = 32;
const MAX_TOKEN_LENGTH = 64;
const MAX_QUERY_CHARS = 4000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
export const SNIPPET_MAX = 160;

// A token starts with a letter/digit and may continue with combining marks (Hindi, Thai, accents).
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
// unicode61 keeps a run of Han/Kana/Thai... as ONE token, so "日記" cannot be found inside
// "今日の日記" through the index. Such tokens (and emoji) also get a substring search.
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const PICTOGRAPH_RE = /\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier}|\u{200D}\p{Extended_Pictographic})*/gu;

/**
 * Split free text into distinct lowercase search tokens (unicode letters and digits).
 * Bounded: at most 32 tokens of at most 64 characters, from the first 4000 characters.
 * @param {unknown} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text === '') return [];
  const input = text.length > MAX_QUERY_CHARS ? text.slice(0, MAX_QUERY_CHARS) : text;
  const seen = new Set();
  const out = [];
  for (const match of input.matchAll(TOKEN_RE)) {
    const token = truncateChars(match[0].toLowerCase(), MAX_TOKEN_LENGTH);
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= MAX_QUERY_TOKENS) break;
  }
  return out;
}

/**
 * Build a safe FTS5 MATCH expression from user text, or '' when nothing searchable remains.
 * 'all' (default): every token must match, as a prefix: `"jour"* "fee"*`.
 * 'any': tokens OR-ed, exact: `"work" OR "stress"`.
 * @param {unknown} text
 * @param {'all'|'any'} [mode]
 * @returns {string}
 */
export function buildMatchQuery(text, mode = 'all') {
  const tokens = tokenize(text);
  if (tokens.length === 0) return '';
  const quoted = tokens.map((t) => `"${t.replaceAll('"', '""')}"`);
  return mode === 'any' ? quoted.join(' OR ') : quoted.map((q) => `${q}*`).join(' ');
}

function pictographs(text) {
  if (typeof text !== 'string') return [];
  const found = new Set();
  for (const match of text.slice(0, MAX_QUERY_CHARS).matchAll(PICTOGRAPH_RE)) {
    found.add(match[0]);
    if (found.size >= 8) break;
  }
  return [...found];
}

const foldWord = (word) => word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

// Where, in the (whitespace-collapsed) text, does the earliest search term start? -1 if nowhere.
function firstMatchIndex(text, terms) {
  const folded = terms.map(foldWord);
  const substring = terms.filter((t) => NO_SPACE_SCRIPT.test(t) || !/^[\p{L}\p{N}]/u.test(t));
  let best = -1;
  for (const m of text.matchAll(WORD_RE)) {
    const word = foldWord(m[0]);
    if (folded.some((t) => word.startsWith(t))) {
      best = m.index;
      break;
    }
  }
  const lower = text.toLowerCase();
  for (const term of substring) {
    const at = lower.length === text.length ? lower.indexOf(term.toLowerCase()) : text.indexOf(term);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best;
}

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Plain-text excerpt of at most `max` characters, centred on the first occurrence of any term,
 * with "…" marking cut ends. No markup of any kind is added.
 * @param {string} text
 * @param {string[]} terms lowercase search terms (prefix-matched against words)
 * @param {number} [max]
 * @returns {string}
 */
export function makeSnippet(text, terms, max = SNIPPET_MAX) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const at = terms.length > 0 ? firstMatchIndex(flat, terms) : -1;
  // Put the match a little before the middle so the reader sees the words that lead up to it,
  // but never leave the window half empty when the match is near the end of the text.
  let start = at <= 0 ? 0 : Math.max(0, at - Math.floor(max * 0.42));
  start = Math.min(start, Math.max(0, flat.length - max + 1));
  // Do not begin in the middle of a word when a nearby space allows a clean start.
  if (start > 0) {
    const space = flat.indexOf(' ', start);
    if (space !== -1 && space - start <= 12 && space < at) start = space + 1;
  }
  if (isLowSurrogate(flat.charCodeAt(start))) start++;
  let room = max - (start > 0 ? 1 : 0);
  let end = start + room;
  if (end < flat.length) {
    room -= 1; // space for the trailing ellipsis
    end = start + room;
    const space = flat.lastIndexOf(' ', end);
    if (space > start && end - space <= 12 && (at === -1 || space > at)) end = space;
    if (isHighSurrogate(flat.charCodeAt(end - 1))) end--;
  }
  const body = flat.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${body}${end < flat.length ? '…' : ''}`;
}

function likePattern(term) {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

// Non-numeric or non-positive limits fall back to the default rather than silently returning 1 row.
const parseLimit = (value) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
};

/** How many of the best hits may be skipped to reach a later page (paging deeper than this is not offered). */
const MAX_OFFSET = 1000;
const parseOffset = (value) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_OFFSET) : 0;
};

/**
 * @param {ReturnType<import('./context.js').createContext>} ctx
 */
export function createSearch(ctx) {
  const tagsText = (row) => [...safeArray(row.tags), ...safeArray(row.emotions)].join(' ');

  function safeArray(json) {
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  const totalWords = (parts) => parts.reduce((sum, text) => sum + countWords(text), 0);

  // True while the index may still physically hold terms of rows that were replaced or deleted:
  // FTS5 only appends "delete" markers and keeps the old segments until they are merged.
  let stale = false;

  /**
   * Rebuild the FTS5 index from the stored row text so the terms of deleted and rewritten rows are
   * physically dropped from the file. DELETE alone only appends "delete" markers and leaves the old
   * segments (and with them every word of the deleted text) in place; the 'optimize' command is not
   * enough either, because it keeps those markers when all segments sit below the top level.
   * Costs about 150 ms per 12 000 messages and nothing for an empty or small journal.
   */
  function purge() {
    ctx.handle.exec("INSERT INTO entry_search (entry_search) VALUES ('rebuild')");
    stale = false; // nothing is left to purge until the next replace or delete (so scrub() and close() do not rebuild twice)
  }

  /** purge() unless nothing was replaced or deleted since the last time; used when closing. */
  function purgeIfStale() {
    if (stale) purge();
  }

  function dropRow(rid) {
    if (ctx.run('DELETE FROM entry_search WHERE rowid = :rid', { rid }).changes > 0) stale = true;
  }

  function writeRow(rid, entryId, title, body, tags) {
    dropRow(rid);
    ctx.run('INSERT INTO entry_search (rowid, entry_id, title, body, tags) VALUES (:rid, :entryId, :title, :body, :tags)', {
      rid,
      entryId,
      title,
      body,
      tags,
    });
  }

  function userContents(entryId) {
    return ctx
      .all("SELECT content FROM messages WHERE entry_id = :entryId AND role = 'user' ORDER BY seq", { entryId })
      .map((r) => r.content);
  }

  /**
   * Rewrite the index row of one entry from the database state. Call inside the transaction that
   * changed the entry or its messages.
   * @param {string} entryId
   * @param {string[]} [userParts] contents of the user messages in order, if the caller has them
   * @returns {boolean} false if the entry does not exist
   */
  function reindexEntry(entryId, userParts) {
    const row = ctx.one('SELECT rid, id, title, tags, emotions FROM entries WHERE id = :id', { id: entryId });
    if (!row) return false;
    const parts = userParts ?? userContents(entryId);
    writeRow(row.rid, row.id, row.title, parts.join('\n'), tagsText(row));
    return true;
  }

  /** Drop the index row of an entry (call before deleting the entry itself). */
  function removeEntry(entryId) {
    const row = ctx.one('SELECT rid FROM entries WHERE id = :id', { id: entryId });
    if (row) dropRow(row.rid);
  }

  function bodiesByEntry() {
    const map = new Map();
    const rows = ctx.prepare("SELECT entry_id, content FROM messages WHERE role = 'user' ORDER BY entry_id, seq").all();
    for (const r of rows) {
      const list = map.get(r.entry_id);
      if (list) list.push(r.content);
      else map.set(r.entry_id, [r.content]);
    }
    return map;
  }

  /**
   * Rebuild the whole index (and the cached word counts) from entries and messages.
   * @returns {number} number of entries indexed
   */
  function reindexAll() {
    return ctx.tx(() => {
      ctx.run('DELETE FROM entry_search');
      stale = true;
      const bodies = bodiesByEntry();
      const entries = ctx.prepare('SELECT rid, id, title, tags, emotions, word_count FROM entries ORDER BY rid').all();
      for (const row of entries) {
        const parts = bodies.get(row.id) ?? [];
        writeRow(row.rid, row.id, row.title, parts.join('\n'), tagsText(row));
        const words = totalWords(parts);
        if (words !== row.word_count) ctx.run('UPDATE entries SET word_count = :words WHERE rid = :rid', { words, rid: row.rid });
      }
      return entries.length;
    });
  }

  /**
   * Compare the index and the cached word counts with what reindexAll() would produce.
   * @returns {{ ok: boolean, problems: string[], entries: number, indexed: number }}
   */
  function checkConsistency() {
    const problems = [];
    const bodies = bodiesByEntry();
    const indexed = new Map();
    for (const r of ctx.prepare('SELECT rowid AS rid, entry_id, title, body, tags FROM entry_search').all()) indexed.set(r.rid, { ...r });
    const entries = ctx.prepare('SELECT rid, id, title, tags, emotions, word_count FROM entries').all();
    for (const row of entries) {
      if (totalWords(bodies.get(row.id) ?? []) !== row.word_count) problems.push(`entry ${row.id}: stale word count`);
      const actual = indexed.get(row.rid);
      indexed.delete(row.rid);
      if (!actual) {
        problems.push(`entry ${row.id} has no search row`);
        continue;
      }
      const expectedBody = (bodies.get(row.id) ?? []).join('\n');
      if (actual.entry_id !== row.id) problems.push(`entry ${row.id}: search row points at ${actual.entry_id}`);
      if (actual.title !== row.title) problems.push(`entry ${row.id}: stale title in search index`);
      if (actual.body !== expectedBody) problems.push(`entry ${row.id}: stale body in search index`);
      if (actual.tags !== tagsText(row)) problems.push(`entry ${row.id}: stale tags in search index`);
    }
    for (const [rid, row] of indexed) problems.push(`orphan search row ${rid} (${row.entry_id})`);
    try {
      ctx.handle.exec("INSERT INTO entry_search (entry_search) VALUES ('integrity-check')");
    } catch (err) {
      problems.push(`FTS5 integrity check failed: ${err.message}`);
    }
    return { ok: problems.length === 0, problems, entries: entries.length, indexed: entries.length + indexed.size };
  }

  // Shared WHERE fragments for both the FTS and the substring stage. `filters` is the validated
  // result of entryFilters(), the same parser entries.list() uses.
  function filterClauses(opts, filters, params) {
    const where = [...filters.where];
    Object.assign(params, filters.params);
    if (!opts.includePrivate) where.push('e.private = 0');
    if (typeof opts.excludeEntryId === 'string' && opts.excludeEntryId) {
      where.push('e.id != :excludeId');
      params.excludeId = opts.excludeEntryId;
    }
    return where;
  }

  function ftsStage(match, opts, filters, limit) {
    const params = { match, limit };
    const where = ['entry_search MATCH :match', ...filterClauses(opts, filters, params)];
    const sql = `
      SELECT e.id AS entry_id, bm25(entry_search, 0.0, 6.0, 1.0, 2.5) AS score,
             entry_search.title AS title, entry_search.body AS body, entry_search.tags AS tags
      FROM entry_search JOIN entries e ON e.rid = entry_search.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY score, e.created_at DESC, e.id
      LIMIT :limit`;
    try {
      return ctx.all(sql, params);
    } catch (err) {
      // The expression is generated from quoted tokens and should always parse; if FTS5 still
      // rejects it, "no results" is the right answer for a search box. Anything else is a real bug.
      if (/fts5|syntax error|unterminated/i.test(String(err && err.message))) return [];
      throw err;
    }
  }

  function substringStage(terms, mode, opts, filters, limit) {
    const params = { limit };
    const where = filterClauses(opts, filters, params);
    const likes = terms.map((term, i) => {
      params[`t${i}`] = likePattern(term);
      return `(entry_search.title || char(10) || entry_search.body || char(10) || entry_search.tags) LIKE :t${i} ESCAPE '\\'`;
    });
    where.push(`(${likes.join(mode === 'any' ? ' OR ' : ' AND ')})`);
    const sql = `
      SELECT e.id AS entry_id, 0 AS score,
             entry_search.title AS title, entry_search.body AS body, entry_search.tags AS tags
      FROM entry_search JOIN entries e ON e.rid = entry_search.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY e.created_at DESC, e.id
      LIMIT :limit`;
    return ctx.all(sql, params);
  }

  /**
   * Search entries.
   *
   * 'all' (default): every word must match as a prefix; for the search box.
   * 'any': any word may match, ranked by BM25; for related-entry recall.
   * Chinese/Japanese/Thai words and emoji, which the tokenizer cannot split, additionally fall back
   * to a plain substring match so they are still found.
   *
   * @param {string} queryText untrusted user text
   * @param {{ limit?: number, offset?: number, excludeEntryId?: string, includePrivate?: boolean, mode?: 'all'|'any',
   *           mood?: number|string, tag?: string, from?: string, to?: string, pinned?: boolean|string }} [options]
   *   The entry filters accept exactly what entries.list() accepts (query-string values such as
   *   mood '3' or pinned '1' included) and throw DbError('invalid') for malformed ones.
   *   `offset` skips that many of the best hits (at most MAX_OFFSET), so a caller can page through a long result list:
   *   the ranking is deterministic (score, newest first, id), so page 2 continues where page 1 stopped.
   * @returns {{ entryId: string, rank: number, snippet: string }[]} best first. `rank` is the BM25
   *   score (smaller = better, usually negative); substring-only hits have rank 0 and come last.
   */
  function search(queryText, options = {}) {
    const opts = options ?? {};
    const mode = opts.mode === 'any' ? 'any' : 'all';
    const offset = parseOffset(opts.offset);
    const limit = parseLimit(opts.limit) + offset; // the hits to collect: the skipped ones and the page
    // Validate the filters before looking at the text, so a bad filter is an error even when the
    // query itself turns out to be empty.
    const filters = entryFilters(opts);
    const tokens = tokenize(queryText);
    const emoji = tokens.length === 0 ? pictographs(queryText) : [];
    if (tokens.length === 0 && emoji.length === 0) return [];

    const hits = [];
    const seen = new Set();
    const collect = (rows, terms) => {
      for (const row of rows) {
        if (seen.has(row.entry_id) || hits.length >= limit) continue;
        seen.add(row.entry_id);
        hits.push({ entryId: row.entry_id, rank: row.score, snippet: snippetFor(row, terms) });
      }
    };

    if (tokens.length > 0) {
      collect(ftsStage(buildMatchQuery(queryText, mode), opts, filters, limit), tokens);
    }
    const terms = tokens.length > 0 ? tokens : emoji;
    const needsSubstring = emoji.length > 0 || tokens.some((t) => NO_SPACE_SCRIPT.test(t));
    if (needsSubstring && hits.length < limit) {
      const extra = substringStage(terms, mode, opts, filters, limit + seen.size);
      collect(extra, terms);
    }
    return offset > 0 ? hits.slice(offset) : hits;
  }

  function snippetFor(row, terms) {
    if (row.body) {
      const snippet = makeSnippet(row.body, terms);
      if (snippet) return snippet;
    }
    return makeSnippet(row.title || row.tags || '', terms);
  }

  return Object.assign(search, { reindexEntry, removeEntry, reindexAll, checkConsistency, purge, purgeIfStale, tokenize, buildMatchQuery, makeSnippet });
}

