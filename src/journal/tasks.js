// Parsers for model output. Small models drift: they bold the labels, add chatter, refuse, answer in
// JSON or in another language, or ramble. Nothing here throws, and every parser has a deterministic
// fallback so a bad answer never blocks saving an entry.
//
//   cleanReply(text)                      -> display-ready reply text
//   parseMeta(text, opts)                 -> { title, summary, emotions[], tags[] }
//   parseMemoryLines(text, { existing })  -> string[]  (0-3 durable facts)
//   detectEmotions(text, max)             -> string[]  (lexicon scan; also the fallback of parseMeta)

import { detectLanguage } from './language.js';
import {
  capitalize, cleanText, firstSentences, firstWords, normalizeLabels, oneLine, splitSentences, truncate,
} from './text.js';

// ------------------------------------------------------------------------------------------------
// Shared cleaning

const THINK_TAGS = 'think|thinking|thought|reasoning|reflection|scratchpad';
const THINK_BLOCK_RE = new RegExp(`<(${THINK_TAGS})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, 'gi');
const THINK_OPEN_RE = new RegExp(`<(?:${THINK_TAGS})\\b[^>]*>[\\s\\S]*$`, 'i');
const THINK_CLOSE_RE = new RegExp(`^[\\s\\S]*</(?:${THINK_TAGS})\\s*>`, 'i');

/**
 * Remove reasoning blocks: `<think>...</think>` (and thinking / thought / reasoning), an unterminated
 * opening block (everything after it), and a lone closing tag (everything before it, which is how some
 * reasoning models start their output).
 * @param {unknown} text
 * @returns {string}
 */
export function stripThinking(text) {
  if (typeof text !== 'string') return '';
  let s = text.replace(THINK_BLOCK_RE, '');
  s = s.replace(THINK_OPEN_RE, '');
  s = s.replace(THINK_CLOSE_RE, '');
  return s;
}

const START_TOKENS_RE = /^(?:\s*(?:<\|im_start\|>\s*(?:assistant|user|system)?|<\|start_header_id\|>\s*(?:assistant|user|system)?\s*<\|end_header_id\|>|<start_of_turn>\s*(?:model|user)?|<\|assistant\|>|<\|begin_of_text\|>|<s>|\[\/INST\]|<<\/?SYS>>))+/i;
const END_TOKEN_RE = /<\|(?:im_end|eot_id|endoftext|end_of_text|im_start|start_header_id|end|user|assistant|system)\|>|<\/s>|<end_of_turn>|<start_of_turn>|\[INST\]|<\|EOT\|>/i;
const STRAY_TOKEN_RE = /<\|[^|<>\n]{1,30}\|>/g;

const ROLE_WORDS = '(?:assistant|ai|bot|model|reply|response|answer|output|companion|journal companion|journaling companion|coach|friend|stoic|guide|your reply|my reply|your response|my response|助手|回复|回覆|回答|回應|アシスタント|ассистент)';
const ROLE_PREFIX_RE = new RegExp(`^[\\s>#*_]*\\[?\\s*${ROLE_WORDS}\\s*\\]?[\\s*_]*[:：\\-–—][\\s*_]*`, 'i');
const PREAMBLE_LINE_RE = /^\s*(?:(?:sure|okay|ok|certainly|of course|absolutely|alright)\W+)?here(?:'s| is| are)\b[^\n]{0,70}\b(?:reply|response|answer|reflection|message)\W*:\s*$/i;
const USER_TURN_RE = /\n[ \t>#*_]*(?:user|human|writer|journaler|me)[ \t*_]*[:：]/i;

function stripSpecialTokens(text) {
  let s = text.replace(START_TOKENS_RE, '');
  const end = END_TOKEN_RE.exec(s);
  if (end) s = s.slice(0, end.index);
  return s.replace(STRAY_TOKEN_RE, '');
}

function stripRolePrefixes(text) {
  let s = text;
  for (let i = 0; i < 3; i += 1) {
    const next = s.replace(ROLE_PREFIX_RE, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

function stripWrappingFence(text) {
  const t = text.trim();
  const whole = /^```[\w+-]*[ \t]*\n([\s\S]*?)\n?```$/.exec(t);
  if (whole) return whole[1];
  // An opening fence whose closing fence was cut off, or a stray closing fence.
  if (/^```[\w+-]*[ \t]*\n/.test(t) && !/```\s*$/.test(t.replace(/^```[^\n]*\n/, ''))) return t.replace(/^```[\w+-]*[ \t]*\n/, '');
  return text;
}

const QUOTE_PAIRS = [['"', '"'], ['“', '”'], ['«', '»'], ['„', '“'], ['「', '」']];

function stripWrappingQuotes(text) {
  const t = text.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (t.length < 2 || !t.startsWith(open) || !t.endsWith(close)) continue;
    const inner = t.slice(open.length, t.length - close.length);
    // Only when this is ONE quoted span; `"Hi" she said, "bye"` keeps its quotes.
    if (open === close ? inner.includes(open) : inner.includes(open) || inner.includes(close)) continue;
    return inner.trim();
  }
  return text;
}

/**
 * Turn raw model output into the text to show and store: reasoning blocks, chat-template tokens,
 * "Assistant:" style prefixes, a "Here is my reply:" preamble line, an invented follow-up "User:" turn,
 * and a code fence or quotes wrapping the WHOLE reply are removed; line endings are normalised and
 * excess blank lines collapsed. Markdown-lite (`**bold**`, lists) is kept.
 * @param {unknown} text
 * @returns {string} trimmed; '' for non-strings or output that was only reasoning
 */
export function cleanReply(text) {
  if (typeof text !== 'string') return '';
  let s = cleanText(text);
  s = stripThinking(s);
  s = stripSpecialTokens(s);
  s = s.trim();
  for (let pass = 0; pass < 2; pass += 1) {
    s = stripRolePrefixes(s);
    s = stripWrappingFence(s).trim();
    const firstBreak = s.indexOf('\n');
    if (firstBreak !== -1 && PREAMBLE_LINE_RE.test(s.slice(0, firstBreak))) s = s.slice(firstBreak + 1).trim();
    s = stripWrappingQuotes(s).trim();
  }
  const userTurn = USER_TURN_RE.exec(s);
  if (userTurn && userTurn.index > 0) s = s.slice(0, userTurn.index);
  return s
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const REFUSAL_RE = /^\W*(?:i'?m sorry|i am sorry|sorry|i apologi[sz]e|i can(?:no|')t|i cannot|i can not|i'?m unable|i am unable|i'?m not able|i am not able|unfortunately,? i|as an ai|as a language model|i won'?t|i will not|i do not feel comfortable|i'?m not comfortable|lo siento|je suis désolé|es tut mir leid)\b/i;

/**
 * Does the text read like a refusal or an apology instead of the requested content?
 * @param {unknown} text
 * @returns {boolean}
 */
export function looksLikeRefusal(text) {
  return typeof text === 'string' && REFUSAL_RE.test(text.trim());
}

/** A lone quote at either end (the other half was consumed as part of a JSON-ish label) is not content. */
function stripOrphanQuote(s) {
  for (const q of ['"', '\u201C', '\u201D']) {
    const first = s.indexOf(q);
    if (first === -1) continue;
    const last = s.lastIndexOf(q);
    if (first === last) {
      if (first === 0) return s.slice(1).trim();
      if (first === s.length - 1) return s.slice(0, -1).trim();
    }
  }
  return s;
}

/** Strip markdown emphasis, wrapping quotes / brackets / backticks and JSON leftovers from a one-line value. */
function cleanValue(raw) {
  let s = oneLine(raw);
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s
      .replace(/^[\s>#*_`\-–—•]+/u, '')
      .replace(/[\s*_`]+$/u, '')
      .replace(/,+$/u, '')
      .trim();
    s = stripWrappingQuotes(s);
    if (/^'.*'$/s.test(s) && !s.slice(1, -1).includes("'")) s = s.slice(1, -1);
    s = s.replace(/^\*\*(.+)\*\*$/s, '$1').replace(/^__(.+)__$/s, '$1').replace(/^`(.+)`$/s, '$1');
    s = stripOrphanQuote(s);
    if (s === before) break;
  }
  return s.trim();
}

// ------------------------------------------------------------------------------------------------
// Emotion lexicon (fallback for parseMeta and a way to rescue emotion sentences)

const LB = '(?<![\\p{L}\\p{N}])';
const RB = '(?![\\p{L}\\p{N}])';

/** [label, alternatives]: English first, then a few common Spanish / French / German / Portuguese words. */
const LEXICON_SOURCE = [
  ['anxious', "anxious|anxiety|nervous|worried|worry|worrying|panic|panicking|uneasy|on edge|apprehensive|ansios[oa]|ansiedad|nervios[oa]|preocupad[oa]|angoiss[ée]e?|anxieu[xs]e?|inquiet|inquiète|ängstlich|angstlich|besorgt|nervös|nervos"],
  ['stressed', "stressed|stress|under pressure|tense|estresad[oa]|estrés|stress[ée]e?|gestresst"],
  ['overwhelmed', "overwhelmed|overwhelming|too much|abrumad[oa]|desbordad[oa]|débordé|débordée|überfordert|sobrecarregad[oa]"],
  ['sad', "sad|sadness|unhappy|tearful|crying|cried|tears|(?:feel|feeling|felt|am|i'm|was|been|so|really|bit) down|(?:feel|feeling|felt|so) blue|triste|tristeza|tristesse|traurig|deprimid[oa]"],
  ['grieving', "grief|grieving|mourning|bereaved|duelo|deuil|trauer"],
  ['heartbroken', 'heartbroken|heartbreak|devastated|desolad[oa]|dévasté'],
  ['lonely', "lonely|loneliness|isolated|(?:feel|feeling|felt|so|all) alone|soledad|solitude|einsam|solidão"],
  ['angry', 'angry|anger|furious|rage|enraged|mad at|enfadad[oa]|enojad[oa]|furios[oa]|en colère|énervé|wütend|zangad[oa]'],
  ['frustrated', 'frustrated|frustrating|frustration|frustrad[oa]|frustré|frustrée|frustriert'],
  ['irritated', 'irritated|annoyed|annoying|irritable|fed up|irritad[oa]|ärgerlich'],
  ['resentful', 'resentful|resentment|bitter|rencor|rancune'],
  ['tired', 'tired|exhausted|drained|worn out|sleepy|fatigued|weary|cansad[oa]|cansancio|agotad[oa]|fatigué|fatiguée|épuisé|épuisée|müde|erschöpft'],
  ['burned out', 'burned out|burnt out|burnout|burn-out'],
  ['bored', 'bored|boredom|aburrid[oa]|ennui|gelangweilt|langeweile'],
  ['restless', 'restless|inquieto|agité'],
  ['guilty', 'guilty|guilt|culpable|culpa|coupable|schuldig'],
  ['ashamed', 'ashamed|shame|embarrassed|humiliated|vergüenza|honte|scham|vergonha'],
  ['jealous', 'jealous|envious|envy|celos|envidia|jaloux|eifersüchtig|ciúmes'],
  ['disappointed', 'disappointed|let down|disappointing|decepcionad[oa]|déçu|déçue|enttäuscht'],
  ['hurt', "(?:feel|feeling|felt|was|so|really) hurt|hurt by|hurt that|hurtful|betrayed|wounded"],
  ['scared', 'scared|afraid|fear|frightened|terrified|fearful|asustad[oa]|miedo|peur|effrayé|angst|assustad[oa]'],
  ['confused', "confused|uncertain|unsure|torn|(?:feel|feeling|felt|am|so) lost|confundid[oa]|confus|confuse|verwirrt"],
  ['stuck', '(?:feel|feeling|felt|am|so) stuck|stuck in a rut|trapped'],
  ['numb', "numb|(?:feel|feeling|felt|so) empty|empty inside|hollow"],
  ['hopeless', 'hopeless|despair|worthless|desesperad[oa]|désespéré'],
  ['insecure', 'insecure|self-doubt|doubtful|inadequate|inseguro|insegura'],
  ['dread', 'dread|dreading|temor|appréhension'],
  ['conflicted', 'conflicted|ambivalent|mixed feelings'],
  ['vulnerable', 'vulnerable|exposed'],
  ['discouraged', 'discouraged|demoralized|demoralised|defeated|desanimad[oa]|découragé|entmutigt'],
  ['melancholy', 'melancholy|wistful|melancolía|mélancolie'],
  ['disgusted', 'disgusted|repulsed|asco|dégoût|ekel'],
  ['unmotivated', 'unmotivated|apathetic|indifferent|apático|apathisch'],
  ['happy', 'happy|glad|joyful|joy|cheerful|delighted|feliz|felices|contento|contenta|heureux|heureuse|glücklich|froh|fröhlich|alegre'],
  ['excited', "excited|thrilled|can't wait|looking forward|eager|emocionad[oa]|ilusionad[oa]|enthousiaste|excité|aufgeregt|animad[oa]"],
  ['grateful', 'grateful|thankful|appreciative|blessed|agradecid[oa]|gratitud|reconnaissant|reconnaissante|dankbar'],
  ['proud', 'proud|accomplished|orgullos[oa]|fier|fière|stolz|orgulhos[oa]'],
  ['calm', 'calm|peaceful|relaxed|serene|at peace|tranquil|tranquil[oa]|serein|sereine|ruhig|entspannt|relajad[oa]|détendu|detendu'],
  ['content', '(?:feel|feeling|felt|so|quite) content|satisfied|fulfilled|comfortable|satisfech[oa]'],
  ['relieved', 'relieved|relief|aliviad[oa]|soulagé|soulagée|erleichtert'],
  ['hopeful', 'hopeful|optimistic|hoping|esperanzad[oa]|esperanza|plein d.espoir|zuversichtlich|hoffnungsvoll'],
  ['motivated', 'motivated|inspired|driven|determined|energized|energised|motivad[oa]|inspirad[oa]|motivé|motiviert'],
  ['confident', '(?:feel|feeling|felt) strong|confident|empowered|seguro de mí|confiant|selbstbewusst'],
  ['curious', 'curious|intrigued|curios[oa]|curieux|curieuse|neugierig'],
  ['loved', 'feel loved|felt loved|feeling loved|cared for|supported by|amad[oa]|aimé|geliebt'],
  ['nostalgic', 'nostalgic|nostalgia|homesick|nostalgi[ac]|heimweh'],
  ['surprised', 'surprised|shocked|sorprendid[oa]|surpris|überrascht'],
  ['playful', 'amused|playful|silly|divertid[oa]'],
  ['affectionate', 'affectionate|tender|cariños[oa]|affectueu[xs]e?'],
  ['reflective', 'reflective|thoughtful|contemplative|pensativ[oa]|pensif|nachdenklich'],
  ['peaceful', 'at ease|sereno|serena|en paz|en paix|friedlich'],
];

const LEXICON = LEXICON_SOURCE.map(([label, alternatives]) => ({
  label,
  re: new RegExp(`${LB}(?:${alternatives})${RB}`, 'giu'),
}));

// Chinese, Japanese and Korean have no word boundaries, so these are plain substring patterns; the label returned is
// the native word, because an English chip in an otherwise Chinese journal would look odd.
const CJK_LEXICON = [
  ['焦虑', /焦虑|焦慮|紧张|緊張|担心|擔心/],
  ['开心', /开心|開心|高兴|高興|快乐|快樂|愉快/],
  ['难过', /难过|難過|伤心|傷心|悲伤|悲傷|沮丧|沮喪/],
  ['疲惫', /疲惫|疲憊|疲倦|好累|很累|累了/],
  ['生气', /生气|生氣|愤怒|憤怒|恼火|惱火/],
  ['感恩', /感恩|感激|感谢|感謝/],
  ['压力', /压力|壓力/],
  ['孤独', /孤独|孤獨|寂寞/],
  ['平静', /平静|平靜|平和|放松|放鬆/],
  ['期待', /期待|盼望/],
  ['自豪', /自豪|骄傲|驕傲/],
  ['不安', /不安|心配/],
  ['嬉しい', /嬉しい|うれしい|楽しい|幸せ/],
  ['悲しい', /悲しい|かなしい|寂しい|さみしい/],
  ['疲れ', /疲れ|つかれ|しんどい/],
  ['怒り', /怒り|腹が立|イライラ|むかつ/],
  ['感謝', /ありがた/],
  ['ストレス', /ストレス/],
  ['安心', /安心|ほっと/],
  ['불안', /불안|걱정/],
  ['행복', /행복|기쁘|즐거/],
  ['슬픔', /슬프|우울/],
  ['피곤', /피곤|지치/],
  ['화남', /화가 나|화났|짜증/],
  ['감사', /감사|고마/],
];
const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const NEGATION_BEFORE = /(?:\b(?:not|never|no|without|hardly|barely|nicht|kein|nunca|jamais|pas|nao|não)|n't)\s+(?:really\s+|very\s+|so\s+|that\s+|too\s+|at all\s+|estoy\s+|soy\s+|suis\s+|bin\s+)?$/iu;

/**
 * Emotions named in a text, by scanning a ~60-word lexicon (English plus a few Spanish, French, German
 * and Portuguese words). Negated mentions ("not happy") are skipped. Order of first appearance.
 * @param {unknown} text
 * @param {number} [max=3]
 * @returns {string[]} canonical lowercase labels such as 'anxious', 'tired'
 */
export function detectEmotions(text, max = 3) {
  if (typeof text !== 'string' || text === '') return [];
  const input = text.length > 20_000 ? text.slice(0, 20_000) : text;
  const hits = [];
  for (const { label, re } of LEXICON) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(input)) !== null) {
      const before = input.slice(Math.max(0, m.index - 24), m.index);
      if (NEGATION_BEFORE.test(before)) continue;
      hits.push({ label, at: m.index });
      break;
    }
  }
  if (HAS_CJK.test(input)) {
    for (const [label, re] of CJK_LEXICON) {
      const m = re.exec(input);
      if (m) hits.push({ label, at: m.index });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  return hits.slice(0, Math.max(0, max)).map((h) => h.label);
}

// ------------------------------------------------------------------------------------------------
// parseMeta

/**
 * The example output the meta prompt used to show. The prompt now shows placeholders instead (1B models copied the example
 * verbatim), but a copy of this example is still rejected by parseMeta, as are the placeholders themselves.
 */
export const META_EXAMPLE = Object.freeze({
  title: 'Rainy bike ride home',
  summary: 'Got soaked cycling home but felt free and cheerful by the end.',
  emotions: 'cheerful, free',
  tags: 'cycling, weather',
});

const FIELD_ALIASES = {
  title: ['title', 'titre', 'titulo', 'titel', 'titolo', 'headline', '标题', '標題', '题目', 'タイトル', '題名', '제목', 'заголовок', 'название'],
  summary: ['summary', 'resume', 'resumen', 'resumo', 'zusammenfassung', 'riassunto', 'synopsis', 'sommaire', '摘要', '总结', '總結', '概要', '要约', '要約', '요약', 'резюме', 'краткое содержание'],
  emotions: ['emotions', 'emotion', 'feelings', 'feeling', 'mood', 'moods', 'emociones', 'emocoes', 'emocao', 'emotionen', 'gefuhle', 'sentiments', 'sentimientos', 'sentimentos', 'emozioni', 'sentimenti', 'stimmung',
    '情绪', '情緒', '情感', '心情', '感受', '感情', '気持ち', '감정', '기분', 'эмоции', 'чувства'],
  tags: ['tags', 'tag', 'keywords', 'keyword', 'topics', 'topic', 'themes', 'theme', 'etiquetas', 'etiquettes', 'mots-cles', 'schlagworter', 'stichworter', 'themen', 'palavras-chave', 'temas', 'categories',
    '标签', '標籤', '关键词', '關鍵詞', '主题', '主題', 'タグ', 'キーワード', '태그', '키워드', 'теги', 'ключевые слова'],
};
const foldLabel = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

const FIELD_OF = new Map();
for (const [field, names] of Object.entries(FIELD_ALIASES)) for (const n of names) FIELD_OF.set(foldLabel(n), field);

// A labelled line: optional bullet / number / heading marks, optional bold or quote around the label,
// the label word, optional delimiter, the value.
const LABEL_LINE_RE = /^[ \t>#*_\-•]*(?:\d+[.)]\s*)?[*_`"'[]*\s*(\p{L}[\p{L}-]{1,24})\s*[*_`"'\]]*\s*(?:\([^)\n]{0,40}\)\s*)?(:|：|=|\s[-–—]\s)?\s*[*_`"']*\s*(.*)$/u;
// The same for two-word labels such as "Краткое содержание".
const LABEL_LINE_RE_TWO_WORDS = /^[ \t>#*_\-•]*(?:\d+[.)]\s*)?[*_`"'[]*\s*(\p{L}[\p{L}-]{1,24} \p{L}[\p{L}-]{1,24})\s*[*_`"'\]]*\s*(?:\([^)\n]{0,40}\)\s*)?(:|：|=|\s[-–—]\s)?\s*[*_`"']*\s*(.*)$/u;
const BARE_LABEL_BAD_NEXT = /^(?:of|is|was|and|the|for|to|in|on|that|which|has|had|are|were|will|would|can|could|should|about|with|from|by|at|as)\b/i;

function labelOfLine(line, lenient = false) {
  let m = LABEL_LINE_RE.exec(line);
  let field = m ? FIELD_OF.get(foldLabel(m[1])) : undefined;
  if (!field) {
    m = LABEL_LINE_RE_TWO_WORDS.exec(line);
    field = m ? FIELD_OF.get(foldLabel(m[1])) : undefined;
  }
  if (!m || !field) return null;
  const delimiter = m[2] || '';
  const rest = m[3] || '';
  if (!delimiter) {
    // No colon: only accept a clearly formatted label (bold / quoted / capitalised) with a value that is not prose.
    // The lenient pass (used when the strict one found almost nothing) also takes plain lower-case labels.
    const formatted = lenient || /^[ \t>#\-•\d.)]*[*_`"'[]/.test(line) || /^\s*\p{Lu}/u.test(m[1]);
    if (!formatted || rest.trim() === '' || BARE_LABEL_BAD_NEXT.test(rest.trim())) return null;
  }
  return { field, rest };
}

function parseLabelledLines(text, lenient = false) {
  const lines = text.split('\n');
  const found = {};
  for (let i = 0; i < lines.length; i += 1) {
    const label = labelOfLine(lines[i], lenient);
    if (!label || found[label.field] !== undefined) continue;
    let value = label.rest;
    // Values that continue on the next lines (a wrapped summary, or a bulleted list under the label).
    const wantsContinuation = label.field === 'summary' ? 2 : (label.field === 'emotions' || label.field === 'tags') && value.trim() === '' ? 6 : 0;
    for (let j = i + 1; j < lines.length && j <= i + wantsContinuation; j += 1) {
      const next = lines[j];
      if (next.trim() === '' || labelOfLine(next, lenient)) break;
      if (label.field !== 'summary' && !/^[ \t]*(?:[-*•]|\d+[.)])/.test(next) && next.trim().split(/\s+/).length > 3) break;
      value += `${label.field === 'summary' ? ' ' : ', '}${next.replace(/^[ \t]*(?:[-*•]|\d+[.)])\s*/, '')}`;
    }
    found[label.field] = value;
  }
  return found;
}

function jsonValue(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  return undefined;
}

function parseJsonish(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return {};
  const found = {};
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [key, value] of Object.entries(obj)) {
        const field = FIELD_OF.get(foldLabel(key));
        const v = jsonValue(value);
        if (field && v !== undefined && found[field] === undefined) found[field] = v;
      }
      return found;
    }
  } catch { /* broken JSON: pick out the pairs we can read */ }
  const pair = /"([^"\\]{1,30})"\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\])/g;
  for (const m of text.matchAll(pair)) {
    const field = FIELD_OF.get(foldLabel(m[1]));
    if (!field || found[field] !== undefined) continue;
    try {
      const v = jsonValue(JSON.parse(m[2]));
      if (v !== undefined) found[field] = v;
    } catch { /* skip this pair */ }
  }
  return found;
}

// Instructions echoed back as the value ("a title of 2 to 6 words", "1 to 4 feelings").
const PLACEHOLDER_RE = /\b\d\s*(?:to|-|–)\s*\d\s*(?:words?|sentences?|feelings?|topics?|emotions?|tags?)\b|\b(?:one|two) (?:or (?:one|two|three) )?short sentences?\b|^\W*(?:a|the) (?:title|summary)\b|\bcomma[- ]separated\b|\bseparated by commas?\b/i;

const EMPTY_VALUE_RE = /^(?:none|n\/a|na|nil|null|nothing|unknown|not (?:applicable|available|specified|mentioned|provided)|no (?:title|summary|emotions?|tags?|feelings?)|untitled|-+|\.+|tbd|\?+)$/i;

/** Comparison form for "is this the example?": no case, wrapping quotes or trailing full stop. */
const sameKey = (s) => String(s).toLowerCase().replace(/^[\s"'“”`*]+|[\s.!"'“”`*]+$/gu, '').trim();

/**
 * `<A quiet day>`: the prompt shows the format in angle brackets, so a model sometimes keeps them around its answer. Only
 * plain words are unwrapped; anything that looks like markup (`<img src=x>`) is the person's or the model's text and stays.
 * An empty placeholder (`<title>`, `<summary>`) is nothing.
 */
const unwrapAngles = (s) => {
  if (/^<\s*(?:title|summary|emotions?|tags?|feelings?|topics?)\s*>$/i.test(s)) return '';
  return s.replace(/^<\s*([^<>=/"']*?\s[^<>=/"']*?)\s*>$/, '$1');
};

function titleValue(raw, invented) {
  if (typeof raw !== 'string') return '';
  let s = unwrapAngles(cleanValue(raw)).replace(/^(?:title|titre|título|titel)\s*[:：-]\s*/iu, '');
  s = s.replace(/^#+\s*/, '').replace(/[.:;,\s]+$/u, '').replace(/^["“'`]+|["”'`]+$/gu, '').trim();
  if (s === '' || EMPTY_VALUE_RE.test(s) || PLACEHOLDER_RE.test(s) || looksLikeRefusal(s) || /^title$/i.test(s)) return '';
  if (invented && invented.title && sameKey(s) === sameKey(invented.title)) return '';
  if (Array.from(s).length > 80) s = firstWords(s, 60);
  return capitalize(s);
}

function summaryValue(raw, invented) {
  if (typeof raw !== 'string') return '';
  const s = unwrapAngles(cleanValue(raw)).replace(/^(?:summary|resumen|résumé|resumo|zusammenfassung)\s*[:：-]\s*/iu, '');
  if (s === '' || EMPTY_VALUE_RE.test(s) || PLACEHOLDER_RE.test(s) || looksLikeRefusal(s)) return '';
  if (invented && invented.summary && sameKey(s) === sameKey(invented.summary)) return '';
  const sentences = splitSentences(s);
  const kept = sentences.length > 2 ? sentences.slice(0, 2).join(' ') : s;
  return capitalize(truncate(kept, 280));
}

function listItems(raw) {
  // "anxious (7/10), relieved (a little)": intensities and asides are not part of the label.
  const text = typeof raw === 'string' ? unwrapAngles(raw.trim()).replace(/\s*\([^)]*\)/g, '') : raw;
  if (typeof text === 'string' && EMPTY_VALUE_RE.test(cleanValue(text))) return [];
  const parts = Array.isArray(text) ? text : typeof text === 'string' ? text.split(/[,;|\n•，；、]|\s\/\s|\s+(?:and|y|et|und|e)\s+(?=\p{L})/iu) : [];
  const out = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const item = cleanValue(part).replace(/^[#\[(]+|[\])]+$/g, '').replace(/[.:]+$/u, '').trim();
    if (item === '' || EMPTY_VALUE_RE.test(item) || PLACEHOLDER_RE.test(item) || /^\d+(?:[./]\d+)?$/.test(item)) continue;
    out.push(item);
  }
  return out;
}

// Words that make an "emotions" value a sentence rather than a list of feelings.
const SENTENCE_RE = /\b(?:felt|feels?|feeling|is|are|was|were|am|seems?|seemed|the writer|the user|he|she|they)\b/i;

function emotionsValue(raw) {
  const items = listItems(raw);
  const labels = items.filter((i) => i.split(/\s+/).length <= 3);
  // A sentence instead of a list ("The writer felt anxious and tired", "frustrated with Dan and anxious about the report"):
  // splitting it on commas and "and" leaves fragments such as "tired after work", so read the whole value with the lexicon.
  if (labels.length < items.length || SENTENCE_RE.test(Array.isArray(raw) ? raw.join(', ') : String(raw))) {
    const found = detectEmotions(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').join(', ') : String(raw), 5);
    if (found.length > 0) return found;
  }
  return normalizeLabels(labels, { max: 5, maxLen: 24 });
}

function tagsValue(raw) {
  const items = listItems(raw).filter((i) => i.split(/\s+/).length <= 3);
  return normalizeLabels(items, { max: 5, maxLen: 24 });
}

// Guided exercises start their entries with a label ("Situation: ...", "Rose: ...", "Automatic thought: ..."). It is the
// template's, not the person's, so it must not become the title.
const LEADING_LABEL_RE = /^\p{L}[\p{L}']*(?: \p{L}[\p{L}']*){0,2}:\s+(?=\S)/u;
const stripLeadingLabel = (text) => {
  const stripped = text.replace(LEADING_LABEL_RE, '');
  return Array.from(stripped).length >= 8 ? stripped : text;
};
// A title must not end on "and that" or "of the": drop such words after the cut.
const DANGLING_END_RE = /\s+(?:and|or|but|that|which|who|the|a|an|of|to|in|on|at|for|with|from|by|my|our|your|his|her|their|because|when|while|if|as|than|then|so|is|was|were|are|am|i|i'm|about|after|before|over|into|around|between|through|during|until|without|within|against|toward|towards|y|e|o|de|la|el|que|con|en|et|le|les|des|un|une|du)$/i;

/** A sentence cut to a title: at the first clause break when there is one, else at a word, never on a dangling word. */
function titleFromSentence(sentence) {
  const text = stripLeadingLabel(sentence);
  if (Array.from(text).length <= 60) return text;
  const clause = /[,;:—–]|\s-\s/.exec(text);
  let cut = clause && clause.index >= 12 && clause.index <= 60 ? text.slice(0, clause.index) : firstWords(text, 48);
  for (let i = 0; i < 4; i += 1) {
    const next = cut.replace(DANGLING_END_RE, '');
    if (next === cut) break;
    cut = next;
  }
  return cut;
}

/** The caller's fallback title, else the first sentence of the first message (cut at a word if long). */
function fallbackTitleFrom(fallbackTitle, firstMessage) {
  const fb = typeof fallbackTitle === 'string' ? cleanValue(fallbackTitle) : '';
  let base = fb;
  if (base === '') {
    base = titleFromSentence(firstSentences(firstMessage, { maxChars: 400, maxSentences: 1, minChars: 1 }));
  }
  return capitalize(base.replace(/[.:;,\s。、]+$/u, ''));
}

/**
 * Read the answer to the `meta` task: four labelled lines (`Title:`, `Summary:`, `Emotions:`, `Tags:`).
 * Tolerates bold or numbered labels, any case, a missing colon, chatter before and after, quotes around
 * the title, bullets, JSON-like output, labels translated to Spanish / French / German / Portuguese,
 * and refusals. Whatever cannot be read falls back deterministically:
 *  - title: `fallbackTitle`, else the first words of the first user message;
 *  - summary: the first sentence(s) of the user text, shortened;
 *  - emotions: words from the emotion lexicon found in the user text;
 *  - tags: [].
 * Without `userText` the summary and emotions fallbacks are empty. A copy of the prompt's example (META_EXAMPLE) is
 * recognised as such unless the entry contains the whole example text; copied feelings and topics are dropped too.
 * @param {unknown} text model output
 * @param {{fallbackTitle?: string, userText?: string, firstMessage?: string}} [opts]
 *   `userText`: everything the user wrote in the entry; `firstMessage`: the first user message only
 *   (title fallback; defaults to `userText`).
 * @returns {{title: string, summary: string, emotions: string[], tags: string[]}}
 */
export function parseMeta(text, { fallbackTitle = '', userText = '', firstMessage = '' } = {}) {
  const source = typeof userText === 'string' ? userText : '';
  const cleaned = stripWrappingFence(stripSpecialTokens(stripThinking(cleanText(typeof text === 'string' ? text : '')))).trim();
  const fromJson = parseJsonish(cleaned);
  let fromLines = parseLabelledLines(cleaned);
  if (Object.keys(fromLines).length < 2 && Object.keys(fromJson).length === 0) fromLines = parseLabelledLines(cleaned, true);
  const pick = (field) => (fromJson[field] !== undefined ? fromJson[field] : fromLines[field]);

  // A model that copies the format example has told us nothing about this entry. Sharing a word with the example
  // ("got", "rainy", "home") proves nothing, so a copy is accepted only when the entry contains the WHOLE example text.
  const lowerSource = source.toLowerCase();
  const copied = (value, example) => typeof value === 'string' && sameKey(cleanValue(value)) === sameKey(example) && !lowerSource.includes(sameKey(example));
  const invented = {};
  if (copied(pick('title'), META_EXAMPLE.title)) invented.title = META_EXAMPLE.title;
  if (copied(pick('summary'), META_EXAMPLE.summary)) invented.summary = META_EXAMPLE.summary;

  // Title and summary both copied: the whole answer is the example, so emotions and tags are not about this entry either.
  const fullCopy = invented.title !== undefined && invented.summary !== undefined;
  const pickField = (field) => (fullCopy ? undefined : pick(field));

  let title = titleValue(pickField('title'), invented);
  if (title === '') title = fallbackTitleFrom(fallbackTitle, firstMessage || source);

  let summary = summaryValue(pickField('summary'), invented);
  if (summary === '' && source !== '') summary = capitalize(firstSentences(stripLeadingLabel(source.trimStart()), { maxChars: 200, maxSentences: 2, minChars: 60 }));

  // The example's own feelings and topics ("cheerful, free" / "cycling, weather") are dropped unless the entry names every one of them.
  const isCopiedList = (labels, example) => {
    const wanted = normalizeLabels(example, { max: 10 });
    return labels.length === wanted.length && wanted.every((w) => labels.includes(w)) && !wanted.every((w) => lowerSource.includes(w));
  };

  let emotions = pickField('emotions') !== undefined ? emotionsValue(pickField('emotions')) : [];
  if (isCopiedList(emotions, META_EXAMPLE.emotions)) emotions = [];
  if (emotions.length === 0 && source !== '') emotions = detectEmotions(source, 3);

  let tags = pickField('tags') !== undefined ? tagsValue(pickField('tags')) : [];
  if (isCopiedList(tags, META_EXAMPLE.tags)) tags = [];
  return { title, summary, emotions, tags };
}

// ------------------------------------------------------------------------------------------------
// parseMemoryLines

/**
 * The example facts the memory prompt used to show, each with the word that makes it specific. The prompt no longer has
 * examples (1B models echoed them: 31 of 51 bullets from llama3.2:1b), but a model can still write them out of habit. An
 * echoed example has told us nothing about the entry, so parseMemoryLines drops such a line unless the entry itself
 * contains the example's distinctive word and every other distinctive word of the fact.
 */
export const MEMORY_EXAMPLES = Object.freeze([
  Object.freeze({ fact: 'Has a younger sister called Maya', rare: 'maya' }),
  Object.freeze({ fact: 'Works as a nurse', rare: 'nurse' }),
  Object.freeze({ fact: 'Is training for a half marathon', rare: 'marathon' }),
]);

const NONE_LINE_RE = /^(?:none|n\/a|na|nil|nothing|no|no new (?:facts?|memor(?:y|ies)|information|lasting facts?)|no (?:facts?|memor(?:y|ies)|lasting facts?|durable facts?|personal facts?)(?: (?:found|mentioned|to (?:add|extract|save)))?|nothing (?:new|to add|to extract|lasting|durable|worth (?:remembering|saving))|there (?:are|were|is) no (?:new )?(?:lasting |durable |personal )?(?:facts?|information)|not applicable|no lasting information|ninguno|ninguna|nada|nada nuevo|ning[uú]n hecho nuevo|sin novedades|aucun|aucune|rien|rien de nouveau|keine|keins|nichts|nichts neues|keine neuen fakten|nenhum|nenhuma|nada novo|нет|ничего|无|無|没有|沒有|没有新事实|なし|ありません|없음|해당 없음)[.。]?$/iu;
const INTRO_LINE_RE = /^(?:here(?:'s| is| are)|sure|okay|ok|certainly|based on|from the|the following|facts?|memor(?:y|ies)|new facts?|new memor(?:y|ies)|existing|already known|note|output|answer|reply|response|these|in summary|summary)\b/i;
const FACT_PREFIX_RE = /^(?:(?:new )?(?:fact|memory)s?\s*\d*\s*[:.\-–]\s*)/i;

// Words that open advice, instructions, hedges or ordinary-day events in English. FACT_VERBS (below) is an allow-list
// for English lines; this deny-list covers lines that do not look English enough for that check.
const BAD_STARTS = new Set(('try consider remember make take do don\'t dont avoid please let focus keep start stop be ask talk reach write practice practise get give find think '
  + 'ensure call set use spend reflect journal continue plan create schedule seek visit review celebrate allow accept acknowledge notice breathe rest maybe perhaps you your '
  + 'had went got saw met told said felt woke ate spent talked called texted argued fought cried slept walked watched visited decided tried wanted needed thought realised '
  + 'realized noticed learned wrote shared mentioned expressed described feels seems sounds appears looks thinks says mentions shares expresses reports describes notes asks '
  + 'tells wonders hopes worries').split(' '));
// Two or more of these mean "English" (one could be a French "a" or a German "in").
const ENGLISH_WORDS = /\b(?:the|a|an|of|and|with|in|at|to|for|on|by|from|is|are|was|were|has|have|had|who|that|this|their|they|she|he|her|his|as|about)\b/gi;
const HAS_CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// One of these is enough to call a short line English ("Boss Dan is annoying", "Dan annoys them"); chosen because they are not
// everyday words in Spanish, French, German or Portuguese.
const STRONG_ENGLISH_RE = /\b(?:the|and|with|from|is|are|were|their|them|they|who|that|this|about|have|had|not|but|very|too|many|more|some)\b/i;
const ENGLISH_ENTRY_WORDS = new Set(('the and of to is my it that for with but have had this not are be you we they just about what when how because would could very really i').split(' '));
const FIRST_PERSON_LEFTOVER_RE = /\b(?:I|me|Me|myself|Myself|we|We|mine|us)\b/;

/** Is the entry written in English? Facts are written in the language of the entry, so this decides how strictly short lines are judged. */
function looksEnglishText(text) {
  const words = text.slice(0, 20_000).toLowerCase().match(/[a-z']+/g) || [];
  if (words.length === 0) return false;
  let hits = 0;
  for (const w of words) if (ENGLISH_ENTRY_WORDS.has(w)) hits += 1;
  return hits >= 1 && hits / words.length >= 0.12;
}

// Third-person present-tense verbs that can open a lasting fact ("Works as ...", "Is married to ...").
// An allow-list on purpose: advice ("Try ..."), events ("Went ..."), hedges ("Maybe ...") and names never match.
const FACT_VERBS = new Set(('has is works lives loves likes enjoys dislikes hates prefers plays studies owns wants needs struggles suffers practises practices runs teaches manages '
  + 'speaks drives rides cares believes values identifies collects writes reads paints draws sings dances cooks bakes swims hikes cycles travels volunteers trains coaches '
  + 'mentors attends goes takes uses keeps follows avoids tends lacks hopes dreams plans aims commutes fears sleeps eats drinks meditates prays raises supports grows leads '
  + 'rents shares balances juggles does wears builds makes gardens fishes climbs skis skates surfs sails knits sews').split(' '));
const PAST_OK = new Set(['their', 'was', 'were', 'born', 'married', 'divorced', 'widowed', 'grew', 'moved', 'graduated', 'retired', 'immigrated', 'emigrated', 'adopted', 'raised', 'studied', 'trained']);

const TRANSIENT_RE = /\b(?:today|tonight|tomorrow|yesterday|this (?:morning|afternoon|evening|week|weekend)|right now|at the moment|for now|next week|last night|these days|hoy|ma[ñn]ana|ayer|esta noche|ahora mismo|aujourd'hui|demain|hier|ce soir|heute|morgen|gestern|heute abend|hoje|amanh[ãa]|ontem|esta noite)\b|今天|今日|明天|明日|昨天|昨日|今晚|今夜|오늘|내일|어제/iu;
const HEDGE_RE = /\b(?:might|may|maybe|perhaps|possibly|probably|seems? to|appears? to|unclear|not sure|could be|quiz[aá]s|tal vez|probablemente|peut-[êe]tre|vielleicht|wahrscheinlich|talvez|provavelmente)\b|也许|可能|大概|かもしれ|たぶん|아마/iu;
const EMOTION_STATE_RE = /^(?:is |was |feels? |felt |seems? |sounds? |appears? |has been |is feeling |has felt )?(?:(?:very|really|quite|so|a bit|a little|extremely|feeling|currently|still|just|pretty|too) )*(?:sad|happy|anxious|stressed|tired|exhausted|angry|upset|worried|nervous|overwhelmed|excited|lonely|frustrated|depressed|hopeful|grateful|proud|calm|bored|annoyed|scared|afraid|down|low|stuck|lost|confused|relieved|disappointed|hurt|guilty|ashamed|fine|okay|ok|good|bad|great|awful|terrible|emotional|drained|burnt out|burned out|motivated|inspired|content|restless)\b/i;
// A "Has been ..." or "Has had a ..." fact is kept unless it is plainly a passing state: "Has been diagnosed with ADHD" and
// "Has been a nurse for ten years" are lasting, "Has been feeling low" and "Has had a hard day" are not.
const FEELING_STATE_RE = /^(?:se siente|se sent[ií]a|sinti[óo]|est[aá]|estaba|se sent|se sentait|f[üu]hlt sich|f[üu]hlte sich|sente-se|sentiu-se|has felt\b|has been (?:feeling|having an? |so |very |really |quite |a bit |a little |too )|has had an? (?:hard|bad|rough|tough|long|great|good|nice|lovely|terrible|awful|stressful|busy|quiet|lazy|difficult|productive|boring|slow|crazy|weird) (?:day|night|week|morning|afternoon|evening|weekend|time|start)\b|is struggling with (?:sleep|motivation) (?:lately|recently)|needs to (?:rest|relax|sleep|breathe|calm|vent|cry|slow down|unwind|recharge|take a break|take it easy)|wants to (?:rest|relax|sleep|vent|cry|unwind|recharge|take a break|take it easy)|needs (?:more |some |a lot of |lots of )?(?:sleep|rest|a break|a nap|a hug|a holiday|a vacation|space|time off|time|coffee|food|water|a drink|a day off)\b|wants (?:to )?(?:quit|give up|run away|scream|hide|escape|be alone|go home|go to bed|stay in bed|cry|vent)\b|wants (?:a break|out)\b)/i;
const SENSITIVE_RE = /\b(?:password|passcode|pin code|api[ -]?key|secret key|token|ssn|social security|credit card|card number|iban)\b|sk-[A-Za-z0-9]{8,}|\b\d{8,}\b|[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\//i;

// Lasting facts are states ("Works as a nurse", "Lives in Leeds"), not what the writer is busy with right now. A progressive
// opening ("Is cooking a ratatouille", "Is planning to ask for Friday off", "Is waiting for someone") passes the allow-list of
// fact verbs, so it needs its own rule: only these ongoing activities are lasting ("Is training for a 10k run").
const LASTING_ACTIVITY = new Set(('training studying learning working living raising recovering caring saving writing building practising practicing volunteering dating '
  + 'expecting commuting managing coaching teaching renovating renting').split(' '));
const PROGRESSIVE_RE = /^(?:(?:is|are|was|were)|has been|have been)\s+(?:currently\s+|now\s+|still\s+|just\s+|also\s+|really\s+)?(\p{L}+ing)\b/iu;
const ACTIVITY_NOW_RE = /^(?:is|are) just\b|^has (?:never |not |often )?(?:felt|thought|wondered)\b|^(?:does|do) not (?:even )?(?:know|understand|remember)\b|\bnot sure\b|^(?:is|are) (?:about|going) to\b/i;
const isTransientActivity = (s) => {
  const m = PROGRESSIVE_RE.exec(s);
  return (m !== null && !LASTING_ACTIVITY.has(m[1].toLowerCase())) || ACTIVITY_NOW_RE.test(s);
};
// "Was in their grandmother's kitchen" is a scene, "Was born in Leeds" is a fact.
const WAS_LASTING_RE = /^(?:was|were)\s+(?:born|raised|adopted|married|divorced|widowed|diagnosed|brought up|previously|once|formerly|a |an |the )/i;
// "Their apple cake" is a noun fragment: a fact about a person has a verb.
const THEIR_VERB_RE = /\b(?:is|are|was|were|has|have|had|lives|lived|works|worked|studies|studied|loves|likes|enjoys|plays|runs|died|passed|moved|born|married|divorced|retired|owns|keeps|needs|wants|teaches|struggles|suffers|speaks|grew|trained|called|named)\b/i;
// Past-tense verbs of a diary event. A lasting fact does not say who cancelled, told or visited.
const EVENT_IN_FACT_RE = /\b(?:cancell?ed|surprised|interrupted|texted|invited|asked|told|said|gave|brought|bought|came|emailed|sent|left|woke|went|saw|presented|hid|skipped|decided|forgot|noticed|realized|realised|mentioned|complained|argued|apologi[sz]ed|replied|answered|arrived|returned|visited)\b/i;
// Facts are written in the third person. A line in the writer's own voice in Spanish, French, German, Portuguese or
// Italian ("Mi jefa me pidió...", "J'ai parlé à...") is a copied sentence or a diary event, not a fact about the writer.
// A lone possessive ("Vive con mi pareja Alex") is only a model slip and is turned into the third person instead.
const FIRST_PERSON_FOREIGN_RE = /(?<![\p{L}\p{N}])(?:me|conmigo|yo|estoy|tengo|soy|fui|tuve|dormí|sentí|hablé|hablamos|pasamos|fuimos|estamos|je|moi|nous|notre|nos|ich|mir|mich|wir|unser|eu|io|ho|sono|siamo)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])[jm]['’](?=\p{L})/iu;
const FOREIGN_POSSESSIVES = new Map(Object.entries({
  mi: 'su', mis: 'sus', mon: 'son', ma: 'sa', mes: 'ses', mein: 'sein', meine: 'seine', meinen: 'seinen', meinem: 'seinem', meiner: 'seiner',
  meu: 'seu', minha: 'sua', meus: 'seus', minhas: 'suas', mio: 'suo', mia: 'sua', miei: 'suoi', mie: 'sue',
}));
const FOREIGN_POSSESSIVE_RE = /(?<![\p{L}\p{N}])(?:mi|mis|mon|ma|mes|mein|meine|meinen|meinem|meiner|meu|minha|meus|minhas|mio|mia|miei|mie)(?![\p{L}\p{N}])/giu;
const foreignThirdPerson = (line) => line.replace(FOREIGN_POSSESSIVE_RE, (word) => {
  const out = FOREIGN_POSSESSIVES.get(word.toLowerCase());
  return word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase() ? capitalize(out) : out;
});
// Spanish and French diary events ("vino de visita", "a parlé à") and a third-person pronoun as subject ("Il a ri...": that is
// about someone else). Lasting facts use present-tense states ("Tiene", "Vive", "Travaille").
const FOREIGN_EVENT_RE = /(?<![\p{L}\p{N}])(?:vino|vinieron|fue|fueron|hizo|hicieron|dijo|dijeron|tuvo|puso|pidió|llamó|visitó|invitó|preguntó|regresó|llegó|salió|cenó|comió|habló|dormía|había|estaba|estaban|se sintió|se siente|se sentía|se reunió|se dio cuenta|était|étaient|avait|faisait|se sent|se sentait|se sentit)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])a (?:parlé|appelé|dit|vu|fait|ri|invité|passé|mangé|dormi|eu|été|pris|mis)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])est (?:venu|venue|allé|allée|rentré|rentrée|arrivé|arrivée)(?![\p{L}\p{N}])/iu;
const FOREIGN_PRONOUN_START_RE = /^(?:il|elle|ils|elles|él|ella|ellos|ellas|er|sie|ele|ela|lui|lei)\s/iu;
// A model that answers the memory task with a chat reply addresses the writer ("tu hermano", "あなた"): that is not a third-person fact.
const FOREIGN_SECOND_PERSON_RE = /(?<![\p{L}\p{N}])(?:tú|tu|tus|te|ti|contigo|usted|ustedes|toi|ton|ta|tes|vous|votre|vos|dich|dir|dein|deine|deinen|deinem|deiner|você|vocês|teu|tua|teus|tuas|tuo|tuoi|tue)(?![\p{L}\p{N}])|あなた|君|你|您|당신/iu;
// Japanese: past polite forms, plans, wishes and passing states (tired, busy, looking forward) are not lasting facts.
const JA_TRANSIENT_RE = /ました|でした|予定|つもり|したい|行きたい|ところです|思います|でしょう|疲れ|忙し|楽しみ|嬉し|うれし|悲し|かなし|寂し|さみし|眠|不安|心配|緊張|ちょっと|少し/u;
const HAS_KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

// Words that carry no information about which facts the user actually stated.
const GENERIC_FACT_WORDS = new Set(('has have works work lives live loves love likes like enjoys enjoy their with from that this also into about called named year years '
  + 'being been very just really often always never than then them they were what when where which while who whom will would could should more most some such '
  + 'only other many much does doing goes going gets getting makes making takes taking wants want needs need plays play').split(' '));

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const escapeRe = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does the (lower-cased) text mention this word? Long words by their first five letters (inflection, other languages), short ones whole. */
function mentionsWord(hay, word) {
  if (Array.from(word).length >= 5) return hay.includes(word.slice(0, 5));
  // Latin-only boundaries: a name written inside Chinese or Japanese text ("我妹妹Maya今天...") has letters on both sides.
  return new RegExp(`(?<![\\p{Script=Latin}\\p{N}])${escapeRe(word)}(?![\\p{Script=Latin}\\p{N}])`, 'u').test(hay);
}

/**
 * Names and numbers cannot be paraphrased, so a model that invents them is caught: every capitalised word after the
 * first ("Maya", "Lisbon") and every number ("3", "two") of the fact must occur in the entry.
 */
function specificsGrounded(fact, hay) {
  for (const m of fact.matchAll(/\p{Lu}[\p{L}'’-]+/gu)) {
    if (m.index === 0) continue;
    const name = m[0].toLowerCase().replace(/['’]s$/u, '');
    if (name.length >= 3 && !mentionsWord(hay, name)) return false;
  }
  for (const m of fact.toLowerCase().matchAll(/(?<![\p{L}\p{N}])(?:\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?![\p{L}\p{N}])/gu)) {
    const n = /^\d/.test(m[0]) ? Number(m[0]) : NUMBER_WORDS.indexOf(m[0]);
    const asDigits = new RegExp(`(?<![\\d])${n}(?![\\d])`);
    const asWord = n >= 2 && n <= 20 && new RegExp(`(?<![\\p{L}])${NUMBER_WORDS[n]}(?![\\p{L}])`, 'u').test(hay);
    if (!asDigits.test(hay) && !asWord) return false;
  }
  return true;
}

/**
 * A fact is grounded when at least one of its content words (or the first five letters of it) occurs in the
 * text the user wrote, its names and numbers occur there too, and it is not one of the prompt's example facts
 * (unless the entry has the example's distinctive word). This stops a model from pasting the examples of the
 * prompt or inventing details.
 */
function isGrounded(fact, userText) {
  const hay = userText.toLowerCase();
  const lower = fact.toLowerCase();
  const copiedExample = MEMORY_EXAMPLES.find(({ fact: example }) => isNearDuplicate(example, fact));
  if (copiedExample) {
    // An echoed example needs the entry to hold its distinctive word AND every other distinctive word of the fact:
    // "Has a younger sister called Maya" is refused for an entry about "my sister Maya" ("younger" is the prompt's).
    if (!hay.includes(copiedExample.rare)) return false;
    const unsupported = (lower.match(/[\p{L}\p{N}]{5,}/gu) || []).filter((w) => !GENERIC_FACT_WORDS.has(w) && !hay.includes(w.slice(0, 5)));
    if (unsupported.length > 0) return false;
  }
  if (!specificsGrounded(fact, hay)) return false;
  // Chinese, Japanese and Korean have no spaces: compare character pairs instead of words.
  for (const run of lower.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu) || []) {
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i += 1) if (hay.includes(chars[i] + chars[i + 1])) return true;
  }
  const words = lower.match(/[\p{L}\p{N}]{4,}/gu) || [];
  const content = words.filter((w) => !GENERIC_FACT_WORDS.has(w) && !HAS_CJK_CHAR.test(w));
  return content.some((w) => hay.includes(w.slice(0, Math.min(w.length, 5))));
}

const IRREGULAR_THIRD = { be: 'is', am: 'is', have: 'has', do: 'does', go: 'goes' };

function thirdPerson(verb) {
  const v = verb.toLowerCase();
  if (IRREGULAR_THIRD[v]) return IRREGULAR_THIRD[v];
  if (/(?:s|x|z|ch|sh)$/.test(v)) return `${v}es`;
  if (/[^aeiou]y$/.test(v)) return `${v.slice(0, -1)}ies`;
  return `${v}s`;
}

/**
 * "I work as a nurse" / "My sister is Maya" / "The user has two cats" / "Sam has two cats" -> third person, neutral.
 * A leading name is only removed when it is the user's own name (`userName`): in "Dan is her brother" the fact is
 * about someone else, and the allow-list in acceptFact() then rejects it.
 */
function toNeutralThirdPerson(line, userName) {
  let s = line.trim();
  s = s.replace(/^(?:the )?(?:user|writer|author|journaler|journaller|person|diarist)'s\s+/i, 'their ');
  s = s.replace(/^(?:the )?(?:user|writer|author|journaler|journaller|person|diarist)\s+/i, '');
  s = s.replace(/^(?:they|she|he)\s+/i, '');
  if (userName) {
    const escaped = userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`^${escaped}'s\\s+`, 'iu'), 'their ').replace(new RegExp(`^${escaped}\\s+`, 'iu'), '');
  }
  let m;
  if ((m = /^i(?:'m| am)\s+(.*)$/i.exec(s))) return `is ${m[1]}`;
  if ((m = /^i(?:'ve| have)(?: got)?\s+(.*)$/i.exec(s))) return `has ${m[1]}`;
  if ((m = /^i(?:'d| would)\s+(?:like|love)\s+to\s+(.*)$/i.exec(s))) return `would like to ${m[1]}`;
  if ((m = /^i(?:'m| am) not\s+(.*)$/i.exec(s))) return `is not ${m[1]}`;
  if ((m = /^i\s+(?:don't|do not)\s+(\p{L}+)\s*(.*)$/iu.exec(s))) return `does not ${m[1]} ${m[2]}`.trim();
  if ((m = /^i\s+(\p{L}+)\s*(.*)$/iu.exec(s))) {
    const past = /(?:ed|ew|ent|ad|ot|aw|ook|ame)$/i.test(m[1]) && !/^(?:need|feed|read|lead|bleed|plead|proceed|succeed|exceed)$/i.test(m[1]);
    return past ? `${m[1]} ${m[2]}`.trim() : `${thirdPerson(m[1])} ${m[2]}`.trim();
  }
  if ((m = /^my\s+(.*)$/i.exec(s))) return `their ${m[1]}`;
  if ((m = /^(?:me|myself)\b\s*(.*)$/i.exec(s))) return m[1];
  return s;
}

/** Comparison key for duplicate detection: lower case, no accents or punctuation, no filler words. */
function memoryKey(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(?:the user|user|their|his|her|a|an|the|of|to|in|on|at|and|is|has|have|called|named)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNearDuplicate(a, b) {
  const ka = memoryKey(a);
  const kb = memoryKey(b);
  if (ka === '' || kb === '') return false;
  if (ka === kb) return true;
  const shorter = ka.length <= kb.length ? ka : kb;
  const longer = shorter === ka ? kb : ka;
  if (shorter.split(' ').length >= 2 && longer.includes(shorter)) return true;
  const sa = new Set(ka.split(' '));
  const sb = new Set(kb.split(' '));
  let common = 0;
  for (const w of sa) if (sb.has(w)) common += 1;
  const union = sa.size + sb.size - common;
  return Math.min(sa.size, sb.size) >= 2 && common / union >= 0.7;
}

function candidateLines(cleaned) {
  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);
  const bulletRe = /^(?:[-*•–]|\d+[.)])\s+/;
  const hasBullets = lines.some((l) => bulletRe.test(l));
  if (!hasBullets && lines.length > 3) return [];
  return lines.filter((l) => hasBullets ? bulletRe.test(l) : true).map((l) => l.replace(bulletRe, ''));
}

/** Turn one raw candidate line into a clean fact, or null if it is not a lasting personal fact. */
function acceptFact(raw, userName, englishEntry = false) {
  const original = cleanValue(cleanValue(raw).replace(FACT_PREFIX_RE, ''));
  if (original === '' || original.endsWith(':') || /\?/.test(original)) return null;
  if (INTRO_LINE_RE.test(original)) return null;
  // Checked before any rewriting, so a leading "Maybe" or "Password" cannot be mistaken for a name and stripped.
  if (TRANSIENT_RE.test(original) || HEDGE_RE.test(original) || SENSITIVE_RE.test(original)) return null;
  const s = toNeutralThirdPerson(original, userName).replace(/[.!\s]+$/u, '').replace(/\s+/g, ' ').trim();
  const words = s.split(' ');
  const first = words[0].toLowerCase();
  const length = Array.from(s).length;
  const cjk = HAS_CJK_CHAR.test(s);
  if (length > 200 || length < (cjk ? 3 : 6) || (words.length < 2 && !cjk)) return null;
  if (splitSentences(s).length > 1) return null; // a fact is one short statement; two sentences are a paragraph of chat
  if (BAD_STARTS.has(first)) return null;
  // "Sam has two cats": a named subject. The user's own name was removed earlier; any other name means another person.
  if (words.length > 1 && FACT_VERBS.has(words[1].toLowerCase()) && !FACT_VERBS.has(first) && !PAST_OK.has(first)) return null;
  // English lines must open like a fact ("Has", "Works", ...); text in other languages is judged by the checks below.
  // A line also counts as English when the entry is (facts follow the language of the entry) or it holds an unmistakably English word.
  const looksEnglish = englishEntry || FACT_VERBS.has(first) || (s.match(ENGLISH_WORDS) || []).length >= 2 || STRONG_ENGLISH_RE.test(s);
  if (looksEnglish && !FACT_VERBS.has(first) && !PAST_OK.has(first) && first !== 'would') return null;
  if (EMOTION_STATE_RE.test(s) || FEELING_STATE_RE.test(s)) return null;
  if (/\byou(?:r)?\b|\bshould\b|\bmust\b/i.test(s)) return null;
  if (/<\s*(?:short fact|fact|facts)\s*>/i.test(s)) return null; // the format placeholder of the prompt, echoed
  if (looksEnglish) {
    if (isTransientActivity(s) || EVENT_IN_FACT_RE.test(s)) return null;
    if (/^(?:was|were)\b/i.test(s) && !WAS_LASTING_RE.test(s)) return null;
    if (/^their\b/i.test(s) && !THEIR_VERB_RE.test(s)) return null;
  }
  if (!looksEnglish) {
    if (FOREIGN_SECOND_PERSON_RE.test(s)) return null;
    if (HAS_KANA.test(s) ? JA_TRANSIENT_RE.test(s) : (FIRST_PERSON_FOREIGN_RE.test(s) || FOREIGN_EVENT_RE.test(s) || FOREIGN_PRONOUN_START_RE.test(s))) return null;
    return capitalize(foreignThirdPerson(s));
  }
  // The fact is read as "Things you know about Sam: - ...": a leftover "my" would be read as the model's own. "my" / "our" become
  // "their"; a line that still talks about "I" or "me" mixes two speakers ("Has a brother, Tom, and I talk to him weekly").
  const neutral = s.replace(/\b(?:my|our)\b/gi, 'their');
  if (FIRST_PERSON_LEFTOVER_RE.test(neutral)) return null;
  return capitalize(neutral);
}

const norm = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Is the fact (almost) one sentence of the entry, copied? A model that was not given a good format writes the entry's own
 * sentences as bullets ("Mi jefa me pidió terminar el informe antes del viernes"): that is a diary line, not a fact.
 * Short sentences are exempt ("I have a sister called Maya" is itself a fact).
 */
function copiesEntry(fact, entry) {
  const f = norm(fact);
  const e = norm(entry);
  const factWords = f.split(' ').filter(Boolean);
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(f)) return Array.from(f.replace(/ /g, '')).length >= 8 && e.replace(/ /g, '').includes(f.replace(/ /g, ''));
  if (factWords.length < 5) return false;
  if (e.includes(f) && factWords.length >= 6) return true;
  const factSet = new Set(factWords);
  for (const sentence of splitSentences(entry)) {
    const words = norm(sentence).split(' ').filter(Boolean);
    if (words.length < 8) continue;
    const set = new Set(words);
    let shared = 0;
    for (const w of factSet) if (set.has(w)) shared += 1;
    if (shared / factSet.size >= 0.8 && shared / set.size >= 0.6) return true;
  }
  return false;
}

/**
 * Read the answer to the `memory` task: bullet lines of lasting facts about the writer, or `none`.
 * Conservative: questions, advice, instructions, feelings and one-day states ("feels sad today"),
 * hedged guesses, events, second-person text and anything that looks like a secret (passwords, numbers,
 * e-mail addresses) are dropped; first person ("I work as a nurse") and "The user ..." are rewritten to the
 * neutral third person ("Works as a nurse"). Near-duplicates of `existing` and of each other are removed.
 * With `userText` (everything the user wrote in the entry) a fact must also share a content word with that text,
 * its names and numbers must occur there, and the prompt's own example facts (MEMORY_EXAMPLES) are accepted only when
 * the entry has their distinctive word; anything else is treated as invented or copied and dropped. When the entry is
 * in English, a line must open with a fact verb ("Has", "Works", ...): "Dan annoys them" and "Exam stress" are not facts
 * about the writer, and neither are what the writer is doing right now ("Is cooking...", "Is planning...") or diary events
 * ("Their friend cancelled..."). "my" / "our" inside a fact become "their"; a line that still says "I" or "me" is dropped.
 * Lines in other languages are dropped when they are in the writer's own voice, an event, addressed to the writer, a
 * sentence copied from the entry, or more than one sentence; a lone "mi"/"mon"/"mein" becomes "su"/"son"/"sein".
 * @param {unknown} text model output
 * @param {{existing?: (string|{text: string})[], userText?: string, userName?: string}} [opts] `existing`: memories that are
 *   already stored; `userName`: the user's name, so "Sam has two cats" becomes "Has two cats"
 * @returns {string[]} at most 3 facts of at most 200 characters; [] for "none", "n/a", "no new facts"
 */
export function parseMemoryLines(text, { existing = [], userText = '', userName = '' } = {}) {
  const cleaned = cleanReply(text);
  if (cleaned === '') return [];
  const known = (Array.isArray(existing) ? existing : [])
    .map((e) => (typeof e === 'string' ? e : e && typeof e.text === 'string' ? e.text : ''))
    .filter(Boolean);
  const lines = candidateLines(cleaned);
  if (lines.length === 0) return [];
  const firstMeaningful = cleanValue(lines[0]).replace(FACT_PREFIX_RE, '');
  if (NONE_LINE_RE.test(firstMeaningful)) return [];
  const entry = typeof userText === 'string' ? userText : '';
  const englishEntry = looksEnglishText(entry) || (detectLanguage(entry) || {}).code === 'en';
  const out = [];
  for (const line of lines) {
    if (NONE_LINE_RE.test(cleanValue(line))) continue;
    const fact = acceptFact(line, typeof userName === 'string' ? userName.trim() : '', englishEntry);
    if (!fact) continue;
    if (entry.trim() !== '' && (!isGrounded(fact, entry) || copiesEntry(fact, entry))) continue;
    if (known.some((k) => isNearDuplicate(k, fact)) || out.some((o) => isNearDuplicate(o, fact))) continue;
    out.push(fact);
    if (out.length >= 3) break;
  }
  return out;
}
