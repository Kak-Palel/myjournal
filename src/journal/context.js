// Prompt builders: turn app data into the `messages` array sent to a model.
//
// Every system message starts with a `TASK: <name>` line (mock servers and logs rely on it). Prompts are
// written for 1B-3B models: short imperative bullets, one job per call, the user's latest text LAST,
// never JSON. The budget logic keeps every prompt within `settings.ai.contextBudgetTokens` by this
// module's own estimator (tokens.js) and degrades in a fixed order:
//
//   1. related-entry lines   (least relevant first)
//   2. memory lines          (unpinned before pinned; oldest first)
//   3. oldest conversation turns (never the latest user message)
//   4. compact system prompt (shorter rules, no profile text)
//   5. the middle of the latest user message (head and tail are kept)
//
// Pure functions: no I/O, no clock (the caller passes `now`).

import { resolvePersonaPrompt } from './personas.js';
import { getTemplate, templateStep } from './templates.js';
import { LOCALIZED, detectLanguage } from './language.js';
import { MESSAGE_OVERHEAD_TOKENS, estimateTokens } from './tokens.js';
import {
  cleanText, normalizeLabels, oneLine, truncate, truncateMiddle,
} from './text.js';
import {
  diffDays, formatLongDate, formatShortDate, formatWeekdayDate, parseDateString, toDateString,
} from './dates.js';

/** Used when the settings carry no (valid) `ai.contextBudgetTokens`. */
export const DEFAULT_CONTEXT_BUDGET = 3000;
const MIN_BUDGET = 300; // below this the fixed instructions alone would not fit (settings allow 500 and up)
const MAX_BUDGET = 200_000;
const MEMORY_BLOCK_CAP = 600;
const RELATED_BLOCK_CAP = 700;
const MIN_LAST_USER_TOKENS = 24;
const MAX_MEMORY_CHARS = 200;
const MAX_WEEKLY_ENTRIES = 200;
const DROP_BLOCKS = [8, 4, 2]; // turns dropped at a time from the start of a long conversation, for local providers (see buildConversation)
const MIN_STOPPED_CHARS = 20;

const MOOD_LABELS = Object.freeze({ 1: 'Awful', 2: 'Low', 3: 'Okay', 4: 'Good', 5: 'Great' });

/**
 * Sampling the server should force for the small structured tasks (ARCHITECTURE section 8: temperature 0.2 for
 * metadata and memory calls). Replies, wrap-ups and weekly reports use the user's own settings.
 * `maxTokens` is generous for four short lines or three bullets, yet stops a rambling model early.
 */
export const TASK_SAMPLING = Object.freeze({
  meta: Object.freeze({ temperature: 0.2, maxTokens: 160 }),
  memory: Object.freeze({ temperature: 0.2, maxTokens: 160 }),
});

/** @typedef {{role: 'system'|'user'|'assistant', content: string}} ChatMessage */
/**
 * @typedef {object} BuildDebug
 * @property {number} approxTokens  estimated size of the returned prompt (content plus 4 tokens per message)
 * @property {number} budget        the budget that was applied
 * @property {number} droppedMessages  conversation messages left out because of the budget
 * @property {number} memoriesUsed
 * @property {number} relatedUsed
 * @property {boolean} compact      the shorter system prompt was used
 * @property {boolean} truncatedLastUser  the middle of the latest user message was cut
 * @property {number} [truncatedTurns] older turns that were shortened (middle cut) because they were huge
 * @property {boolean} [endsWithAssistant] (reply) the conversation ends with an assistant turn: nothing to reply to
 * @property {boolean} [noMessages] the conversation had no usable message
 * @property {{n: number, total: number, done: boolean}} [step] guided-session position for the reply being written
 * @property {boolean} [cue] (wrap-up) the closing cue was added to the prompt
 * @property {string|null} [language] (reply, wrap-up) code of the language named in the rules (`detectLanguage`), null when unclear
 */

// ------------------------------------------------------------------------------------------------
// Rules (the shared rule set; personas only add voice)

// "Write in Spanish, the language the user writes in." beats "Write in the language the user writes in." on small models:
// measured on llama3.2:1b and qwen3:1.7b, 32 of 34 and 26 of 34 replies stayed in the user's language with the neutral
// wording, 34 of 34 and 34 of 34 with the language named (qwen3:1.7b answered Spanish, French and Japanese entries in
// English 15 times in 85 without). The name comes from detectLanguage(); without a clear guess the neutral wording is used.
// English keeps the neutral wording too: naming it made qwen3:1.7b write two questions more often (72 of 85 replies ended
// with exactly one, 81 of 85 without), and an English reply to an English entry needs no help.
const languageRule = (language) => (language && language.code !== 'en' ? `Write in ${language.name}, the language the user writes in.` : 'Write in the language the user writes in.');
const languageShort = (language) => (language && language.code !== 'en' ? `Write in ${language.name}.` : "Use the user's language.");

const BACKGROUND_RULE = '- Profile notes, memories and earlier entries are background: mention one only when it directly relates to what the user just wrote.';
const NO_INVENTING_RULE = '- Do not invent details (times, places, events) that the user did not mention.';

const replyRules = (language) => [
  'Rules, always follow them:',
  '- Reply in 2 to 4 short sentences of plain prose. No lists or headings unless the user asks for them.',
  '- Respond to what the user just wrote, then ask exactly ONE open follow-up question. Your last sentence is that question.',
  `- ${languageRule(language)}`,
  "- Do not diagnose, label conditions or give orders. Do not repeat the user's text back; add something new.",
  BACKGROUND_RULE,
  NO_INVENTING_RULE,
  '- Do not bring up being an AI unless asked. Never claim to be human.',
  '- If the user may be in danger or wants to end their life: answer with warmth, take it seriously, encourage them to reach someone they trust or a local emergency or crisis line, and do not lecture.',
].join('\n');

