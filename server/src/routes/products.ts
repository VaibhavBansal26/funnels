import { Hono, type Context } from 'hono';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { clientIp } from '../ratelimit/ip.js';
import * as catalog from '../services/catalog.js';
import { syncAll, syncProduct } from '../services/catalogsync.js';
import { paymentsStatus } from '../services/payments.js';
import { PaymentSettingsPatch, updatePaymentSettings } from '../services/paymentsettings.js';
import { bodyOf, queryOf } from './util.js';

/** The product catalog and the payments screen (permissions and limits in routes/spec.ts). */
export function productRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  const ws = (c: Context<AppEnv>) => authOf(c).workspaceId;
  const ip = (c: Context<AppEnv>) => clientIp(c, deps.config);
  r.get('/', async (c) => c.json(await catalog.listProducts(deps, ws(c), queryOf(c, catalog.ProductQuery))));
  r.post('/', async (c) => c.json(await catalog.createProduct(deps, authOf(c), await bodyOf(c, catalog.ProductInput), ip(c)), 201));
  r.post('/sync', async (c) => c.json(await syncAll(deps, ws(c), authOf(c).userId)));
  r.get('/:id', async (c) => c.json(await catalog.getProduct(deps, ws(c), c.req.param('id'))));
  r.patch('/:id', async (c) => c.json(await catalog.updateProduct(deps, authOf(c), c.req.param('id'), await bodyOf(c, catalog.ProductPatch), ip(c))));
  r.post('/:id/archive', async (c) => c.json(await catalog.setProductStatus(deps, authOf(c), c.req.param('id'), 'archived', ip(c))));
  r.post('/:id/restore', async (c) => c.json(await catalog.setProductStatus(deps, authOf(c), c.req.param('id'), 'active', ip(c))));
  r.post('/:id/sync', async (c) => {
    await catalog.requireProductRow(deps, ws(c), c.req.param('id'));
    const result = await syncProduct(deps, ws(c), c.req.param('id'));
    return c.json({ result, product: await catalog.getProduct(deps, ws(c), c.req.param('id')) });
  });
  r.post('/:id/prices', async (c) => c.json(await catalog.addPrice(deps, authOf(c), c.req.param('id'), await bodyOf(c, catalog.PriceInput), ip(c)), 201));
  r.post('/:id/prices/:priceId/replace', async (c) => c.json(await catalog.replacePrice(deps, authOf(c), c.req.param('id'), c.req.param('priceId'), await bodyOf(c, catalog.PriceInput), ip(c))));
  r.patch('/:id/prices/:priceId', async (c) => c.json(await catalog.patchPrice(deps, ws(c), c.req.param('id'), c.req.param('priceId'), await bodyOf(c, catalog.PricePatch))));
  r.post('/:id/prices/:priceId/archive', async (c) => c.json(await catalog.archivePrice(deps, authOf(c), c.req.param('id'), c.req.param('priceId'), ip(c))));
  return r;
}

export function paymentRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.get('/status', async (c) => c.json(await paymentsStatus(deps, authOf(c).workspaceId)));
  r.patch('/settings', async (c) => c.json(await updatePaymentSettings(deps, authOf(c), await bodyOf(c, PaymentSettingsPatch), clientIp(c, deps.config))));
  return r;
}
