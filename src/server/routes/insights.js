// /api/insights : numbers for the Insights screen and the AI weekly reflection.

import { computeOverview } from '../../journal/insights.js';
import { notFound } from '../http.js';
import { bodyObject, idParam, localToday, optDate, optInt, queryDate, queryInt } from '../validate.js';

/**
 * @param {ReturnType<import('../http.js').createRouter>} router
 * @param {{ db: object, gen: object }} deps
 */
export function register(router, { db, gen }) {
  router.add('GET', '/insights/overview', (ctx) => {
    const today = queryDate(ctx.query, 'today') ?? localToday();
    const days = queryInt(ctx.query, 'days', { min: 1, max: 3660, fallback: 90 });
    // Every entry counts for the person's own numbers, private ones included.
    ctx.json(computeOverview({ entries: db.entries.rowsForInsights({}), today, days }));
  });

  router.add('GET', '/insights/reports', (ctx) => ctx.json({ reports: db.reports.list() }));

  router.add('DELETE', '/insights/reports/:id', (ctx) => {
    if (!db.reports.delete(idParam(ctx.params.id, 'report'))) throw notFound('No such report.');
    ctx.noContent();
  });

  router.add('POST', '/insights/weekly', async (ctx) => {
    const body = bodyObject(await ctx.readJson());
    const job = gen.prepareWeekly({
      today: optDate(body, 'today') ?? localToday(),
      days: optInt(body, 'days', { min: 1, max: 366 }) ?? 7,
    });
    await gen.runJob(ctx.res, job);
  });
}