const replyRulesCompact = (language) => [
  'Rules:',
  '- 2 to 4 short sentences of plain prose, no lists.',
  '- Then ask exactly ONE open question. End with it.',
  `- ${languageShort(language)} No diagnosing. Never claim to be human.`,
  '- Mention background notes only when they directly relate. Invent nothing.',
  '- If the user may be in danger, be warm and point to a trusted person or a local crisis line.',
].join('\n');

const wrapupRules = (language) => [
  'The session is ending now. Do not continue the conversation or answer the last message: write a short closing reflection instead.',
  'Rules, always follow them:',
  '- Write 3 to 5 sentences of plain prose. No lists or headings. Do not ask a question.',
  '- Speak to the user as "you", like a companion. Never write as if you were the user.',
  '- Name what the user seemed to feel and one specific thing they wrote in this conversation that stood out.',
  '- Point out a strength or an insight you noticed. Be honest, not flattering.',
  '- Profile notes, memories and earlier entries are background: mention one only when it clearly connects. Call an earlier entry an earlier entry, and never present background as something the user said today.',
  NO_INVENTING_RULE,
  '- End with a kind closing line or a small thought to carry forward.',
  `- ${languageRule(language)} Do not diagnose or give orders. Never claim to be human.`,
  '- If the user may be in danger or wants to end their life: answer warmly, encourage them to reach someone they trust or a local emergency or crisis line, and do not lecture.',
].join('\n');

const wrapupRulesCompact = (language) => [
  'The session is ending. Do not answer the last message directly: write a closing reflection.',
  '- 3 to 5 sentences, plain prose, no lists, no question at the end.',
  '- Speak to the user as "you". Name the main feeling and one specific thing they wrote. End kindly.',
  `- ${languageShort(language)} No diagnosing. Invent nothing.`,
].join('\n');

/** Added to the system prompt when the caller's crisis detection fired: a 1B model may ignore the generic rule. */
const CRISIS_LINE = 'The user may be in real distress right now. Put care first: acknowledge their pain, take it seriously, and gently encourage them to reach someone they trust or a local emergency or crisis line. Do not lecture and do not give advice.';

/**
 * The last user turn of a closing-reflection prompt when the language is unknown. With a known language the same cue is
 * used in that language (`closingCue`). Measured on llama3.2:1b with Spanish, French and Japanese entries: the English cue
 * kept the reflection in the entry's language in 0 of 8 tries, the cue in the entry's language in 8 of 8. The cue speaks as
 * the user ("write ... to me, addressing me as you"), which is what turns "As I close this entry, I feel..." into a
 * reflection about the user: 13 of 22 reflections from llama3.2:1b and 10 of 22 from qwen3:1.7b were in the wrong voice
 * (the user's, or about "Sam" in the third person) before, 3 of 22 and 1 of 22 after.
 */
export const WRAPUP_CUE = `${LOCALIZED.en.closing} Use the language I have been writing in.`;

/** @param {{code: string, name: string}|null} language @returns {string} */
export function closingCue(language) {
  if (language && LOCALIZED[language.code]) return LOCALIZED[language.code].closing;
  return language ? `${LOCALIZED.en.closing} Write it in ${language.name}.` : WRAPUP_CUE;
}

const META_INTRO = [
  'TASK: meta',
  'You label a private journal entry so it can be found later.',
];
// The format is shown with placeholders, not with an example: 1B models copy any example verbatim (llama3.2:1b copied it
// in 15 of 17 entries). With placeholders alone 14 of 17 entries parsed without falling back; the reminder at the end of the
// user message (META_TAIL) makes it 17 of 17.
const META_BODY = [
  'Write a title of 2 to 6 words. Write a summary of one or two short sentences about what happened and how the writer felt, without using "I" or "you".',
  'Name 1 to 4 feelings and 1 to 4 topics, separated by commas.',
  'Use the language of the entry and only what the entry says.',
  'Reply with exactly four lines, in this order, and nothing else:',
  'Title: <2 to 6 words>',
  'Summary: <one or two short sentences, without "I" or "you">',
  'Emotions: <1 to 4 feelings, separated by commas>',
  'Tags: <1 to 4 topics, separated by commas>',
];
const META_TAIL = 'Now write the four lines (Title, Summary, Emotions, Tags) for this entry.';

const MEMORY_SYSTEM = [
  'TASK: memory',
  'You find lasting facts about the writer in a private journal entry.',
  'A lasting fact is still true months from now: people in their life (name and relation), job or studies, where they live, hobbies, health conditions they mention, values, long-term goals, big life events.',
  'Do NOT include feelings, moods, what happened today, plans for the next days, opinions, advice or questions.',
  // No example facts: 1B models copy them (31 of 51 bullets from llama3.2:1b, 63 of 72 from smollm2:360m were the example).
  'Write at most 3 facts, one per line, each starting with "- ". Write each fact as: - <short fact>. Use the third person and few words.',
].join('\n');

const memoryLanguageLine = (language) => (language
  ? `Write the facts in ${language.name}.`
  : 'Write the facts in the same language as the entry.');

const MEMORY_SYSTEM_END = 'If the entry has no new lasting fact, reply with exactly: none';

