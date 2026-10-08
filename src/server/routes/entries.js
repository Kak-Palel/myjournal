// /api/entries : the journal itself, plus the two AI endpoints that stream (reply, wrap-up).

import { getTemplate } from '../../journal/templates.js';
import { entryLockKey } from '../generation.js';
import { entryFilename, entryToMarkdown } from '../export.js';
import { HttpError, badRequest, notFound } from '../http.js';
import {
  bodyObject, idParam, localToday, optBool, optDate, optEnum, optLabels, optMood, optString,
  queryDate, queryInt, queryText, charCount,
} from '../validate.js';

const MAX_MESSAGE_CHARS = 20_000;
const MAX_SEARCH_RESULTS = 50;
const TIE_BATCH = 200;

/**
 * The text of a message from a request body: required, not blank, at most 20 000 characters. Stored trimmed.
 * @throws {HttpError} 400 for blank/non-text, 413 payload_too_large for over-long text
 */
function messageText(body) {
  const raw = body.content;
  if (typeof raw !== 'string') throw badRequest('content must be text.', { fields: { content: 'content is required and must be text.' } });
  // NUL characters are stripped by the database; a message made only of them would end up empty, so drop them first.
  const text = raw.replaceAll('\u0000', '').trim();
  if (text === '') throw badRequest('A message cannot be empty.', { fields: { content: 'content must not be empty.' } });
  if (charCount(text, MAX_MESSAGE_CHARS) > MAX_MESSAGE_CHARS) {
    throw new HttpError(413, 'payload_too_large', `A message can have at most ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters.`, {
      hint: 'Split it into two messages.',
      fields: { content: `content must be at most ${MAX_MESSAGE_CHARS} characters.` },
    });
  }
  return text;
}

/**
 * @param {ReturnType<import('../http.js').createRouter>} router
 * @param {{ db: object, gen: object, generations: object }} deps
 */
