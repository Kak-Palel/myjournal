// Small shared helpers for the DB layer: errors, limits, JSON/row conversion and text
// normalisation. Nothing in here touches SQLite.

/**
 * Error raised by the DB layer for problems the caller can act on.
 * `code`: 'invalid' (bad argument; `field` names it), 'not_found', 'conflict', 'schema_too_new',
 * 'open_failed', 'bad_file' (not a MyJournal database, or damaged), 'no_fts5' (this Node.js has no full-text search), 'invalid_import'.
 */
export class DbError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ field?: string, cause?: unknown }} [extra]
   */
  constructor(code, message, { field, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DbError';
    this.code = code;
    if (field) this.field = field;
  }
}

/** Size limits shared by the repositories and the importer. */
export const LIMITS = Object.freeze({
  title: 300,
  summary: 2000,
  templateId: 64,
  messageContent: 200_000,
  memoryText: 300,
  memoryRaw: 4096,
  reportContent: 100_000,
  metaBytes: 16_384,
  metaDepth: 4,
  emotions: 5,
  tags: 8,
  labelLength: 24,
  idLength: 100,
});

/** Newest timestamp we accept (9999-12-31); keeps `new Date(ms)` valid. */
export const MAX_TIMESTAMP = 253_402_300_799_999;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True for the keys that enable prototype pollution when copied naively. */
export function isDangerousKey(key) {
  return DANGEROUS_KEYS.has(key);
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** node:sqlite rows have a null prototype; callers get ordinary objects. */
export function plainRow(row) {
  return row ? { ...row } : null;
}

/** Parse a JSON column that must hold an array of strings; anything else yields []. */
export function parseStringArray(text) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Parse a JSON column that must hold an object; anything else yields {}. */
export function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

export const isSafeInt = (v) => typeof v === 'number' && Number.isSafeInteger(v);

/** Integer milliseconds in [0, MAX_TIMESTAMP]. */
export function isTimestamp(v) {
  return isSafeInt(v) && v >= 0 && v <= MAX_TIMESTAMP;
}

/** Ids we are willing to store: short, printable, no whitespace; never the prototype-pollution names. */
export function isValidId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= LIMITS.idLength && /^[A-Za-z0-9_.:-]+$/.test(v) && !isDangerousKey(v);
}

/** A real calendar date in `YYYY-MM-DD` form. */
export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1000) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` in the server's local time zone; only a fallback, clients send their own date. */
export function localDateString(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Cut to at most `max` code points without splitting a surrogate pair. */
export function truncateChars(text, max) {
  if (text.length <= max) return text;
  // Array.from() allocates one element per code point, which is ruinous for a multi-megabyte string
  // from a hostile import. `max` code points never need more than 2 * max UTF-16 units.
  const head = text.length > max * 2 ? text.slice(0, max * 2) : text;
  return Array.from(head).slice(0, max).join('');
}

// NUL ends a C string inside SQLite's text functions and FTS5, so anything after it silently
// vanishes from the stored value; the other C0 controls (tab, newline, VT, FF and CR excepted) and
// DEL have no business in titles, labels or short texts either.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000e-\u001f\u007f]/g;

/**
 * Remove NUL and the other control characters and replace lone surrogates with U+FFFD, so the value
 * we validate and compare is exactly what SQLite hands back later.
 * @param {string} text
 */
export function cleanChars(text) {
  return text.replace(CONTROL_CHARS, '').toWellFormed();
}

/** One clean line: control characters removed, whitespace collapsed, trimmed. */
export function cleanLine(text) {
  return cleanChars(text).replace(/\s+/g, ' ').trim();
}

/** True when `text` has more than `max` code points; never walks a huge string to find out. */
export function exceedsChars(text, max) {
  return text.length > max * 2 || Array.from(text).length > max;
}

// A label is cut to 24 characters anyway; looking at a bounded prefix keeps a hostile 40 MB "tag"
// from costing seconds of regex work and hundreds of MB of memory.
const LABEL_RAW_MAX = 256;

function cleanLabel(item) {
  const raw = item.length > LABEL_RAW_MAX ? item.slice(0, LABEL_RAW_MAX) : item;
  return cleanLine(raw).replace(/^#+/, '').trim().toLowerCase();
}

/**
 * Lowercase, trimmed, de-duplicated labels (tags / emotions). Accepts an array or a comma
 * separated string; non-strings are ignored. Control characters are removed, over-long labels are
 * cut, extra labels dropped.
 * @param {unknown} list
 * @param {{ max: number, maxLen?: number }} opts
 * @returns {string[]}
 */
export function normalizeLabels(list, { max, maxLen = LIMITS.labelLength }) {
  const items = typeof list === 'string' ? list.split(',') : Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const label = truncateChars(cleanLabel(item), maxLen).trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Word counting

// Scripts written without spaces between words: whitespace splitting would count a whole
// sentence as one word, so those tokens go through Intl.Segmenter instead.
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
let segmenter = null;

function segmentedWordCount(token) {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  let n = 0;
  for (const part of segmenter.segment(token)) if (part.isWordLike) n++;
  return n;
}

/**
 * Number of words in a text. Whitespace-separated tokens that contain a letter or digit count as
 * one word ("well-known" is one, "-" is none); Chinese/Japanese/Thai runs are segmented.
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  if (typeof text !== 'string' || text === '') return 0;
  let n = 0;
  for (const token of text.split(/\s+/)) {
    if (token === '') continue;
    if (NO_SPACE_SCRIPT.test(token)) n += Math.max(1, segmentedWordCount(token));
    else if (HAS_WORD_CHAR.test(token)) n += 1;
  }
  return n;
}

/** First ~160 characters of a text on one line, with an ellipsis when cut. */
export function previewOf(text, max = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max).join('').trimEnd()}…`;
}

