// Pure helpers for the History view: month grouping, search-term highlighting and filter <-> URL/API
// plumbing. No DOM access, so it is unit-tested in Node.

const WORD_CHAR = /[\p{L}\p{N}]/u;
// Mirrors the server tokenizer (src/db/search.js) so highlighted words are the words that matched.
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
// Scripts without spaces and emoji are found by substring on the server, so they are highlighted that way too.
const SUBSTRING_TERM = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Extended_Pictographic}]/u;
const PICTOGRAPH_RE = /\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier}|\u{200D}\p{Extended_Pictographic})*/gu;

const MAX_TERMS = 32;
const MAX_TERM_LENGTH = 64;
const MAX_HIGHLIGHT_TEXT = 4000;
const MAX_MATCHES = 200;

/** Title to show for an entry: its title, else the start of what was written, else a placeholder. */
export function entryTitle(entry) {
  const title = String((entry && entry.title) || '').trim();
  if (title) return title;
  const preview = String((entry && entry.preview) || '').replace(/\s+/g, ' ').trim();
  if (preview) {
    const chars = Array.from(preview);
    return chars.length > 60 ? `${chars.slice(0, 57).join('').trimEnd()}…` : preview;
  }
  return 'Untitled entry';
}

/**
 * Text under a card's title: the search snippet when there is one, else the preview. The API cuts
 * previews at ~160 characters without marking the cut, so a long preview that stops mid-sentence gets an ellipsis.
 */
export function previewText(entry) {
  const raw = String((entry && (entry.snippet || entry.preview)) || '').replace(/\s+/g, ' ').trim();
  if (!raw || (entry && entry.snippet)) return raw;
  return raw.length >= 150 && !/[.!?…"”')\]]$/.test(raw) ? `${raw}…` : raw;
}

/* ------------------------------------------------------------------ month grouping */
/** 'YYYY-MM' of an entry's date (falls back to its creation time), or 'unknown'. */
export function monthKey(entry) {
  const date = entry && typeof entry.date === 'string' ? entry.date : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date.slice(0, 7);
  if (entry && Number.isFinite(entry.createdAt)) {
    const d = new Date(entry.createdAt);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  return 'unknown';
}

/** First day of a month key as YYYY-MM-DD (for formatMonth). */
export function monthStart(key) {
  return /^\d{4}-\d{2}$/.test(key) ? `${key}-01` : '';
}

/**
 * Group consecutive entries that share a month. Order is preserved (the API sorts by creation time,
 * which can differ from `date` after an edit, so entries are never reordered).
 * @param {object[]} entries
 * @param {string|null} [previousKey] month of the entry just above this batch ("Load more"); the first group then has `continues: true`
 * @returns {{ key: string, entries: object[], continues: boolean }[]}
 */
export function groupByMonth(entries, previousKey = null) {
  const groups = [];
  for (const entry of entries) {
    const key = monthKey(entry);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else groups.push({ key, entries: [entry], continues: groups.length === 0 && key === previousKey });
  }
  return groups;
}

/* ------------------------------------------------------------------ highlighting */
/** Distinct lowercase search terms of a query (letters/digits runs; emoji when there are no words). */
export function searchTerms(query) {
  const text = String(query ?? '').slice(0, 4000);
  const seen = new Set();
  const out = [];
  const add = (term) => {
    const t = Array.from(term.toLowerCase()).slice(0, MAX_TERM_LENGTH).join('');
    if (t && !seen.has(t) && out.length < MAX_TERMS) { seen.add(t); out.push(t); }
  };
  for (const m of text.matchAll(TOKEN_RE)) add(m[0]);
  if (out.length === 0) for (const m of text.matchAll(PICTOGRAPH_RE)) add(m[0]);
  return out;
}

/** Lowercase and strip accents, remembering where every folded unit came from. */
function fold(text) {
  let folded = '';
  const map = []; // map[i] = index in `text` that produced folded[i]
  for (let i = 0; i < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(i));
    const f = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let k = 0; k < f.length; k += 1) map.push(i);
    folded += f;
    i += ch.length;
  }
  map.push(text.length);
  return { folded, map };
}

/**
 * Split `text` into plain and matching segments for the given terms. Words match from their start
 * (prefix search, like the server); accents and case are ignored. Output is data, never HTML.
 * @param {string} text
 * @param {string[]} terms from searchTerms()
 * @returns {{ text: string, match: boolean }[]}
 */
export function highlightSegments(text, terms) {
  const source = String(text ?? '');
  if (!source) return [];
  if (!terms || terms.length === 0 || source.length > MAX_HIGHLIGHT_TEXT) return [{ text: source, match: false }];

  const { folded, map } = fold(source);
  const ranges = [];
  for (const raw of terms) {
    const term = fold(raw).folded;
    if (!term) continue;
    const anywhere = SUBSTRING_TERM.test(term);
    for (let from = 0; ranges.length < MAX_MATCHES;) {
      const at = folded.indexOf(term, from);
      if (at === -1) break;
      from = at + term.length;
      if (!anywhere && at > 0 && WORD_CHAR.test(folded[at - 1])) continue; // mid-word: not a prefix match
      ranges.push([map[at], map[at + term.length]]);
    }
  }
  if (ranges.length === 0) return [{ text: source, match: false }];

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out = [];
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out.push({ text: source.slice(pos, a), match: false });
    out.push({ text: source.slice(a, b), match: true });
    pos = b;
  }
  if (pos < source.length) out.push({ text: source.slice(pos), match: false });
  return out;
}

/* ------------------------------------------------------------------ filters */
/** @typedef {{ q: string, mood: number|null, tag: string, pinned: boolean }} Filters */

/** Read filters from URL params (`?q=&mood=&tag=&pinned=1`), ignoring junk. @returns {Filters} */
export function parseFilters(params) {
  const get = (name) => (params && typeof params.get === 'function' ? params.get(name) : null) || '';
  const mood = Number.parseInt(get('mood'), 10);
  return {
    q: get('q').slice(0, 200),
    mood: mood >= 1 && mood <= 5 ? mood : null,
    tag: get('tag').slice(0, 24),
    pinned: get('pinned') === '1',
  };
}

/** URL params for the current filters (only the active ones). */
export function filtersToParams(filters) {
  const p = new URLSearchParams();
  if (filters.q.trim()) p.set('q', filters.q.trim());
  if (filters.mood) p.set('mood', String(filters.mood));
  if (filters.tag) p.set('tag', filters.tag);
  if (filters.pinned) p.set('pinned', '1');
  return p;
}

export function hasActiveFilters(filters) {
  return Boolean(filters.q.trim() || filters.mood || filters.tag || filters.pinned);
}

/** `/entries?...` path for the API. Search is a single ranked page, so `before` is ignored with `q`. */
export function listPath(filters, { before = null, limit = 30 } = {}) {
  const p = filtersToParams(filters);
  const searching = Boolean(filters.q.trim());
  p.set('limit', String(searching ? Math.min(limit, 50) : limit));
  if (before !== null && before !== undefined && !searching) p.set('before', String(before));
  return `/entries?${p.toString()}`;
}
