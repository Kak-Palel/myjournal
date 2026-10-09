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

const TITLE_FALLBACK_CHARS = 60;

/**
 * Cut `text` (one line) to at most `max` code points at a word boundary; `rest` is what was left out, starting at the next word.
 * A text that already fits is returned whole with no rest.
 * @returns {{ head: string, rest: string }}
 */
function cutAtWord(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return { head: text, rest: '' };
  const budget = max - 1; // room for the ellipsis the caller adds
  const slice = chars.slice(0, budget).join('');
  const space = slice.lastIndexOf(' ');
  const cut = space >= Math.floor(budget * 0.4) && chars[budget] !== ' ' ? space : slice.length;
  return { head: slice.slice(0, cut).trimEnd(), rest: text.slice(cut).trimStart() };
}

/** Title to show for an entry: its title, else the start of what was written, else a placeholder. */
export function entryTitle(entry) {
  const title = String((entry && entry.title) || '').trim();
  if (title) return title;
  const preview = String((entry && entry.preview) || '').replace(/\s+/g, ' ').trim();
  if (preview) {
    const { head, rest } = cutAtWord(preview, TITLE_FALLBACK_CHARS);
    return rest ? `${head}…` : head;
  }
  return 'Untitled entry';
}

/**
 * The two lines of a history card: the title and the text under it.
 * An entry without a title uses the start of what was written as its title, so the text under it must not say the same words
 * again: it continues where the title stopped (and is left out when the title already shows everything there is).
 * @returns {{ title: string, excerpt: string }}
 */
export function cardTexts(entry) {
  const own = String((entry && entry.title) || '').trim();
  const preview = String((entry && entry.preview) || '').replace(/\s+/g, ' ').trim();
  const excerpt = previewText(entry);
  if (own || !preview) return { title: entryTitle(entry), excerpt };
  const { head, rest } = cutAtWord(preview, TITLE_FALLBACK_CHARS);
  const title = rest ? `${head}…` : head;
  const snippet = String((entry && entry.snippet) || '').replace(/\s+/g, ' ').trim();
  if (snippet) {
    // a search excerpt shows the part that matched; it is redundant only when that part is already in the title
    const bare = snippet.replace(/^…|…$/g, '').trim().toLowerCase();
    return { title, excerpt: bare && head.toLowerCase().includes(bare) ? '' : excerpt };
  }
  if (!rest) return { title, excerpt: '' };
  // the API cuts a long preview without marking it (see previewText), so a cut that stops mid-sentence gets its ellipsis here too
  return { title, excerpt: preview.length >= 150 && !/[.!?…"”')\]]$/.test(rest) ? `${rest}…` : rest };
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

/** Newest first: by the entry's date, then by when it was written, then by id (so the order never depends on arrival order). */
function newerFirst(a, b) {
  const da = typeof a.date === 'string' ? a.date : '';
  const db = typeof b.date === 'string' ? b.date : '';
  if (da !== db) return da < db ? 1 : -1;
  const ca = Number.isFinite(a.createdAt) ? a.createdAt : 0;
  const cb = Number.isFinite(b.createdAt) ? b.createdAt : 0;
  if (ca !== cb) return ca < cb ? 1 : -1;
  return String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0;
}

/**
 * Put `entry` where it belongs in a list of month groups (newest month first, 'unknown' last; inside a month newest first).
 * The server lists entries by WHEN THEY WERE WRITTEN, but the headings are the entry's own `date`, which the person can edit.
 * Grouping the cards in arrival order put an entry that was backdated under an older month in the middle of the list and
 * repeated the heading of the month around it. Placing every card by its date gives each month one heading, whatever the order
 * the pages arrive in; for entries written on their own day (the usual case) each card simply lands at the end of its group.
 * @param {{ key: string, entries: object[] }[]} months the groups so far (changed in place)
 * @param {object} entry
 * @returns {{ monthIndex: number, entryIndex: number, newMonth: boolean }} where the entry went (indexes after the insert)
 */
export function placeInMonths(months, entry) {
  const key = monthKey(entry);
  let monthIndex = months.findIndex((m) => m.key === key);
  const newMonth = monthIndex === -1;
  if (newMonth) {
    const rank = (k) => (k === 'unknown' ? '' : k); // 'unknown' sorts as the oldest
    monthIndex = months.findIndex((m) => rank(m.key) < rank(key));
    if (monthIndex === -1) monthIndex = months.length;
    months.splice(monthIndex, 0, { key, entries: [] });
  }
  const list = months[monthIndex].entries;
  let entryIndex = list.length;
  while (entryIndex > 0 && newerFirst(entry, list[entryIndex - 1]) < 0) entryIndex -= 1;
  list.splice(entryIndex, 0, entry);
  return { monthIndex, entryIndex, newMonth };
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

/** The server pages a search through its best 500 matches (MAX_SEARCH_DEPTH in routes/entries.js); deeper ones are not offered. */
export const SEARCH_DEPTH = 500;
/** A search page holds at most this many entries (MAX_SEARCH_RESULTS in routes/entries.js). */
export const SEARCH_PAGE_MAX = 50;

/**
 * `/entries?...` path for the API. A list continues with `before` (the createdAt of the last card); a search is ranked, so it
 * continues with `offset` (how many of the best matches are already shown) and `before` is ignored.
 */
export function listPath(filters, { before = null, offset = 0, limit = 30 } = {}) {
  const p = filtersToParams(filters);
  const searching = Boolean(filters.q.trim());
  p.set('limit', String(searching ? Math.min(limit, SEARCH_PAGE_MAX) : limit));
  if (searching) {
    if (offset > 0) p.set('offset', String(offset));
  } else if (before !== null && before !== undefined) {
    p.set('before', String(before));
  }
  return `/entries?${p.toString()}`;
}