/**
 * Key used to detect duplicate memories: lowercase, collapsed whitespace, no leading bullet or
 * quote and no trailing punctuation.
 * @param {string} text
 */
export function normalizeMemoryText(text) {
  // Same cleaning as when a memory is stored, so a candidate containing NUL still matches.
  return cleanChars(String(text ?? ''))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-*\u{2022}\u{201C}\u{2018}"'(\[\s]+/u, '')
    .replace(/[\s.!?,;:\u{2026}\u{3002}\u{FF01}\u{FF1F}\u{3001}"'\u{201D}\u{2019})\]]+$/u, '');
}

// ---------------------------------------------------------------------------------------------
// Free-form JSON (message meta, report meta)

function sanitizeJson(value, depth) {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'object':
      break;
    default:
      return undefined; // undefined, function, symbol, bigint: dropped
  }
  if (depth > LIMITS.metaDepth) throw new DbError('invalid', `meta is nested deeper than ${LIMITS.metaDepth} levels`, { field: 'meta' });
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeJson(item, depth + 1) ?? null);
  }
  const out = {};
  let count = 0;
  for (const key of Object.keys(value)) {
    if (isDangerousKey(key)) continue;
    const clean = sanitizeJson(value[key], depth + 1);
    if (clean === undefined) continue;
    out[key] = clean;
    if (++count >= 50) break;
  }
  return out;
}

/**
 * Make a free-form `meta` object safe to store: plain JSON only, prototype-pollution keys
 * removed, bounded depth and size. `undefined`/`null` become `{}`.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 * @throws {DbError} code 'invalid' when it is not an object, too deep or too large
 */
export function sanitizeMeta(value) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw new DbError('invalid', 'meta must be an object', { field: 'meta' });
  const clean = sanitizeJson(value, 1);
  if (JSON.stringify(clean).length > LIMITS.metaBytes) {
    throw new DbError('invalid', `meta is larger than ${LIMITS.metaBytes} bytes`, { field: 'meta' });
  }
  return clean;
}

/**
 * Shallow merge-patch for `meta`: keys in `patch` overwrite, a `null` value deletes the key.
 * @param {Record<string, unknown>} current
 * @param {unknown} patch
 */
export function mergeMeta(current, patch) {
  const clean = sanitizeMeta(patch);
  const out = { ...current };
  for (const key of Object.keys(clean)) {
    if (clean[key] === null) delete out[key];
    else out[key] = clean[key];
  }
  return sanitizeMeta(out);
}
