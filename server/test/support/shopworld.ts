import { expect } from 'vitest';
import { createPageBuilder } from '../../src/pagemodel/shared/build.js';
import type { Harness } from '../helpers.js';

export const DESKTOP = { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' };

/** A Stripe-shaped publishable key built at runtime (never a literal in the repository). */
export const testPublishableKey = (): string => ['pk', 'test', 'Fake0123456789abcdef'].join('_');

let op = 0;
export const opId = () => `op_${Date.now().toString(36)}_${++op}`;

/**
 * A store funnel built through the real API: a catalog with two USD products, a EUR product, a subscription and a USD bump; steps
 * Shop (Add to cart x3 + Cart count), Cart (Cart block pointing at Pay), Pay (Payment form for the cart + an order bump), Thanks.
 */
export async function shop(h: Harness, token: string, opts: { payment?: Record<string, unknown>; upsell?: boolean } = {}) {
  const product = async (name: string, amount: number, currency = 'USD', extra: Record<string, unknown> = {}) => {
    const r = await h.call('POST', '/api/products', { token, body: { name, price: { currency, amount, ...extra }, ...(extra.interval ? { type: 'subscription' } : {}) } });
    expect(r.status, r.text).toBe(201);
    return { productId: r.json.id as string, priceId: r.json.prices[0].id as string, name };
  };
  const mug = await product('Mug', 24);
  const tee = await product('T-shirt', 12);
  const euro = await product('Euro poster', 10, 'EUR');
  const club = await product('Coffee club', 9, 'USD', { interval: 'month' });
  const wrap = await product('Gift wrap', 5);
  const up = opts.upsell ? await product('Grinder', 40) : null;

  const f = (await h.call('POST', '/api/funnels', { token, body: { name: 'Store' } })).json;
  const first = (await h.call('GET', `/api/funnels/${f.id}/steps`, { token })).json.data[0];
  const add = async (name: string, path: string) => (await h.call('POST', `/api/funnels/${f.id}/steps`, { token, body: { name, base_path: path } })).json;
  const cartStep = await add('Cart', '/cart');
  const payStep = await add('Pay', '/pay');
  const upStep = opts.upsell ? await add('Upsell', '/upsell') : null;
  const thanks = await add('Thanks', '/thanks');
  const save = async (stepId: string, build: (pm: ReturnType<typeof createPageBuilder>) => unknown[]) => {
    const pm = createPageBuilder('s');
    const project = pm.project([pm.section([pm.stack([pm.heading('Page', { level: 1 }), ...(build(pm) as never[])])])]);
    const cur = (await h.call('GET', `/api/funnels/${f.id}/steps/${stepId}/page`, { token })).json;
    const r = await h.call('PUT', `/api/funnels/${f.id}/steps/${stepId}/page`, { token, body: { doc: { version: 2, project }, version: cur.version } });
    expect(r.status, r.text).toBe(200);
    return (await h.call('GET', `/api/funnels/${f.id}/steps/${stepId}/page`, { token })).json.doc;
  };
  const shopDoc = await save(first.id, (pm) => [
    pm.cartAdd('atcmug', { productName: mug.name, price: 24, productId: mug.productId, priceId: mug.priceId, quantity: { enabled: true, min: 1, max: 5, default: 1 } }),
    pm.cartAdd('atctee', { productName: tee.name, price: 12, productId: tee.productId, priceId: tee.priceId }),
    pm.cartAdd('atceur', { productName: euro.name, price: 10, currency: 'EUR', productId: euro.productId, priceId: euro.priceId }),
    pm.cartAdd('atcclub', { productName: club.name, price: 9, productId: club.productId, priceId: club.priceId }),
    pm.cartCount({ cartStepId: cartStep.id }),
  ]);
  await save(cartStep.id, (pm) => [pm.cart('cartbox', { checkoutStepId: payStep.id })]);
  const payDoc = await save(payStep.id, (pm) => [
    pm.checkout('bumpwrap', { productName: wrap.name, price: 5, productId: wrap.productId, priceId: wrap.priceId, orderBump: true }),
    pm.payment('payform', { source: 'cart', mode: 'embedded', ...(opts.payment ?? {}) }),
  ]);
  if (upStep && up) await save(upStep.id, (pm) => [pm.checkout('upsell', { productName: up.name, price: 40, productId: up.productId, priceId: up.priceId, oneClickUpsell: true })]);
  await save(thanks.id, (pm) => [pm.text('Thank you')]);
  expect(shopDoc.commerce.map((b: { id: string }) => b.id)).toEqual(['atcmug', 'atctee', 'atceur', 'atcclub']);
  expect(payDoc.commerce.map((b: { id: string }) => b.id)).toEqual(['payform']);

  const base = { funnelId: f.id as string, shopStepId: first.id as string, cartStepId: cartStep.id as string, payStepId: payStep.id as string, thanksStepId: thanks.id as string, upsellStepId: upStep?.id as string | undefined };
  const visitorId = `v${Math.random().toString(36).slice(2, 12)}`;
  let token$: string | undefined;
  const pub = async (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const r = await h.call('POST', path, { body: { visitorId, token: token$, ...body }, headers: { ...DESKTOP, ...headers } });
    if (r.json?.token) token$ = r.json.token;
    return r;
  };
  return {
    ...base, f, mug, tee, euro, club, wrap, up, visitorId,
    get cartToken() { return token$; },
    set cartToken(t: string | undefined) { token$ = t; },
    add: (block: string, extra: Record<string, unknown> = {}) => pub(`/api/public/cart/${f.id}/${first.id}/${block}/add`, { opId: opId(), ...extra }),
    view: (extra: Record<string, unknown> = {}) => pub(`/api/public/cart/${f.id}/view`, { cartBlock: { stepId: cartStep.id, blockId: 'cartbox' }, ...extra }),
    update: (extra: Record<string, unknown>) => pub(`/api/public/cart/${f.id}/update`, { opId: opId(), cartBlock: { stepId: cartStep.id, blockId: 'cartbox' }, ...extra }),
    quote: (extra: Record<string, unknown> = {}) => pub(`/api/public/pay/${f.id}/${payStep.id}/payform`, extra),
    complete: (extra: Record<string, unknown>) => pub('/api/public/pay/complete', extra),
  };
}

export const contact = { email: 'shopper@example.com', name: 'Sam Shopper' };