const WEEKLY_RULES = [
  'Write a weekly reflection from the journal entries the user sends. Speak to the user as "you".',
  'Use only what the entries say. Do not invent events, people or feelings.',
  'Write 3 or 4 short paragraphs, each starting with a bold lead-in:',
  '**How the week felt.** The overall mood and main themes, in 2 sentences.',
  '**What stood out.** One or two specific moments or wins. Quote a few of their own words.',
  '**A pattern.** Something that repeats across the entries (a person, a feeling, a situation). If nothing is clear, say so.',
  '**For next week.** One small, kind suggestion or question.',
  'Keep it under 200 words. Warm and honest. No lists, no diagnosing, no medical advice.',
  "Use the language of the entries. Do not bring up being an AI.",
].join('\n');

/**
 * The closing instruction of the weekly prompt (last words of the user message). Seeded with the opening words of the
 * reflection, in the entries' language: measured on llama3.2:1b and qwen3:1.7b, 4 of 8 and 7 of 8 weekly reflections
 * were written as the user ("I felt...") or about "Sam" without it, 0 of 8 and 0 of 8 with it, in English and Spanish.
 * The seed names no period ("This week, you" would be wrong for a 14 or 30 day report).
 */
function weeklyCue(language) {
  const loc = language && LOCALIZED[language.code];
  if (loc) return `Write my weekly reflection now, as my companion${language.code === 'en' ? '' : `, in ${language.name}`}. Start exactly with: "${loc.weeklyLead}"`;
  return `Write my weekly reflection now, as my companion, speaking to me as "you", ${language ? `in ${language.name}` : 'in the language of my entries'}.`;
}

// ------------------------------------------------------------------------------------------------
// Input normalisation

function readBudget(settings) {
  const raw = Number(settings && settings.ai && settings.ai.contextBudgetTokens);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CONTEXT_BUDGET;
  return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.floor(raw)));
}

function readProfile(settings) {
  const profile = (settings && settings.profile) || {};
  return {
    name: truncate(oneLine(profile.name), 40),
    about: truncate(oneLine(profile.about), 600),
  };
}

function isOn(settings, group, key) {
  const g = settings && settings[group];
  return !g || g[key] !== false; // a missing flag means "on", like DEFAULT_SETTINGS
}

/** Conversation -> alternating turns. Safety notices and empty messages are skipped; same-role neighbours merge. */
function prepareTurns(messages) {
  const turns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (m.meta && m.meta.kind === 'safety') continue;
    const content = cleanText(m.content).trim();
    if (content === '') continue;
    // A reply that was stopped after a word or two ("That") is not worth a turn: it only teaches the model to be abrupt.
    if (m.role === 'assistant' && m.meta && m.meta.stopped === true && Array.from(content).length < MIN_STOPPED_CHARS) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) {
      last.content += `\n\n${content}`;
      last.count += 1;
    } else {
      turns.push({ role: m.role, content, count: 1 });
    }
  }
  return turns;
}

function userTexts(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== 'user') continue;
    const content = cleanText(m.content).trim();
    if (content !== '') out.push(content);
  }
  return out;
}

/** Memories (strings or {text, pinned}) -> [{text, pinned}], pinned first, capped by count and tokens. */
function selectMemories(memories, { maxItems, capTokens }) {
  const seen = new Set();
  const items = [];
  for (const m of Array.isArray(memories) ? memories : []) {
    const text = truncate(oneLine(typeof m === 'string' ? m : m && m.text), MAX_MEMORY_CHARS);
    const key = text.toLowerCase();
    if (text === '' || seen.has(key)) continue;
    seen.add(key);
    items.push({ text, pinned: typeof m === 'object' && m !== null && m.pinned === true });
  }
  const ordered = [...items.filter((i) => i.pinned), ...items.filter((i) => !i.pinned)];
  const out = [];
  let tokens = 0;
  for (const item of ordered) {
    const cost = estimateTokens(item.text) + 2;
    if (out.length >= maxItems || tokens + cost > capTokens) {
      if (item.pinned) continue; // a pinned fact that does not fit must not hide smaller ones behind it
      break;
    }
    tokens += cost;
    out.push(item);
  }
  return out;
}

/** Related entries -> prompt lines "(Oct 3) Title: summary", best first, capped by count and tokens. */
function selectRelated(related, { maxItems, capTokens, nowYear }) {
  const out = [];
  let tokens = 0;
  for (const r of Array.isArray(related) ? related : []) {
    if (!r || typeof r !== 'object') continue;
    const title = truncate(oneLine(r.title), 60);
    const summary = truncate(oneLine(r.summary || r.snippet), 220);
    if (title === '' && summary === '') continue;
    const date = toDateString(r.date);
    const parsed = parseDateString(date);
    const when = parsed ? `(${formatShortDate(date, { withYear: nowYear !== null && parsed.year !== nowYear })}) ` : '';
    const body = title !== '' && summary !== '' ? `${title}: ${summary}` : title || summary;
    const line = `${when}${body}`;
    const cost = estimateTokens(line) + 2;
    if (out.length >= maxItems || tokens + cost > capTokens) break;
    tokens += cost;
    out.push(line);
  }
  return out;
}

function limitsFor(providerId, budget) {
  const small = providerId === 'local';
  return {
    maxMemories: small ? 8 : 20,
    maxRelated: small ? 2 : 4,
    memoryCap: Math.min(MEMORY_BLOCK_CAP, Math.floor(budget * 0.2)),
    relatedCap: Math.min(RELATED_BLOCK_CAP, Math.floor(budget * 0.25)),
  };
}

