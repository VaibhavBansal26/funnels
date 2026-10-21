import { requireFlag } from '../services/flags.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import * as ai from '../ai/service.js';
import * as build from '../ai/builder/service.js';
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
  // Multi-stage funnel builder (docs/AI-BUILDER.md): start returns 202 at once; progress arrives on the SSE stream as `ai.build` events and from GET.
  r.post('/builds', async (c) => c.json(await build.startBuild(deps, authOf(c), await bodyOf(c, build.BuildRequest)), 202));
  r.get('/builds', async (c) => c.json(await build.listBuilds(deps, authOf(c).workspaceId, Number(c.req.query('limit') ?? 20) || 20)));
  r.get('/builds/:id', async (c) => c.json(await build.getBuild(deps, authOf(c).workspaceId, c.req.param('id'))));
  r.post('/builds/:id/cancel', async (c) => c.json(await build.cancelBuild(deps, authOf(c), c.req.param('id'))));
  r.post('/builds/:id/steps/:key/regenerate', async (c) => c.json(await build.regenerateStep(deps, authOf(c), c.req.param('id'), c.req.param('key'), await bodyOf(c, build.RegenerateRequest))));
  return r;
}
