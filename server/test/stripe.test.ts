import { describe, expect, it } from 'vitest';
import { signStripePayload, verifyStripeSignature } from '../src/payments/stripe.js';
import { checkoutTarget, makeHarness } from './helpers.js';
import { CONNECT, DESKTOP, PLATFORM, store, world } from './support/stripeworld.js';

describe('Stripe signature scheme', () => {
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000;
  it('accepts a fresh correct signature, any one of several v1 values (secret rotation), and nothing else', () => {
    const good = signStripePayload('whsec_x', body, now);
    expect(verifyStripeSignature('whsec_x', good, body, now)).toBe(true);
    expect(verifyStripeSignature('whsec_x', `${good},v1=${'0'.repeat(64)}`, body, now)).toBe(true);
    expect(verifyStripeSignature('whsec_x', `t=${now},v1=${'0'.repeat(64)},${good.split(',')[1]}`, body, now)).toBe(true);
    expect(verifyStripeSignature('whsec_other', good, body, now)).toBe(false);
    expect(verifyStripeSignature('whsec_x', good, `${body} `, now)).toBe(false); // body changed by a single byte
    expect(verifyStripeSignature('whsec_x', undefined, body, now)).toBe(false);
    expect(verifyStripeSignature('whsec_x', 'garbage', body, now)).toBe(false);
    expect(verifyStripeSignature('whsec_x', `t=abc,v1=${'0'.repeat(64)}`, body, now)).toBe(false);
  });
  it('refuses a stale or future timestamp (replay) beyond the tolerance', () => {
    const old = signStripePayload('whsec_x', body, now - 301);
    expect(verifyStripeSignature('whsec_x', old, body, now)).toBe(false);
    expect(verifyStripeSignature('whsec_x', old, body, now, 600)).toBe(true);
    expect(verifyStripeSignature('whsec_x', signStripePayload('whsec_x', body, now + 400), body, now)).toBe(false);
  });
});

