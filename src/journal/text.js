// Small, pure text helpers shared by the prompt builders and the output parsers.
// Everything here is code-point safe (never splits a surrogate pair) and tolerant of non-string input.

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// Zero-width space, bidi embedding/override controls, word joiner / invisible operators and the BOM have no business
// in prompts or labels. U+200C (ZWNJ), U+200D (ZWJ), U+200E (LRM) and U+200F (RLM) are kept on purpose: they are part
// of the spelling in Persian, Urdu, Kurdish, Malayalam and Indic conjuncts, and they glue emoji families together.
const INVISIBLE_RE = /[​‪-‮⁠-⁤﻿]/g;

// Scripts written without spaces between words: whitespace splitting would count a sentence as one word.
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

let wordSegmenter = null;

function segmentedWordCount(token) {
  wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  let n = 0;
  for (const part of wordSegmenter.segment(token)) if (part.isWordLike) n += 1;
  return n;
}

/**
 * Remove control and invisible characters, normalise line endings to `\n`.
 * Tabs and newlines survive.
 * @param {unknown} text
 * @returns {string}
 */
export function cleanText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').replace(INVISIBLE_RE, '');
}

/**
 * Everything on one line: all whitespace runs become a single space, ends trimmed.
 * @param {unknown} text
 * @returns {string}
 */
export function oneLine(text) {
  return cleanText(text).replace(/\s+/g, ' ').trim();
}

/** @param {unknown} text @returns {string} first character upper-cased (code-point safe) */
export function capitalize(text) {
  const s = typeof text === 'string' ? text : '';
  if (s === '') return s;
  const first = String.fromCodePoint(s.codePointAt(0));
  return first.toUpperCase() + s.slice(first.length);
}

/**
 * Number of words. Whitespace-separated tokens that contain a letter or digit count as one
 * ("well-known" is one, a lone "-" is none); runs of Chinese, Japanese or Thai are segmented
 * with Intl.Segmenter so a sentence in those scripts is not a single word.
 * @param {unknown} text
 * @returns {number}
 */
export function wordCount(text) {
  if (typeof text !== 'string' || text === '') return 0;
  let n = 0;
  for (const token of text.split(/\s+/)) {
    if (token === '') continue;
    if (NO_SPACE_SCRIPT.test(token)) n += Math.max(1, segmentedWordCount(token));
    else if (HAS_WORD_CHAR.test(token)) n += 1;
  }
  return n;
}

/**
 * Cut to at most `maxChars` code points, ending in an ellipsis when something was removed
 * (the ellipsis counts towards the limit). Never splits a surrogate pair.
 * @param {unknown} text
 * @param {number} maxChars
 * @param {string} [ellipsis='…']
 * @returns {string}
 */
export function truncate(text, maxChars, ellipsis = '…') {
  const s = typeof text === 'string' ? text : '';
  const max = Math.floor(maxChars);
  if (!(max > 0)) return '';
  if (s.length <= max) return s; // UTF-16 length >= code point count, so this is a safe fast path
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const room = Math.max(0, max - Array.from(ellipsis).length);
  return chars.slice(0, room).join('').trimEnd() + ellipsis;
}

/**
 * Keep the beginning and the end of a long text and replace the middle with a marker.
 * The result has at most `maxChars` code points (marker included).
 * @param {unknown} text
 * @param {number} maxChars
 * @param {string} [marker=' […] ']
 * @returns {string}
 */
export function truncateMiddle(text, maxChars, marker = ' […] ') {
  const s = typeof text === 'string' ? text : '';
  const max = Math.floor(maxChars);
  if (!(max > 0)) return '';
  if (s.length <= max) return s;
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const markerLen = Array.from(marker).length;
  if (max <= markerLen + 2) return chars.slice(0, max).join('');
  const keep = max - markerLen;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return chars.slice(0, head).join('').trimEnd() + marker + (tail > 0 ? chars.slice(chars.length - tail).join('').trimStart() : '');
}

/**
 * The beginning of a text cut at a word boundary, on one line, for titles and previews.
 * Trailing punctuation left by the cut is removed. Texts without spaces (Chinese, Japanese) are cut hard.
 * @param {unknown} text
 * @param {number} maxChars maximum length in code points (ellipsis included when requested)
 * @param {{ellipsis?: boolean}} [opts] append `…` when the text was shortened (default false)
 * @returns {string}
 */
