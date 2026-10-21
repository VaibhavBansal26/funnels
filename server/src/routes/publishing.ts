import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { clientIp } from '../ratelimit/ip.js';
import * as publishing from '../services/publishing.js';
import { bodyOf, queryOf } from './util.js';

export const DisconnectQuery = z.object({ force: z.enum(['true', 'false']).optional() });

/** Publishing (Cloudflare Pages). Per-route authentication, because this router is mounted at the API root; permissions are declared in routes/spec.ts. */
export function publishingRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const auth = authenticate(deps);
  const ws = (c: Context<AppEnv>) => authOf(c).workspaceId;
  const ip = (c: Context<AppEnv>) => clientIp(c, deps.config);
  const fid = (c: Context<AppEnv>) => c.req.param('id') as string;

  r.get('/publishing/connection', auth, async (c) => c.json(await publishing.getConnection(deps, ws(c))));
  r.put('/publishing/connection', auth, async (c) => c.json(await publishing.connect(deps, authOf(c), await bodyOf(c, publishing.ConnectInput), ip(c))));
  r.post('/publishing/connection/verify', auth, async (c) => c.json(await publishing.verifyConnection(deps, authOf(c))));
  r.delete('/publishing/connection', auth, async (c) => {
    await publishing.disconnect(deps, authOf(c), queryOf(c, DisconnectQuery).force === 'true', ip(c));
    return c.body(null, 204);
  });

  r.get('/funnels/:id/publishing', auth, async (c) => c.json(await publishing.getSettings(deps, ws(c), fid(c))));
  r.put('/funnels/:id/publishing', auth, async (c) => c.json(await publishing.updateSettings(deps, authOf(c), fid(c), await bodyOf(c, publishing.SettingsInput), ip(c))));
  r.post('/funnels/:id/publishing/redeploy', auth, async (c) => c.json(await publishing.redeploy(deps, authOf(c), fid(c), ip(c)), 202));
  r.post('/funnels/:id/publishing/unpublish', auth, async (c) => c.json(await publishing.unpublish(deps, authOf(c), fid(c), await bodyOf(c, publishing.UnpublishInput, { optional: true }), ip(c))));
  r.post('/funnels/:id/publishing/rollback/:did', auth, async (c) => c.json(await publishing.rollback(deps, authOf(c), fid(c), c.req.param('did'), ip(c))));
  r.post('/funnels/:id/publishing/domain/refresh', auth, async (c) => c.json(await publishing.refreshDomain(deps, ws(c), fid(c))));
  r.get('/funnels/:id/publishing/deployments', auth, async (c) => c.json(await publishing.listDeployments(deps, ws(c), fid(c))));
  r.get('/funnels/:id/publishing/deployments/:did', auth, async (c) => c.json(await publishing.getDeployment(deps, ws(c), fid(c), c.req.param('did'))));
  return r;
}
