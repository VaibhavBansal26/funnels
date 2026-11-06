import { describe, expect, it } from 'vitest';
import { cartIdOf, cartToken } from '../src/services/cart.js';
import { runMaintenance } from '../src/services/maintenance.js';
import { makeHarness } from './helpers.js';
import { contact, opId, shop } from './support/shopworld.js';

// Carts (docs/PRODUCTS.md#cart) and the Payment form with the TEST card form (PAYMENTS_PROVIDER=mock, the default).
async function setup(env: Record<string, string> = {}) {
  const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', PUBLIC_FORMS_PER_MINUTE: '100000', PUBLIC_CART_PER_MINUTE: '100000', ...env } });
  const owner = await h.register();
  const s = await shop(h, owner.token);
  return { h, owner, s };
}

describe('cart', () => {
  it('adds catalog prices, keeps one line per price, counts units and answers a signed token', async () => {
    const { s } = await setup();
    const a = await s.add('atcmug', { quantity: 2 });
    expect(a.status, a.text).toBe(200);
    expect(a.json.token).toMatch(/^crt_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32}$/);
    expect(a.json).toMatchObject({ ok: true, eventId: expect.stringMatching(/^atc_/), added: { name: 'Mug', quantity: 2, unitAmount: 2400, currency: 'USD', value: 48 } });
    await s.add('atctee');
    const again = await s.add('atcmug', { quantity: 1 });
    expect(again.json.cart).toMatchObject({ count: 4, currency: 'USD', subtotal: 8400, subtotalFormatted: '$84.00', total: 8400 });
    expect(again.json.cart.lines.map((l: any) => [l.name, l.quantity, l.total])).toEqual([['Mug', 3, '$72.00'], ['T-shirt', 1, '$12.00']]);
  });

  it('is idempotent per operation id (a retry or double click changes the cart once)', async () => {
    const { s } = await setup();
    const id = opId();
    const first = await s.add('atcmug', { opId: id, quantity: 2 });
    const dup = await s.add('atcmug', { opId: id, quantity: 2 });
    expect(dup.json).toMatchObject({ duplicate: true });
    expect(dup.json.cart.count).toBe(2);
    expect(first.json.cart.count).toBe(2);
    const [a, b] = await Promise.all([s.update({ itemId: first.json.cart.lines[0].id, quantity: 4, opId: 'same_op_1234' }), s.update({ itemId: first.json.cart.lines[0].id, quantity: 4, opId: 'same_op_1234' })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await s.view()).json.cart.count).toBe(4);
  });

  it('never takes an amount or price from the request; checks the quantity against the block', async () => {
    const { s } = await setup();
    const r = await s.add('atcmug', { quantity: 1, price: 0.01, amount: 1, unitAmount: 1, priceId: s.tee.priceId });
    expect(r.json.cart.lines[0]).toMatchObject({ name: 'Mug', unitAmount: 2400 });
    expect((await s.add('atcmug', { quantity: 6 })).json.error.code).toBe('INVALID_QUANTITY'); // block allows 1..5
    expect((await s.add('atctee', { quantity: 2 })).json.error.code).toBe('INVALID_QUANTITY'); // no quantity picker: one at a time
    expect((await s.add('nope')).status).toBe(404);
  });

  it('refuses a second currency with a message that says what to do, and refuses subscriptions', async () => {
    const { s } = await setup();
    await s.add('atcmug');
    const eur = await s.add('atceur');
    expect(eur.status).toBe(409);
    expect(eur.json.error).toMatchObject({ code: 'CART_CURRENCY_MISMATCH', details: { cartCurrency: 'USD', currency: 'EUR' } });
    expect(eur.json.error.message).toMatch(/Your cart is in USD/);
    expect((await s.add('atcclub')).json.error.code).toBe('SUBSCRIPTION_NOT_IN_CART');
    // Emptying the cart frees the currency.
    const line = (await s.view()).json.cart.lines[0];
    await s.update({ itemId: line.id, quantity: 0 });
    expect((await s.add('atceur')).status).toBe(200);
    expect((await s.view()).json.cart.currency).toBe('EUR');
  });

  it('caps a line at CART_MAX_QUANTITY and the number of lines at CART_MAX_LINES', async () => {
    const { s } = await setup({ CART_MAX_QUANTITY: '6', CART_MAX_LINES: '1' });
    await s.add('atcmug', { quantity: 5 });
    const more = await s.add('atcmug', { quantity: 5 });
    expect(more.json).toMatchObject({ limited: true, cart: { count: 6 } });
    expect((await s.add('atctee')).json.error.code).toBe('CART_FULL');
  });

  it('finds the cart by its token, else by the visitor id; a forged token is not a cart', async () => {
    const { h, s } = await setup();
    await s.add('atcmug');
    const token = s.cartToken!;
    expect(cartIdOf(h.deps, token)).toMatch(/^crt_/);
    expect(cartIdOf(h.deps, `${token.split('.')[0]}.${'A'.repeat(32)}`)).toBeNull();
    s.cartToken = undefined;
    expect((await s.view()).json.cart.count).toBe(1); // visitor id fallback (sandboxed pages cannot read cookies)
    const other = await h.call('POST', `/api/public/cart/${s.funnelId}/view`, { body: { token: `${token.split('.')[0]}.${'B'.repeat(32)}`, visitorId: 'someoneelse' } });
    expect(other.json).toMatchObject({ token: null, cart: { count: 0 } });
    // A token of another funnel's cart is not honoured here.
    const id = cartIdOf(h.deps, token)!;
    await h.deps.db.run('UPDATE carts SET funnel_id = (SELECT id FROM funnels WHERE id <> ? LIMIT 1) WHERE id = ? AND EXISTS (SELECT 1 FROM funnels WHERE id <> ?)', s.funnelId, id, s.funnelId);
    expect(cartToken(h.deps, id)).toBe(token);
  });

  it('follows replaced prices, marks archived products unavailable and re-reads the catalog at checkout', async () => {
    const { h, owner, s } = await setup();
    await s.add('atcmug');
    await s.add('atctee');
    const replaced = await h.call('POST', `/api/products/${s.mug.productId}/prices/${s.mug.priceId}/replace`, { token: owner.token, body: { currency: 'USD', unitAmount: 3000 } });
    expect(replaced.status, replaced.text).toBe(200);
    const v = (await s.view()).json.cart;
    expect(v.lines[0]).toMatchObject({ name: 'Mug', unitAmount: 3000, priceId: replaced.json.id, available: true });
    expect((await s.quote()).json.summary.total).toBe(4200);
    await h.call('POST', `/api/products/${s.tee.productId}/archive`, { token: owner.token });
    const after = (await s.view()).json.cart;
    expect(after.lines[1]).toMatchObject({ name: 'T-shirt', available: false });
    expect(after.count).toBe(1);
    const q = await s.quote();
    expect(q.status).toBe(409);
    expect(q.json.error).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', details: { itemId: after.lines[1].id } });
  });

  it('expires after CART_TTL_DAYS without a change, and maintenance deletes expired carts', async () => {
    const { h, s } = await setup({ CART_TTL_DAYS: '2' });
    await s.add('atcmug');
    h.clock.advance(36 * 3_600_000);
    expect((await s.view()).json.cart.count).toBe(1);
    await s.add('atctee'); // a change extends the life
    h.clock.advance(36 * 3_600_000);
    expect((await s.view()).json.cart.count).toBe(2);
    h.clock.advance(13 * 3_600_000);
    expect((await s.view()).json).toMatchObject({ token: null, cart: { count: 0 } });
    expect(Number((await h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM carts'))!.n)).toBe(1);
    await runMaintenance(h.deps);
    expect(Number((await h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM carts'))!.n)).toBe(0);
    expect(Number((await h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cart_items'))!.n)).toBe(0);
  });

  it('stores nothing personal in a cart', async () => {
    const { h, s } = await setup();
    await s.add('atcmug');
    const row = await h.deps.db.get<Record<string, unknown>>('SELECT * FROM carts');
    expect(Object.keys(row!).sort()).toEqual(['bumps_json', 'checked_out_at', 'created_at', 'currency', 'expires_at', 'funnel_id', 'id', 'preview', 'status', 'updated_at', 'version', 'visitor_id', 'workspace_id']);
  });

  it('offers the checkout step order bumps in the cart; the selection carries over to the Payment form', async () => {
    const { s } = await setup();
    await s.add('atcmug');
    const v = (await s.view()).json.cart;
    expect(v.bumps).toEqual([expect.objectContaining({ stepId: s.payStepId, blockId: 'bumpwrap', name: 'Gift wrap', amount: 500, selected: false })]);
    const sel = (await s.update({ bump: { stepId: s.payStepId, blockId: 'bumpwrap', selected: true } })).json.cart;
    expect(sel).toMatchObject({ subtotal: 2400, total: 2900, totalFormatted: '$29.00' });
    const q = (await s.quote()).json;
    expect(q.bumpBlockIds).toEqual(['bumpwrap']);
    expect(q.summary.lines.map((l: any) => [l.name, l.role])).toEqual([['Mug', 'cart'], ['Gift wrap', 'bump']]);
    expect((await s.update({ bump: { stepId: s.payStepId, blockId: 'atcmug', selected: true } })).json.error.code).toBe('INVALID_BUMP');
  });

  it('answers CORS for registered customer domains only, and is rate limited by its own policy', async () => {
    const { h, owner, s } = await setup({ PUBLIC_CART_PER_MINUTE: '3' });
    await h.call('POST', '/api/domains', { token: owner.token, body: { hostname: 'shop.example.com' } });
    const pre = await h.call('OPTIONS', `/api/public/cart/${s.funnelId}/view`, { headers: { origin: 'https://shop.example.com', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
    const evil = await h.call('POST', `/api/public/cart/${s.funnelId}/view`, { body: {}, headers: { origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await s.view()).status;
    expect(last).toBe(429);
  });
});

describe('Payment form with the TEST card form (no Stripe)', () => {
  const pay = async (s: Awaited<ReturnType<typeof setup>>['s'], test: string, extra: Record<string, unknown> = {}) => {
    const q = await s.quote({ contact });
    expect(q.status, q.text).toBe(200);
    return s.complete({ attemptId: q.json.attemptId, test, ...extra });
  };

  it('quotes from the server (never the browser), declines, simulates authentication and records one order per cart line plus bumps', async () => {
    const { h, owner, s } = await setup();
    await s.add('atcmug', { quantity: 2 });
    await s.add('atctee');
    const q = (await s.quote({ bumpBlockIds: ['bumpwrap'], amount: 1, total: 1 })).json;
    expect(q).toMatchObject({ ok: true, provider: 'mock', mode: 'embedded', attemptId: expect.stringMatching(/^pay_/), summary: { total: 6500, currency: 'USD', totalFormatted: '$65.00' } });
    expect(q.stripe).toBeUndefined();
    const bad = await s.quote({ attemptId: q.attemptId, contact: { email: 'not-an-email' }, bumpBlockIds: ['bumpwrap'] });
    expect(bad.status).toBe(422);
    expect(bad.json.error.details.fields).toEqual({ email: 'Enter a valid email address' });
    expect((await s.quote({ attemptId: q.attemptId, bumpBlockIds: ['atcmug'] })).json.error.code).toBe('INVALID_BUMP');

    const declined = await pay(s, 'decline', {});
    expect(declined.status).toBe(402);
    expect(declined.json.error).toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'card_declined' } });
    const auth = await pay(s, 'authenticate');
    expect(auth.json).toEqual({ ok: true, requiresAction: true });
    const failedAuth = await s.complete({ attemptId: (await s.quote({ contact })).json.attemptId, test: 'authenticate', authenticated: false });
    expect(failedAuth.json.error.details.reason).toBe('authentication_failed');
    const okAuth = await s.complete({ attemptId: (await s.quote({ contact })).json.attemptId, test: 'authenticate', authenticated: true });
    expect(okAuth.status, okAuth.text).toBe(200);
    expect(okAuth.json).toMatchObject({ recorded: true, orderId: expect.stringMatching(/^ord_/) });
    expect(okAuth.json.orders.map((o: any) => [o.productName, o.amountCents, o.isBump])).toEqual([['Mug', 4800, false], ['T-shirt', 1200, false], ['Gift wrap', 500, true]]);

    const rows = await h.deps.db.all<any>('SELECT * FROM orders ORDER BY created_at, id');
    expect(rows.map((o) => [o.role, o.quantity, o.product_id, o.provider])).toEqual([['cart', 2, s.mug.productId, 'mock'], ['cart', 1, s.tee.productId, 'mock'], ['bump', 1, s.wrap.productId, 'mock']]);
    expect(rows[1].parent_order_id).toBe(rows[0].id);
    expect(new Set(rows.map((o) => o.provider_ref)).size).toBe(1); // one payment
    // The cart is closed: the badge shows 0 and the next add starts a new cart.
    expect((await s.view()).json.cart.count).toBe(0);
    // Idempotent: a second completion (double submit, a retry) returns the same orders.
    const again = await s.complete({ attemptId: okAuth.json.orders ? (await h.deps.db.get<{ id: string }>("SELECT id FROM payment_attempts WHERE status = 'succeeded'"))!.id : '', test: 'success' });
    expect(again.json).toMatchObject({ recorded: false, orderId: okAuth.json.orderId });
    expect(Number((await h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM orders'))!.n)).toBe(3);

    // Refunds per order line keep working.
    const refund = await h.call('POST', `/api/orders/${rows[1].id}/refund`, { token: owner.token, body: {} });
    expect(refund.status, refund.text).toBe(200);
    expect(refund.json.order).toMatchObject({ status: 'refunded', refundedCents: 1200 });
    expect((await h.deps.db.get<{ status: string }>('SELECT status FROM orders WHERE id = ?', rows[0].id))!.status).toBe('paid');
  });

  it('a cart purchase reaches the rollups, funnel analytics, product analytics, the event export, webhooks and conversions', async () => {
    const { h, owner, s } = await setup();
    await h.call('POST', '/api/webhooks', { token: owner.token, body: { url: 'https://hooks.example.com/in', events: ['funnel.purchase'] } });
    await s.add('atcmug', { quantity: 2 });
    await s.add('atctee');
    const q = (await s.quote({ contact })).json;
    const done = await s.complete({ attemptId: q.attemptId, test: 'success' });
    expect(done.status, done.text).toBe(200);
    const roll = await h.deps.db.get<any>('SELECT SUM(orders) AS orders, SUM(cents) AS cents, SUM(cart_adds) AS adds, SUM(checkouts) AS checkouts FROM event_rollups WHERE funnel_id = ?', s.funnelId);
    expect([roll.orders, roll.cents, roll.adds, roll.checkouts].map(Number)).toEqual([2, 6000, 2, 1]);
    const day = h.deps.now().toISOString().slice(0, 10);
    const a = (await h.call('GET', `/api/funnels/${s.funnelId}/analytics?from=${day}&to=${day}`, { token: owner.token })).json;
    expect(a.summary.sales).toMatchObject({ orders: 2, gross: 60 });
    expect(a.summary.cart).toEqual({ adds: 2, checkouts: 1 });
    expect(a.steps.find((x: any) => x.stepId === s.shopStepId).cart.adds).toBe(2);
    expect(a.steps.find((x: any) => x.stepId === s.payStepId)).toMatchObject({ cart: { checkouts: 1 }, sales: { orders: 2, gross: 60 } });
    const p = (await h.call('GET', `/api/analytics/products?from=${day}&to=${day}`, { token: owner.token })).json;
    const mug = p.products.find((x: any) => x.productId === s.mug.productId);
    expect(mug).toMatchObject({ orders: 1, units: 2, gross: 48, roles: { cart: 1, main: 0 } });
    expect(p.totals[0]).toMatchObject({ currency: 'USD', orders: 2, gross: 60 });
    // Analytics API v1: products and the event export (schema-valid lines with the new event types).
    const key = (await h.call('POST', '/api/v1/api-keys', { token: owner.token, body: { name: 'bi', mode: 'test', scopes: ['analytics:read', 'analytics:export'] } })).json; // the funnel is still in test status
    const auth = { authorization: `Bearer ${key.key}` };
    const v1 = await h.call('GET', `/api/v1/analytics/products?from=${day}&to=${day}`, { headers: auth });
    expect(v1.status, v1.text).toBe(200);
    expect(v1.json.data.find((x: any) => x.product_id === s.mug.productId)).toMatchObject({ orders: 1, units: 2, gross: 48, roles: { cart: 1 } });
    const exp = await h.call('GET', `/api/v1/analytics/export/events?from=${day}&to=${day}`, { headers: auth });
    expect(exp.status, exp.text).toBe(200);
    const types = exp.text.trim().split('\n').map((l) => JSON.parse(l).type);
    expect(types.filter((t) => t === 'add_to_cart')).toHaveLength(2);
    expect(types.filter((t) => t === 'begin_checkout')).toHaveLength(1);
    expect(types.filter((t) => t === 'order')).toHaveLength(2);
    // funnel.purchase: one delivery per order, each carrying every line of the purchase.
    const deliveries = await h.deps.db.all<{ payload_json: string }>("SELECT payload_json FROM webhook_deliveries WHERE event = 'funnel.purchase' ORDER BY created_at");
    expect(deliveries).toHaveLength(2);
    const body = JSON.parse(deliveries[0]!.payload_json);
    expect(body.data?.purchase ?? body.purchase).toMatchObject({ currency: 'USD', total: 60, lines: [expect.objectContaining({ productName: 'Mug', quantity: 2, amount: 48, role: 'cart' }), expect.objectContaining({ productName: 'T-shirt', role: 'cart' })] });
  });

  it('server-side AddToCart, InitiateCheckout and Purchase use the browser event ids and respect consent', async () => {
    const { h, owner, s } = await setup();
    const ig = await h.call('POST', '/api/integrations', { token: owner.token, body: { provider: 'meta', name: 'm', pixelId: '123456789012345', secret: 'EAAB-secret-token-123456' } });
    expect(ig.status, ig.text).toBe(201);
    const add = (await s.add('atcmug')).json;
    const q = (await s.quote({ contact })).json;
    const done = (await s.complete({ attemptId: q.attemptId, test: 'success' })).json;
    const names = await h.deps.db.all<{ event_name: string; event_id: string; status: string }>('SELECT event_name, event_id, status FROM conversion_deliveries ORDER BY created_at, id');
    expect(names.map((n) => [n.event_name, n.event_id])).toEqual([['AddToCart', add.eventId], ['InitiateCheckout', q.eventId], ['Purchase', `purchase_${done.orderId}`]]);
  });

  it('previews and hidden-field bots record nothing', async () => {
    const { h, s } = await setup();
    const add = await s.add('atcmug', { preview: true });
    expect(add.status).toBe(200);
    const q = await s.quote({ preview: true, contact });
    expect(q.json).toMatchObject({ provider: 'preview', attemptId: null, summary: { total: 2400 } });
    expect((await s.quote({ _hp: 'filled' })).json.attemptId).toBeNull();
    expect(Number((await h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events'))!.n)).toBe(0);
    expect(Number((await h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM payment_attempts'))!.n)).toBe(0);
    expect((await s.view()).json.cart.count).toBe(0); // the live cart is separate from the preview cart
    expect((await s.view({ preview: true })).json.cart.count).toBe(1);
  });

  it('two tabs on one cart: once one pays, the other cannot pay the same cart again', async () => {
    const { h, s } = await setup();
    await s.add('atcmug');
    const tab1 = (await s.quote({ contact })).json;
    const tab2 = (await s.quote({ contact })).json; // the second tab has no attempt id in its session storage: its own attempt
    expect(tab2.attemptId).not.toBe(tab1.attemptId);
    // Double submit in tab 1: one set of orders.
    const [a, b] = await Promise.all([s.complete({ attemptId: tab1.attemptId, test: 'success' }), s.complete({ attemptId: tab1.attemptId, test: 'success' })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(Number((await h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM orders'))!.n)).toBe(1);
    // Tab 2 cannot pay the same cart again.
    const second = await s.complete({ attemptId: tab2.attemptId, test: 'success' });
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe('CART_ALREADY_PAID');
    expect(Number((await h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM orders'))!.n)).toBe(1);
    expect((await s.quote({ contact, attemptId: tab2.attemptId })).json.error.code).toBe('CART_EMPTY');
  });

  it('hosted mode with test payments records the order at once', async () => {
    const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', PUBLIC_FORMS_PER_MINUTE: '100000' } });
    const owner = await h.register();
    const s = await shop(h, owner.token, { payment: { mode: 'hosted' } });
    await s.add('atctee');
    const first = (await s.quote()).json;
    expect(first).toMatchObject({ mode: 'hosted', attemptId: null });
    const r = (await s.quote({ contact, hosted: true })).json;
    expect(r).toMatchObject({ recorded: true, orders: [expect.objectContaining({ productName: 'T-shirt', amountCents: 1200 })] });
    const declined = await s.quote({ contact: { email: 'decline@example.com' }, hosted: true });
    expect(declined.status).toBe(409); // the cart was paid and closed
  });

  it('a product Payment form (no cart) sells the chosen catalog price with the page bumps', async () => {
    const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', PUBLIC_FORMS_PER_MINUTE: '100000' } });
    const owner = await h.register();
    const probe = await shop(h, owner.token);
    const s = await shop(h, owner.token, { payment: { source: 'product', productName: probe.mug.name, price: 1, productId: probe.mug.productId, priceId: probe.mug.priceId, quantity: { enabled: true, min: 1, max: 3, default: 1 } } });
    const page = (await h.call('GET', `/api/funnels/${s.funnelId}/steps/${s.payStepId}/page`, { token: owner.token })).json.doc;
    expect(page.commerce[0]).toMatchObject({ price: 24, currency: 'USD' }); // the display snapshot was refreshed from the catalog on save
    const q = (await s.quote({ quantity: 2, bumpBlockIds: ['bumpwrap'] })).json;
    expect(q.summary.lines.map((l: any) => [l.name, l.quantity, l.amount, l.role])).toEqual([['Mug', 2, 4800, 'main'], ['Gift wrap', 1, 500, 'bump']]);
    expect((await s.quote({ quantity: 4 })).json.error.code).toBe('INVALID_QUANTITY');
  });
});

describe('templates with a cart and a payment page', () => {
  it('"Store with cart" binds its products to the catalog and sells through the cart, the bump and the Payment form', async () => {
    const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', PUBLIC_FORMS_PER_MINUTE: '100000' } });
    const owner = await h.register();
    const f = (await h.call('POST', '/api/templates/store-with-cart/use', { token: owner.token })).json;
    expect(f.steps.map((s: any) => s.name)).toEqual(['Shop', 'Cart', 'Checkout', 'Thank you']);
    const docOf = async (i: number) => (await h.call('GET', `/api/funnels/${f.id}/steps/${f.steps[i].id}/page`, { token: owner.token })).json.doc;
    const shopDoc = await docOf(0);
    expect(shopDoc.commerce.filter((c: any) => c.type === 'cart-add').every((c: any) => /^prc_/.test(c.priceId))).toBe(true);
    const payDoc = await docOf(2);
    const [green, black] = shopDoc.commerce;
    const vid = 'templatevisitor1';
    let token: string | undefined;
    const post = async (path: string, body: object) => { const r = await h.call('POST', path, { body: { visitorId: vid, token, ...body } }); if (r.json?.token) token = r.json.token; return r; };
    await post(`/api/public/cart/${f.id}/${f.steps[0].id}/${green.id}/add`, { opId: opId(), quantity: 2 });
    await post(`/api/public/cart/${f.id}/${f.steps[0].id}/${black.id}/add`, { opId: opId() });
    const pay = payDoc.commerce.find((c: any) => c.type === 'payment');
    const bump = payDoc.products.find((p: any) => p.orderBump);
    const q = (await post(`/api/public/pay/${f.id}/${f.steps[2].id}/${pay.id}`, { bumpBlockIds: [bump.id], contact })).json;
    expect(q.summary).toMatchObject({ total: 2 * 1400 + 1600 + 600, currency: 'USD' });
    const done = await post('/api/public/pay/complete', { attemptId: q.attemptId, test: 'success' });
    expect(done.json.orders.map((o: any) => o.productName)).toEqual(['Morning green tea', 'Smoky black tea', 'Bamboo tea infuser']);
  });

  it('"Offer with a payment page" sells its product from a dedicated checkout step', async () => {
    const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', PUBLIC_FORMS_PER_MINUTE: '100000' } });
    const owner = await h.register();
    const f = (await h.call('POST', '/api/templates/offer-with-payment-page/use', { token: owner.token })).json;
    const doc = (await h.call('GET', `/api/funnels/${f.id}/steps/${f.steps[1].id}/page`, { token: owner.token })).json.doc;
    const pay = doc.commerce[0];
    expect(pay).toMatchObject({ type: 'payment', source: 'product', productName: 'Watercolour weekend workshop', price: 49, priceId: expect.stringMatching(/^prc_/) });
    const q = (await h.call('POST', `/api/public/pay/${f.id}/${f.steps[1].id}/${pay.id}`, { body: { visitorId: 'v_offer_1', contact } })).json;
    expect(q.summary.lines.map((l: any) => [l.name, l.role])).toEqual([['Watercolour weekend workshop', 'main']]);
  });
});