export function firstWords(text, maxChars, { ellipsis = false } = {}) {
  const flat = oneLine(text);
  const max = Math.floor(maxChars);
  if (!(max > 0)) return '';
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  const budget = ellipsis ? Math.max(1, max - 1) : max;
  const slice = chars.slice(0, budget).join('');
  // Cut at the last space unless that would throw away most of the text.
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace >= Math.floor(budget * 0.4) && chars[budget] !== ' ' ? slice.slice(0, lastSpace) : slice;
  const trimmed = cut.replace(/[\s,;:\-–—(\["'“‘]+$/u, '');
  return ellipsis ? `${trimmed}…` : trimmed;
}

const LABEL_BAD_EDGE = /^[\s"'`“”‘’«»<>()[\]{}#*_.,;:!?\-–—•]+|[\s"'`“”‘’«»<>()[\]{}*_.,;:!?\-–—•]+$/gu;

/**
 * Clean up a list of tags / emotions: lowercase, trimmed, de-duplicated, leading `#` and wrapping
 * quotes or brackets removed, over-long labels cut, extra labels dropped. Accepts an array or a
 * comma / semicolon / newline separated string; non-strings are ignored.
 * @param {unknown} list
 * @param {{max?: number, maxLen?: number}} [opts] defaults: 5 labels of 24 characters
 * @returns {string[]}
 */
export function normalizeLabels(list, { max = 5, maxLen = 24 } = {}) {
  const items = typeof list === 'string' ? list.split(/[,;\n]/) : Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    let label = oneLine(item).toLowerCase().replace(LABEL_BAD_EDGE, '');
    label = Array.from(label).slice(0, maxLen).join('').replace(LABEL_BAD_EDGE, '');
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Keywords

const STOPWORDS_EN = `a about above after again against all almost also although always am an and another any anyone anything
are aren't around as at back be because been before being below between both but by can can't cannot could couldn't day days did didn't
do does doesn't doing don't done down during each either else enough even ever every everyone everything feel feeling feelings feels felt
few for from further get gets getting go goes going gone got had hadn't has hasn't have haven't having he her here hers herself him himself
his how however i i'd i'll i'm i've if in into is isn't it it's its itself just keep kind know last let like little long look looking lot
made make makes many may maybe me might more most much must my myself need needs never new next no nobody none nor not nothing now of off
often oh ok okay old on once one only onto or other others our ours ourselves out over own people perhaps put quite rather really right
said same say see seems she should shouldn't since so some someone something sometimes still such take than that that's the their theirs
them themselves then there there's these they they'd they'll they're they've thing things think thinking thought through time times to
today tomorrow tonight too took toward try trying two under until up upon us use used very want wanted wants was wasn't way we we'd we'll
we're we've well went were weren't what whatever when where whether which while who whom whose why will with within without won't would
wouldn't yeah yes yesterday yet you you'd you'll you're you've your yours yourself`.split(/\s+/);

const STOPWORDS_ES = `a al algo algún alguna algunas alguno algunos ante antes aquí así aunque bien cada casi como con contra cosa cosas cuando de del
desde donde dos el ella ellas ellos en entre era eran es esa esas ese eso esos esta está están estaba estoy este esto estos fue ha había han
hasta hay hoy la las le les lo los más mi mis mucho muy nada ni no nos nosotros o otra otro para pero poco por porque que qué quien se ser si
sí sin sobre solo son su sus también tan tanto te tengo tiene todo todos tu tus un una uno unos ya yo`.split(/\s+/);

const STOPWORDS_FR = `à au aux avec avoir bien c ça car ce ceci cela ces cette chaque chose choses comme comment d dans de des du elle elles en encore
est et être étais était été eu il ils j je l la le les leur leurs lui m ma mais me même mes moi mon n ne ni nos notre nous on ou où par pas
pour pourquoi qu que quel quelle qui s sa sans se ses si son sont sur t ta te tes toi ton très tu un une vos votre vous y`.split(/\s+/);

const STOPWORDS_DE = `aber alle als also am an auch auf aus bei bin bis da dann das dass dein der die dies diese dir doch du ein eine einem einen einer
er es etwas für gegen hab habe haben hat hatte ich ihr im in ist ja kann kein keine man mehr mein meine mich mir mit nach nicht noch nur ob oder
ohne sehr sein sich sie sind so über um und uns von vor war waren was weil wenn wer wie wir wird wo zu zum zur`.split(/\s+/);

const STOPWORDS = new Set([...STOPWORDS_EN, ...STOPWORDS_ES, ...STOPWORDS_FR, ...STOPWORDS_DE]);

const WORD_TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu;
const MAX_KEYWORD_INPUT = 20_000;

/**
 * The most meaningful words of a text, most frequent first (ties: first appearance), for searching
 * related past entries. Stopwords (English plus small Spanish, French and German sets), numbers and
 * very short words are skipped; Chinese / Japanese / Thai runs are segmented into words.
 * Only the first 20 000 characters are considered.
 * @param {unknown} text
 * @param {{max?: number}} [opts] default 8
 * @returns {string[]} lowercase keywords
 */
export function extractKeywords(text, { max = 8 } = {}) {
  if (typeof text !== 'string' || text === '') return [];
  const limit = Math.max(1, Math.min(50, Math.floor(max) || 8));
  const input = text.length > MAX_KEYWORD_INPUT ? text.slice(0, MAX_KEYWORD_INPUT) : text;
  const counts = new Map();
  const add = (word) => {
    if (STOPWORDS.has(word)) return;
    counts.set(word, (counts.get(word) || 0) + 1);
  };
  for (const match of input.toLowerCase().matchAll(WORD_TOKEN_RE)) {
    let token = match[0].replace(/['’]s$/u, '').replace(/^['’-]+|['’-]+$/gu, '');
    if (token === '') continue;
    if (NO_SPACE_SCRIPT.test(token)) {
      wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
      for (const part of wordSegmenter.segment(token)) {
        if (part.isWordLike && Array.from(part.segment).length >= 2) add(part.segment);
      }
      continue;
    }
    if (/^[\p{N}\p{M}'’-]+$/u.test(token)) continue; // numbers
    token = token.replace(/['’]/g, "'");
    if (Array.from(token).length < 3 || Array.from(token).length > 30) continue;
    add(token);
  }
  // Map preserves insertion order, so a stable sort keeps "first appearance" as the tie-break.
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([word]) => word);
}

// ------------------------------------------------------------------------------------------------
// Sentences

const ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'vs', 'etc', 'e.g', 'i.e', 'no', 'approx', 'inc', 'jr', 'sr']);

/**
 * Split prose into sentences (also on line breaks and CJK full stops). Light abbreviation handling
 * ("Dr. Lee" stays together). Empty pieces are dropped.
 * @param {unknown} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const pieces = text
    .split(/(?<=[.!?…]["')\]”’]*)\s+|(?<=[。！？])|\n+/u)
    .map((p) => p.trim())
    .filter(Boolean);
  const out = [];
  for (const piece of pieces) {
    const prev = out[out.length - 1];
    if (prev && /[.]$/.test(prev)) {
      const lastWord = (prev.slice(0, -1).split(/\s+/).pop() || '').toLowerCase();
      if (ABBREVIATIONS.has(lastWord) || /^\p{Lu}$/u.test(lastWord)) {
        out[out.length - 1] = `${prev} ${piece}`;
        continue;
      }
    }
    out.push(piece);
  }
  return out;
}

/**
 * The first one or two sentences of a text on one line, at most `maxChars` code points.
 * Sentences are added while the result is still shorter than `minChars`, so a very short first
 * sentence ("Ugh.") is extended by the next one.
 * @param {unknown} text
 * @param {{maxChars?: number, maxSentences?: number, minChars?: number}} [opts]
 * @returns {string}
 */
export function firstSentences(text, { maxChars = 200, maxSentences = 2, minChars = 40 } = {}) {
  const sentences = splitSentences(cleanText(text)).map((s) => s.replace(/\s+/g, ' '));
  let out = '';
  for (let i = 0; i < sentences.length && i < maxSentences; i += 1) {
    const next = out ? `${out} ${sentences[i]}` : sentences[i];
    if (out && Array.from(next).length > maxChars) break;
    out = next;
    if (Array.from(out).length >= minChars) break;
  }
  return truncate(out, maxChars);
}