// ------------------------------------------------------------------------------------------------
// Budget helpers

/** Cut the middle of `text` until its estimated size is at most `maxTokens`. */
function shrinkToTokens(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  let lo = 1;
  let hi = Array.from(text).length;
  let best = truncateMiddle(text, Math.max(1, Math.min(hi, 8)));
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = truncateMiddle(text, mid);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { text: best, truncated: true };
}

/**
 * Keep the START of `text`, cut so that its estimated size is at most `maxTokens`. The cut falls on the last
 * sentence or line end (else the last space) so a small model never sees a sentence broken off mid-word.
 */
function clipToTokens(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return text;
  const chars = Array.from(text);
  let lo = 1;
  let hi = chars.length;
  let keep = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (estimateTokens(chars.slice(0, mid).join('')) <= maxTokens) {
      keep = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const prefix = chars.slice(0, keep).join('');
  const sentenceEnd = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('! '), prefix.lastIndexOf('? '), prefix.lastIndexOf('\n'));
  if (sentenceEnd >= prefix.length * 0.4) return prefix.slice(0, sentenceEnd + 1).trim();
  const space = prefix.lastIndexOf(' ');
  return (space >= prefix.length * 0.4 ? prefix.slice(0, space) : prefix).trim();
}

function promptTokens(system, turns) {
  let total = estimateTokens(system) + MESSAGE_OVERHEAD_TOKENS;
  for (const t of turns) total += t.tokens + MESSAGE_OVERHEAD_TOKENS;
  return total;
}

const withTokens = (turn) => ({ ...turn, tokens: estimateTokens(turn.content) });

// ------------------------------------------------------------------------------------------------
// reply / wrap-up

// What the person told the app about themselves is labelled as background in the text itself, next to the text. A rule far
// below is not enough for a hosted model: Gemini Flash-Lite mentioned the cat of "Lives with a cat called Miso" in 5 of 17
// replies about something else with the rules alone (4 of 5 on the conversations that had leaked), and in 0 of 26 with this
// label. Small local models do not profit (llama3.2:1b: 14 of 85 replies before, 9 to 18 of 85 after) and write the
// "exactly one question" reply less often with the longer labels (qwen3:1.7b: 80 of 85 replies with the plain labels, 72 of
// 85 with these), so `lean` prompts (local providers) keep the plain ones.
const aboutLine = (name, about, lean = false) => (lean
  ? `About ${name || 'the user'}: ${about}`
  : `Background about ${name || 'the user'} (do not mention it unless it is relevant): ${about}`);
const knownBlock = (name, mems) => `Things you know about ${name || 'the user'}:\n${mems.map((m) => `- ${m.text}`).join('\n')}`;

function contextLines({ nowDate, profile, entry, level, lean }) {
  const lines = [];
  if (nowDate) lines.push(`Today is ${formatLongDate(nowDate)}.`);
  if (profile.name && level !== 'minimal') lines.push(`The user's name is ${profile.name}.`);
  if (profile.about && level === 'full') lines.push(aboutLine(profile.name, profile.about, lean));
  const mood = entry && Number.isInteger(entry.mood) ? MOOD_LABELS[entry.mood] : undefined;
  if (mood && level === 'full') lines.push(`Mood the user logged for this entry: ${mood} (${entry.mood} of 5).`);
  return lines;
}

// How much of the free-text parts survive at each level. Limits are in tokens, because a line of emoji or Japanese
// costs several times more per character than English.
const PERSONA_TOKENS = { full: 450, compact: 110, minimal: 40 };
const GUIDANCE_TOKENS = { full: 200, compact: 70, minimal: 0 };

// Past entries are found by a keyword search, so a hit can be about something else entirely (a measured wrap-up presented a
// "wrong number in the report" from another entry as something the user said today). The header says how to use them.
export const RELATED_HEADER = 'Possibly relevant past entries (background; mention one only if it clearly connects, and call it an earlier entry):';
const RELATED_HEADER_LEAN = 'Possibly relevant past entries (use only if they genuinely connect):';

function renderConversationSystem(task, c) {
  const { level } = c;
  const compact = level !== 'full';
  const parts = [`TASK: ${task}`, c.persona[level]];

  const ctx = contextLines(c).join('\n');
  if (ctx) parts.push(ctx);
  if (c.mems.length > 0) parts.push(knownBlock(c.profile.name, c.mems));
  if (c.rels.length > 0) parts.push(`${c.lean ? RELATED_HEADER_LEAN : RELATED_HEADER}\n${c.rels.map((r) => `- ${r}`).join('\n')}`);

  // `c.guidance` is always an object, so it must be its text that decides: a free-write prompt has none.
  if (task === 'reply' && (c.template || c.guidance.full)) {
    const lines = [c.guidance[level] || (level === 'minimal' ? '' : 'This is a guided session.')];
    if (c.step) lines.push(c.step.text);
    const block = lines.filter(Boolean).join('\n');
    if (block) parts.push(block);
  } else if (task === 'wrapup' && c.template && level !== 'minimal') {
    parts.push(`This session was a guided exercise: ${c.template.title}.`);
  }

  const rules = task === 'wrapup' ? (compact ? wrapupRulesCompact : wrapupRules) : (compact ? replyRulesCompact : replyRules);
  parts.push(rules(c.language));
  if (c.crisis) parts.push(CRISIS_LINE);
  return parts.join('\n\n');
}

