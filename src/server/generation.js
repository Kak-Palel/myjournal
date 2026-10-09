// AI generation: replies, the wrap-up pipeline and weekly reflections (docs/ARCHITECTURE.md section 7).
//
// Shape of every job:
//   prepareX(...)  synchronous. Checks the preconditions (they become JSON errors BEFORE any stream is opened), takes
//                  the lock, builds the prompt, and returns { lock, run(sse, signal) }. Throws an HttpError otherwise.
//   run(sse, signal) streams events to the client. Provider failures are reported as `error` events, never thrown.
//   runJob(...)    opens the SSE response, turns "the client went away" into an abort, and ALWAYS releases the lock.
//
// Rules this file keeps: the user's message is saved before any model call; a partial reply is saved (stopped) when
// the client leaves or the model fails halfway; the per-entry lock is released on every path.

import { TASK_SAMPLING, buildMemoryMessages, buildMetaMessages, buildReplyMessages, buildWeeklyMessages, buildWrapUpMessages } from '../journal/context.js';
import { addDays } from '../journal/dates.js';
import { crisisNotice, detectCrisis } from '../journal/safety.js';
import { cleanReply, parseMemoryLines, parseMeta } from '../journal/tasks.js';
import { extractKeywords, firstWords, splitSentences } from '../journal/text.js';
import { DbError } from '../db/index.js';
import { ProviderError, errorPayload, isAbortError } from '../providers/index.js';
import { HttpError, conflict, notFound, openSse } from './http.js';
import { localToday } from './validate.js';

const MAX_REPLY_CHARS = 150_000;
const MAX_REPORT_CHARS = 100_000;
const SMALL_CALL_TIMEOUT_MS = 60_000;
const MAX_USER_TEXT_CHARS = 30_000;
const MAX_WEEKLY_ENTRIES = 200;

// ---------------------------------------------------------------------------------------------
// Locks

/** Lock key of an entry. Namespaced, because imported entries may have any id, including 'weekly'. */
export const entryLockKey = (entryId) => `entry:${entryId}`;
const WEEKLY_LOCK_KEY = 'job:weekly';
export const PULL_LOCK_KEY = 'job:pull';

/**
 * One generation per key at a time. Keys: entryLockKey(id) (reply and wrap-up share it), 'job:weekly', 'job:pull'.
 * Each lock owns an AbortController so shutdown, a deleted entry or a vanished client can stop the work.
 */
