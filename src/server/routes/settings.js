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
    // Merge over the seeded settings so that environment defaults a person never changed stay as they were shown.
    const { settings, errors } = mergeSettings(ai.loadSettings(), patch);
    if (Object.keys(errors).length > 0) {
      throw new HttpError(400, 'invalid_settings', 'Some settings are not valid.', {
        fields: errors,
        hint: 'Fix the highlighted fields and save again.',
      });
    }
    db.settings.set(settings);
    // Answer with what GET will return and what the providers will use: the saved document with the environment's
    // URL/model seeds applied, not the bare saved one (they differ when a saved value equals the built-in default).
    ctx.json(ai.publicSettings());
  });
}
