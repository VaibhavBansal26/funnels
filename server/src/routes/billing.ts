import { Hono, type Context } from 'hono';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { clientIp } from '../ratelimit/ip.js';
import * as billing from '../services/billing.js';
import { finalizeSession, RefundInput, refundOrder } from '../services/stripepay.js';
import * as disputes from '../services/disputes.js';
import { receiveStripeWebhook } from '../services/stripewebhooks.js';
import { bodyOf, queryOf } from './util.js';

/** Billing and Stripe: workspace routes (permissions in routes/spec.ts) and the two webhook endpoints plus the visitor's checkout return, which are public. */
export function billingRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const ip = (c: Context) => clientIp(c, deps.config);
  const auth = authenticate(deps);

  // Public: authenticated by Stripe's signature over the raw body, or by re-reading the session from Stripe.
  r.post('/stripe/webhook', async (c) => c.json(await receiveStripeWebhook(deps, 'platform', await c.req.text(), c.req.header('stripe-signature'))));
  r.post('/stripe/connect-webhook', async (c) => c.json(await receiveStripeWebhook(deps, 'connect', await c.req.text(), c.req.header('stripe-signature'))));
  r.get('/public/checkout/return', async (c) => {
    const cs = c.req.query('cs') ?? '';
    const done = /^cs_[A-Za-z0-9_]{8,200}$/.test(cs) ? await finalizeSession(deps, cs).catch((e) => (deps.log.error('checkout return failed', { error: (e as Error).message }), null)) : null;
    if (!done) return c.html('<!doctype html><meta charset="utf-8"><title>Payment</title><p>We could not find this payment. If you were charged you will receive a confirmation by email; otherwise go back and try again.</p>', 404);
    return c.redirect(done.paid ? done.nextUrl : done.cancelUrl, 303);
  });

  r.get('/billing', auth, async (c) => c.json(await billing.overview(deps, authOf(c).workspaceId)));
  r.post('/billing/subscribe', auth, async (c) => c.json(await billing.startSubscription(deps, authOf(c), (await bodyOf(c, billing.SubscribeInput)).plan, ip(c))));
  r.post('/billing/portal', auth, async (c) => c.json(await billing.openPortal(deps, authOf(c))));
  r.get('/billing/connect', auth, async (c) => c.json(await billing.connectStatus(deps, authOf(c).workspaceId)));
  r.post('/billing/connect/start', auth, async (c) => c.json(await billing.startConnect(deps, authOf(c), ip(c))));
  r.post('/billing/connect/disconnect', auth, async (c) => {
    await billing.disconnect(deps, authOf(c), ip(c));
    return c.body(null, 204);
  });
  r.post('/orders/:id/refund', auth, async (c) => c.json(await refundOrder(deps, authOf(c), c.req.param('id'), await bodyOf(c, RefundInput, { optional: true }), ip(c))));
  r.get('/disputes', auth, async (c) => c.json(await disputes.listDisputes(deps, authOf(c).workspaceId, queryOf(c, disputes.DisputeQuery))));
  return r;
}
