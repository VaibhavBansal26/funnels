import { describe, expect, it } from 'vitest';
import { makeFunnel, makeHarness } from './helpers.js';
import { DESKTOP, store, world } from './support/stripeworld.js';

const create = (h: any, token: string, body: object) => h.call('POST', '/api/products', { token, body });
const usd = (cents: number) => ({ currency: 'USD', unitAmount: cents });

describe('payments status and settings', () => {
  it('without Stripe configured the state is unavailable', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const s = (await h.call('GET', '/api/payments/status', { token: u.token })).json;
    expect(s).toMatchObject({ state: 'unavailable', mode: null, connect: null, account: null, settings: { statementDescriptor: null, receiptEmails: true, taxEnabled: false } });
    expect(s.testCards.length).toBeGreaterThan(3);
    expect((await h.call('GET', '/api/payments/status')).status).toBe(401);
  });

  it('walks not connected -> onboarding incomplete -> connected, with account details, test mode and Stripe Tax availability', async () => {
    const { h, owner, stripe } = await world();
    const get = async () => (await h.call('GET', '/api/payments/status', { token: owner.token })).json;
    expect(await get()).toMatchObject({ state: 'not_connected', mode: 'test', webhooks: { platform: true, connect: true } });
    await h.call('POST', '/api/billing/connect/start', { token: owner.token });
    expect(await get()).toMatchObject({ state: 'onboarding_incomplete', connect: { chargesEnabled: false, requirementsDue: ['external_account'] } });
    const acct = [...stripe.accounts.keys()][0]!;
    stripe.enable(acct);
    const connected = await get();
    expect(connected).toMatchObject({
      state: 'connected', stale: false,
      connect: { accountId: acct, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, requirementsDue: [] },
      account: { country: 'US', currency: 'USD', paymentMethods: expect.arrayContaining(['card']), statementDescriptor: 'EXAMPLE', displayName: 'Example Store', taxAvailable: false },
    });
    stripe.taxActive = true;
    expect((await get()).account.taxAvailable).toBe(true);
    // charges disabled again by Stripe with nothing due: restricted
    Object.assign(stripe.accounts.get(acct)!, { charges_enabled: false, requirements: { currently_due: [] } });
    expect((await get()).state).toBe('restricted');
  });

  it('keeps answering with the stored state when Stripe is down, and shows the live banner for a live key without test cards', async () => {
    const { h, owner, stripe } = await world();
    await h.call('POST', '/api/billing/connect/start', { token: owner.token });
    stripe.enable([...stripe.accounts.keys()][0]!);
    await h.call('GET', '/api/payments/status', { token: owner.token });
    stripe.down = true;
    expect(await (await h.call('GET', '/api/payments/status', { token: owner.token })).json).toMatchObject({ state: 'connected', stale: true });
    const live = await world({ STRIPE_SECRET_KEY: 'sk_live_fake' });
    const s = (await live.h.call('GET', '/api/payments/status', { token: live.owner.token })).json;
    expect(s).toMatchObject({ mode: 'live', testCards: [] });
  });

  it('settings are validated, saved, audited and sent to Stripe on the next checkout (receipt, statement descriptor suffix, automatic tax)', async () => {
    const { h, owner, buy, stripe } = await store();
    expect((await h.call('PATCH', '/api/payments/settings', { token: owner.token, body: { statementDescriptor: 'x'.repeat(23) } })).status).toBe(400);
    expect((await h.call('PATCH', '/api/payments/settings', { token: owner.token, body: { statementDescriptor: 'Bad <b>' } })).status).toBe(400);
    const ok = await h.call('PATCH', '/api/payments/settings', { token: owner.token, body: { statementDescriptor: 'ACME COURSES', taxEnabled: true } });
    expect(ok.json).toEqual({ statementDescriptor: 'ACME COURSES', receiptEmails: true, taxEnabled: true });
    await buy();
    const p = stripe.called('POST', /checkout\/sessions$/).at(-1)!.params;
    expect(p).toMatchObject({ 'payment_intent_data[receipt_email]': 'buyer@example.com', 'payment_intent_data[statement_descriptor_suffix]': 'ACME COURSES', 'automatic_tax[enabled]': 'true' });
    await h.call('PATCH', '/api/payments/settings', { token: owner.token, body: { receiptEmails: false, taxEnabled: false, statementDescriptor: null } });
    await buy('second@example.com');
    const q = stripe.called('POST', /checkout\/sessions$/).at(-1)!.params;
    expect(q['payment_intent_data[receipt_email]']).toBeUndefined();
    expect(q['payment_intent_data[statement_descriptor_suffix]']).toBeUndefined();
    expect(q['automatic_tax[enabled]']).toBeUndefined();
    const actions = (await h.call('GET', '/api/audit?limit=50', { token: owner.token })).json.data.map((a: any) => a.action);
    expect(actions).toContain('payments.settings_changed');
  });

  it('records a tax-inclusive total without counting tax as revenue', async () => {
    const { h, buy, hook, stripe, acct } = await store();
    await buy();
    const sid = [...stripe.sessions.keys()].at(-1)!;
    stripe.pay(sid, { tax: 912 });
    expect((await hook('connect', 'checkout.session.completed', { id: sid }, { account: acct })).status).toBe(200);
    const rows = await h.deps.db.all<any>('SELECT amount_cents FROM orders ORDER BY created_at, id');
    expect(rows.map((r) => r.amount_cents)).toEqual([9700, 1700]); // 912 of tax is Stripe's to remit, not revenue
  });
});