function buildConversation(task, args) {
  const {
    settings, entry, messages, memories, related, now, providerId, templateGuidance, crisis,
  } = args || {};
  const budget = readBudget(settings);
  const profile = readProfile(settings);
  const nowDate = toDateString(now) || toDateString(entry && entry.date);
  const nowYear = nowDate ? parseDateString(nowDate).year : null;
  const limits = limitsFor(providerId, budget);

  const template = entry && entry.templateId ? getTemplate(entry.templateId) : null;
  const guidance = typeof templateGuidance === 'string' && templateGuidance.trim() !== ''
    ? oneLine(templateGuidance)
    : template ? template.guidance : '';

  let turns = prepareTurns(messages);
  const endsWithAssistant = turns.length > 0 && turns[turns.length - 1].role === 'assistant';
  const userTurnCount = turns.filter((t) => t.role === 'user').length;
  // The language to name in the prompt: the latest user message, or (when that is too short to tell, like "ok") everything written.
  const userContents = turns.filter((t) => t.role === 'user').map((t) => t.content);
  const language = task === 'wrapup'
    ? detectLanguage(userContents.join('\n\n'))
    : detectLanguage(userContents[userContents.length - 1]) || detectLanguage(userContents.slice(-6).join('\n\n'));
  let cueAdded = false;
  if (task === 'wrapup' && turns.length > 0) {
    const cue = closingCue(language);
    if (endsWithAssistant) {
      turns.push({ role: 'user', content: cue, count: 0 });
    } else {
      // The conversation ends with the user's own text: the cue goes at the end of that turn, so it is still the last thing read.
      const last = turns[turns.length - 1];
      turns[turns.length - 1] = { ...last, content: `${last.content}\n\n${cue}` };
    }
    cueAdded = true;
  }

  // One enormous old message must not push every other turn out of the prompt.
  const maxOldTurnTokens = Math.max(150, Math.floor(budget * 0.45));
  let truncatedTurns = 0;
  turns = turns.map((t, i) => {
    const turn = withTokens(t);
    if (i === turns.length - 1 || turn.tokens <= maxOldTurnTokens) return turn;
    truncatedTurns += 1;
    return withTokens({ ...t, content: shrinkToTokens(t.content, maxOldTurnTokens).text });
  });

  const useMemory = isOn(settings, 'memory', 'enabled');
  const useRelated = useMemory && isOn(settings, 'memory', 'useRelatedEntries');
  const personaText = resolvePersonaPrompt(settings && settings.persona);
  const c = {
    persona: {
      full: clipToTokens(personaText, PERSONA_TOKENS.full),
      compact: clipToTokens(personaText, PERSONA_TOKENS.compact),
      minimal: clipToTokens(personaText, PERSONA_TOKENS.minimal),
    },
    profile: { name: profile.name, about: clipToTokens(profile.about, 160) },
    entry,
    nowDate,
    template,
    guidance: {
      full: clipToTokens(guidance, GUIDANCE_TOKENS.full),
      compact: clipToTokens(guidance, GUIDANCE_TOKENS.compact),
      minimal: '',
    },
    step: task === 'reply' && template ? templateStep(template, userTurnCount) : null,
    mems: useMemory ? selectMemories(memories, { maxItems: limits.maxMemories, capTokens: limits.memoryCap }) : [],
    rels: useRelated ? selectRelated(related, { maxItems: limits.maxRelated, capTokens: limits.relatedCap, nowYear }) : [],
    level: 'full',
    crisis: crisis === true,
    language,
    lean: providerId === 'local',
  };

  // A system prompt that alone takes almost half the budget would starve the conversation: shorten it up front.
  const bareSystem = renderConversationSystem(task, { ...c, mems: [], rels: [] });
  if (estimateTokens(bareSystem) > budget * 0.45) c.level = 'compact';

  let system = renderConversationSystem(task, c);
  let systemTokens = estimateTokens(system);
  let turnTokens = turns.reduce((n, t) => n + t.tokens + MESSAGE_OVERHEAD_TOKENS, 0);
  let first = 0; // index of the oldest turn that is still in the prompt
  let dropped = 0;
  let truncatedLast = false;
  const blockwise = providerId === 'local';
  const fits = () => systemTokens + MESSAGE_OVERHEAD_TOKENS + turnTokens <= budget;
  const rerender = () => {
    system = renderConversationSystem(task, c);
    systemTokens = estimateTokens(system);
  };

  while (!fits()) {
    if (c.rels.length > 0) {
      c.rels.pop();
      rerender();
    } else if (c.mems.length > 0) {
      // Pinned memories are listed first, so popping from the end removes unpinned ones before pinned ones.
      c.mems.pop();
      rerender();
    } else if (turns.length - first > 1) {
      dropped += turns[first].count;
      turnTokens -= turns[first].tokens + MESSAGE_OVERHEAD_TOKENS;
      first += 1;
    } else if (c.level === 'full') {
      c.level = 'compact';
      rerender();
    } else if (c.level === 'compact') {
      c.level = 'minimal';
      rerender();
    } else {
      const last = turns[first];
      const room = Math.max(MIN_LAST_USER_TOKENS, budget - systemTokens - 2 * MESSAGE_OVERHEAD_TOKENS);
      const shrunk = shrinkToTokens(last.content, room);
      turns[first] = withTokens({ ...last, content: shrunk.text });
      turnTokens = turns[first].tokens + MESSAGE_OVERHEAD_TOKENS;
      truncatedLast = shrunk.truncated;
      break;
    }
  }
  // Local servers (Ollama, llama.cpp) keep the processed prompt and only compute what is new. Dropping ONE old turn on every
  // request moves the start of the history each time, so they process everything again (measured on llama3.2:1b, 30 turns:
  // median reply 9 s and 14 % of the prompt reused once the budget was full, against 2.7 s and 76 % with blocks). So for
  // them the first kept turn is rounded up to a multiple of a block size, counted from the start of the conversation: the
  // same turns are kept for the next few requests and the cached prefix survives. The block is 8 turns when that costs at
  // most 40 % of what fits, else 4 or 2 (a small budget must not lose most of its history). Only more is dropped: the
  // budget is still honoured and the latest message is never touched.
  if (blockwise && first > 0 && turns.length - first > 0) {
    const fitting = turns.length - first;
    const block = DROP_BLOCKS.find((b) => b - 1 <= fitting * 0.4) || 1;
    const rounded = Math.min(turns.length - 1, Math.ceil(first / block) * block);
    while (first < rounded) {
      dropped += turns[first].count;
      turnTokens -= turns[first].tokens + MESSAGE_OVERHEAD_TOKENS;
      first += 1;
    }
  }
  turns = turns.slice(first);

  const out = [{ role: 'system', content: system }, ...turns.map(({ role, content }) => ({ role, content }))];
  /** @type {BuildDebug} */
  const debug = {
    approxTokens: systemTokens + MESSAGE_OVERHEAD_TOKENS + turnTokens,
    budget,
    droppedMessages: dropped,
    memoriesUsed: c.mems.length,
    relatedUsed: c.rels.length,
    compact: c.level !== 'full',
    truncatedLastUser: truncatedLast,
    truncatedTurns,
    endsWithAssistant: task === 'reply' && endsWithAssistant,
    noMessages: turns.length === 0,
    cue: cueAdded,
    language: language ? language.code : null,
  };
  if (c.step) debug.step = { n: c.step.n, total: c.step.total, done: c.step.done };
  return { messages: out, debug };
}

