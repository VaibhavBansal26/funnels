import { Hono } from 'hono';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import * as gr from '../services/googlereviews.js';
import { clientIp } from '../ratelimit/ip.js';
import { bodyOf } from './util.js';

/** Settings > Integrations > Google reviews, and the place lookups of the builder. Review content for pages is served by `GET /public/reviews/:token`. */
export function googleReviewsRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.get('/settings', async (c) => c.json(await gr.getSettingsView(deps, authOf(c).workspaceId)));
  r.put('/settings', async (c) => c.json(await gr.saveSettings(deps, authOf(c), await bodyOf(c, gr.SettingsInput), clientIp(c, deps.config))));
  r.post('/test', async (c) => c.json(await gr.testConnection(deps, authOf(c), await bodyOf(c, gr.TestInput))));
  r.post('/search', async (c) => c.json(await gr.searchPlaces(deps, authOf(c), await bodyOf(c, gr.SearchInput))));
  r.get('/places/:placeId', async (c) => {
    const id = gr.PlaceIdSchema.safeParse(c.req.param('placeId'));
    if (!id.success) return c.json({ error: { code: 'INVALID_PLACE', message: 'Invalid place id' } }, 400);
    return c.json(await gr.previewPlace(deps, authOf(c).workspaceId, id.data));
  });
  return r;
}