describe('add payments to a funnel (wizard)', () => {
  it('one step: adds a checkout and bump section to a new step with the catalog prices and a thank-you step', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token, { name: 'Course funnel' });
    const main = (await create(h, u.token, { name: 'Course', description: 'Everything', price: usd(9700) })).json;
    const r = await h.call('POST', `/api/funnels/${f.id}/payments`, { token: u.token, body: { product: { priceId: main.prices[0].id }, bump: { create: { name: 'Cheat sheet', amount: 9, currency: 'USD' } }, layout: 'one-step' } });
    expect(r.status, r.text).toBe(201);
    expect(r.json.added.map((s: any) => s.kind)).toEqual(['checkout', 'thankyou']);
    const steps = (await h.call('GET', `/api/funnels/${f.id}/steps`, { token: u.token })).json.data;
    expect(steps.map((s: any) => s.name)).toEqual(['Landing page', 'Checkout', 'Thank you']);
    const co = r.json.added[0];
    const page = (await h.call('GET', `/api/funnels/${f.id}/steps/${co.id}/page`, { token: u.token })).json;
    expect(page.doc.products).toHaveLength(2);
    expect(page.doc.products.find((p: any) => !p.orderBump)).toMatchObject({ productId: main.id, priceId: main.prices[0].id, price: 97, currency: 'USD', productName: 'Course' });
    expect(page.doc.products.find((p: any) => p.orderBump)).toMatchObject({ price: 9, productName: 'Cheat sheet' });
    const html = (await h.call('GET', `/api/funnels/${f.id}/steps/${co.id}/html`, { token: u.token })).json.html as string;
    expect(html).toContain('data-fn-checkout');
    expect(html).toContain('Cheat sheet');
    // the flow works end to end through the public endpoint
    const block = page.doc.products.find((p: any) => !p.orderBump);
    const order = await h.call('POST', `/api/public/checkout/${f.id}/${co.id}/${block.id}`, { body: { email: 'buyer@example.com', bumpBlockIds: [page.doc.products.find((p: any) => p.orderBump).id] } });
    expect(order.status, order.text).toBe(200);
    expect(order.json.orders.map((o: any) => o.amountCents)).toEqual([9700, 900]);
  });

  it('puts the checkout on an existing step (one-step) or builds offer plus checkout (two-step) right after it', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token, { name: 'Funnel' });
    const landing = (await h.call('GET', `/api/funnels/${f.id}/steps`, { token: u.token })).json.data[0];
    await h.call('POST', `/api/funnels/${f.id}/steps`, { token: u.token, body: { name: 'Last page' } });
    const before = (await h.call('GET', `/api/funnels/${f.id}/steps/${landing.id}/page`, { token: u.token })).json;
    const one = await h.call('POST', `/api/funnels/${f.id}/payments`, { token: u.token, body: { stepId: landing.id, product: { create: { name: 'Kit', amount: 49, currency: 'USD' } }, thankYou: false } });
    expect(one.status, one.text).toBe(201);
    expect(one.json.added).toHaveLength(0);
    const after = (await h.call('GET', `/api/funnels/${f.id}/steps/${landing.id}/page`, { token: u.token })).json;
    expect(after.doc.products).toHaveLength(1);
    expect(after.doc.project.pages[0].frames[0].component.components.length).toBe(before.doc.project.pages[0].frames[0].component.components.length + 1); // the existing content stays
    expect(after.doc.products[0].success).toEqual({ type: 'message', message: expect.stringContaining('Thank you') });
    const two = await h.call('POST', `/api/funnels/${f.id}/payments`, { token: u.token, body: { stepId: landing.id, layout: 'two-step', product: { create: { name: 'Kit 2', amount: 59, currency: 'USD' } } } });
    expect(two.status, two.text).toBe(201);
    const names = (await h.call('GET', `/api/funnels/${f.id}/steps`, { token: u.token })).json.data.map((s: any) => s.name);
    expect(names).toEqual(['Landing page', 'Checkout', 'Thank you', 'Last page']); // inserted right after the step they belong to
    const offerHtml = (await h.call('GET', `/api/funnels/${f.id}/steps/${landing.id}/html`, { token: u.token })).json.html as string;
    expect(offerHtml).toContain('Continue to checkout');
  });

  it('builds the upsell and downsell steps and routes accept and decline: accepting skips the downsell', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token, { name: 'Big funnel' });
    const r = await h.call('POST', `/api/funnels/${f.id}/payments`, { token: u.token, body: {
      product: { create: { name: 'Main', amount: 100, currency: 'USD' } }, upsell: { create: { name: 'Upsell', amount: 50, currency: 'USD' } }, downsell: { create: { name: 'Downsell', amount: 20, currency: 'USD' } },
    } });
    expect(r.status, r.text).toBe(201);
    const [co, up, down, thanks] = r.json.added;
    expect([up.kind, down.kind, thanks.kind]).toEqual(['upsell', 'downsell', 'thankyou']);
    const html = async (s: any) => (await h.call('GET', `/api/funnels/${f.id}/steps/${s.id}/html`, { token: u.token })).json.html as string;
    const upHtml = await html(up);
    expect(upHtml).toContain(`data-href="${thanks.path}"`); // accept -> thank-you
    expect(upHtml).toContain(`href="${down.path}">No thanks`); // decline -> downsell
    const downPage = (await h.call('GET', `/api/funnels/${f.id}/steps/${down.id}/page`, { token: u.token })).json;
    expect(downPage.doc.products[0]).toMatchObject({ oneClickUpsell: true, downsell: true });
    // buying through the public endpoints: main, then the upsell and the downsell off the first order
    const page = async (s: any) => (await h.call('GET', `/api/funnels/${f.id}/steps/${s.id}/page`, { token: u.token })).json.doc.products[0];
    const main = await h.call('POST', `/api/public/checkout/${f.id}/${co.id}/${(await page(co)).id}`, { body: { email: 'b@example.com' } });
    const upsell = await h.call('POST', `/api/public/checkout/${f.id}/${up.id}/${(await page(up)).id}`, { body: { previousOrderId: main.json.orderId } });
    expect(upsell.json.orders[0]).toMatchObject({ amountCents: 5000, isUpsell: true });
    const downsell = await h.call('POST', `/api/public/checkout/${f.id}/${down.id}/${(await page(down)).id}`, { body: { previousOrderId: main.json.orderId } });
    expect((await h.deps.db.get<any>("SELECT role FROM orders WHERE id = ?", downsell.json.orders[0].id)).role).toBe('downsell');
  });

  it('validates the request and the permissions; another workspace\'s prices and steps are 404', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const other = await h.register();
    const f = await makeFunnel(h, u.token);
    const body = (extra: object) => ({ product: { create: { name: 'P', amount: 10, currency: 'USD' } }, ...extra });
    const go = (token: string, b: object, funnel = f.id) => h.call('POST', `/api/funnels/${funnel}/payments`, { token, body: b });
    expect((await go(u.token, body({ downsell: { create: { name: 'D', amount: 5, currency: 'USD' } } }))).json.error.code).toBe('DOWNSELL_NEEDS_UPSELL');
    expect((await go(u.token, body({ upsell: { create: { name: 'S', amount: 5, currency: 'USD', type: 'subscription', interval: 'month' } } }))).json.error.code).toBe('SUBSCRIPTION_UPSELL_UNSUPPORTED');
    expect((await go(u.token, body({ bump: { create: { name: 'E', amount: 5, currency: 'EUR' } } }))).json.error.code).toBe('MIXED_CURRENCY');
    expect((await go(u.token, { product: { priceId: 'prc_nope' } })).status).toBe(404);
    expect((await go(u.token, body({ stepId: 'stp_nope' }))).status).toBe(404);
    const foreign = (await create(h, other.token, { name: 'Theirs', price: usd(500) })).json;
    expect((await go(u.token, { product: { priceId: foreign.prices[0].id } })).status).toBe(404);
    expect((await go(other.token, body({}))).status).toBe(404); // not their funnel
    const archived = (await create(h, u.token, { name: 'Gone', price: usd(500) })).json;
    await h.call('POST', `/api/products/${archived.id}/archive`, { token: u.token });
    expect((await go(u.token, { product: { priceId: archived.prices[0].id } })).json.error.code).toBe('PRODUCT_UNAVAILABLE');
    expect((await go(u.token, {})).status).toBe(400);
    expect((await h.call('GET', `/api/funnels/${f.id}/steps`, { token: u.token })).json.data).toHaveLength(1); // every refusal left the funnel untouched
    const viewer = await h.member(u, 'viewer');
    const editorOnly = await h.memberWith(u, ['funnels:read', 'funnels:write']);
    expect((await go(viewer.token, body({}))).status).toBe(403);
    expect((await go(editorOnly.token, body({}))).status).toBe(403); // needs products:write as well
    const member = await h.member(u, 'member');
    expect((await go(member.token, body({}))).status).toBe(201);
    expect((await go('', body({}))).status).toBe(401);
  });

  it('a funnel built by the wizard takes a Stripe test-mode purchase end to end', async () => {
    const { h, owner, stripe, hook, acct } = await store();
    const f = await makeFunnel(h, owner.token, { name: 'Wizard shop' });
    const r = await h.call('POST', `/api/funnels/${f.id}/payments`, { token: owner.token, body: { product: { create: { name: 'Poster', amount: 25, currency: 'USD' } } } });
    expect(r.status, r.text).toBe(201);
    const domain = (await h.deps.db.get<{ domain_id: string }>('SELECT domain_id FROM funnels WHERE domain_id IS NOT NULL LIMIT 1'))!.domain_id;
    expect((await h.call('PATCH', `/api/funnels/${f.id}`, { token: owner.token, body: { status: 'live', domain_id: domain } })).status).toBe(200);
    const co = r.json.added[0];
    const block = (await h.call('GET', `/api/funnels/${f.id}/steps/${co.id}/page`, { token: owner.token })).json.doc.products[0];
    const buy = await h.call('POST', `/api/public/checkout/${f.id}/${co.id}/${block.id}`, { body: { email: 'poster@example.com' }, headers: DESKTOP });
    expect(buy.status, buy.text).toBe(200);
    const sid = [...stripe.sessions.keys()].at(-1)!;
    expect(stripe.sessions.get(sid)!.amount_total).toBe(2500);
    stripe.pay(sid);
    await hook('connect', 'checkout.session.completed', { id: sid }, { account: acct });
    expect((await h.deps.db.get<any>("SELECT amount_cents, product_id FROM orders WHERE email = 'poster@example.com'"))).toMatchObject({ amount_cents: 2500, product_id: block.productId });
    expect(r.json.funnel.id).toBe(f.id);
  });
});

