import { Hono } from 'hono';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import * as leads from '../services/leads.js';
import * as orders from '../services/orders.js';
import { queryOf } from './util.js';

const csv = (body: string, name: string) =>
  new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' } });

export function leadRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.get('/', (c) => c.json(leads.listLeads(deps, authOf(c).workspaceId, queryOf(c, leads.LeadQuery))));
  r.get('/export', (c) => csv(leads.leadsCsv(deps, authOf(c).workspaceId, queryOf(c, leads.LeadQuery)), 'leads.csv'));
  return r;
}

export function orderRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.get('/', (c) => c.json(orders.listOrders(deps, authOf(c).workspaceId, queryOf(c, orders.OrderQuery))));
  r.get('/export', (c) => csv(orders.ordersCsv(deps, authOf(c).workspaceId, queryOf(c, orders.OrderQuery)), 'orders.csv'));
  r.get('/:id', (c) => c.json(orders.getOrder(deps, authOf(c).workspaceId, c.req.param('id'))));
  return r;
}
