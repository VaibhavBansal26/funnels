import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { STRIPE_CSP, cspFor, withPaymentHosts } from '../src/publish/bundle.js';
import { activeDomain } from './helpers.js';
import { contact, shop, testPublishableKey } from './support/shopworld.js';
import { world } from './support/stripeworld.js';

// The embedded Payment form with Stripe (docs/STRIPE.md#embedded-payment-form), against the in-process fake of the Stripe API. NOT run against real Stripe.
async function live(env: Record<string, string> = {}, opts: Parameters<typeof shop>[2] = {}) {
  const w = await world({ STRIPE_PUBLISHABLE_KEY: testPublishableKey(), PUBLIC_FORMS_PER_MINUTE: '100000', PUBLIC_CART_PER_MINUTE: '100000', ...env });
  const { h, owner, stripe } = w;
  await h.call('POST', '/api/billing/connect/start', { token: owner.token });
  const acct = [...stripe.accounts.keys()][0]!;
  stripe.enable(acct);
  await h.call('GET', '/api/billing/connect', { token: owner.token });
  const s = await shop(h, owner.token, opts);
  const d = await activeDomain(h, owner.token, 'shop.example.com');
  const r = await h.call('PATCH', `/api/funnels/${s.funnelId}`, { token: owner.token, body: { status: 'live', domain_id: d } });
  expect(r.status, r.text).toBe(200);
  const intent = (id: string) => stripe.intents.get(id)!;
  const lastIntent = () => [...stripe.intents.values()].at(-1)!;
  const orders = () => h.deps.db.all<any>('SELECT * FROM orders ORDER BY created_at, id');
  return { ...w, acct, s, intent, lastIntent, orders };
}