describe('use a template with product bindings', () => {
  it('creates catalog products from the template slots by default and reuses them the second time', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const use = (body: object = {}) => h.call('POST', '/api/templates/sales-page-bump-upsell/use', { token: u.token, body });
    const a = await use({ name: 'My masterclass funnel' });
    expect(a.status, a.text).toBe(201);
    expect(a.json.name).toBe('My masterclass funnel');
    const list = (await h.call('GET', '/api/products', { token: u.token })).json.data;
    expect(list.map((p: any) => p.name).sort()).toEqual(['1:1 coaching call (45 min)', 'Done-for-you subject line pack', 'Email Marketing Masterclass']);
    expect((await use()).status).toBe(201);
    expect((await h.call('GET', '/api/products', { token: u.token })).json.data).toHaveLength(3); // reused, not duplicated
    const page = (await h.call('GET', `/api/funnels/${a.json.id}/steps/${a.json.steps[0].id}/page`, { token: u.token })).json;
    expect(page.doc.products.every((p: any) => p.productId && p.priceId && p.slot)).toBe(true);
  });

  it('binds a slot to an existing price; refuses unknown slots, foreign, archived and subscription-for-upsell bindings', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const other = await h.register();
    const mine = (await create(h, u.token, { name: 'My own course', description: 'Mine', price: usd(19_900) })).json;
    const use = (bindings: object) => h.call('POST', '/api/templates/sales-page-bump-upsell/use', { token: u.token, body: { bindings } });
    const ok = await use({ main: { priceId: mine.prices[0].id } });
    expect(ok.status, ok.text).toBe(201);
    const page = (await h.call('GET', `/api/funnels/${ok.json.id}/steps/${ok.json.steps[0].id}/page`, { token: u.token })).json;
    expect(page.doc.products.find((p: any) => p.slot === 'main')).toMatchObject({ productId: mine.id, productName: 'My own course', price: 199 });
    expect((await use({ nope: { create: true } })).json.error.code).toBe('UNKNOWN_SLOT');
    const foreign = (await create(h, other.token, { name: 'Foreign', price: usd(100) })).json;
    expect((await use({ main: { priceId: foreign.prices[0].id } })).status).toBe(404);
    const sub = (await create(h, u.token, { name: 'Club', type: 'subscription', price: { currency: 'USD', amount: 5, interval: 'month' } })).json;
    expect((await use({ upsell: { priceId: sub.prices[0].id } })).json.error.code).toBe('SUBSCRIPTION_UPSELL_UNSUPPORTED');
    expect((await use({ bump: { priceId: sub.prices[0].id } })).status).toBe(201); // a subscription may be a bump
    await h.call('POST', `/api/products/${mine.id}/archive`, { token: u.token });
    expect((await use({ main: { priceId: mine.prices[0].id } })).json.error.code).toBe('PRODUCT_UNAVAILABLE');
    const funnels = (await h.call('GET', '/api/funnels', { token: u.token })).json.data;
    expect(funnels).toHaveLength(2); // refused bindings created no funnel (the transaction rolled back)
  });

  it('a subscription template (free trial) creates a subscription product with its trial', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const r = await h.call('POST', '/api/templates/saas-free-trial/use', { token: u.token });
    expect(r.status, r.text).toBe(201);
    const p = (await h.call('GET', '/api/products', { token: u.token })).json.data[0];
    expect(p).toMatchObject({ type: 'subscription' });
    expect(p.prices[0]).toMatchObject({ interval: 'month', trialDays: 14, unitAmount: 2900 });
  });
});