export function register(router, { db, gen, generations }) {
  function entryOr404(id) {
    const entry = db.entries.get(idParam(id, 'entry'));
    if (!entry) throw notFound('No such entry.');
    return entry;
  }

  /** A message of this entry, or 404 (a message id from another entry does not exist as far as this URL is concerned). */
  function messageOr404(entryId, messageId) {
    const message = db.messages.get(idParam(messageId, 'message'));
    if (!message || message.entryId !== entryId) throw notFound('No such message.');
    return message;
  }

  /**
   * One page of the list, never cutting a run of entries that share a createdAt in two. The client continues with
   * `before=<nextBefore>` only, which means "strictly older", so entries of the same timestamp left behind would
   * be skipped for good. db.entries.page() already keeps such a run together up to 500 extra rows; this finishes
   * longer ones (an import from a tool that stamps everything alike) by reading on past the page's last row.
   */
  function pageWithWholeTies(options) {
    const page = db.entries.page(options);
    if (page.nextBefore === null) return { entries: page.entries, nextBefore: null };
    const entries = [...page.entries];
    const boundary = page.nextBefore; // createdAt of the last row
    let size = 1; // the usual case is a clean boundary: one row tells
    for (;;) {
      const last = entries[entries.length - 1];
      const batch = db.entries.list({ ...options, limit: size, before: last.createdAt, beforeId: last.id });
      const ties = batch.filter((row) => row.createdAt === boundary);
      entries.push(...ties);
      if (ties.length < batch.length) return { entries, nextBefore: boundary }; // an older entry follows
      if (batch.length < size) return { entries, nextBefore: null }; // that was the end of the journal
      size = TIE_BATCH;
    }
  }

  router.add('GET', '/entries', (ctx) => {
    const { query } = ctx;
    const limit = queryInt(query, 'limit', { min: 1, max: 200, fallback: 30 });
    const filters = {
      mood: query.get('mood') || undefined,
      tag: queryText(query, 'tag', 100),
      from: queryDate(query, 'from'),
      to: queryDate(query, 'to'),
      pinned: query.get('pinned') || undefined,
    };
    const q = queryText(query, 'q', 500);
    if (q) {
      const hits = db.search(q, { limit: Math.min(limit, MAX_SEARCH_RESULTS), includePrivate: true, ...filters });
      const snippets = new Map(hits.map((h) => [h.entryId, h.snippet]));
      const entries = db.entries.summariesFor(hits.map((h) => h.entryId)).map((row) => ({ ...row, snippet: snippets.get(row.id) ?? '' }));
      ctx.json({ entries, nextBefore: null });
      return;
    }
    const page = pageWithWholeTies({
      limit,
      before: query.get('before') || undefined,
      beforeId: query.get('beforeId') || undefined,
      includePrivate: true,
      ...filters,
    });
    ctx.json({ entries: page.entries, nextBefore: page.nextBefore });
  });

  router.add('POST', '/entries', async (ctx) => {
    const body = bodyObject(await ctx.readJson());
    const templateId = optString(body, 'templateId', { max: 64, nullable: true });
    const template = templateId ? getTemplate(templateId) : null;
    if (templateId && !template) throw badRequest('Unknown guided journal template.', { fields: { templateId: 'is not a known template.' } });
    const kind = optEnum(body, 'kind', ['free', 'guided']);
    const title = optString(body, 'title', { max: 2000, nullable: true });
    const mood = optMood(body);
    const date = optDate(body, 'date') ?? localToday();
    const isPrivate = optBool(body, 'private');
    const content = body.content === undefined ? undefined : messageText(body);

    const fields = { date };
    if (template) {
      fields.templateId = template.id;
      fields.kind = 'guided';
    } else if (kind) {
      fields.kind = kind;
    }
    if (typeof title === 'string') fields.title = title;
    if (mood !== undefined) fields.mood = mood;
    if (isPrivate !== undefined) fields.private = isPrivate;

    const id = db.tx(() => {
      const entry = db.entries.create(fields);
      // A guided session opens with the template's own first question: no AI is involved.
      if (template) db.messages.add(entry.id, { role: 'assistant', content: template.opening, meta: { kind: 'prompt' } });
      if (content) db.messages.add(entry.id, { role: 'user', content });
      return entry.id;
    });
    ctx.json({ entry: db.entries.get(id), messages: db.messages.list(id) }, 201);
  });

  router.add('GET', '/entries/:id', (ctx) => {
    const entry = entryOr404(ctx.params.id);
    ctx.json({ entry, messages: db.messages.list(entry.id) });
  });

  router.add('PATCH', '/entries/:id', async (ctx) => {
    const id = idParam(ctx.params.id, 'entry');
    const body = bodyObject(await ctx.readJson());
    const patch = {};
    const set = (key, value) => { if (value !== undefined) patch[key] = value; };
    set('title', optString(body, 'title', { max: 2000 }));
    set('mood', optMood(body));
    set('tags', optLabels(body, 'tags'));
    set('emotions', optLabels(body, 'emotions'));
    set('private', optBool(body, 'private'));
    set('pinned', optBool(body, 'pinned'));
    set('date', optDate(body, 'date'));
    const entry = db.entries.update(id, patch);
    if (!entry) throw notFound('No such entry.');
    ctx.json({ entry });
  });

  router.add('DELETE', '/entries/:id', (ctx) => {
    const id = idParam(ctx.params.id, 'entry');
    generations.abort(entryLockKey(id)); // a reply still being written has nowhere to go
    if (!db.entries.delete(id)) throw notFound('No such entry.');
    ctx.noContent();
  });

  router.add('POST', '/entries/:id/messages', async (ctx) => {
    const entry = entryOr404(ctx.params.id);
    const content = messageText(bodyObject(await ctx.readJson()));
    const message = db.messages.add(entry.id, { role: 'user', content });
    ctx.json({ message, entry: db.entries.get(entry.id) }, 201);
  });

  router.add('PATCH', '/entries/:id/messages/:mid', async (ctx) => {
    const entry = entryOr404(ctx.params.id);
    const message = messageOr404(entry.id, ctx.params.mid);
    const content = messageText(bodyObject(await ctx.readJson()));
    const saved = content === message.content ? message : db.messages.update(message.id, { content, meta: { edited: true } });
    ctx.json({ message: saved, entry: db.entries.get(entry.id) });
  });

  router.add('DELETE', '/entries/:id/messages/:mid', (ctx) => {
    const entry = entryOr404(ctx.params.id);
    const message = messageOr404(entry.id, ctx.params.mid);
    db.messages.delete(message.id);
    ctx.json({ entry: db.entries.get(entry.id) });
  });

  router.add('POST', '/entries/:id/reply', async (ctx) => {
    const id = idParam(ctx.params.id, 'entry');
    const body = bodyObject(await ctx.readJson());
    const job = gen.prepareReply(id, { regenerate: optBool(body, 'regenerate') ?? false, today: optDate(body, 'today') });
    await gen.runJob(ctx.res, job);
  });

  router.add('POST', '/entries/:id/wrap-up', async (ctx) => {
    const id = idParam(ctx.params.id, 'entry');
    const body = bodyObject(await ctx.readJson());
    const job = gen.prepareWrapUp(id, { today: optDate(body, 'today') });
    await gen.runJob(ctx.res, job);
  });

  router.add('GET', '/entries/:id/export.md', (ctx) => {
    const entry = entryOr404(ctx.params.id);
    ctx.text(entryToMarkdown(entry, db.messages.list(entry.id)), 'text/markdown; charset=utf-8', entryFilename(entry));
  });
}
