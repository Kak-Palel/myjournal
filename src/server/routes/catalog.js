// GET /api/catalog : guided templates, personas and the prompt of the day.

import { publicPersonas } from '../../journal/personas.js';
import { TEMPLATES, promptOfTheDay, publicTemplate } from '../../journal/templates.js';
import { localToday, queryDate } from '../validate.js';

/** @param {ReturnType<import('../http.js').createRouter>} router */
export function register(router) {
  router.add('GET', '/catalog', (ctx) => {
    const date = queryDate(ctx.query, 'date') || localToday();
    ctx.json({
      templates: TEMPLATES.map(publicTemplate),
      personas: publicPersonas(),
      promptOfTheDay: promptOfTheDay(date),
    });
  });
}