/**
 * Prompt for the companion's next reply.
 *
 * Input shapes (all optional unless stated; unknown fields are ignored):
 *  - `settings`: internal settings. Read: `profile.{name,about}`, `persona.{id,custom}`, `ai.contextBudgetTokens`
 *    (default 3000), `memory.{enabled,useRelatedEntries}` (false switches the block off here too).
 *  - `entry`: `{ templateId?, mood?: 1..5|null, date?: 'YYYY-MM-DD' }`. A known `templateId` adds the guided-session
 *    guidance and the computed "Step n of m" hint.
 *  - `messages` (required): the conversation, oldest first, `{ role: 'user'|'assistant', content, meta?: { kind? } }`.
 *    Messages with `meta.kind === 'safety'` and empty messages are skipped, consecutive same-role messages are merged.
 *  - `memories`: `{ text, pinned? }[]` (or plain strings), best first (pinned first is what `GET /api/memories` returns).
 *  - `related`: `{ date: 'YYYY-MM-DD', title?: string, summary?: string, snippet?: string }[]`, most relevant first.
 *    Rendered as "- (Oct 3) Title: summary" (`snippet` is used when `summary` is empty).
 *  - `now`: Date | epoch ms | 'YYYY-MM-DD'. Produces "Today is Thursday, 8 October 2026." (falls back to `entry.date`, else no line).
 *  - `providerId`: 'gemini' | 'openai' | 'local'. `local` gets a leaner context (fewer memories / related entries).
 *  - `templateGuidance`: overrides the guidance text of the entry's template.
 *  - `crisis`: true when detectCrisis() flagged the latest user message; adds an explicit "put care first" line after the rules.
 *
 * If the conversation ends with an assistant turn there is nothing to reply to: the messages are returned as they
 * are (no invented user turn) and `debug.endsWithAssistant` is true.
 * @param {object} args
 * @returns {{messages: ChatMessage[], debug: BuildDebug}}
 */
export function buildReplyMessages(args) {
  return buildConversation('reply', args);
}

/**
 * Prompt for the closing reflection of a session. Same inputs as buildReplyMessages(). The conversation is
 * sent as it stands, followed by the closing cue (closingCue(): in the user's language when `detectLanguage()` can tell,
 * written as the user so that the reflection comes back addressed to them): if it ends with an assistant turn, the cue is
 * a short user turn, so every provider gets a prompt that ends with a user message; otherwise it ends the user's last turn.
 * @param {object} args see buildReplyMessages
 * @returns {{messages: ChatMessage[], debug: BuildDebug}}
 */
export function buildWrapUpMessages(args) {
  return buildConversation('wrapup', args);
}

// ------------------------------------------------------------------------------------------------
// meta / memory: one system message and one user message that holds the writing

function buildSingleUser({ system, header, bodyText, tail = '', budget, emptyText }) {
  const body = bodyText === '' ? emptyText : bodyText;
  const fixed = estimateTokens(system) + estimateTokens(header) + estimateTokens(tail) + 2 * MESSAGE_OVERHEAD_TOKENS;
  const room = Math.max(MIN_LAST_USER_TOKENS, budget - fixed);
  const shrunk = shrinkToTokens(body, room);
  const content = `${header}${shrunk.text}${tail}`;
  return { content, truncated: shrunk.truncated };
}

function guidedLine(entry) {
  const template = entry && entry.templateId ? getTemplate(entry.templateId) : null;
  return template ? `This entry came from a guided exercise: ${template.title}.` : '';
}

