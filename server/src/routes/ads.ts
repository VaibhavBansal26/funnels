import { Hono, type Context } from 'hono';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { badRequest } from '../errors.js';
import { clientIp } from '../ratelimit/ip.js';
import * as spend from '../services/adspend.js';
import * as report from '../services/adsreport.js';
import { retryDelivery } from '../services/conversions.js';
import * as integrations from '../services/integrations.js';
import * as pixels from '../services/pixels.js';
import { bodyOf, queryOf } from './util.js';

/**
 * Ads: integrations (server-side conversions), pixels, ad spend and the attribution / performance reports. Authentication is per route (not `use('*')`) because this
 * router is mounted at the API root next to public routes; the permission each route needs is declared in routes/spec.ts and enforced by authenticate().
 */
export function adsRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const auth = authenticate(deps);
  const ws = (c: Context<AppEnv>) => authOf(c).workspaceId;
  const ip = (c: Context<AppEnv>) => clientIp(c, deps.config);

  // integrations
  r.get('/integrations', auth, async (c) => c.json(await integrations.listIntegrations(deps, ws(c))));
  r.post('/integrations', auth, async (c) => c.json(await integrations.createIntegration(deps, authOf(c), await bodyOf(c, integrations.IntegrationInput), ip(c)), 201));
  r.patch('/integrations/:id', auth, async (c) => c.json(await integrations.updateIntegration(deps, authOf(c), c.req.param('id'), await bodyOf(c, integrations.IntegrationPatch), ip(c))));
  r.delete('/integrations/:id', auth, async (c) => {
    await integrations.deleteIntegration(deps, authOf(c), c.req.param('id'), ip(c));
    return c.body(null, 204);
  });
  r.post('/integrations/:id/test', auth, async (c) => c.json(await integrations.sendTestEvent(deps, authOf(c), c.req.param('id'), ip(c))));
  r.get('/integrations/:id/deliveries', auth, async (c) => c.json(await integrations.listDeliveries(deps, ws(c), c.req.param('id'), queryOf(c, integrations.DeliveryQuery))));
  r.post('/integrations/deliveries/:did/retry', auth, async (c) => c.json(await retryDelivery(deps, authOf(c), c.req.param('did'), ip(c))));

  // pixels and consent
  const body = (c: Context<AppEnv>) => bodyOf(c, pixels.PixelSettings);
  r.get('/pixels', auth, async (c) => c.json(await pixels.getPixels(deps, ws(c), 'workspace', null, null)));
  r.put('/pixels', auth, async (c) => c.json(await pixels.setPixels(deps, authOf(c), 'workspace', null, null, await body(c), ip(c))));
  r.get('/funnels/:id/pixels', auth, async (c) => c.json(await pixels.getPixels(deps, ws(c), 'funnel', c.req.param('id'), null)));
  r.put('/funnels/:id/pixels', auth, async (c) => c.json(await pixels.setPixels(deps, authOf(c), 'funnel', c.req.param('id'), null, await body(c), ip(c))));
  r.get('/funnels/:id/steps/:sid/pixels', auth, async (c) => c.json(await pixels.getPixels(deps, ws(c), 'step', c.req.param('id'), c.req.param('sid'))));
  r.put('/funnels/:id/steps/:sid/pixels', auth, async (c) => c.json(await pixels.setPixels(deps, authOf(c), 'step', c.req.param('id'), c.req.param('sid'), await body(c), ip(c))));

  // reports
  const csv = (text: string, name: string) => new Response(text, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' } });
  r.get('/ads/performance', auth, async (c) => c.json(await report.adsPerformance(deps, ws(c), queryOf(c, report.AdsQuery))));
  r.get('/ads/performance/export', auth, async (c) => csv(report.performanceCsv(await report.adsPerformance(deps, ws(c), queryOf(c, report.AdsQuery))), 'ads-performance.csv'));
  r.get('/ads/attribution', auth, async (c) => c.json(await report.attributionReport(deps, ws(c), queryOf(c, report.AttributionQuery))));
  r.get('/ads/attribution/export', auth, async (c) => csv(report.attributionCsv(await report.attributionReport(deps, ws(c), queryOf(c, report.AttributionQuery))), 'attribution.csv'));

  // spend
  r.get('/ads/spend', auth, async (c) => c.json(await spend.listSpend(deps, ws(c), queryOf(c, spend.SpendQuery))));
  r.post('/ads/spend', auth, async (c) => c.json(await spend.saveSpend(deps, authOf(c), await bodyOf(c, spend.SpendInput), ip(c))));
  r.delete('/ads/spend/:id', auth, async (c) => {
    await spend.deleteSpend(deps, authOf(c), c.req.param('id'), ip(c));
    return c.body(null, 204);
  });
  r.post('/ads/spend/import', auth, async (c) => {
    const type = c.req.header('content-type') ?? '';
    if (!/^text\/(csv|plain)|^application\/csv/i.test(type)) throw badRequest('UNSUPPORTED_MEDIA_TYPE', 'Send the file as the request body with Content-Type: text/csv');
    return c.json(await spend.importSpend(deps, authOf(c), await c.req.text(), queryOf(c, spend.ImportQuery), ip(c)));
  });
  r.get('/ads/mappings', auth, async (c) => c.json(await spend.listMappings(deps, ws(c))));
  r.put('/ads/mappings', auth, async (c) => c.json(await spend.saveMapping(deps, authOf(c), await bodyOf(c, spend.MapInput), ip(c))));
  r.delete('/ads/mappings/:id', auth, async (c) => {
    await spend.deleteMapping(deps, authOf(c), c.req.param('id'), ip(c));
    return c.body(null, 204);
  });
  return r;
}