export function createGenerationManager() {
  /** @type {Map<string, { key: string, kind: string, controller: AbortController, startedAt: number }>} */
  const locks = new Map();
  return {
    /** @returns {object|null} the lock, or null when something is already running under this key */
    acquire(key, kind) {
      if (locks.has(key)) return null;
      const lock = { key, kind, controller: new AbortController(), startedAt: Date.now() };
      locks.set(key, lock);
      return lock;
    },
    release(lock) {
      if (locks.get(lock.key) === lock) locks.delete(lock.key);
    },
    isLocked: (key) => locks.has(key),
    /** Abort the running generation for `key`. @returns {boolean} whether there was one */
    abort(key) {
      const lock = locks.get(key);
      if (lock) lock.controller.abort();
      return Boolean(lock);
    },
    abortAll() {
      for (const lock of locks.values()) lock.controller.abort();
    },
    get size() {
      return locks.size;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// One question per reply (REPLY ONLY: wrap-up and weekly share cleanReply, never this)

// "?" (or the full-width one of Japanese and Chinese), optionally followed by closing quotes, brackets or markdown emphasis.
const QUESTION_END = /[?\uFF1F][\s"'\u201D\u2019\u00BB)\]*_~`]*$/u;
const BLANK_LINE = /\n[ \t]*\n\s*/g;
const STREAM_WINDOW = 4000; // characters of a streamed reply inspected per chunk
const LIST_OR_HEADING = /^(?:[-*\u2022+#>]|\d{1,3}[.)])\s/u;

/** The last paragraph of `text`, the one before it and where the blank line between them starts; null for a single paragraph. */
function lastParagraph(text) {
  let last = null;
  let before = null;
  for (const m of text.matchAll(BLANK_LINE)) {
    before = last;
    last = m;
  }
  if (!last) return null;
  const prevStart = before ? before.index + before[0].length : 0;
  return { cut: last.index, prev: text.slice(prevStart, last.index), tail: text.slice(last.index + last[0].length) };
}

/** One line, one sentence, not a list item or a heading. */
const isLoneSentence = (paragraph) => !paragraph.includes('\n') && !LIST_OR_HEADING.test(paragraph) && splitSentences(paragraph).length === 1;

/**
 * Small models sometimes follow their question with a second one in a paragraph of its own (qwen3:1.7b ended with exactly
 * one question in only 78 of 85 replies). The rule asks for ONE: when the reply has two or more paragraphs, the last is a
 * single sentence ending in a question mark and the paragraph before it also ends in one, the last paragraph is dropped.
 * Anything else is returned untouched (lists, a question in the middle of a paragraph, a single paragraph).
 * Used for replies only: a wrap-up or a weekly reflection may legitimately end differently.
 * @param {string} text a reply already passed through cleanReply
 * @returns {string}
 */
export function dropSecondQuestion(text) {
  if (typeof text !== 'string') return text;
  const p = lastParagraph(text);
  if (!p) return text;
  const tail = p.tail.trim();
  if (!QUESTION_END.test(p.prev.trim()) || !QUESTION_END.test(tail) || !isLoneSentence(tail)) return text;
  return text.slice(0, p.cut).trimEnd();
}

/**
 * How much of the reply streamed so far may be shown. A paragraph that follows a question might be the second one, which is
 * dropped at the end, so it is held back until it is clear that it will stay (it grows past one sentence, becomes a list)
 * or the reply is over. The live bubble then never shows text that the saved message does not have.
 */
function streamableLength(raw) {
  // Only the last two paragraphs matter, so a long reply is looked at through a window: this runs on every chunk.
  const base = Math.max(0, raw.length - STREAM_WINDOW);
  const view = base > 0 ? raw.slice(base) : raw;
  const trimmed = view.trimEnd();
  if (view.length > trimmed.length && view.slice(trimmed.length).includes('\n') && QUESTION_END.test(trimmed)) return base + trimmed.length;
  const p = lastParagraph(view);
  const tail = p ? p.tail.trim() : '';
  if (p && tail !== '' && QUESTION_END.test(p.prev.trim()) && isLoneSentence(tail)) return base + p.cut;
  return raw.length;
}

/**
 * Forwards a reply's text as it arrives, holding back a paragraph that may still be dropped by dropSecondQuestion.
 * `finish(true)` sends whatever is held (the reply is kept whole, or it ended some other way); `finish(false)` discards it.
 * @param {(text: string) => void} send
 */
function createReplyStream(send) {
  let raw = '';
  let sent = 0;
  const flushTo = (end) => {
    if (end <= sent) return;
    send(raw.slice(sent, end));
    sent = end;
  };
  return {
    push(text) {
      raw += text;
      flushTo(streamableLength(raw));
    },
    finish(keepHeld) {
      if (keepHeld) flushTo(raw.length);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Small helpers

const lastWhere = (list, test) => {
  for (let i = list.length - 1; i >= 0; i -= 1) if (test(list[i])) return list[i];
  return null;
};
const isSafety = (m) => m.role === 'assistant' && Boolean(m.meta) && m.meta.kind === 'safety';
// The client treats every assistant message that is not a prompt, wrap-up or care card as a reply (kind 'reply' or none).
const NOT_A_REPLY = new Set(['prompt', 'wrapup', 'safety']);
const isReply = (m) => m.role === 'assistant' && !NOT_A_REPLY.has(m.meta && m.meta.kind);

function userTextOf(messages) {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n\n')
    .slice(0, MAX_USER_TEXT_CHARS);
}

/** Short reason for a warn notice. Only provider errors carry text that is meant for people. */
function reasonOf(err) {
  return err instanceof ProviderError ? err.message.replace(/\s+/g, ' ').trim() : 'something unexpected went wrong.';
}

const emptyReplyError = (what) => ({
  error: { code: 'empty', message: `The model sent back an empty ${what}.`, hint: 'Try again, or pick a different model in Settings.' },
});

/**
 * Drain provider.stream(), forwarding text through `onDelta`. Never throws: the error (if any) is returned together
 * with the text received so far.
 * @returns {Promise<{ text: string, finishReason: string|null, error: unknown }>}
 */
async function collectStream(provider, request, onDelta) {
  const acc = { text: '', finishReason: null, error: null };
  try {
    for await (const event of provider.stream(request)) {
      if (event.type === 'delta') {
        acc.text += event.text;
        onDelta(event.text);
      } else if (event.type === 'done') {
        acc.finishReason = event.finishReason;
      }
    }
  } catch (error) {
    acc.error = error;
  }
  return acc;
}

/**
 * How did a collected stream end? 'stopped': the client left (or the server is shutting down), 'failed': the
 * provider reported a problem, 'ok': the model finished.
 */
function outcomeOf(acc, signal) {
  if (acc.error) return signal.aborted || isAbortError(acc.error) ? 'stopped' : 'failed';
  if (signal.aborted && acc.finishReason === null) return 'stopped';
  return 'ok';
}

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {ReturnType<import('./ai-service.js').createAiService>} deps.ai
 * @param {object} deps.config
 * @param {ReturnType<typeof createGenerationManager>} deps.generations
 * @param {{ error: Function, warn: Function }} deps.log
 */
export function createGenerationService({ db, ai, config, generations, log }) {
  function reportFailure(sse, error, what) {
    if (!(error instanceof ProviderError)) log.error(`${what} failed`, error);
    sse.send('error', { error: errorPayload(error) });
  }

  /** Save partial assistant text as a "stopped" message. Returns it, or null if there is nothing worth saving. */
  function savePartial(entryId, rawText, meta) {
    const text = dropSecondQuestion(cleanReply(rawText)).slice(0, MAX_REPLY_CHARS);
    if (!text) return null;
    try {
      return db.messages.add(entryId, { role: 'assistant', content: text, meta: { ...meta, stopped: true } });
    } catch (err) {
      if (!(err instanceof DbError && err.code === 'not_found')) log.error('Could not save a partial reply', err);
      return null; // the entry was deleted while the model was writing
    }
  }

  /** Save a finished assistant message. Returns null when the entry vanished meanwhile. */
  function saveMessage(entryId, content, meta) {
    try {
      return db.messages.add(entryId, { role: 'assistant', content, meta });
    } catch (err) {
      if (err instanceof DbError && err.code === 'not_found') return null;
      throw err;
    }
  }

  /**
   * If the person's latest message (the one an answer is owed to) shows signs of crisis, make sure the static care
   * card follows it, once. Returns the card, or null.
   */
  function ensureSafetyMessage(entryId, messages) {
    const lastTurn = lastWhere(messages, (m) => !isSafety(m));
    if (!lastTurn || lastTurn.role !== 'user') return null;
    if (!detectCrisis(lastTurn.content).flagged) return null;
    const existing = messages.slice(messages.lastIndexOf(lastTurn) + 1).find(isSafety);
    if (existing) return existing;
    return db.messages.add(entryId, { role: 'assistant', content: crisisNotice(), meta: { kind: 'safety' } });
  }

  /** Past entries that may connect to what is being written now (never private ones, never this one). */
  function findRelated(entry, text, settings) {
    if (entry.private || !settings.memory.enabled || !settings.memory.useRelatedEntries) return [];
    const keywords = extractKeywords(text, { max: 8 });
    if (keywords.length === 0) return [];
    try {
      const hits = db.search(keywords.join(' '), { mode: 'any', limit: 4, excludeEntryId: entry.id, includePrivate: false });
      const snippets = new Map(hits.map((h) => [h.entryId, h.snippet]));
      return db.entries.summariesFor(hits.map((h) => h.entryId)).map((s) => ({
        date: s.date,
        title: s.title,
        summary: s.summary,
        snippet: snippets.get(s.id) || s.preview,
      }));
    } catch (err) {
      log.warn('Related-entry search failed; continuing without it', err);
      return [];
    }
  }

  const memoriesFor = (settings) => (settings.memory.enabled ? db.memories.list() : []);

  // Preconditions shared by reply and wrap-up. The order is part of the contract:
  // not_found, ai_disabled, ai_not_configured, generation_in_progress, then the entry specific ones.
  function begin(entryId, kind, whenUnavailable) {
    const entry = db.entries.get(entryId);
    if (!entry) throw notFound('No such entry.');
    const settings = ai.loadSettings();
    let active;
    try {
      active = ai.getActive(settings);
    } catch (err) {
      try {
        whenUnavailable(entry);
      } catch (inner) {
        log.error('Could not save the care card', inner);
      }
      throw err;
    }
    const lock = generations.acquire(entryLockKey(entry.id), kind);
    if (!lock) {
      throw conflict('generation_in_progress', 'The companion is already writing in this entry.', {
        hint: 'Wait for it to finish, or press Stop first.',
      });
    }
    return { entry, settings, lock, provider: active.provider, cfg: active.cfg };
  }

  const nothingToReply = (hint) => conflict('nothing_to_reply_to', 'There is nothing new to reply to.', { hint });

  // -------------------------------------------------------------------------------------------
  // Reply

  /** The trailing reply that `regenerate` replaces, or null. */
  const replyToDrop = (messages, regenerate) => {
    const trailing = messages.at(-1);
    return regenerate && trailing && isReply(trailing) ? trailing : null;
  };

  /**
   * @param {string} entryId
   * @param {{ regenerate?: boolean, today?: string }} [options]
   * @returns {{ lock: object, run: (sse: object, signal: AbortSignal) => Promise<void> }}
   * @throws {HttpError} not_found, ai_disabled, ai_not_configured, generation_in_progress, nothing_to_reply_to
   */
  function prepareReply(entryId, { regenerate = false, today } = {}) {
    // A crisis card must not depend on the AI being usable: it is saved even when the reply has to be refused.
    const { entry, settings, lock, provider, cfg } = begin(entryId, 'reply', (found) => {
      const all = db.messages.list(found.id);
      ensureSafetyMessage(found.id, replyToDrop(all, regenerate) ? all.slice(0, -1) : all);
    });
    try {
      const all = db.messages.list(entry.id);
      const drop = replyToDrop(all, regenerate);
      const conversation = drop ? all.slice(0, -1) : all;
      const lastTurn = lastWhere(conversation, (m) => !isSafety(m));
      if (!lastTurn || lastTurn.role !== 'user') {
        throw nothingToReply(regenerate ? 'There is no reply of the companion to redo here.' : 'Write something first, then ask for a reply.');
      }
      const prompt = buildReplyMessages({
        settings,
        entry,
        messages: conversation,
        memories: memoriesFor(settings),
        related: findRelated(entry, lastTurn.content, settings),
        now: today || localToday(),
        providerId: cfg.id,
        crisis: detectCrisis(lastTurn.content).flagged,
      });
      if (prompt.debug.endsWithAssistant || prompt.debug.noMessages) throw nothingToReply('Write something first, then ask for a reply.');

      // Everything that can be refused is behind us: now change the journal.
      if (drop) db.messages.delete(drop.id);
      const safety = ensureSafetyMessage(entry.id, conversation);
      const meta = { kind: 'reply', provider: cfg.id, model: cfg.model };
      const request = { messages: prompt.messages, temperature: cfg.temperature, maxTokens: cfg.maxTokens, timeoutMs: cfg.timeoutMs };

      return {
        lock,
        async run(sse, signal) {
          if (safety) sse.send('notice', { kind: 'safety', text: safety.content, message: safety });
          const live = createReplyStream((text) => sse.send('delta', { text }));
          const acc = await collectStream(provider, { ...request, signal }, live.push);
          const outcome = outcomeOf(acc, signal);
          const cleaned = cleanReply(acc.text);
          const tidy = dropSecondQuestion(cleaned);
          live.finish(tidy === cleaned); // a dropped second question is never streamed; everything else is, held text included
          if (outcome !== 'ok') {
            savePartial(entry.id, acc.text, meta);
            if (outcome === 'failed') reportFailure(sse, acc.error, 'Reply');
            return;
          }
          const text = tidy.slice(0, MAX_REPLY_CHARS);
          if (!text) {
            sse.send('error', emptyReplyError('reply'));
            return;
          }
          const message = saveMessage(entry.id, text, meta);
          if (message) sse.send('done', { message, entry: db.entries.get(entry.id) });
        },
      };
    } catch (err) {
      generations.release(lock);
      throw err;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Wrap-up

  /** Step 2: title (only if the person has not set one), summary, emotions, tags. Best effort. */
  async function metadataStep({ entry, settings, provider, signal, sse, timeoutMs }) {
    const messages = db.messages.list(entry.id);
    const current = db.entries.get(entry.id);
    if (!current) return;
    const built = buildMetaMessages({ entry: current, messages, settings });
    let result;
    try {
      result = await provider.chat({
        messages: built.messages,
        temperature: TASK_SAMPLING.meta.temperature,
        maxTokens: TASK_SAMPLING.meta.maxTokens,
        timeoutMs,
        signal,
      });
    } catch (err) {
      if (signal.aborted || isAbortError(err)) return;
      if (!(err instanceof ProviderError)) log.error('Metadata step failed', err);
      sse.send('notice', { kind: 'warn', text: `Saved without an automatic title or summary: ${reasonOf(err)}` });
      return;
    }
    const firstMessage = (messages.find((m) => m.role === 'user') || {}).content || '';
    const parsed = parseMeta(result.text, {
      fallbackTitle: current.title,
      userText: userTextOf(messages),
      firstMessage: firstMessage.slice(0, 2000),
    });
    const patch = {};
    if (parsed.summary) patch.summary = parsed.summary;
    if (!current.title && parsed.title) patch.title = parsed.title; // never overwrite a title the person chose
    if (current.emotions.length === 0 && parsed.emotions.length > 0) patch.emotions = parsed.emotions;
    if (current.tags.length === 0 && parsed.tags.length > 0) patch.tags = parsed.tags;
    const updated = Object.keys(patch).length > 0 ? db.entries.update(entry.id, patch) : current;
    if (updated) sse.send('entry', { entry: updated });
  }

  /** Step 3: up to three lasting facts, deduplicated against what is already remembered. Best effort. */
  async function memoryStep({ entry, settings, provider, signal, sse, timeoutMs }) {
    const messages = db.messages.list(entry.id);
    const existing = db.memories.list();
    const current = db.entries.get(entry.id);
    if (!current) return [];
    const built = buildMemoryMessages({ entry: current, messages, existingMemories: existing, settings });
    let result;
    try {
      result = await provider.chat({
        messages: built.messages,
        temperature: TASK_SAMPLING.memory.temperature,
        maxTokens: TASK_SAMPLING.memory.maxTokens,
        timeoutMs,
        signal,
      });
    } catch (err) {
      if (signal.aborted || isAbortError(err)) return [];
      if (!(err instanceof ProviderError)) log.error('Memory step failed', err);
      sse.send('notice', { kind: 'warn', text: `Saved without new memories: ${reasonOf(err)}` });
      return [];
    }
    const facts = parseMemoryLines(result.text, { existing, userText: userTextOf(messages), userName: settings.profile.name });
    const created = [];
    db.tx(() => {
      for (const fact of facts) {
        if (db.memories.exists(fact)) continue;
        try {
          created.push(db.memories.create({ text: fact, sourceEntryId: entry.id }));
        } catch (err) {
          if (!(err instanceof DbError)) throw err; // a fact the database refuses is skipped, not fatal
        }
      }
    });
    if (created.length > 0) sse.send('memories', { added: created });
    return created;
  }

  /**
   * @param {string} entryId
   * @param {{ today?: string }} [options]
   * @returns {{ lock: object, run: (sse: object, signal: AbortSignal) => Promise<void> }}
   */
  function prepareWrapUp(entryId, { today } = {}) {
    const { entry, settings, lock, provider, cfg } = begin(entryId, 'wrapup', (found) => {
      ensureSafetyMessage(found.id, db.messages.list(found.id));
    });
    try {
      const all = db.messages.list(entry.id);
      const lastUser = lastWhere(all, (m) => m.role === 'user');
      if (!lastUser) throw nothingToReply('Write something first, then wrap up.');
      const prompt = buildWrapUpMessages({
        settings,
        entry,
        messages: all,
        memories: memoriesFor(settings),
        related: findRelated(entry, userTextOf(all), settings),
        now: today || localToday(),
        providerId: cfg.id,
        crisis: detectCrisis(lastUser.content).flagged,
      });
      const safety = ensureSafetyMessage(entry.id, all);
      const meta = { kind: 'wrapup', provider: cfg.id, model: cfg.model };
      const timeoutMs = Math.min(cfg.timeoutMs, SMALL_CALL_TIMEOUT_MS);
      const memoryEligible = settings.memory.enabled && settings.memory.autoExtract && !entry.private;

      return {
        lock,
        async run(sse, signal) {
          if (safety) sse.send('notice', { kind: 'safety', text: safety.content, message: safety });

          // 1. The closing reflection, streamed. A half-written reflection is not worth keeping: nothing is saved on failure.
          sse.send('phase', { name: 'reflection' });
          const acc = await collectStream(
            provider,
            { messages: prompt.messages, temperature: cfg.temperature, maxTokens: cfg.maxTokens, timeoutMs: cfg.timeoutMs, signal },
            (text) => sse.send('delta', { text }),
          );
          const outcome = outcomeOf(acc, signal);
          if (outcome === 'stopped') return;
          if (outcome === 'failed') {
            reportFailure(sse, acc.error, 'Wrap-up');
            return;
          }
          const text = cleanReply(acc.text).slice(0, MAX_REPLY_CHARS);
          if (!text) {
            sse.send('error', emptyReplyError('reflection'));
            return;
          }
          const reflection = saveMessage(entry.id, text, meta);
          if (!reflection) return;

          // 2. and 3. are best effort, one after the other (free-tier rate limits). Stopping skips what is left,
          // but the reflection exists, so the entry still counts as wrapped.
          const step = { entry, settings, provider, signal, sse, timeoutMs };
          const added = [];
          if (!signal.aborted) {
            sse.send('phase', { name: 'metadata' });
            await metadataStep(step);
          }
          if (memoryEligible && !signal.aborted) {
            sse.send('phase', { name: 'memory' });
            added.push(...(await memoryStep(step)));
          }

          const finished = db.entries.update(entry.id, { status: 'wrapped' });
          if (finished) sse.send('done', { message: reflection, entry: finished, memories: added });
        },
      };
    } catch (err) {
      generations.release(lock);
      throw err;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Weekly reflection

  /**
   * @param {{ today?: string, days?: number }} [options] window of `days` days ending on `today` (inclusive)
   * @returns {{ lock: object, run: (sse: object, signal: AbortSignal) => Promise<void> }}
   * @throws {HttpError} ai_disabled, ai_not_configured, generation_in_progress, 422 not_enough_entries
   */
  function prepareWeekly({ today = localToday(), days = 7 } = {}) {
    const settings = ai.loadSettings();
    const { provider, cfg } = ai.getActive(settings);
    const lock = generations.acquire(WEEKLY_LOCK_KEY, 'weekly');
    if (!lock) throw conflict('generation_in_progress', 'A weekly reflection is already being written.', { hint: 'Wait for it to finish.' });
    try {
      const periodEnd = today;
      const periodStart = addDays(today, -(days - 1));
      const rows = db.entries.rowsForInsights({ from: periodStart, to: periodEnd, includePrivate: false });
      if (rows.length === 0) {
        throw new HttpError(422, 'not_enough_entries', 'There are no entries in that period to reflect on.', {
          hint: 'Write a few entries first. Private entries are never included.',
        });
      }
      const entries = rows.slice(-MAX_WEEKLY_ENTRIES).map((row) => {
        let excerpt = '';
        if (!row.summary) {
          const text = db.messages.list(row.id).filter((m) => m.role === 'user').map((m) => m.content).join(' ');
          excerpt = firstWords(text, 300);
        }
        return { date: row.date, title: row.title, summary: row.summary, excerpt, mood: row.mood, emotions: row.emotions, tags: row.tags };
      });
      const prompt = buildWeeklyMessages({ entries, memories: memoriesFor(settings), settings, periodStart, periodEnd });
      // Four short paragraphs need room even when the person chose a small reply cap.
      const request = {
        messages: prompt.messages,
        temperature: cfg.temperature,
        maxTokens: Math.min(8192, Math.max(cfg.maxTokens || 0, 600)),
        timeoutMs: cfg.timeoutMs,
      };
      return {
        lock,
        async run(sse, signal) {
          const acc = await collectStream(provider, { ...request, signal }, (text) => sse.send('delta', { text }));
          const outcome = outcomeOf(acc, signal);
          if (outcome === 'stopped') return; // a stopped reflection is not saved
          if (outcome === 'failed') {
            reportFailure(sse, acc.error, 'Weekly reflection');
            return;
          }
          const content = cleanReply(acc.text).slice(0, MAX_REPORT_CHARS);
          if (!content) {
            sse.send('error', emptyReplyError('reflection'));
            return;
          }
          const report = db.reports.create({
            kind: 'weekly',
            periodStart,
            periodEnd,
            content,
            meta: { provider: cfg.id, model: cfg.model, entryCount: rows.length },
          });
          sse.send('done', { report });
        },
      };
    } catch (err) {
      generations.release(lock);
      throw err;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Streaming wrapper

  /**
   * Open the SSE response for a prepared job and run it. Resolves when the stream has ended; always releases the lock.
   * @param {import('node:http').ServerResponse} res
   * @param {{ lock: object, run: Function }} job
   */
  async function runJob(res, job) {
    const { lock } = job;
    let sse = null;
    // 'close' without a finished response means the client went away.
    const onClose = () => {
      if (!res.writableFinished) lock.controller.abort();
    };
    res.once('close', onClose);
    try {
      if (res.destroyed) return;
      sse = openSse(res, { pingMs: config.ssePingMs });
      await job.run(sse, lock.controller.signal);
    } catch (err) {
      log.error('Generation failed', err);
      if (sse) sse.send('error', { error: errorPayload(err) });
    } finally {
      generations.release(lock);
      res.off('close', onClose);
      if (sse) sse.close();
    }
  }

  return { prepareReply, prepareWrapUp, prepareWeekly, runJob };
}
