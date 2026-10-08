// /api/data : stats, export, import and wipe.

import { journalToMarkdown } from '../export.js';
import { badRequest } from '../http.js';
import { bodyObject, localToday, optBool } from '../validate.js';

/**
 * @param {ReturnType<import('../http.js').createRouter>} router
 * @param {{ db: object, config: object, generations: object }} deps
 */
export function register(router, { db, config, generations }) {
  router.add('GET', '/data/stats', (ctx) => ctx.json(db.stats()));

  router.add('GET', '/data/export', (ctx) => {
    const format = ctx.query.get('format') || 'json';
    if (format !== 'json' && format !== 'markdown') {
      throw badRequest('format must be json or markdown.', { fields: { format: 'must be json or markdown.' } });
    }
    const doc = db.exportAll(); // never contains settings or API keys
    const stamp = localToday();
    if (format === 'json') {
      ctx.text(JSON.stringify(doc, null, 2), 'application/json; charset=utf-8', `myjournal-export-${stamp}.json`);
    } else {
      ctx.text(journalToMarkdown(doc), 'text/markdown; charset=utf-8', `myjournal-export-${stamp}.md`);
    }
  });

  router.add('POST', '/data/import', async (ctx) => {
    const doc = await ctx.readJson({ expect: 'object', allowEmpty: false });
    const { imported, skipped } = db.importAll(doc); // a DbError 'invalid_import' becomes a 400
    ctx.json({ imported, skipped });
  }, { bodyLimit: config.maxImportBytes });

  router.add('POST', '/data/wipe', async (ctx) => {
    const body = bodyObject(await ctx.readJson());
    if (body.confirm !== 'DELETE') {
      throw badRequest('Type DELETE to confirm.', { fields: { confirm: 'must be the word DELETE.' } });
    }
    const includeSettings = optBool(body, 'includeSettings') ?? false;
    generations.abortAll(); // nothing may keep writing into a journal that is being emptied
    db.wipe({ includeSettings });
    ctx.json({ ok: true });
  });
}
