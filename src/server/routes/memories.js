// /api/memories : short durable facts about the person, always visible, editable and deletable.

import { notFound } from '../http.js';
import { bodyObject, idParam, optBool, reqString, optString } from '../validate.js';

const MAX_MEMORY_CHARS = 300;

/**
 * @param {ReturnType<import('../http.js').createRouter>} router
 * @param {{ db: object }} deps
 */
export function register(router, { db }) {
  router.add('GET', '/memories', (ctx) => ctx.json({ memories: db.memories.list() }));

  router.add('POST', '/memories', async (ctx) => {
    const body = bodyObject(await ctx.readJson());
    const text = reqString(body, 'text', { max: MAX_MEMORY_CHARS });
    const memory = db.memories.create({ text, pinned: optBool(body, 'pinned') ?? false });
    ctx.json({ memory }, 201);
  });

  router.add('POST', '/memories/clear', (ctx) => {
    const removed = db.memories.clear();
    db.scrub();
    ctx.json({ ok: true, removed });
  });

  router.add('PATCH', '/memories/:id', async (ctx) => {
    const id = idParam(ctx.params.id, 'memory');
    const body = bodyObject(await ctx.readJson());
    const patch = {};
    const text = optString(body, 'text', { max: MAX_MEMORY_CHARS, min: 1 });
    if (text !== undefined) patch.text = text;
    const pinned = optBool(body, 'pinned');
    if (pinned !== undefined) patch.pinned = pinned;
    const memory = db.memories.update(id, patch);
    if (!memory) throw notFound('No such memory.');
    ctx.json({ memory });
  });

  router.add('DELETE', '/memories/:id', (ctx) => {
    if (!db.memories.delete(idParam(ctx.params.id, 'memory'))) throw notFound('No such memory.');
    db.scrub();
    ctx.noContent();
  });
}