describe('Stripe Connect', () => {
  it('onboarding creates one connected account per workspace (idempotent) and returns a link; status refreshes from Stripe', async () => {
    const { h, owner, stripe } = await world();
    const a = await h.call('POST', '/api/billing/connect/start', { token: owner.token });
    expect(a.status).toBe(200);
    expect(a.json.url).toContain('connect.stripe.test/setup/acct_');
    const b = await h.call('POST', '/api/billing/connect/start', { token: owner.token });
    expect(stripe.accounts.size).toBe(1);
    expect(b.json.url).toBe(a.json.url);
    expect(stripe.called('POST', /accounts$/)[0]!.params).toMatchObject({ type: 'standard', 'metadata[workspace_id]': owner.wsId });
    const st1 = (await h.call('GET', '/api/billing/connect', { token: owner.token })).json;
    expect(st1).toMatchObject({ connected: true, chargesEnabled: false });
    stripe.enable([...stripe.accounts.keys()][0]!);
    expect((await h.call('GET', '/api/billing/connect', { token: owner.token })).json).toMatchObject({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
    expect(((await h.call('GET', '/api/billing', { token: owner.token })).json as { stripe: { connect: { chargesEnabled: boolean } } }).stripe.connect.chargesEnabled).toBe(true);
  });

  it('account.updated and account.application.deauthorized webhooks keep the state right; disconnect forgets the account', async () => {
    const { h, owner, stripe, hook } = await world();
    await h.call('POST', '/api/billing/connect/start', { token: owner.token });
    const id = [...stripe.accounts.keys()][0]!;
    expect((await hook('connect', 'account.updated', { id, charges_enabled: true, payouts_enabled: false, details_submitted: true }, { account: id })).status).toBe(200);
    expect((await h.deps.db.get<{ charges_enabled: number }>('SELECT charges_enabled FROM stripe_accounts'))!.charges_enabled).toBe(1);
    expect((await hook('connect', 'account.application.deauthorized', { id }, { account: id })).status).toBe(200);
    expect(await h.deps.db.get('SELECT 1 FROM stripe_accounts')).toBeUndefined();
    await h.call('POST', '/api/billing/connect/start', { token: owner.token });
    expect((await h.call('POST', '/api/billing/connect/disconnect', { token: owner.token })).status).toBe(204);
    expect((await h.call('POST', '/api/billing/connect/disconnect', { token: owner.token })).status).toBe(404);
  });

  it('checkout is refused until the account can take charges, and for funnels that are not live', async () => {
    const { h, owner, stripe } = await world();
    const t = await checkoutTarget(h, owner.token);
    const attempt = () => h.call('POST', t.mainPath, { body: { email: 'a@example.com' }, headers: DESKTOP });
    expect((await attempt()).json.error.code).toBe('STRIPE_NOT_CONNECTED');
    await h.call('POST', '/api/billing/connect/start', { token: owner.token });
    expect((await attempt()).json.error.code).toBe('STRIPE_NOT_CONNECTED'); // onboarding not finished
    stripe.enable([...stripe.accounts.keys()][0]!);
    await h.call('GET', '/api/billing/connect', { token: owner.token });
    expect((await attempt()).json.error.code).toBe('FUNNEL_NOT_LIVE');
    expect(stripe.called('POST', /checkout\/sessions$/)).toHaveLength(0);
  });
});

describe('hosted checkout', () => {
  it('creates the session on the connected account with prices from the stored blocks, the plan fee and an idempotency key; creates no order yet', async () => {
    const { t, buy, stripe, acct, orders } = await store();
    const r = await buy('buyer@example.com', { price: 0.01, amountCents: 1, amount: 1 }); // a visitor cannot choose what they pay
    expect(r.json).toMatchObject({ ok: true, recorded: false, redirect: expect.stringContaining('checkout.stripe.test/c/'), orders: [] });
    const [call] = stripe.called('POST', /checkout\/sessions$/);
    expect(call!.account).toBe(acct);
    expect(call!.idempotencyKey).toMatch(/^cks_/);
    const p = call!.params;
    expect(p).toMatchObject({ mode: 'payment', customer_email: 'buyer@example.com', customer_creation: 'always' });
    const main = Number(p['line_items[0][price_data][unit_amount]']);
    const bump = Number(p['line_items[1][price_data][unit_amount]']);
    expect(main).toBeGreaterThan(100);
    expect(bump).toBeGreaterThan(0);
    expect(Number(p['payment_intent_data[application_fee_amount]'])).toBe(Math.floor(((main + bump) * 500) / 10_000)); // free plan: 5%
    expect(p['payment_intent_data[setup_future_usage]']).toBe('off_session'); // this funnel has a one-click upsell
    expect(p.success_url).toMatch(/\/api\/public\/checkout\/return\?cs=\{CHECKOUT_SESSION_ID\}$/);
    expect(p.cancel_url).toBe('https://shop.example.com/offer?purchase=cancelled'.replace('/offer', new URL(p.cancel_url!).pathname));
    expect(await orders()).toHaveLength(0);
    expect(t.bumpId).toBeTruthy();
  });

  it('the plan sets the application fee: pro 2%, business 0 (no fee parameter)', async () => {
    const { h, buy, stripe, owner } = await store();
    await h.deps.db.run("UPDATE workspaces SET plan = 'business' WHERE id = ?", owner.wsId);
    await buy();
    expect(stripe.called('POST', /checkout\/sessions$/).at(-1)!.params['payment_intent_data[application_fee_amount]']).toBeUndefined();
    await h.deps.db.run("UPDATE workspaces SET plan = 'pro' WHERE id = ?", owner.wsId);
    await buy('second@example.com');
    const p = stripe.called('POST', /checkout\/sessions$/).at(-1)!.params;
    const total = Number(p['line_items[0][price_data][unit_amount]']) + Number(p['line_items[1][price_data][unit_amount]']);
    expect(Number(p['payment_intent_data[application_fee_amount]'])).toBe(Math.floor((total * 200) / 10_000));
  });

  it('the signed webhook turns the paid session into orders, events, a lead and a purchase webhook; redelivery is a no-op; the return URL then redirects without new orders', async () => {
    const { h, owner, pay, hook, orders, stripe, acct } = await store();
    await h.call('POST', '/api/webhooks', { token: owner.token, body: { url: 'https://hooks.example.com/p', events: ['funnel.purchase'] } });
    const { sid } = await pay();
    const evt = { id: 'evt_pay_1' };
    const r1 = await hook('connect', 'checkout.session.completed', { id: sid }, { account: acct }, evt);
    expect(r1.status).toBe(200);
    const rows = await orders();
    expect(rows).toHaveLength(2);
    expect(rows.map((o) => [o.is_bump, o.provider, o.status, o.refunded_cents])).toEqual([[0, 'stripe', 'paid', 0], [1, 'stripe', 'paid', 0]]);
    expect(rows[0]!.provider_ref).toBe(rows[1]!.provider_ref); // one PaymentIntent paid for both
    expect(rows[0]!.payment_method_ref).toMatch(/^pm_/);
    expect(rows[0]!.provider_customer).toMatch(/^cus_/);
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'order'"))!.n)).toBe(2);
    expect((await h.deps.db.get<{ email: string }>('SELECT email FROM leads'))!.email).toBe('buyer@example.com');
    await h.worker.tick();
    expect(h.http.calls.filter((c) => JSON.parse(c.body).event === 'funnel.purchase')).toHaveLength(2);
    const again = await hook('connect', 'checkout.session.completed', { id: sid }, { account: acct }, evt);
    expect(await again.json()).toMatchObject({ received: true, duplicate: true });
    const back = await h.app.request(`/api/public/checkout/return?cs=${sid}`);
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toMatch(/^https:\/\/shop\.example\.com\//);
    expect(await orders()).toHaveLength(2);
    expect(stripe.called('GET', /checkout\/sessions\//).length).toBeGreaterThanOrEqual(1);
  });

  it('webhook and the visitor returning at the same instant create the orders exactly once', async () => {
    const { h, pay, hook, orders, acct } = await store();
    const { sid } = await pay();
    const results = await Promise.all([
      hook('connect', 'checkout.session.completed', { id: sid }, { account: acct }),
      h.app.request(`/api/public/checkout/return?cs=${sid}`),
      h.app.request(`/api/public/checkout/return?cs=${sid}`),
      hook('connect', 'checkout.session.completed', { id: sid }, { account: acct }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 303, 303]);
    expect(await orders()).toHaveLength(2);
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'order'"))!.n)).toBe(2);
  });

  it('a return before payment completes redirects back to the page and creates nothing; a bad or unknown session is a 404', async () => {
    const { h, buy, orders, stripe } = await store();
    await buy();
    const sid = [...stripe.sessions.keys()][0]!;
    const back = await h.app.request(`/api/public/checkout/return?cs=${sid}`);
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toContain('purchase=cancelled');
    expect((await h.app.request('/api/public/checkout/return?cs=cs_test_unknown00')).status).toBe(404);
    expect((await h.app.request('/api/public/checkout/return?cs=nope')).status).toBe(404);
    expect(await orders()).toHaveLength(0);
  });

  it('refuses to finish when the paid amount is not what the server stored, and a failed webhook is retried (not marked done)', async () => {
    const { h, pay, hook, orders, stripe, acct } = await store();
    const { sid } = await pay();
    stripe.sessions.get(sid)!.amount_total -= 100; // Stripe says less was paid than the order is worth
    const bad = await hook('connect', 'checkout.session.completed', { id: sid }, { account: acct }, { id: 'evt_mismatch' });
    expect(bad.status).toBe(409);
    expect(await orders()).toHaveLength(0);
    expect((await h.deps.db.get<{ processed_at: string | null; error: string | null }>("SELECT processed_at, error FROM stripe_events WHERE id = 'evt_mismatch'"))).toMatchObject({ processed_at: null, error: expect.stringContaining('does not match') });
    stripe.sessions.get(sid)!.amount_total += 100; // Stripe retries the same event later and now it is consistent
    expect((await hook('connect', 'checkout.session.completed', { id: sid }, { account: acct }, { id: 'evt_mismatch' })).status).toBe(200);
    expect(await orders()).toHaveLength(2);
  });

  it('a Stripe outage while starting the checkout is a 502 and leaves nothing half-created that could be finished', async () => {
    const { h, t, stripe } = await store();
    stripe.down = true;
    const r = await h.call('POST', t.mainPath, { body: { email: 'a@example.com' }, headers: DESKTOP });
    expect(r.status).toBe(502);
    expect(r.json.error.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect((await h.deps.db.get<{ status: string }>('SELECT status FROM checkout_sessions'))!.status).toBe('failed');
  });

  it('bad webhooks: wrong signature, wrong secret for the endpoint, stale timestamp, invalid body: all refused before anything runs', async () => {
    const { h, hook } = await world();
    const post = (source: 'platform' | 'connect', o: { secret?: string; t?: number } = {}) => hook(source, 'account.updated', { id: 'acct_x' }, {}, o);
    expect((await post('connect', { secret: 'whsec_wrong' })).status).toBe(400);
    expect((await post('connect', { secret: PLATFORM })).status).toBe(400); // each endpoint has its own secret
    expect((await post('platform', { secret: CONNECT })).status).toBe(400);
    expect((await post('connect', { t: Math.floor(h.clock.now().getTime() / 1000) - 3600 })).status).toBe(400);
    const unsigned = await h.app.request('/api/stripe/connect-webhook', { method: 'POST', body: '{}' });
    expect(unsigned.status).toBe(400);
    const junk = 'not json';
    const t = Math.floor(h.clock.now().getTime() / 1000);
    expect((await h.app.request('/api/stripe/connect-webhook', { method: 'POST', body: junk, headers: { 'stripe-signature': signStripePayload(CONNECT, junk, t) } })).status).toBe(400);
    expect(Number((await h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stripe_events'))!.n)).toBe(0);
  });
});

describe('one-click upsell', () => {
  async function bought() {
    const w = await store();
    const { sid } = await w.pay();
    await w.hook('connect', 'checkout.session.completed', { id: sid }, { account: w.acct });
    const first = (await w.orders())[0]!;
    const up = (previousOrderId = first.id, extra: object = {}) => w.h.call('POST', w.t.upsellPath, { body: { previousOrderId, ...extra }, headers: DESKTOP });
    return { ...w, first, up };
  }

  it('charges the saved payment method off-session on the same connected account, and records an upsell order under the original', async () => {
    const { up, stripe, first, acct, orders } = await bought();
    const r = await up();
    expect(r.status, r.text).toBe(200);
    const [pi] = stripe.called('POST', /payment_intents$/);
    expect(pi!.account).toBe(acct);
    expect(pi!.params).toMatchObject({ customer: first.provider_customer, payment_method: first.payment_method_ref, off_session: 'true', confirm: 'true' });
    const rows = await orders();
    const upsell = rows.find((o) => o.is_upsell === 1)!;
    expect(upsell).toMatchObject({ provider: 'stripe', status: 'paid' });
    expect(upsell.provider_ref).toMatch(/^pi_/);
    expect(upsell.provider_ref).not.toBe(first.provider_ref);
  });

  it('a declined card, a card that needs authentication, and an order with no saved method are all 402s that create nothing', async () => {
    const { up, stripe, orders } = await bought();
    const before = (await orders()).length;
    stripe.nextIntent = 'decline';
    const declined = await up();
    expect([declined.status, declined.json.error.code]).toEqual([402, 'PAYMENT_FAILED']);
    expect(declined.json.error.details.reason).toBe('insufficient_funds');
    stripe.nextIntent = 'action';
    const action = await up();
    expect(action.status).toBe(402);
    expect(action.json.error.details.reason).toBe('authentication_required');
    expect(stripe.called('POST', /payment_intents\/\w+\/cancel$/)).toHaveLength(1); // the intent that needs the customer is cancelled, not left hanging
    expect((await orders()).length).toBe(before);
  });

  it('is idempotent per submission: the same submission id charges once', async () => {
    const { up, stripe, orders } = await bought();
    const a = await up(undefined, { submissionId: 'upsell-sub-0001' });
    const b = await up(undefined, { submissionId: 'upsell-sub-0001' });
    expect(a.json.recorded).toBe(true);
    expect(b.json).toMatchObject({ recorded: false, duplicate: true });
    expect(stripe.called('POST', /payment_intents$/)).toHaveLength(1);
    expect((await orders()).filter((o) => o.is_upsell === 1)).toHaveLength(1);
  });
});

describe('refunds', () => {
  async function paid() {
    const w = await store();
    const { sid } = await w.pay();
    await w.hook('connect', 'checkout.session.completed', { id: sid }, { account: w.acct });
    const [main, bump] = await w.orders();
    const refund = (id: string, body: object = {}, token = w.owner.token, headers: Record<string, string> = {}) => w.h.call('POST', `/api/orders/${id}/refund`, { token, body, headers });
    return { ...w, main: main!, bump: bump!, refund };
  }

  it('a full refund calls Stripe once with the payment intent, amount and connected account, marks the order refunded and records it (audit, webhook, notification)', async () => {
    const { h, owner, main, refund, stripe, acct, orders } = await paid();
    await h.call('POST', '/api/webhooks', { token: owner.token, body: { url: 'https://hooks.example.com/r', events: ['funnel.refund'] } });
    const r = await refund(main.id, { reason: 'requested_by_customer' });
    expect(r.status, r.text).toBe(200);
    expect(r.json.refund).toMatchObject({ amountCents: main.amount_cents, orderId: main.id });
    expect(r.json.order).toMatchObject({ status: 'refunded', refundedCents: main.amount_cents });
    const [call] = stripe.called('POST', /refunds$/);
    expect(call).toMatchObject({ account: acct });
    expect(call!.params).toMatchObject({ payment_intent: main.provider_ref, amount: String(main.amount_cents), reason: 'requested_by_customer', 'metadata[order_id]': main.id });
    expect(call!.idempotencyKey).toMatch(/^rfd_/);
    expect((await orders())[0]).toMatchObject({ status: 'refunded', refunded_cents: main.amount_cents });
    expect((await orders())[1]).toMatchObject({ status: 'paid', refunded_cents: 0 }); // the bump is its own order
    expect((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.refunded'"))!.n).toBe(1);
    await h.worker.tick();
    expect(h.http.calls.some((c) => JSON.parse(c.body).event === 'funnel.refund')).toBe(true);
    expect((await refund(main.id)).json.error.code).toBe('ALREADY_REFUNDED');
  });

  it('partial refunds add up; more than what is left is refused; the remaining amount is reported', async () => {
    const { main, refund, stripe } = await paid();
    const first = await refund(main.id, { amountCents: 1000 });
    expect(first.json.order).toMatchObject({ status: 'partially_refunded', refundedCents: 1000 });
    expect((await refund(main.id, { amountCents: main.amount_cents })).json.error.code).toBe('INVALID_AMOUNT'); // only amount - 1000 is left
    const rest = await refund(main.id); // no amount: everything left
    expect(rest.json.refund.amountCents).toBe(main.amount_cents - 1000);
    expect(rest.json.order.status).toBe('refunded');
    expect(stripe.called('POST', /refunds$/)).toHaveLength(2);
    expect((await refund(main.id, { amountCents: 0 })).status).toBe(400);
  });

  it('two simultaneous full refunds: exactly one reaches Stripe and succeeds (the amount is reserved before the call)', async () => {
    const { main, refund, stripe } = await paid();
    const results = await Promise.all([refund(main.id), refund(main.id), refund(main.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(stripe.called('POST', /refunds$/)).toHaveLength(1);
  });

  it('when Stripe refuses, the reservation is released and the order is unchanged (502, or 409 if Stripe says it was already refunded)', async () => {
    const { main, refund, stripe, orders } = await paid();
    stripe.failRefund = { status: 500 };
    const down = await refund(main.id);
    expect([down.status, down.json.error.code]).toEqual([502, 'REFUND_FAILED']);
    expect((await orders())[0]).toMatchObject({ status: 'paid', refunded_cents: 0 });
    stripe.failRefund = { status: 400, code: 'charge_already_refunded' };
    expect((await refund(main.id)).json.error.code).toBe('ALREADY_REFUNDED');
    expect((await orders())[0]!.refunded_cents).toBe(0);
    stripe.failRefund = null;
    expect((await refund(main.id)).status).toBe(200); // and a retry works
  });

  it('needs orders:refund, only for orders of the workspace', async () => {
    const { h, owner, main, refund } = await paid();
    const member = await h.member(owner, 'member');
    const admin = await h.member(owner, 'admin');
    expect((await refund(main.id, {}, member.token)).status).toBe(403);
    const other = await h.register();
    expect((await refund(main.id, {}, other.token)).status).toBe(404);
    expect((await refund('ord_nope', {}, admin.token)).status).toBe(404);
    expect((await refund(main.id, { amountCents: 100 }, admin.token)).status).toBe(200);
  });

  it('refunds made in the Stripe dashboard arrive by webhook, are spread over the orders of the payment, and our own refunds are not counted twice', async () => {
    const { h, hook, main, bump, refund, acct, orders, stripe } = await paid();
    const ours = await refund(main.id, { amountCents: 500 });
    expect(ours.status).toBe(200);
    const ourRe = [...stripe.refunds.keys()][0]!;
    // Stripe echoes our refund and also reports one made in its dashboard that covers the rest of the offer and part of the bump
    const dash = main.amount_cents - 500 + 300;
    const charge = { payment_intent: main.provider_ref, refunds: { data: [{ id: ourRe, amount: 500 }, { id: 're_dashboard_1', amount: dash, reason: 'requested_by_customer' }] } };
    const dr = await hook('connect', 'charge.refunded', charge, { account: acct }); expect(dr.status, await dr.text()).toBe(200);
    const [m, b] = await orders();
    expect(m).toMatchObject({ status: 'refunded', refunded_cents: main.amount_cents });
    expect(b).toMatchObject({ status: 'partially_refunded', refunded_cents: 300 });
    expect(bump.amount_cents).toBeGreaterThan(300);
    await hook('connect', 'charge.refunded', charge, { account: acct }, { id: 'evt_again' }); // a different event with the same refunds changes nothing
    expect((await orders())[1]!.refunded_cents).toBe(300);
    expect(Number((await h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM refunds'))!.n)).toBe(3);
  });

  it('orders from the mock provider can be refunded too (no Stripe call), so the dashboard behaves the same in development', async () => {
    const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000' } });
    const owner = await h.register();
    const t = await checkoutTarget(h, owner.token);
    await h.call('POST', t.mainPath, { body: { email: 'mock@example.com' }, headers: DESKTOP });
    const o = (await h.deps.db.get<{ id: string; amount_cents: number }>('SELECT id, amount_cents FROM orders'))!;
    const r = await h.call('POST', `/api/orders/${o.id}/refund`, { token: owner.token, body: { amountCents: 100 } });
    expect(r.json.order).toMatchObject({ status: 'partially_refunded', refundedCents: 100 });
  });
});

describe('platform billing and plan limits', () => {
  it('subscribing creates the customer once and a subscription Checkout Session with the plan price and the workspace in the metadata', async () => {
    const { h, owner, stripe } = await world();
    const a = await h.call('POST', '/api/billing/subscribe', { token: owner.token, body: { plan: 'pro' } });
    expect(a.status, a.text).toBe(200);
    expect(a.json.url).toContain('checkout.stripe.test');
    await h.call('POST', '/api/billing/subscribe', { token: owner.token, body: { plan: 'business' } });
    expect(stripe.customers.size).toBe(1);
    const sessions = stripe.called('POST', /checkout\/sessions$/);
    expect(sessions[0]!.params).toMatchObject({ mode: 'subscription', 'line_items[0][price]': 'price_pro', 'metadata[workspace_id]': owner.wsId, 'subscription_data[metadata][workspace_id]': owner.wsId, client_reference_id: owner.wsId });
    expect(sessions[0]!.account).toBeUndefined(); // the platform's own account, not a connected one
    expect(sessions[1]!.params['line_items[0][price]']).toBe('price_business');
    expect((await h.call('POST', '/api/billing/subscribe', { token: owner.token, body: { plan: 'free' } })).status).toBe(400);
  });

  it('a plan without a configured price is not available', async () => {
    const { h, owner } = await world({ STRIPE_PRICE_BUSINESS: 'unset' });
    expect((await h.call('POST', '/api/billing/subscribe', { token: owner.token, body: { plan: 'business' } })).json.error.code).toBe('PLAN_NOT_AVAILABLE');
  });

  it('subscription webhooks set, keep and end the plan; past-due keeps the plan and warns; an unknown price changes nothing', async () => {
    const { h, owner, stripe, hook } = await world();
    await h.call('POST', '/api/billing/subscribe', { token: owner.token, body: { plan: 'pro' } });
    const customer = [...stripe.customers.keys()][0]!;
    const sub = stripe.subscription({ price: 'price_pro', customer, workspace: owner.wsId });
    const plan = async () => h.deps.db.get<{ plan: string; plan_status: string; plan_period_end: string | null; stripe_subscription_id: string | null }>('SELECT plan, plan_status, plan_period_end, stripe_subscription_id FROM workspaces WHERE id = ?', owner.wsId);
    // the checkout session completing: the plan comes from the subscription object, read from Stripe
    await hook('platform', 'checkout.session.completed', { id: 'cs_sub', mode: 'subscription', subscription: sub.id, client_reference_id: owner.wsId, metadata: { workspace_id: owner.wsId } });
    expect(await plan()).toMatchObject({ plan: 'pro', plan_status: 'active', stripe_subscription_id: sub.id, plan_period_end: new Date(1_800_000_000 * 1000).toISOString() });
    expect(((await h.call('GET', '/api/billing', { token: owner.token })).json as { plan: string; applicationFeePercent: number }).applicationFeePercent).toBe(2);
    await hook('platform', 'invoice.payment_failed', { customer, metadata: {} });
    expect((await plan())!.plan_status).toBe('past_due');
    expect((await plan())!.plan).toBe('pro'); // grace while Stripe retries
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE type = 'billing'"))!.n)).toBe(1);
    await hook('platform', 'invoice.paid', { customer });
    expect((await plan())!.plan_status).toBe('active');
    await hook('platform', 'customer.subscription.updated', { ...stripe.subscription({ id: sub.id, price: 'price_business', customer, workspace: owner.wsId }) });
    expect((await plan())!.plan).toBe('business');
    await hook('platform', 'customer.subscription.updated', { ...stripe.subscription({ id: sub.id, price: 'price_unknown', customer, workspace: owner.wsId }) });
    expect((await plan())!.plan).toBe('business'); // not guessed
    await hook('platform', 'customer.subscription.deleted', { id: sub.id, customer, metadata: { workspace_id: owner.wsId } });
    expect(await plan()).toMatchObject({ plan: 'free', plan_status: 'canceled', stripe_subscription_id: null });
    const unknown = await hook('platform', 'customer.subscription.updated', { id: 'sub_x', status: 'active', customer: 'cus_nobody', items: { data: [{ price: { id: 'price_pro' } }] }, metadata: { workspace_id: 'ws_nobody' } });
    expect(await unknown.json()).toMatchObject({ received: true, ignored: true });
  });

  it('the billing portal needs a customer; the overview reports plan, limits and usage', async () => {
    const { h, owner } = await world();
    expect((await h.call('POST', '/api/billing/portal', { token: owner.token })).json.error.code).toBe('NO_BILLING_ACCOUNT');
    await h.call('POST', '/api/billing/subscribe', { token: owner.token, body: { plan: 'pro' } });
    expect((await h.call('POST', '/api/billing/portal', { token: owner.token })).json.url).toContain('billing.stripe.test/portal/cus_');
    const o = (await h.call('GET', '/api/billing', { token: owner.token })).json;
    expect(o).toMatchObject({ plan: 'free', limits: { funnels: 3, domains: 1, members: 2, apiKeys: 1 }, usage: { funnels: 0, domains: 0, members: 1, apiKeys: 0 }, enforced: false });
    expect(o.plans.map((p: { id: string; purchasable: boolean }) => [p.id, p.purchasable])).toEqual([['free', false], ['pro', true], ['business', true]]);
  });

  it('plan limits: with enforcement on, going over is 402 PLAN_LIMIT_REACHED with the details; trashing frees a slot; upgrading lifts the limit; with enforcement off nothing is limited', async () => {
    const { h, owner, stripe, hook } = await world({ BILLING_ENFORCE_LIMITS: 'true' });
    const make = (name: string) => h.call('POST', '/api/funnels', { token: owner.token, body: { name } });
    const ids: string[] = [];
    for (const n of ['A', 'B', 'C']) ids.push((await make(n)).json.id);
    const over = await make('D');
    expect([over.status, over.json.error.code]).toEqual([402, 'PLAN_LIMIT_REACHED']);
    expect(over.json.error.details).toMatchObject({ resource: 'funnels', limit: 3, used: 3, plan: 'free' });
    expect((await h.call('POST', `/api/funnels/${ids[0]}/duplicate`, { token: owner.token })).status).toBe(402);
    expect((await h.call('POST', '/api/templates/lead-magnet/use', { token: owner.token })).status).toBe(402);
    await h.call('DELETE', `/api/funnels/${ids[0]}`, { token: owner.token });
    expect((await make('D')).status).toBe(201);
    expect((await h.call('POST', `/api/funnels/${ids[0]}/restore`, { token: owner.token })).status).toBe(402); // restoring needs a free slot too
    // upgrading lifts it
    await h.call('POST', '/api/billing/subscribe', { token: owner.token, body: { plan: 'pro' } });
    const customer = [...stripe.customers.keys()][0]!;
    await hook('platform', 'customer.subscription.created', stripe.subscription({ price: 'price_pro', customer, workspace: owner.wsId }));
    expect((await make('E')).status).toBe(201);
    const off = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000' } });
    const o = await off.register();
    for (let i = 0; i < 5; i++) expect((await off.call('POST', '/api/funnels', { token: o.token, body: { name: `F${i}` } })).status).toBe(201);
  });

  it('plan limits cover domains, members (pending invitations count) and API keys', async () => {
    const { h, owner } = await world({ BILLING_ENFORCE_LIMITS: 'true' });
    const dom = (host: string) => h.call('POST', '/api/domains', { token: owner.token, body: { hostname: host } });
    expect((await dom('one.example.com')).status).toBe(201);
    expect((await dom('two.example.com')).json.error.details).toMatchObject({ resource: 'domains', limit: 1 });
    const inv = (email: string) => h.call('POST', '/api/invitations', { token: owner.token, body: { email, roleId: 'member' } });
    expect((await inv('a@example.test')).status).toBe(201); // owner + 1 pending = 2
    const full = await inv('b@example.test');
    expect([full.status, full.json.error.details.resource]).toEqual([402, 'members']);
    const key = (name: string) => h.call('POST', '/api/v1/api-keys', { token: owner.token, body: { name, scopes: ['analytics:read'] } });
    expect((await key('k1')).status).toBe(201);
    expect((await key('k2')).json.error.details.resource).toBe('apiKeys');
  });
});