/**
 * Prompt for the `meta` task (title, summary, emotions, tags). The user message is `Journal entry:` followed by
 * everything the user wrote (assistant turns are left out), then a one-line reminder of the format (and, for a non-English
 * entry, of its language); when the entry does not fit the budget its middle is cut.
 * The model is asked for the four labelled lines that parseMeta() reads.
 * @param {{entry?: object, messages: object[], settings?: object}} args `entry.templateId` adds one line of context
 * @returns {{messages: ChatMessage[], debug: BuildDebug}}
 */
export function buildMetaMessages({ entry, messages, settings } = {}) {
  const budget = readBudget(settings);
  const guided = guidedLine(entry);
  const system = [...META_INTRO, ...(guided ? [guided] : []), ...META_BODY].join('\n');
  const text = userTexts(messages).join('\n\n');
  // The reminder after the entry is what makes a 1B model write the four lines instead of repeating the format (see META_BODY).
  // Naming a non-English language keeps title and summary in it (qwen3:1.7b answered 4 of 4 non-English entries in English
  // without); the labels stay English because parseMeta reads them.
  const language = detectLanguage(text);
  const tail = `\n\n${META_TAIL}${language && language.code !== 'en' ? ` Keep the four labels in English and write the rest in ${language.name}.` : ''}`;
  const { content, truncated } = buildSingleUser({ system, header: 'Journal entry:\n\n', bodyText: text, tail, budget, emptyText: '(empty entry)' });
  const out = [{ role: 'system', content: system }, { role: 'user', content }];
  return {
    messages: out,
    debug: {
      approxTokens: promptTokens(system, [{ tokens: estimateTokens(content) }]),
      budget,
      droppedMessages: 0,
      memoriesUsed: 0,
      relatedUsed: 0,
      compact: false,
      truncatedLastUser: truncated,
    },
  };
}

/**
 * Prompt for the `memory` task (0-3 lasting facts about the writer). The user message is `Journal entry:` plus the
 * user's own writing. Facts that are already stored are listed in the system message ("do not repeat") as far as
 * the budget allows.
 * @param {{entry?: object, messages: object[], existingMemories?: ({text: string}|string)[], settings?: object}} args
 * @returns {{messages: ChatMessage[], debug: BuildDebug}}
 */
export function buildMemoryMessages({ entry, messages, existingMemories, settings } = {}) {
  const budget = readBudget(settings);
  const text = userTexts(messages).join('\n\n');
  const known = selectMemories(existingMemories, { maxItems: 12, capTokens: Math.min(300, Math.floor(budget * 0.15)) });
  const languageLine = memoryLanguageLine(detectLanguage(text));
  const render = () => {
    const parts = [MEMORY_SYSTEM];
    if (known.length > 0) parts.push(`Already known, do not repeat:\n${known.map((m) => `- ${m.text}`).join('\n')}`);
    parts.push(languageLine, MEMORY_SYSTEM_END);
    return parts.join('\n');
  };
  let system = render();
  const minUser = Math.min(estimateTokens(text) + 8, 120);
  while (known.length > 0 && estimateTokens(system) + minUser + 2 * MESSAGE_OVERHEAD_TOKENS + 4 > budget) {
    known.pop();
    system = render();
  }
  const { content, truncated } = buildSingleUser({ system, header: 'Journal entry:\n\n', bodyText: text, budget, emptyText: '(empty entry)' });
  return {
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
    debug: {
      approxTokens: promptTokens(system, [{ tokens: estimateTokens(content) }]),
      budget,
      droppedMessages: 0,
      memoriesUsed: known.length,
      relatedUsed: 0,
      compact: false,
      truncatedLastUser: truncated,
    },
  };
}

// ------------------------------------------------------------------------------------------------
// weekly

function readWeeklyEntries(entries) {
  const rows = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    const date = toDateString(e.date);
    if (!date || !parseDateString(date)) continue;
    rows.push({
      date,
      title: truncate(oneLine(e.title), 70),
      body: oneLine(e.summary) || oneLine(e.excerpt),
      mood: Number.isInteger(e.mood) && e.mood >= 1 && e.mood <= 5 ? e.mood : null,
      emotions: normalizeLabels(e.emotions, { max: 4, maxLen: 24 }),
      tags: normalizeLabels(e.tags, { max: 4, maxLen: 24 }),
    });
  }
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.date < b.r.date ? -1 : a.r.date > b.r.date ? 1 : a.i - b.i)).map((x) => x.r);
}

function weeklyEntryLine(e, bodyChars) {
  const bits = [];
  if (e.mood !== null) bits.push(`mood ${e.mood}/5`);
  if (e.emotions.length > 0) bits.push(`feelings: ${e.emotions.join(', ')}`);
  if (e.tags.length > 0) bits.push(`tags: ${e.tags.join(', ')}`);
  const head = `- ${formatWeekdayDate(e.date)}${bits.length > 0 ? ` (${bits.join('; ')})` : ''}`;
  const body = bodyChars > 0 ? truncate(e.body, bodyChars) : '';
  const text = e.title !== '' && body !== '' ? `${e.title}: ${body}` : e.title || body || '(no text)';
  return `${head}: ${text}`;
}

function weeklyOverview(rows) {
  const moods = rows.map((r) => r.mood).filter((m) => m !== null);
  const counts = new Map();
  for (const r of rows) for (const label of r.emotions) counts.set(label, (counts.get(label) || 0) + 1);
  // A feeling that appeared once is not a pattern; listing it would only invite invented trends.
  const top = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label, n]) => `${label} (${n})`);
  const parts = [`${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`];
  if (moods.length > 0) parts.push(`average mood ${(Math.round((moods.reduce((a, b) => a + b, 0) / moods.length) * 10) / 10).toFixed(1)} of 5`);
  if (top.length > 0) parts.push(`most common feelings: ${top.join(', ')}`);
  return `${parts.join('; ')}.`;
}