describe('embedded Payment form with Stripe (fake)', () => {
  it('creates ONE PaymentIntent on the connected account from the server-side quote, with the application fee and an idempotency key', async () => {
    const { s, stripe, acct, lastIntent } = await live();
    await s.add('atcmug', { quantity: 2 });
    await s.add('atctee');
    const q = await s.quote({ amount: 1, unitAmount: 1, total: 1 });
    expect(q.status, q.text).toBe(200);
    expect(q.json).toMatchObject({ provider: 'stripe', mode: 'embedded', summary: { total: 6000 }, stripe: { publishableKey: testPublishableKey(), account: acct, clientSecret: expect.stringMatching(/^pi_\w+_secret_/) } });
    expect(q.json.returnUrl).toBe(`https://app.funnels.test/api/public/pay/return?attempt=${q.json.attemptId}`);
    const create = stripe.called('POST', /^\/v1\/payment_intents$/)[0]!;
    expect(create.account).toBe(acct);
    expect(create.idempotencyKey).toBe(`pay:${q.json.attemptId}:0`);
    expect(create.params).toMatchObject({ amount: '6000', currency: 'usd', 'automatic_payment_methods[enabled]': 'true', application_fee_amount: '300', 'metadata[attempt_id]': q.json.attemptId });
    expect(lastIntent().status).toBe('requires_payment_method');
    // Loading the page again (same attempt) does not create another intent.
    const again = await s.quote({ attemptId: q.json.attemptId });
    expect(again.json.attemptId).toBe(q.json.attemptId);
    expect(stripe.called('POST', /^\/v1\/payment_intents$/)).toHaveLength(1);
  });

  it('an order bump re-quotes and updates the PaymentIntent amount; the contact creates a customer on the connected account', async () => {
    const { s, stripe, acct, lastIntent } = await live();
    await s.add('atctee');
    const q = (await s.quote()).json;
    const bumped = (await s.quote({ attemptId: q.attemptId, bumpBlockIds: ['bumpwrap'] })).json;
    expect(bumped.summary.total).toBe(1700);
    expect(lastIntent()).toMatchObject({ amount: 1700, application_fee_amount: 85 });
    const withContact = await s.quote({ attemptId: q.attemptId, bumpBlockIds: ['bumpwrap'], contact });
    expect(withContact.status, withContact.text).toBe(200);
    const cus = stripe.called('POST', /^\/v1\/customers$/);
    expect(cus).toHaveLength(1);
    expect(cus[0]!.account).toBe(acct);
    expect(lastIntent().customer).toBe([...stripe.customers.keys()][0]);
    expect(stripe.called('POST', /^\/v1\/payment_intents$/)).toHaveLength(1);
  });

  it('a succeeded intent becomes orders exactly once when the webhook and the browser race; refunds still work per line', async () => {
    const { h, owner, s, stripe, hook, acct, lastIntent, orders } = await live();
    await s.add('atcmug', { quantity: 2 });
    await s.add('atctee');
    const q = (await s.quote({ contact })).json;
    stripe.confirm(lastIntent().id, '4242 4242 4242 4242');
    const [a, b, c] = await Promise.all([
      s.complete({ attemptId: q.attemptId }),
      hook('connect', 'payment_intent.succeeded', { id: lastIntent().id, object: 'payment_intent' }, { account: acct }),
      s.complete({ attemptId: q.attemptId }),
    ]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    const rows = await orders();
    expect(rows.map((o) => [o.product_name, o.amount_cents, o.role, o.provider, o.provider_ref, o.provider_account])).toEqual([
      ['Mug', 4800, 'cart', 'stripe', lastIntent().id, acct],
      ['T-shirt', 1200, 'cart', 'stripe', lastIntent().id, acct],
    ]);
    expect(rows[0].payment_method_ref).toBe(lastIntent().payment_method);
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'order'"))!.n)).toBe(2);
    // A replay of the webhook changes nothing.
    await hook('connect', 'payment_intent.succeeded', { id: lastIntent().id }, { account: acct });
    expect(await orders()).toHaveLength(2);
    const refund = await h.call('POST', `/api/orders/${rows[1].id}/refund`, { token: owner.token, body: { amountCents: 500 } });
    expect(refund.status, refund.text).toBe(200);
    expect(stripe.called('POST', /^\/v1\/refunds$/)[0]!.params).toMatchObject({ payment_intent: lastIntent().id, amount: '500' });
  });

  it('the webhook alone finishes the order (the buyer closed the tab)', async () => {
    const { s, stripe, hook, acct, lastIntent, orders } = await live();
    await s.add('atctee');
    await s.quote({ contact });
    stripe.confirm(lastIntent().id, '4242424242424242');
    const r = await hook('connect', 'payment_intent.succeeded', { id: lastIntent().id }, { account: acct });
    expect(r.status).toBe(200);
    expect(await orders()).toHaveLength(1);
    expect((await s.view()).json.cart.count).toBe(0);
  });

  it('declines are shown and can be retried with another card; payment_intent.payment_failed is recorded', async () => {
    const { h, s, stripe, hook, acct, lastIntent, orders } = await live();
    await s.add('atctee');
    const q = (await s.quote({ contact })).json;
    stripe.confirm(lastIntent().id, '4000 0000 0000 0002');
    await hook('connect', 'payment_intent.payment_failed', { id: lastIntent().id, last_payment_error: lastIntent().last_payment_error }, { account: acct });
    const d = await s.complete({ attemptId: q.attemptId });
    expect(d.status).toBe(402);
    expect(d.json.error).toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'generic_decline' } });
    expect((await h.deps.db.get<{ last_error: string }>('SELECT last_error FROM payment_attempts WHERE id = ?', q.attemptId))!.last_error).toBe('generic_decline');
    stripe.confirm(lastIntent().id, '4242 4242 4242 4242');
    expect((await s.complete({ attemptId: q.attemptId })).status).toBe(200);
    expect(await orders()).toHaveLength(1);
  });

  it('3-D Secure: needs authentication, then the return URL finishes the order and sends the buyer on with the order id', async () => {
    const { h, s, stripe, lastIntent, orders } = await live();
    await s.add('atctee');
    const q = (await s.quote({ contact })).json;
    stripe.confirm(lastIntent().id, '4000 0025 0000 3155');
    const pending = await s.complete({ attemptId: q.attemptId });
    expect(pending.json.error.details.reason).toBe('authentication_required');
    stripe.authenticate(lastIntent().id, true);
    const back = await h.call('GET', `/api/public/pay/return?attempt=${q.attemptId}&payment_intent=${lastIntent().id}&redirect_status=succeeded`);
    expect(back.status).toBe(303);
    const rows = await orders();
    expect(back.headers.get('location')).toBe(`https://shop.example.com/thanks?fn_order=${rows[0].id}`);
    // A failed challenge returns to the payment page with a message.
    await s.add('atcmug');
    const q2 = (await s.quote({ contact })).json;
    stripe.confirm(lastIntent().id, '4000 0025 0000 3155');
    stripe.authenticate(lastIntent().id, false);
    const failed = await h.call('GET', `/api/public/pay/return?attempt=${q2.attemptId}`);
    expect(failed.headers.get('location')).toBe('https://shop.example.com/pay?payment=failed');
    expect((await h.call('GET', '/api/public/pay/return?attempt=pay_doesnotexist')).status).toBe(404);
  });

  it('refuses an amount that does not match the stored quote (tampering at Stripe or a stale intent) and leaves the webhook to retry', async () => {
    const { s, stripe, hook, acct, lastIntent, orders } = await live();
    await s.add('atctee');
    const q = (await s.quote({ contact })).json;
    stripe.confirm(lastIntent().id, '4242424242424242');
    lastIntent().amount = 1; // what a forged or stale intent would look like
    expect((await s.complete({ attemptId: q.attemptId })).json.error.code).toBe('CHECKOUT_MISMATCH');
    expect((await hook('connect', 'payment_intent.succeeded', { id: lastIntent().id }, { account: acct })).status).toBe(409);
    expect(await orders()).toHaveLength(0);
  });

  it('ignores events of another connected account and intents it did not create (hosted Checkout, one-click upsells)', async () => {
    const { s, stripe, hook, lastIntent, orders } = await live();
    await s.add('atctee');
    await s.quote({ contact });
    stripe.confirm(lastIntent().id, '4242424242424242');
    const other = await hook('connect', 'payment_intent.succeeded', { id: lastIntent().id }, { account: 'acct_other' });
    expect(await other.json()).toMatchObject({ ignored: true });
    expect(await (await hook('connect', 'payment_intent.succeeded', { id: 'pi_unknown' }, { account: 'acct_x' })).json()).toMatchObject({ ignored: true });
    expect(await orders()).toHaveLength(0);
  });

  it('two tabs on one cart: the second tab\'s unconfirmed intent is cancelled when the first pays', async () => {
    const { s, stripe, intent, orders } = await live();
    await s.add('atctee');
    const t1 = (await s.quote({ contact })).json;
    const t2 = (await s.quote({ contact })).json;
    const [pi1, pi2] = [...stripe.intents.keys()];
    stripe.confirm(pi1!, '4242424242424242');
    expect((await s.complete({ attemptId: t1.attemptId })).status).toBe(200);
    expect(intent(pi2!).status).toBe('canceled');
    expect((await s.complete({ attemptId: t2.attemptId })).json.error.code).toBe('CART_ALREADY_PAID');
    expect(await orders()).toHaveLength(1);
  });

  it('a one-click upsell after an embedded payment charges the saved card off-session on the same account', async () => {
    const { h, s, stripe, acct, lastIntent, orders } = await live({}, { upsell: true });
    await s.add('atctee');
    const q = (await s.quote({ contact })).json;
    expect(stripe.called('POST', /^\/v1\/payment_intents$/)[0]!.params.setup_future_usage).toBe('off_session');
    stripe.confirm(lastIntent().id, '4242424242424242');
    const done = (await s.complete({ attemptId: q.attemptId })).json;
    const up = await h.call('POST', `/api/public/checkout/${s.funnelId}/${s.upsellStepId}/upsell`, { body: { previousOrderId: done.orderId, submissionId: 'upsell_submission_1' }, headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120' } });
    expect(up.status, up.text).toBe(200);
    const first = stripe.called('POST', /^\/v1\/payment_intents$/)[0]!;
    const off = stripe.called('POST', /^\/v1\/payment_intents$/).at(-1)!;
    expect(off).not.toBe(first);
    expect(off.account).toBe(acct);
    const saved = (await orders())[0];
    expect(off.params).toMatchObject({ off_session: 'true', confirm: 'true', amount: '4000', customer: saved.provider_customer, payment_method: saved.payment_method_ref });
    expect((await orders()).map((o) => o.role)).toEqual(['cart', 'upsell']);
  });

  it('without a publishable key the form uses hosted Checkout; the cart is closed when the session is paid', async () => {
    const { h, s, stripe, hook, acct, orders } = await live({ STRIPE_PUBLISHABLE_KEY: 'unset' });
    await s.add('atcmug', { quantity: 2 });
    const first = (await s.quote()).json;
    expect(first).toMatchObject({ mode: 'hosted', attemptId: null });
    expect(first.stripe).toBeUndefined();
    const r = (await s.quote({ contact, hosted: true })).json;
    expect(r.redirect).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const session = [...stripe.sessions.values()].at(-1)!;
    expect(session.params['line_items[0][quantity]']).toBe('2');
    expect(session.amount_total).toBe(4800); // priced from the catalog (the synced Stripe price of the connected account)
    stripe.pay(session.id);
    await hook('connect', 'checkout.session.completed', { id: session.id }, { account: acct });
    expect((await orders()).map((o) => [o.product_name, o.role, o.quantity])).toEqual([['Mug', 'cart', 2]]);
    expect((await s.view()).json.cart.count).toBe(0);
    void h;
  });

  it('needs a connected account with charges enabled and a live funnel', async () => {
    const w = await world({ STRIPE_PUBLISHABLE_KEY: testPublishableKey() });
    const s = await shop(w.h, w.owner.token);
    await s.add('atctee');
    expect((await s.quote()).json.error.code).toBe('STRIPE_NOT_CONNECTED');
  });
});

