// Deterministic, role-aware reply generator shared by the mock LLM servers.
//
// The system message of every model call made by the app starts with a line `TASK: reply|wrapup|meta|memory|weekly`
// (docs/ARCHITECTURE.md §8). The responder answers each task in the format the app's parsers expect, derived
// from the text it is given, so end-to-end flows can be tested without a real model. Same input, same output.

export const TASKS = Object.freeze(['reply', 'wrapup', 'meta', 'memory', 'weekly']);

const STOPWORDS = new Set((
  'about above after again against also because been before being below between both but could did does doing down during each ' +
  'few from further had has have having here hers herself himself his how into its itself just like make more most much myself ' +
  'once only other ours ourselves over own really same should some such than that their theirs them themselves then there these ' +
  'they this those through under until very want was were what when where which while who whom why will with would your yours ' +
  'yourself yourselves today still feel felt feeling think thought thing things going went got get'
).split(' '));

const EMOTION_LEXICON = [
  ['tired', /\b(tired|exhaust\w*|drained|worn out|sleepy)\b/i],
  ['anxious', /\b(anxi\w*|nervous|worr\w*|uneasy|panic\w*)\b/i],
  ['stressed', /\b(stress\w*|pressure|deadline)\b/i],
  ['overwhelmed', /\b(overwhelm\w*|too much)\b/i],
  ['sad', /\b(sad|cry\w*|tears|down|depress\w*|grief|miss(?:ed|ing)?)\b/i],
  ['lonely', /\b(lonely|alone|isolated)\b/i],
  ['frustrated', /\b(frustrat\w*|angry|anger|annoy\w*|irritat\w*|furious)\b/i],
  ['happy', /\b(happy|joy\w*|great|wonderful|amazing|fun|delighted)\b/i],
  ['grateful', /\b(grateful|thankful|appreciat\w*|thank)\b/i],
  ['proud', /\b(proud|accomplish\w*|achiev\w*)\b/i],
  ['calm', /\b(calm|peace\w*|relax\w*|content|serene)\b/i],
  ['excited', /\b(excited|thrilled|can't wait|looking forward)\b/i],
  ['hopeful', /\b(hopeful|hope|optimis\w*)\b/i],
];
const NEGATIVE = new Set(['tired', 'anxious', 'stressed', 'overwhelmed', 'sad', 'lonely', 'frustrated']);
const POSITIVE = new Set(['happy', 'grateful', 'proud', 'calm', 'excited', 'hopeful']);

const edgePunctuation = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** FNV-1a 32 bit: tiny, stable, good enough to pick between canned phrases. */
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The task named by the first line of the first system message, or null. */
export function parseTask(messages) {
  const system = (messages || []).find((m) => m && m.role === 'system' && typeof m.content === 'string');
  if (!system) return null;
  const first = system.content.split(/\r?\n/, 1)[0];
  const m = /^\s*TASK:\s*(reply|wrapup|meta|memory|weekly)\b/i.exec(first);
  return m ? m[1].toLowerCase() : null;
}

/** Text of the last user message ('' if none). */
export function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

/** All user text, oldest first, joined with blank lines. */
export function allUserText(messages) {
  return (messages || []).filter((m) => m && m.role === 'user' && typeof m.content === 'string').map((m) => m.content).join('\n\n');
}

export function wordCount(text) {
  return (String(text).match(/\S+/g) || []).length;
}

function sentencesOf(text) {
  return String(text)
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

const DANGLING = new Set('a an the and or but of to in on at for with as by from after before while if so than is was are my i i\'m'.split(' '));

/** Drop trailing function words ("... went to the") so a cut-off phrase reads like a phrase, keeping at least `min` words. */
function trimDangling(tokens, min = 3) {
  const out = [...tokens];
  const textOf = (t) => (typeof t === 'string' ? t : t[0]);
  while (out.length > min && DANGLING.has(textOf(out[out.length - 1]).toLowerCase().replace(/[^\p{L}']/gu, ''))) out.pop();
  return out;
}

/**
 * A verbatim run of 3-6 words from the text (fewer if the text is shorter), taken from a single sentence,
 * with edge punctuation, quotes and question marks removed so it embeds cleanly.
 * @param {string} text
 * @param {{salt?: string}} [opts]
 */
export function pickQuote(text, { salt = '' } = {}) {
  const sentences = sentencesOf(text);
  if (sentences.length === 0) return '';
  const h = hash(String(text) + salt);
  const long = sentences.filter((s) => wordCount(s) >= 3);
  const sentence = long.length ? long[long.length - 1 - (h % Math.min(long.length, 2))] || long[long.length - 1] : sentences[sentences.length - 1];
  const tokens = [...sentence.matchAll(/\S+/g)];
  const length = Math.min(tokens.length, 3 + (h % 4));
  const start = tokens.length > length ? (h >>> 3) % (tokens.length - length + 1) : 0;
  const run = trimDangling(tokens.slice(start, start + length));
  const from = run[0].index;
  const last = run[run.length - 1];
  const raw = sentence.slice(from, last.index + last[0].length);
  return raw.replace(/[?"“”]/g, '').replace(edgePunctuation, '').trim();
}

/** Most frequent meaningful words (lowercase), ties broken by first appearance. */
export function keywords(text, max = 4) {
  const counts = new Map();
  const order = [];
  for (const w of String(text).toLowerCase().match(/[\p{L}][\p{L}'-]{3,}/gu) || []) {
    if (STOPWORDS.has(w)) continue;
    if (!counts.has(w)) order.push(w);
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return order
    .map((w, i) => ({ w, n: counts.get(w), i }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, max)
    .map((x) => x.w);
}

export function detectEmotions(text, max = 3) {
  const found = [];
  for (const [label, re] of EMOTION_LEXICON) {
    if (re.test(text)) found.push(label);
    if (found.length >= max) break;
  }
  return found.length ? found : ['reflective'];
}

function tone(text) {
  const emotions = detectEmotions(text, 13).filter((e) => e !== 'reflective');
  const neg = emotions.filter((e) => NEGATIVE.has(e)).length;
  const pos = emotions.filter((e) => POSITIVE.has(e)).length;
  if (neg > pos) return 'negative';
  if (pos > neg) return 'positive';
  return 'neutral';
}

const OPENERS = {
  negative: ['That sounds like a lot to carry.', 'I can hear how heavy that felt.', 'Thank you for trusting this page with something hard.'],
  positive: ['I love hearing that.', 'That sounds like a real bright spot.', 'It is good to notice moments like that.'],
  neutral: ['Thank you for writing that down.', 'I appreciate you putting that into words.', 'Thanks for sharing that with me.'],
};
const MIDDLES = [
  (q) => `You wrote “${q}”, and that stayed with me.`,
  (q) => `When you say “${q}”, it seems to matter.`,
  (q) => `I keep coming back to “${q}”.`,
];
const QUESTIONS = [
  'What feels most important about that right now?',
  'What do you think is underneath that feeling?',
  'What would you like to understand better about it?',
  'How did that land in your body when it happened?',
];

/** 2-3 warm sentences, a verbatim 3-6 word quote, and exactly one question at the end. */
function composeReply(text) {
  const h = hash(text);
  const quote = pickQuote(text) || 'what you shared';
  const parts = [];
  if (h % 3 !== 0) parts.push(OPENERS[tone(text)][h % 3]);
  parts.push(MIDDLES[(h >>> 2) % MIDDLES.length](quote));
  parts.push(QUESTIONS[(h >>> 4) % QUESTIONS.length]);
  return parts.join(' ');
}

function composeWrapup(text) {
  const h = hash(text);
  const sentences = sentencesOf(text);
  const first = pickQuote(sentences[0] || text, { salt: 'a' }) || 'what you shared';
  const last = pickQuote(sentences[sentences.length - 1] || text, { salt: 'b' }) || first;
  const words = keywords(text, 3);
  const emotions = detectEmotions(text, 2).join(' and ');
  const topic = words.length ? words.slice(0, 2).join(' and ') : 'what was on your mind';
  const closers = [
    'Showing up to write this down is a kind of care, and it counts.',
    'Whatever tomorrow brings, you have put today into words, and that is worth honoring.',
    'You do not have to resolve it all tonight; noticing it is already a step.',
  ];
  return [
    `Looking back on this entry, “${first}” felt like where it started, and the feeling underneath seemed to be ${emotions}.`,
    `Something worth noticing is that you kept returning to ${topic}, ending on “${last}”. That says something about what matters to you right now.`,
    closers[h % closers.length],
  ].join('\n\n');
}

function titleCase(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function composeMeta(text) {
  const clean = String(text).replace(/^\s*(journal entry|entry|transcript|conversation)\s*:\s*$/gim, '');
  const sentences = sentencesOf(clean);
  const sentence = sentences.find((x) => wordCount(x) >= 3) || sentences[0] || '';
  const titleWords = trimDangling(sentence.split(/\s+/).filter(Boolean).slice(0, 6)).join(' ').replace(edgePunctuation, '');
  const title = titleCase(titleWords.slice(0, 60)) || 'Untitled reflection';
  const words = keywords(clean, 3);
  const emotions = detectEmotions(clean, 3);
  const about = words.length === 0 ? 'a few things on your mind'
    : words.length === 1 ? words[0]
      : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  const summary = `You wrote about ${about}. It felt ${emotions[0]}.`;
  const tags = words.length ? words.slice(0, 3) : ['journal'];
  return [
    `Title: ${title}`,
    `Summary: ${summary}`,
    `Emotions: ${emotions.join(', ')}`,
    `Tags: ${tags.join(', ')}`,
  ].join('\n');
}

const SKIP_STATE = /^(so|very|really|just|too|not|still|feeling|going|trying|about|a bit|kind of|sure|glad|sorry)\b/i;

/** "- fact" lines derived from first-person statements, or `none` when there is too little text. */
function composeMemory(text) {
  if (wordCount(text) < 6) return 'none';
  const facts = [];
  const add = (fact) => {
    const f = fact.replace(/\s+/g, ' ').replace(/\b(and|but|so|because|when|that)$/i, '').trim().replace(edgePunctuation, '');
    if (f.length >= 6 && !facts.some((x) => x.toLowerCase() === f.toLowerCase())) facts.push(titleCase(f.slice(0, 120)));
  };
  for (const s of sentencesOf(text)) {
    let m;
    if ((m = /\bmy ([a-z]+(?: [a-z]+)?) (?:is|was|are) (?:called |named )?([^.,;!?]{2,40})/i.exec(s))) add(`Their ${m[1]} is ${m[2]}`);
    if ((m = /\bI work(?:ed)? ((?:at|as|for|in|from)\b[^.,;!?]{2,50})/i.exec(s))) add(`Works ${m[1]}`);
    if ((m = /\bI live (in|near|with) ([^.,;!?]{2,40})/i.exec(s))) add(`Lives ${m[1]} ${m[2]}`);
    if ((m = /\bI (love|like|enjoy|hate|dislike|prefer) ([^.,;!?]{3,50})/i.exec(s))) {
      const verb = { love: 'Loves', like: 'Likes', enjoy: 'Enjoys', hate: 'Hates', dislike: 'Dislikes', prefer: 'Prefers' }[m[1].toLowerCase()];
      add(`${verb} ${m[2]}`);
    }
    if ((m = /\bI(?:'m| am) ((?:a |an |the )[^.,;!?]{3,60})/i.exec(s)) && !SKIP_STATE.test(m[1])) add(`Is ${m[1]}`);
    if ((m = /\bI (?:have|had|got) ((?:a |an |the |two |three |\d+ )[^.,;!?]{3,60})/i.exec(s))) add(`Has ${m[1]}`);
    if (facts.length >= 3) break;
  }
  if (facts.length === 0) {
    const words = keywords(text, 3);
    add(words.length ? `Wrote about ${words.join(', ')}` : 'Keeps a journal');
  }
  return facts.slice(0, 3).map((f) => `- ${f}`).join('\n');
}

function composeWeekly(text) {
  const words = keywords(text, 4);
  const emotions = detectEmotions(text, 3);
  const quote = pickQuote(text) || 'what you shared';
  const topic = words.length ? words.slice(0, 3).join(', ') : 'a mix of everyday things';
  return [
    `**The shape of your week.** You kept coming back to ${topic}. The feeling that showed up most was ${emotions[0]}.`,
    `**A line that stood out.** “${quote}” says a lot in a few words. It is worth sitting with.`,
    `**A pattern to watch.** ${titleCase(emotions[emotions.length - 1])} appeared more than once, which suggests it is a theme rather than a one-off.`,
    '**Looking ahead.** Pick one small thing from this week to repeat, and one to ease up on.',
  ].join('\n\n');
}

function composeGeneric(text) {
  const quote = pickQuote(text);
  const echo = quote ? ` I noticed “${quote}”.` : '';
  return `Thanks for the message.${echo} I am a mock assistant, but I am happy to keep chatting. What would you like to talk about next?`;
}

/**
 * Produce the reply for a chat request.
 * @param {{role: string, content: string}[]} messages
 * @returns {string}
 */
export function respond(messages) {
  const task = parseTask(messages);
  const last = lastUserText(messages);
  switch (task) {
    case 'reply': return composeReply(last);
    case 'wrapup': return composeWrapup(allUserText(messages) || last);
    case 'meta': return composeMeta(last);
    case 'memory': return composeMemory(last);
    case 'weekly': return composeWeekly(last);
    default: return composeGeneric(last);
  }
}

/**
 * Split text into streaming deltas of 1-6 characters (a deterministic cycle), so words are cut in the middle
 * like a real tokenizer sometimes does. By default a surrogate pair is never split; set
 * `splitCodePoints: true` to allow lone surrogates (to exercise consumers that must cope with them).
 * @param {string} text
 * @param {{chunkSize?: number, sizes?: number[], splitCodePoints?: boolean}} [opts]
 * @returns {string[]}
 */
export function splitIntoDeltas(text, { chunkSize, sizes: sizeCycle, splitCodePoints = false } = {}) {
  const sizes = chunkSize ? [chunkSize] : (sizeCycle && sizeCycle.length ? sizeCycle : [3, 1, 4, 2, 5, 2, 6, 3]);
  const units = splitCodePoints ? text.split('') : Array.from(text);
  const out = [];
  let i = 0;
  let k = 0;
  while (i < units.length) {
    const size = sizes[k % sizes.length];
    out.push(units.slice(i, i + size).join(''));
    i += size;
    k += 1;
  }
  return out;
}