/**
 * Prompt for the weekly reflection.
 *
 * `entries`: `{ date: 'YYYY-MM-DD', title?: string, summary?: string, excerpt?: string, mood?: 1..5|null,
 * emotions?: string[], tags?: string[] }[]` in any order (private entries must be filtered out by the caller).
 * `summary` is preferred; `excerpt` (the start of what the user wrote) is used for entries that were never wrapped up.
 * `memories`: `{ text, pinned? }[]` or strings (optional personal context). `periodStart` / `periodEnd`:
 * `YYYY-MM-DD` (inclusive); derived from the entries when missing. At most the newest 200 entries are considered.
 * The user message lists one line per entry, oldest first, and ends with the instruction to write the reflection, seeded
 * with its first words in the entries' language (see weeklyCue). To fit the budget it first
 * drops memories, then the persona text, then shortens every entry's text, then drops the oldest entries.
 * @param {{entries: object[], memories?: object[], settings?: object, periodStart?: string, periodEnd?: string}} args
 * @returns {{messages: ChatMessage[], debug: BuildDebug & {entriesUsed: number}}}
 */
export function buildWeeklyMessages({
  entries, memories, settings, periodStart, periodEnd,
} = {}) {
  const budget = readBudget(settings);
  const profile = readProfile(settings);
  let rows = readWeeklyEntries(entries).slice(-MAX_WEEKLY_ENTRIES);
  const total = rows.length;

  const explicitStart = toDateString(periodStart);
  const explicitEnd = toDateString(periodEnd);
  const period = () => {
    const start = (total === rows.length && explicitStart) || (rows[0] && rows[0].date) || '';
    const end = explicitEnd || (rows.length > 0 && rows[rows.length - 1].date) || '';
    if (!start || !end) return 'Journal entries';
    const days = diffDays(start, end) + 1;
    const year = formatLongDate(end).split(' ').pop();
    const span = `${formatWeekdayDate(start)} to ${formatWeekdayDate(end)} ${year}${days > 0 ? ` (${days} ${days === 1 ? 'day' : 'days'})` : ''}`;
    // Say so when older entries were left out for space, so the model does not describe a week it was not shown.
    return `Journal entries from ${span}${total > rows.length ? ', older entries left out' : ''}`;
  };

  const useMemory = isOn(settings, 'memory', 'enabled');
  let mems = useMemory ? selectMemories(memories, { maxItems: 10, capTokens: Math.min(300, Math.floor(budget * 0.15)) }) : [];
  let includePersona = true;
  let includeAbout = true;
  let bodyChars = 320;
  const persona = clipToTokens(resolvePersonaPrompt(settings && settings.persona), PERSONA_TOKENS.full);
  const about = clipToTokens(profile.about, 160);

  const renderSystem = () => {
    const parts = ['TASK: weekly'];
    if (includePersona) parts.push(persona);
    const who = [];
    if (profile.name) who.push(`The user's name is ${profile.name}.`);
    if (about && includeAbout) who.push(aboutLine(profile.name, about));
    if (who.length > 0) parts.push(who.join('\n'));
    if (mems.length > 0) parts.push(knownBlock(profile.name, mems));
    parts.push(WEEKLY_RULES);
    return parts.join('\n\n');
  };
  // The language of what the user wrote (titles and summaries), not of the app's own "mood 3/5" labels.
  const language = detectLanguage(rows.map((r) => `${r.title}. ${r.body}`).join('\n'));
  const cue = weeklyCue(language);
  const renderUser = () => {
    const lines = rows.length > 0 ? rows.map((r) => weeklyEntryLine(r, bodyChars)) : ['(no entries)'];
    return `${period()}:\n${weeklyOverview(rows)}\n\n${lines.join('\n')}\n\n${cue}`;
  };

  let system = renderSystem();
  let user = renderUser();
  const used = () => estimateTokens(system) + estimateTokens(user) + 2 * MESSAGE_OVERHEAD_TOKENS;
  // Entry text is shortened step by step but never below ~60 characters while other entries can still be dropped.
  const bodySteps = [220, 150, 100, 60];
  let truncatedUser = false;
  while (used() > budget) {
    if (mems.length > 0) mems = mems.slice(0, -1);
    else if (includePersona) includePersona = false;
    else if (includeAbout && about) includeAbout = false;
    else if (bodySteps.length > 0) bodyChars = bodySteps.shift();
    else if (rows.length > 1) rows = rows.slice(1);
    else if (bodyChars > 0) bodyChars = 0;
    else {
      const room = Math.max(MIN_LAST_USER_TOKENS, budget - estimateTokens(system) - 2 * MESSAGE_OVERHEAD_TOKENS);
      user = shrinkToTokens(user, room).text;
      truncatedUser = true;
      break;
    }
    system = renderSystem();
    user = renderUser();
  }

  return {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    debug: {
      approxTokens: used(),
      budget,
      droppedMessages: 0,
      memoriesUsed: mems.length,
      relatedUsed: 0,
      compact: !includePersona,
      truncatedLastUser: truncatedUser,
      entriesUsed: rows.length,
      entriesDropped: total - rows.length,
    },
  };
}

export { MOOD_LABELS };
