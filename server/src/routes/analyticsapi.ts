import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { schemaDocument } from '../analyticsapi/schemas.js';
import * as api from '../services/analyticsapi.js';
import * as keys from '../services/apikeys.js';
import { applyKeyLayers } from '../ratelimit/http.js';
import { clientIp } from '../ratelimit/ip.js';
import { bodyOf, queryOf } from './util.js';

const API = 'apiAuth';
const apiOf = (c: Context): keys.ApiAuth => c.get(API as never) as keys.ApiAuth;

/**
 * Analytics API v1 under `/api/v1`: the read and export routes take an API key (`Authorization: Bearer fa_live_...`), key management and the identity pepper
 * take a signed-in person with the permission declared in routes/spec.ts. Each key route names the scope its key must carry.
 */
export function analyticsApiRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const key = (scope: keys.Scope): MiddlewareHandler => async (c, next) => {
    const who = await keys.authenticateKey(deps, c, scope);
    c.set(API as never, who as never);
    await applyKeyLayers(deps, c, who);
    await next();
  };
  const read = key('analytics:read');
  const exportKey = key('analytics:export');
  const ip = (c: Context) => clientIp(c, deps.config);
  const gz = promisify(gzip);
  // The global compressor only knows a fixed list of content types and NDJSON is not on it, so exports are gzipped here when the client accepts it.
  const ndjson = async (c: Context, page: { body: string; nextCursor: string | null; rows: number }) => {
    const headers: Record<string, string> = { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', vary: 'accept-encoding', 'x-row-count': String(page.rows), ...(page.nextCursor ? { 'x-next-cursor': page.nextCursor } : {}) };
    if (page.body.length > 1024 && /\bgzip\b/i.test(c.req.header('accept-encoding') ?? '')) {
      headers['content-encoding'] = 'gzip';
      return c.body((await gz(page.body)) as unknown as ArrayBuffer, 200, headers);
    }
    return c.body(page.body, 200, headers);
  };

  r.get('/analytics/funnels', read, async (c) => c.json(await api.listFunnels(deps, apiOf(c), queryOf(c, api.ApiListQuery))));
  r.get('/analytics/funnels/:id/steps', read, async (c) => c.json(await api.funnelSteps(deps, apiOf(c), c.req.param('id'), queryOf(c, api.ApiRangeQuery))));
  r.get('/analytics/funnels/:id/timeseries', read, async (c) => c.json(await api.funnelTimeseries(deps, apiOf(c), c.req.param('id'), queryOf(c, api.TimeseriesQuery))));
  r.get('/analytics/schema', read, (c) => c.json(schemaDocument()));
  r.get('/analytics/export/events', exportKey, async (c) => ndjson(c, await api.exportEvents(deps, apiOf(c), queryOf(c, api.ExportQuery))));
  r.get('/analytics/export/leads', exportKey, async (c) => ndjson(c, await api.exportLeads(deps, apiOf(c), queryOf(c, api.ExportQuery))));
  r.get('/analytics/export/funnel-structure', exportKey, async (c) => c.json(await api.funnelStructure(deps, apiOf(c), queryOf(c, api.ApiListQuery))));

  const auth = authenticate(deps);
  r.get('/api-keys', auth, async (c) => c.json(await keys.listKeys(deps, authOf(c).workspaceId)));
  r.post('/api-keys', auth, async (c) => c.json(await keys.createKey(deps, authOf(c), await bodyOf(c, keys.ApiKeyInput), ip(c)), 201));
  r.patch('/api-keys/:id', auth, async (c) => c.json(await keys.updateKey(deps, authOf(c), c.req.param('id'), await bodyOf(c, keys.ApiKeyPatch), ip(c))));
  r.delete('/api-keys/:id', auth, async (c) => {
    await keys.revokeKey(deps, authOf(c), c.req.param('id'), ip(c));
    return c.body(null, 204);
  });
  r.get('/analytics/identity-pepper', auth, async (c) => c.json(await api.identityPepper(deps, authOf(c).workspaceId)));
  r.post('/analytics/identity-pepper/rotate', auth, async (c) => c.json(await api.rotatePepper(deps, authOf(c), ip(c))));
  return r;
}
