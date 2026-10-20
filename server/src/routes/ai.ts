import { requireFlag } from '../services/flags.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import * as ai from '../ai/service.js';
import type { Deps } from '../deps.js';
import { AppError } from '../errors.js';
import { bodyOf } from './util.js';

export function aiRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.use('*', async (c, next) => {
    await requireFlag(deps, authOf(c).workspaceId, 'ai_assistant');
    await next();
  });
  r.use('*', bodyLimit({ maxSize: 256 * 1024, onError: () => { throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large'); } }));
  r.get('/status', async (c) => c.json(await ai.usage(deps, authOf(c).workspaceId)));
  r.post('/funnel', async (c) => c.json(await ai.generateFunnel(deps, authOf(c), await bodyOf(c, ai.FunnelRequest)), 201));
  r.post('/rewrite', async (c) => c.json(await ai.rewriteCopy(deps, authOf(c), await bodyOf(c, ai.RewriteRequest))));
  r.post('/headlines', async (c) => c.json(await ai.headlineVariants(deps, authOf(c), await bodyOf(c, ai.HeadlineRequest))));
  r.post('/insights', async (c) => c.json(await ai.analyticsInsights(deps, authOf(c), await bodyOf(c, ai.InsightRequest))));
  r.post('/alt-text', async (c) => c.json(await ai.altText(deps, authOf(c), await bodyOf(c, ai.AltTextRequest))));
  return r;
}
