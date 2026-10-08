// GET/PUT /api/settings

import { mergeSettings } from '../../settings.js';
import { HttpError } from '../http.js';

/**
 * @param {ReturnType<import('../http.js').createRouter>} router
 * @param {{ db: object, ai: ReturnType<import('../ai-service.js').createAiService> }} deps
 */
export function register(router, { db, ai }) {
  router.add('GET', '/settings', (ctx) => ctx.json(ai.publicSettings()));

  router.add('PUT', '/settings', async (ctx) => {
    const patch = await ctx.readJson({ expect: 'any' });
    // Merge over the settings in force. On a fresh install those carry the environment's URL/model seeds, so this
    // first Save writes them into the document exactly as the person saw them; after that the environment is out of it.
    const { settings, errors } = mergeSettings(ai.loadSettings(), patch);
    if (Object.keys(errors).length > 0) {
      throw new HttpError(400, 'invalid_settings', 'Some settings are not valid.', {
        fields: errors,
        hint: 'Fix the highlighted fields and save again.',
      });
    }
    db.settings.set(settings);
    // Answer with what GET will return and what the providers will use.
    ctx.json(ai.publicSettings());
  });
}
