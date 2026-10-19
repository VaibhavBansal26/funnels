import { Hono, type Context } from 'hono';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import * as leads from '../services/leads.js';
import * as orders from '../services/orders.js';
import { denyError } from '../ratelimit/response.js';
import { principalFor } from '../ratelimit/http.js';
import { queryOf } from './util.js';

/** Holds an export slot (`api.export`) until the stream is finished, cancelled or fails; refuses with 503 + Retry-After when the workspace is at its cap. */
async function exportSlot(deps: Deps, c: Context<AppEnv>) {
  const h = await deps.limiter.acquire('api.export', principalFor(c, deps, authOf(c)));
  if (!h.decision.allowed) throw denyError(h.decision);
  return h;
}

function releasing(body: ReadableStream<Uint8Array>, release: () => Promise<void>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          await release();
        } else controller.enqueue(value);
      } catch (e) {
        await release();
        controller.error(e);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await release();
    },
  });
}

const csv = (body: ReadableStream<Uint8Array>, name: string) =>
  new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' } });

export function leadRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.get('/', async (c) => c.json(await leads.listLeads(deps, authOf(c).workspaceId, queryOf(c, leads.LeadQuery))));
  r.get('/export', async (c) => {
    const slot = await exportSlot(deps, c);
    return csv(releasing(leads.leadsCsvStream(deps, authOf(c).workspaceId, queryOf(c, leads.LeadQuery)), slot.release), 'leads.csv');
  });
  return r;
}

export function orderRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.get('/', async (c) => c.json(await orders.listOrders(deps, authOf(c).workspaceId, queryOf(c, orders.OrderQuery))));
  r.get('/export', async (c) => {
    const slot = await exportSlot(deps, c);
    return csv(releasing(orders.ordersCsvStream(deps, authOf(c).workspaceId, queryOf(c, orders.OrderQuery)), slot.release), 'orders.csv');
  });
  r.get('/:id', async (c) => c.json(await orders.getOrder(deps, authOf(c).workspaceId, c.req.param('id'))));
  return r;
}