describe('configuration and CSP', () => {
  const env = (o: Record<string, string>) => ({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', ...o });
  it('validates STRIPE_PUBLISHABLE_KEY and refuses to start when its mode differs from the secret key', () => {
    const sk = ['sk', 'test', 'abc123'].join('_');
    expect(() => loadConfig(env({ STRIPE_PUBLISHABLE_KEY: 'pk_nope' }))).toThrow(/STRIPE_PUBLISHABLE_KEY must look like/);
    expect(() => loadConfig(env({ STRIPE_SECRET_KEY: sk, STRIPE_PUBLISHABLE_KEY: ['pk', 'live', 'abc123'].join('_') }))).toThrow(/both be test keys or both live keys/);
    expect(loadConfig(env({ STRIPE_SECRET_KEY: sk, STRIPE_PUBLISHABLE_KEY: testPublishableKey() })).STRIPE_PUBLISHABLE_KEY).toBe(testPublishableKey());
  });

  it('adds exactly the Stripe hosts, only to pages with an embedded Payment form, only with Stripe payments', () => {
    const none = { script: [], connect: [], img: [], frame: [] };
    const page = '<form class="fn-pay" id="co-pay1" method="post" action="/api/public/pay/f/s/pay1" data-fn-pay="" data-mode="embedded">';
    expect(withPaymentHosts(none, page, 'mock')).toBe(none);
    expect(withPaymentHosts(none, page.replace('embedded', 'hosted'), 'stripe')).toBe(none);
    expect(withPaymentHosts(none, '<p>no form</p>', 'stripe')).toBe(none);
    const v = withPaymentHosts(none, page, 'stripe');
    expect(v).toEqual(STRIPE_CSP);
    const { policy } = cspFor({ id: 's', basePath: '/', html: page, knownInline: [], vendors: v }, 'https://app.example.com', new Set(['https://app.example.com']));
    expect(policy).toContain("script-src 'self' https://*.js.stripe.com https://js.stripe.com");
    expect(policy).toContain('connect-src \'self\' https://app.example.com https://api.stripe.com');
    expect(policy).toMatch(/frame-src https: https:\/\/js\.stripe\.com https:\/\/\*\.js\.stripe\.com https:\/\/hooks\.stripe\.com https:\/\/m\.stripe\.network/);
    expect(cspFor({ id: 's', basePath: '/', html: '<p></p>', knownInline: [], vendors: none }, 'https://app.example.com', new Set()).policy).not.toContain('stripe');
  });

  it('a built-in address page with the Payment form is served with the Stripe hosts in its CSP', async () => {
    const w = await world({ STRIPE_PUBLISHABLE_KEY: testPublishableKey() });
    const s = await shop(w.h, w.owner.token);
    const go = await w.h.call('POST', `/api/funnels/${s.funnelId}/go-live`, { token: w.owner.token, body: { address: { kind: 'builtin' } } });
    expect(go.status, go.text).toBe(200);
    const base = new URL(go.json.funnel.address.base).pathname.replace(/\/$/, '');
    const pay = await w.h.call('GET', `${base}/pay`);
    expect(pay.status, pay.text.slice(0, 200)).toBe(200);
    expect(pay.headers.get('content-security-policy')).toContain('https://js.stripe.com');
    expect(pay.text).toContain('data-fn-pay');
    const cart = await w.h.call('GET', `${base}/cart`);
    expect(cart.headers.get('content-security-policy')).not.toContain('stripe');
  });
});
