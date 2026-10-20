import { Hono } from 'hono';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { summarizePeriod, SummaryRequest } from '../services/analyticssummary.js';
import { productAnalytics, ProductsExportQuery, productsCsv, ProductsQuery } from '../services/productanalytics.js';
import { bodyOf, queryOf } from './util.js';

/** Product analytics and the AI summary (permissions and limits in routes/spec.ts). Mounted at /analytics and, for the funnel variant, at /funnels. */
export function productAnalyticsRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.get('/products', async (c) => c.json(await productAnalytics(deps, authOf(c).workspaceId, queryOf(c, ProductsQuery))));
  r.get('/products/export', async (c) => c.body(await productsCsv(deps, authOf(c).workspaceId, queryOf(c, ProductsExportQuery)), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="products.csv"', 'cache-control': 'no-store' }));
  r.post('/summary', async (c) => c.json(await summarizePeriod(deps, authOf(c), await bodyOf(c, SummaryRequest))));
  return r;
}

export function funnelProductAnalyticsRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.get('/:id/analytics/products', async (c) => c.json(await productAnalytics(deps, authOf(c).workspaceId, queryOf(c, ProductsQuery), c.req.param('id'))));
  return r;
}
