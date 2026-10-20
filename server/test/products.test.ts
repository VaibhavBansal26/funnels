import { describe, expect, it } from 'vitest';
import { walk, wrapperOf } from '../src/pagemodel/shared/clean.js';
import { backfillCatalog } from '../src/services/catalogcheckout.js';
import { allocate, currencyExponent, formatMinor, fromMinor, toMinor } from '../src/util/money.js';
import { checkoutTarget, makeHarness, type Harness } from './helpers.js';
import { DESKTOP, store, world } from './support/stripeworld.js';

const usd = (cents: number) => ({ currency: 'USD', unitAmount: cents });
const create = (h: Harness, token: string, body: object) => h.call('POST', '/api/products', { token, body });

/** Edits the checkout components of a step page through the real save path (so the server derives and links them like for a builder save). */
async function editBlocks(h: Harness, token: string, funnelId: string, stepId: string, fn: (props: Record<string, any>, id: string) => void) {
  const page = (await h.call('GET', `/api/funnels/${funnelId}/steps/${stepId}/page`, { token })).json;
  walk(wrapperOf(page.doc.project), (n) => {
    if (n.type === 'fn-checkout') fn(n.fnProduct as Record<string, any>, ((n.attributes as Record<string, string>) ?? {}).id!);
  });
  const r = await h.call('PUT', `/api/funnels/${funnelId}/steps/${stepId}/page`, { token, body: { doc: page.doc, version: page.version } });
  expect(r.status, r.text).toBe(200);
  return (await h.call('GET', `/api/funnels/${funnelId}/steps/${stepId}/page`, { token })).json;
}

describe('money in minor units', () => {
  it('uses the currency exponent: zero-decimal, two-decimal and three-decimal currencies', () => {
    expect([currencyExponent('USD'), currencyExponent('jpy'), currencyExponent('KWD'), currencyExponent('BHD')]).toEqual([2, 0, 3, 3]);
    expect(toMinor(12.34, 'USD')).toBe(1234);
    expect(toMinor(1.005, 'USD')).toBe(101); // decimal arithmetic, not 1.00 through float error
    expect(toMinor(500, 'JPY')).toBe(500);
    expect(toMinor(1.5, 'KWD')).toBe(1500);
    expect(fromMinor(1500, 'KWD')).toBe(1.5);
    expect(fromMinor(500, 'JPY')).toBe(500);
    expect(formatMinor(500, 'JPY')).toMatch(/500/);
    expect(formatMinor(1234, 'USD')).toBe('$12.34');
  });
  it('allocates a discount over lines so the parts add up exactly', () => {
    expect(allocate(100, [3333, 3333, 3334])).toEqual([33, 33, 34]);
    expect(allocate(1, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(1);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
    expect(allocate(10, [0, 0])).toEqual([0, 0]);
    for (const total of [1, 7, 99, 1000]) expect(allocate(total, [700, 299, 1]).reduce((a, b) => a + b, 0)).toBe(total);
  });
});

describe('catalog API', () => {
  it('creates products with prices (major or minor units), lists, edits, archives and restores; products are never deleted', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const p = await create(h, u.token, { name: 'Starter kit', description: 'All you need', price: { currency: 'usd', amount: 49.5, nickname: 'Launch' } });
    expect(p.status).toBe(201);
    expect(p.json).toMatchObject({ name: 'Starter kit', status: 'active', type: 'one_time', stripe: { syncState: 'not_connected' }, orderCount: 0 });
    expect(p.json.prices[0]).toMatchObject({ currency: 'USD', unitAmount: 4950, amount: 49.5, exponent: 2, formatted: '$49.50', active: true, nickname: 'Launch' });
    expect(p.json.defaultPriceId).toBe(p.json.prices[0].id);
    const jp = (await create(h, u.token, { name: 'Yen item', price: { currency: 'JPY', unitAmount: 500 } })).json;
    expect(jp.prices[0]).toMatchObject({ unitAmount: 500, exponent: 0, amount: 500 });
    const kw = (await create(h, u.token, { name: 'Dinar item', price: { currency: 'KWD', amount: 1.5 } })).json;
    expect(kw.prices[0]).toMatchObject({ unitAmount: 1500, exponent: 3 });
    expect((await create(h, u.token, { name: 'Bad dinar', price: { currency: 'KWD', unitAmount: 1505 } })).json.error.code).toBe('INVALID_AMOUNT');
    expect((await create(h, u.token, { name: 'Both', price: { currency: 'USD', amount: 1, unitAmount: 100 } })).status).toBe(400);
    expect((await create(h, u.token, { name: 'Neither', price: { currency: 'USD' } })).status).toBe(400);
    expect((await create(h, u.token, { name: 'Bad currency', price: { currency: 'XXQ', amount: 1 } })).status).toBe(400);
    expect((await create(h, u.token, { name: 'Sub', type: 'subscription', price: { currency: 'USD', amount: 9 } })).json.error.code).toBe('INTERVAL_REQUIRED');
    expect((await create(h, u.token, { name: 'One', price: { currency: 'USD', amount: 9, interval: 'month' } })).json.error.code).toBe('INTERVAL_NOT_ALLOWED');
    expect((await create(h, u.token, { name: 'Img', images: ['http://example.com/a.png'] })).status).toBe(400);
    expect((await create(h, u.token, { name: 'Img', images: ['https://example.com/a.png', '/uploads/ast_1/a.png'] })).status).toBe(201);

    const list = (await h.call('GET', '/api/products', { token: u.token })).json;
    expect(list.data).toHaveLength(4);
    expect((await h.call('GET', '/api/products?search=yen', { token: u.token })).json.data.map((x: any) => x.name)).toEqual(['Yen item']);
    const patched = await h.call('PATCH', `/api/products/${p.json.id}`, { token: u.token, body: { name: 'Starter kit v2', metadata: { sku: 'SK-1' }, taxCode: 'txcd_10000000' } });
    expect(patched.json).toMatchObject({ name: 'Starter kit v2', metadata: { sku: 'SK-1' }, taxCode: 'txcd_10000000' });
    expect((await h.call('PATCH', `/api/products/${p.json.id}`, { token: u.token, body: { taxCode: 'bad' } })).status).toBe(400);

    const arch = await h.call('POST', `/api/products/${p.json.id}/archive`, { token: u.token });
    expect(arch.json).toMatchObject({ status: 'archived' });
    expect((await h.call('GET', '/api/products', { token: u.token })).json.data).toHaveLength(3);
    expect((await h.call('GET', '/api/products?status=archived', { token: u.token })).json.data).toHaveLength(1);
    expect((await h.call('POST', `/api/products/${p.json.id}/prices`, { token: u.token, body: usd(100) })).json.error.code).toBe('PRODUCT_ARCHIVED');
    expect((await h.call('POST', `/api/products/${p.json.id}/restore`, { token: u.token })).json.status).toBe('active');
    expect((await h.call('DELETE', `/api/products/${p.json.id}`, { token: u.token })).status).toBe(404); // no delete route: soft archive only
    const audits = (await h.call('GET', '/api/audit?limit=100', { token: u.token })).json.data.map((a: any) => a.action);
    expect(audits).toEqual(expect.arrayContaining(['product.created', 'product.updated', 'product.archived', 'product.restored']));
  });

  it('prices are immutable: replacing creates a new price, archives the old one and moves the default; the last price cannot be archived', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const p = (await create(h, u.token, { name: 'Kit', price: usd(1000) })).json;
    const old = p.prices[0];
    const replaced = await h.call('POST', `/api/products/${p.id}/prices/${old.id}/replace`, { token: u.token, body: usd(1200) });
    expect(replaced.status).toBe(200);
    expect(replaced.json).toMatchObject({ unitAmount: 1200, active: true });
    const after = (await h.call('GET', `/api/products/${p.id}`, { token: u.token })).json;
    expect(after.defaultPriceId).toBe(replaced.json.id);
    expect(after.prices.find((x: any) => x.id === old.id)).toMatchObject({ active: false, replacedBy: replaced.json.id, unitAmount: 1000 });
    expect((await h.call('POST', `/api/products/${p.id}/prices/${old.id}/replace`, { token: u.token, body: usd(1300) })).json.error.code).toBe('PRICE_ARCHIVED');
    expect((await h.call('POST', `/api/products/${p.id}/prices/${replaced.json.id}/archive`, { token: u.token })).json.error.code).toBe('LAST_PRICE');
    const second = (await h.call('POST', `/api/products/${p.id}/prices`, { token: u.token, body: usd(900) })).json;
    const archived = (await h.call('POST', `/api/products/${p.id}/prices/${replaced.json.id}/archive`, { token: u.token })).json;
    expect(archived.defaultPriceId).toBe(second.id);
    expect((await h.call('PATCH', `/api/products/${p.id}/prices/${second.id}`, { token: u.token, body: { nickname: 'Sale' } })).json.nickname).toBe('Sale');
    const edit = await h.call('PATCH', `/api/products/${p.id}/prices/${second.id}`, { token: u.token, body: { nickname: 'Sale', unitAmount: 5 } });
    expect(edit.json).toMatchObject({ nickname: 'Sale', unitAmount: 900 }); // unknown field ignored: amounts cannot be edited
  });

  it('enforces permissions: viewers read, members write, nobody without a session; custom roles can be limited to reads', async () => {
    const h = await makeHarness();
    const owner = await h.register();
    const viewer = await h.member(owner, 'viewer');
    const member = await h.member(owner, 'member');
    const reader = await h.memberWith(owner, ['products:read']);
    const p = (await create(h, owner.token, { name: 'Kit', price: usd(1000) })).json;
    expect((await h.call('GET', '/api/products')).status).toBe(401);
    expect((await h.call('GET', '/api/products', { token: viewer.token })).status).toBe(200);
    expect((await h.call('GET', `/api/products/${p.id}`, { token: reader.token })).status).toBe(200);
    expect((await create(h, viewer.token, { name: 'x' })).status).toBe(403);
    expect((await create(h, reader.token, { name: 'x' })).status).toBe(403);
    expect((await h.call('PATCH', `/api/products/${p.id}`, { token: viewer.token, body: { name: 'y' } })).status).toBe(403);
    expect((await h.call('POST', `/api/products/${p.id}/archive`, { token: viewer.token })).status).toBe(403);
    expect((await create(h, member.token, { name: 'By member' })).status).toBe(201);
    expect((await h.call('PATCH', '/api/payments/settings', { token: member.token, body: { taxEnabled: true } })).status).toBe(403);
  });

  it('isolates tenants: another workspace gets 404 for products and prices and cannot link them from a page', async () => {
    const h = await makeHarness();
    const a = await h.register();
    const b = await h.register();
    const p = (await create(h, a.token, { name: 'Secret', price: usd(1000) })).json;
    expect((await h.call('GET', `/api/products/${p.id}`, { token: b.token })).status).toBe(404);
    expect((await h.call('PATCH', `/api/products/${p.id}`, { token: b.token, body: { name: 'x' } })).status).toBe(404);
    expect((await h.call('POST', `/api/products/${p.id}/archive`, { token: b.token })).status).toBe(404);
    expect((await h.call('POST', `/api/products/${p.id}/prices/${p.prices[0].id}/replace`, { token: b.token, body: usd(1) })).status).toBe(404);
    expect((await h.call('GET', '/api/products', { token: b.token })).json.data).toHaveLength(0);
    // a page of workspace B that names workspace A's price: the ids are not trusted, the block gets a product of B's own
    const t = await checkoutTarget(h, b.token);
    const page = await editBlocks(h, b.token, t.funnelId, t.salesStepId, (props) => {
      if (!props.orderBump) Object.assign(props, { productId: p.id, priceId: p.prices[0].id });
    });
    const main = page.doc.products.find((x: any) => !x.orderBump);
    expect(main.priceId).not.toBe(p.prices[0].id);
    expect((await h.call('GET', '/api/products', { token: b.token })).json.data.length).toBeGreaterThan(0);
    expect((await h.call('GET', `/api/products/${p.id}`, { token: a.token })).json.orderCount).toBe(0);
  });

  it('answers the page save with server-side prices: the block price follows the catalog, whatever the client sent', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const t = await checkoutTarget(h, u.token);
    const products = (await h.call('GET', '/api/products', { token: u.token })).json.data;
    expect(products.map((x: any) => x.name).sort()).toEqual(['1:1 coaching call (45 min)', 'Done-for-you subject line pack', 'Email Marketing Masterclass']);
    const page = await editBlocks(h, u.token, t.funnelId, t.salesStepId, (props) => {
      props.price = 0.01; // a tampering client
    });
    const main = page.doc.products.find((x: any) => !x.orderBump);
    expect(main.price).toBe(97);
    expect(main.productId).toMatch(/^prd_/);
    expect((await h.call('GET', '/api/products', { token: u.token })).json.data).toHaveLength(3); // linking again created nothing new
  });
});

describe('catalog and checkout (mock provider)', () => {
  it('records product, price and role on orders, prices from the catalog, and keeps the old price on old orders after a replace', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const t = await checkoutTarget(h, u.token);
    const buy = (email: string, extra = {}) => h.call('POST', t.mainPath, { body: { email, bumpBlockIds: [t.bumpId], ...extra } });
    const first = await buy('a@example.com');
    expect(first.status, first.text).toBe(200);
    const orders = await h.deps.db.all<any>('SELECT * FROM orders ORDER BY created_at, id');
    expect(orders.map((o) => [o.amount_cents, o.role, o.quantity, !!o.product_id, !!o.price_id])).toEqual([[9700, 'main', 1, true, true], [1700, 'bump', 1, true, true]]);
    const product = (await h.call('GET', '/api/products', { token: u.token })).json.data.find((x: any) => x.name === 'Email Marketing Masterclass');
    expect(product.orderCount).toBe(1);
    await h.call('POST', `/api/products/${product.id}/prices/${product.prices[0].id}/replace`, { token: u.token, body: usd(12_700) });
    const second = await buy('b@example.com');
    expect(second.json.orders[0].amountCents).toBe(12_700);
    const rows = await h.deps.db.all<any>("SELECT price_id, amount_cents FROM orders WHERE product_id = ? ORDER BY created_at, id", product.id);
    expect(rows[0]).toMatchObject({ price_id: product.prices[0].id, amount_cents: 9700 });
    expect(rows[1].price_id).not.toBe(product.prices[0].id);
  });

  it('an archived product refuses checkout with a friendly message while the page still renders; restoring reopens it', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const t = await checkoutTarget(h, u.token);
    const product = (await h.call('GET', '/api/products', { token: u.token })).json.data.find((x: any) => x.name === 'Email Marketing Masterclass');
    await h.call('POST', `/api/products/${product.id}/archive`, { token: u.token });
    const r = await h.call('POST', t.mainPath, { body: { email: 'a@example.com' } });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', message: 'This product is no longer available' });
    const html = await h.call('GET', `/api/funnels/${t.funnelId}/steps/${t.salesStepId}/html`, { token: u.token });
    expect(html.status).toBe(200);
    expect(html.json.html).toContain('Email Marketing Masterclass');
    // saving the page again keeps it as it was (no new product, still refused)
    await editBlocks(h, u.token, t.funnelId, t.salesStepId, () => undefined);
    expect((await h.call('GET', '/api/products?status=all', { token: u.token })).json.data).toHaveLength(3);
    expect((await h.call('POST', t.mainPath, { body: { email: 'a@example.com' } })).status).toBe(409);
    await h.call('POST', `/api/products/${product.id}/restore`, { token: u.token });
    expect((await h.call('POST', t.mainPath, { body: { email: 'a@example.com' } })).status).toBe(200);
    // an archived bump is refused too, naming the bump
    const bump = (await h.call('GET', '/api/products', { token: u.token })).json.data.find((x: any) => x.name.startsWith('Done-for-you'));
    await h.call('POST', `/api/products/${bump.id}/archive`, { token: u.token });
    expect((await h.call('POST', t.mainPath, { body: { email: 'a@example.com', bumpBlockIds: [t.bumpId] } })).json.error.code).toBe('PRODUCT_UNAVAILABLE');
  });

  it('refuses an order that mixes currencies, and a subscription as a one-click offer', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const t = await checkoutTarget(h, u.token);
    const eur = (await create(h, u.token, { name: 'Euro bump', price: { currency: 'EUR', amount: 9 } })).json;
    await editBlocks(h, u.token, t.funnelId, t.salesStepId, (props) => {
      if (props.orderBump) Object.assign(props, { productId: eur.id, priceId: eur.prices[0].id });
    });
    const r = await h.call('POST', t.mainPath, { body: { email: 'a@example.com', bumpBlockIds: [t.bumpId] } });
    expect(r.json.error.code).toBe('MIXED_CURRENCY');
    expect((await h.call('POST', t.mainPath, { body: { email: 'a@example.com' } })).status).toBe(200); // without the bump it is fine
    const sub = (await create(h, u.token, { name: 'Monthly club', type: 'subscription', price: { currency: 'USD', amount: 19, interval: 'month' } })).json;
    await editBlocks(h, u.token, t.funnelId, t.upsellStepId, (props) => Object.assign(props, { productId: sub.id, priceId: sub.prices[0].id }));
    const main = await h.call('POST', t.mainPath, { body: { email: 'c@example.com' } });
    const up = await h.call('POST', t.upsellPath, { body: { previousOrderId: main.json.orderId } });
    expect(up.json.error.code).toBe('SUBSCRIPTION_UPSELL_UNSUPPORTED');
  });

  it('sells quantities only where the block allows them, within its range, and multiplies the catalog price', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const t = await checkoutTarget(h, u.token);
    const buy = (quantity?: number) => h.call('POST', t.mainPath, { body: { email: 'q@example.com', quantity } });
    expect((await buy(3)).json.error.code).toBe('INVALID_QUANTITY'); // not enabled
    await editBlocks(h, u.token, t.funnelId, t.salesStepId, (props) => {
      if (!props.orderBump) props.quantity = { enabled: true, min: 1, max: 5, default: 1 };
    });
    expect((await buy(6)).json.error.code).toBe('INVALID_QUANTITY');
    const ok = await buy(3);
    expect(ok.json.orders[0]).toMatchObject({ amountCents: 29_100 });
    expect((await h.deps.db.get<any>('SELECT quantity FROM orders WHERE id = ?', ok.json.orderId)).quantity).toBe(3);
    expect((await buy(1)).status).toBe(200);
  });

  it('zero-decimal and three-decimal currencies are charged in their own minor units', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const t = await checkoutTarget(h, u.token);
    const yen = (await create(h, u.token, { name: 'Yen course', price: { currency: 'JPY', amount: 4980 } })).json;
    const page = await editBlocks(h, u.token, t.funnelId, t.salesStepId, (props) => {
      if (!props.orderBump) Object.assign(props, { productId: yen.id, priceId: yen.prices[0].id });
    });
    expect(page.doc.products.find((x: any) => !x.orderBump)).toMatchObject({ price: 4980, currency: 'JPY' });
    const r = await h.call('POST', t.mainPath, { body: { email: 'jp@example.com' } });
    expect(r.json.orders[0]).toMatchObject({ amountCents: 4980, currency: 'JPY' });
    const list = (await h.call('GET', '/api/orders', { token: u.token })).json.data;
    expect(list[0]).toMatchObject({ amount: 4980, currency: 'JPY' }); // not 49.80
    const csv = await h.call('GET', '/api/orders/export', { token: u.token });
    expect(csv.text).toContain(',4980,JPY,');
  });

  it('backfills catalog products from pages and orders made before the catalog existed (once)', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const t = await checkoutTarget(h, u.token);
    await h.call('POST', t.mainPath, { body: { email: 'old@example.com' } });
    // simulate the pre-catalog state: no products, no links, orders without product ids
    const unlink = (json: string) => json.replace(/"productId":"[^"]+",?/g, '').replace(/"priceId":"[^"]+",?/g, '');
    for (const row of await h.deps.db.all<{ step_id: string; doc_json: string }>('SELECT step_id, doc_json FROM step_pages')) await h.deps.db.run('UPDATE step_pages SET doc_json = ? WHERE step_id = ?', unlink(row.doc_json), row.step_id);
    await h.deps.db.run('UPDATE orders SET product_id = NULL, price_id = NULL, role = NULL');
    await h.deps.db.run('DELETE FROM prices');
    await h.deps.db.run('DELETE FROM products');
    await h.deps.db.run('DELETE FROM catalog_backfill');
    const res = await backfillCatalog(h.deps);
    expect(res.workspaces).toBe(1);
    expect(res.pages).toBeGreaterThanOrEqual(2);
    expect((await h.call('GET', '/api/products', { token: u.token })).json.data.map((x: any) => x.name).sort()).toEqual(['1:1 coaching call (45 min)', 'Done-for-you subject line pack', 'Email Marketing Masterclass']);
    const o = await h.deps.db.get<any>('SELECT product_id, role FROM orders');
    expect(o.product_id).toMatch(/^prd_/);
    expect(o.role).toBe('main');
    expect(await backfillCatalog(h.deps)).toEqual({ workspaces: 0, pages: 0, orders: 0 }); // idempotent
    expect((await h.call('POST', t.mainPath, { body: { email: 'new@example.com' } })).status).toBe(200);
  });
});

describe('Stripe catalog sync (fake Stripe)', () => {
  it('shows not_connected without an account, then pushes products and prices with idempotency keys when connected', async () => {
    const { h, owner, stripe } = await world();
    const p = (await create(h, owner.token, { name: 'Course', description: 'Learn', price: usd(9900) })).json;
    expect(p.stripe.syncState).toBe('not_connected');
    expect(stripe.calls.filter((c) => /products|prices/.test(c.path))).toHaveLength(0);
    await h.call('POST', '/api/billing/connect/start', { token: owner.token });
    stripe.enable([...stripe.accounts.keys()][0]!);
    const all = (await h.call('POST', '/api/products/sync', { token: owner.token })).json;
    expect(all).toMatchObject({ connected: true, synced: 1, failed: 0 });
    const got = (await h.call('GET', `/api/products/${p.id}`, { token: owner.token })).json;
    expect(got.stripe).toMatchObject({ syncState: 'synced', productId: expect.stringMatching(/^prod_/) });
    expect(got.prices[0].stripe.priceId).toMatch(/^price_/);
    const [pc] = stripe.called('POST', /\/v1\/products$/);
    expect(pc!.account).toBe([...stripe.accounts.keys()][0]);
    expect(pc!.idempotencyKey).toMatch(/^prd:prd_/);
    expect(pc!.params).toMatchObject({ name: 'Course', description: 'Learn', active: 'true', 'metadata[funnels_workspace_id]': owner.wsId });
    const [prc] = stripe.called('POST', /\/v1\/prices$/);
    expect(prc!.params).toMatchObject({ currency: 'usd', unit_amount: '9900', product: got.stripe.productId });
    expect(prc!.idempotencyKey).toMatch(/^prc:prc_/);
    expect(stripe.products.get(got.stripe.productId)!.default_price).toBe(got.prices[0].stripe.priceId);
    // a second sync pushes nothing new
    const before = stripe.calls.length;
    expect((await h.call('POST', '/api/products/sync', { token: owner.token })).json.synced).toBe(0);
    expect(stripe.calls.length).toBe(before);
  });

  it('syncs on change when connected: edits update the product, a changed amount creates a new price and archives the old one, archive and restore propagate', async () => {
    const { h, owner, stripe } = await world();
    await h.call('POST', '/api/billing/connect/start', { token: owner.token });
    stripe.enable([...stripe.accounts.keys()][0]!);
    const p = (await create(h, owner.token, { name: 'Course', price: { currency: 'EUR', amount: 50, nickname: 'Standard' } })).json;
    expect(p.stripe.syncState).toBe('synced');
    const sp = stripe.products.get(p.stripe.productId)!;
    const oldStripePrice = p.prices[0].stripe.priceId;
    await h.call('PATCH', `/api/products/${p.id}`, { token: owner.token, body: { name: 'Course 2', description: 'New text' } });
    expect(sp).toMatchObject({ name: 'Course 2', description: 'New text' });
    const rep = (await h.call('POST', `/api/products/${p.id}/prices/${p.prices[0].id}/replace`, { token: owner.token, body: { currency: 'EUR', amount: 60 } })).json;
    expect(stripe.prices.get(oldStripePrice)!.active).toBe(false);
    expect(stripe.prices.get(rep.stripe.priceId ?? (await h.call('GET', `/api/products/${p.id}`, { token: owner.token })).json.prices.find((x: any) => x.active).stripe.priceId)).toMatchObject({ unit_amount: 6000, active: true });
    expect(stripe.calls.some((c) => /\/v1\/prices\/price_/.test(c.path) && 'unit_amount' in c.params)).toBe(false); // Stripe prices are never edited
    expect(sp.default_price).toBe((await h.call('GET', `/api/products/${p.id}`, { token: owner.token })).json.prices.find((x: any) => x.active).stripe.priceId);
    await h.call('POST', `/api/products/${p.id}/archive`, { token: owner.token });
    expect(sp.active).toBe(false);
    await h.call('POST', `/api/products/${p.id}/restore`, { token: owner.token });
    expect(sp.active).toBe(true);
  });

  it('a Stripe failure never blocks the catalog: the product is saved, marked error, and a later sync recovers it', async () => {
    const { h, owner, stripe } = await world();
    await h.call('POST', '/api/billing/connect/start', { token: owner.token });
    stripe.enable([...stripe.accounts.keys()][0]!);
    stripe.down = true;
    const p = await create(h, owner.token, { name: 'Course', price: usd(1000) });
    expect(p.status).toBe(201);
    expect(p.json.stripe).toMatchObject({ syncState: 'error', error: expect.any(String) });
    stripe.down = false;
    const r = await h.call('POST', `/api/products/${p.json.id}/sync`, { token: owner.token });
    expect(r.json.result).toBe('synced');
    expect(r.json.product.stripe).toMatchObject({ syncState: 'synced', error: null });
    expect(stripe.products.size).toBe(1);
  });

  it('forgets Stripe ids when the workspace connects a different account, then creates the objects there', async () => {
    const { h, owner, stripe } = await world();
    await h.call('POST', '/api/billing/connect/start', { token: owner.token });
    const first = [...stripe.accounts.keys()][0]!;
    stripe.enable(first);
    const p = (await create(h, owner.token, { name: 'Course', price: usd(1000) })).json;
    await h.call('POST', '/api/billing/connect/disconnect', { token: owner.token });
    await h.deps.db.run("UPDATE products SET sync_status = 'pending' WHERE id = ?", p.id);
    // disconnected: nothing attempted, and the state says so
    expect((await h.call('GET', `/api/products/${p.id}`, { token: owner.token })).json.stripe.syncState).toBe('not_connected');
    await h.call('POST', '/api/billing/connect/start', { token: owner.token });
    const second = 'acct_second';
    stripe.accounts.set(second, { ...stripe.accounts.get(first)! , id: second });
    await h.deps.db.run('UPDATE stripe_accounts SET stripe_account_id = ?', second); // the workspace is now connected to another Stripe account
    const r = await h.call('POST', `/api/products/${p.id}/sync`, { token: owner.token });
    expect(r.json.result).toBe('synced');
    expect([...stripe.products.values()].filter((x) => x.account === second)).toHaveLength(1);
  });

  it('reconciles product and price events from Stripe: archive in the dashboard archives here; renames apply; deletes archive and unlink', async () => {
    const { h, owner, stripe, hook } = await world();
    await h.call('POST', '/api/billing/connect/start', { token: owner.token });
    const acct = [...stripe.accounts.keys()][0]!;
    stripe.enable(acct);
    const p = (await create(h, owner.token, { name: 'Course', price: usd(1000) })).json;
    const sid = p.stripe.productId;
    const price = p.prices[0].stripe.priceId;
    expect((await hook('connect', 'product.updated', { id: sid, name: 'Renamed in Stripe', active: true }, { account: acct })).status).toBe(200);
    expect((await h.call('GET', `/api/products/${p.id}`, { token: owner.token })).json.name).toBe('Renamed in Stripe');
    expect((await hook('connect', 'product.updated', { id: sid, name: 'Renamed in Stripe', active: false }, { account: acct })).status).toBe(200);
    expect((await h.call('GET', `/api/products/${p.id}`, { token: owner.token })).json.status).toBe('archived');
    await h.call('POST', `/api/products/${p.id}/restore`, { token: owner.token });
    expect((await hook('connect', 'price.updated', { id: price, active: false }, { account: acct })).status).toBe(200);
    expect((await h.deps.db.get<any>('SELECT active FROM prices WHERE id = ?', p.prices[0].id)).active).toBe(0);
    // events of an unknown object or another account change nothing
    expect((await hook('connect', 'product.updated', { id: 'prod_unknown', name: 'x', active: false }, { account: acct })).status).toBe(200);
    expect((await hook('connect', 'product.updated', { id: sid, name: 'Hijack', active: false }, { account: 'acct_other' })).status).toBe(200);
    expect((await h.call('GET', `/api/products/${p.id}`, { token: owner.token })).json.name).toBe('Renamed in Stripe');
    expect((await hook('connect', 'product.deleted', { id: sid }, { account: acct })).status).toBe(200);
    const gone = (await h.call('GET', `/api/products/${p.id}`, { token: owner.token })).json;
    expect(gone).toMatchObject({ status: 'archived', stripe: { productId: null } });
  });
});

describe('Stripe hosted checkout from the catalog', () => {
  it('uses the synced Stripe price, charges what the catalog says, and records the product on the orders', async () => {
    const { h, owner, buy, pay, hook, orders, stripe, acct, t } = await store();
    await h.call('POST', '/api/products/sync', { token: owner.token });
    await buy();
    const call = stripe.called('POST', /checkout\/sessions$/).at(-1)!;
    expect(call.params['line_items[0][price]']).toMatch(/^price_/);
    expect(call.params['line_items[0][price_data][unit_amount]']).toBeUndefined();
    expect(call.params['line_items[0][quantity]']).toBe('1');
    const { sid } = await pay();
    await hook('connect', 'checkout.session.completed', { id: sid }, { account: acct });
    const rows = await orders();
    expect(rows).toHaveLength(2);
    expect((await h.deps.db.all<any>('SELECT product_id, price_id, role, amount_cents FROM orders ORDER BY created_at, id')).map((r) => [!!r.product_id, !!r.price_id, r.role, r.amount_cents])).toEqual([[true, true, 'main', 9700], [true, true, 'bump', 1700]]);
    expect(t.bumpId).toBeTruthy();
  });

  it('a price changed mid-checkout: the visitor who started pays the old price (recorded on the order), the next visitor the new one', async () => {
    const { h, owner, buy, pay, hook, stripe, acct } = await store();
    const first = await pay('early@example.com');
    const product = (await h.call('GET', '/api/products', { token: owner.token })).json.data.find((x: any) => x.name === 'Email Marketing Masterclass');
    const oldPrice = product.prices[0].id;
    await h.call('POST', `/api/products/${product.id}/prices/${oldPrice}/replace`, { token: owner.token, body: usd(14_700) });
    await hook('connect', 'checkout.session.completed', { id: first.sid }, { account: acct });
    expect((await h.deps.db.get<any>("SELECT amount_cents, price_id FROM orders WHERE email = 'early@example.com' AND is_bump = 0"))).toMatchObject({ amount_cents: 9700, price_id: oldPrice });
    await buy('late@example.com');
    const call = stripe.called('POST', /checkout\/sessions$/).at(-1)!;
    expect(Number(call.params['line_items[0][price_data][unit_amount]'] ?? stripe.prices.get(call.params['line_items[0][price]']!)!.unit_amount)).toBe(14_700);
  });

  it('promotion codes: asks Stripe for the field when the block allows it and records the discounted amounts exactly (discount spread over the lines)', async () => {
    const { h, owner, t, pay, hook, orders, stripe, acct } = await store();
    await editBlocks(h, owner.token, t.funnelId, t.salesStepId, (props) => {
      if (!props.orderBump) props.allowPromotionCodes = true;
    });
    const paid = async (email: string, discount: number) => {
      const r = await h.call('POST', t.mainPath, { body: { email, bumpBlockIds: [t.bumpId] }, headers: DESKTOP });
      expect(r.status, r.text).toBe(200);
      const sid = [...stripe.sessions.keys()].at(-1)!;
      stripe.pay(sid, { discount });
      await hook('connect', 'checkout.session.completed', { id: sid }, { account: acct });
      return sid;
    };
    const sid = await paid('promo@example.com', 1_000);
    expect(stripe.sessions.get(sid)!.params.allow_promotion_codes).toBe('true');
    const rows = await h.deps.db.all<any>("SELECT amount_cents, discount_cents FROM orders WHERE email = 'promo@example.com' ORDER BY created_at, id");
    expect(rows.reduce((a, r) => a + r.amount_cents, 0)).toBe(9700 + 1700 - 1000);
    expect(rows.reduce((a, r) => a + r.discount_cents, 0)).toBe(1000);
    expect(rows[0]!.discount_cents).toBe(851); // proportional: 1000 x 9700 / 11400
    expect(await orders()).toHaveLength(2);
  });

  it('refuses to record a payment whose total does not match what the server stored', async () => {
    const { h, buy, hook, stripe, acct, orders } = await store();
    await buy();
    const sid = [...stripe.sessions.keys()].at(-1)!;
    stripe.pay(sid);
    stripe.sessions.get(sid)!.amount_total -= 500; // a discount Stripe did not report in total_details
    expect((await hook('connect', 'checkout.session.completed', { id: sid }, { account: acct })).status).toBe(409);
    expect(await orders()).toHaveLength(0);
    expect(h).toBeTruthy();
  });

  it('subscriptions: a recurring price makes a subscription-mode session (one-time bump rides along), a trial records a zero-amount first order, and refunds point to Stripe', async () => {
    const { h, owner, t, hook, stripe, acct } = await store();
    const club = (await create(h, owner.token, { name: 'Club', type: 'subscription', price: { currency: 'USD', amount: 29, interval: 'month', trialDays: 14 } })).json;
    const page = await editBlocks(h, owner.token, t.funnelId, t.salesStepId, (props) => {
      if (!props.orderBump) Object.assign(props, { productId: club.id, priceId: club.prices[0].id });
    });
    expect(page.doc.products.find((x: any) => !x.orderBump)).toMatchObject({ price: 29, interval: 'month', trialDays: 14 });
    const r = await h.call('POST', t.mainPath, { body: { email: 'sub@example.com', bumpBlockIds: [t.bumpId] }, headers: DESKTOP });
    expect(r.status, r.text).toBe(200);
    const sid = [...stripe.sessions.keys()].at(-1)!;
    const p = stripe.sessions.get(sid)!.params;
    expect(p).toMatchObject({ mode: 'subscription', 'subscription_data[trial_period_days]': '14' });
    expect(stripe.prices.get(p['line_items[0][price]']!)!.recurring).toMatchObject({ interval: 'month', trial_period_days: 14 });
    expect(p.customer_creation).toBeUndefined();
    expect(p['payment_intent_data[application_fee_amount]']).toBeUndefined();
    expect(p['subscription_data[application_fee_percent]']).toBe('5');
    stripe.pay(sid);
    await hook('connect', 'checkout.session.completed', { id: sid }, { account: acct });
    const rows = await h.deps.db.all<any>("SELECT amount_cents, provider_ref, role FROM orders WHERE email = 'sub@example.com' ORDER BY created_at, id");
    expect(rows.map((x) => x.amount_cents)).toEqual([0, 0]); // trial: nothing charged yet
    expect(rows[0].provider_ref).toMatch(/^sub:sub_/);
    const refund = await h.call('POST', `/api/orders/${(await h.deps.db.get<any>("SELECT id FROM orders WHERE email = 'sub@example.com' AND role = 'main'")).id}/refund`, { token: owner.token });
    expect(refund.json.error.code).toBe('REFUND_IN_STRIPE');
  });

  it('refuses subscriptions with different billing intervals in one order', async () => {
    const { h, owner, t } = await store();
    const monthly = (await create(h, owner.token, { name: 'Monthly', type: 'subscription', price: { currency: 'USD', amount: 9, interval: 'month' } })).json;
    const yearly = (await create(h, owner.token, { name: 'Yearly', type: 'subscription', price: { currency: 'USD', amount: 90, interval: 'year' } })).json;
    await editBlocks(h, owner.token, t.funnelId, t.salesStepId, (props) => Object.assign(props, props.orderBump ? { productId: yearly.id, priceId: yearly.prices[0].id } : { productId: monthly.id, priceId: monthly.prices[0].id }));
    const r = await h.call('POST', t.mainPath, { body: { email: 'x@example.com', bumpBlockIds: [t.bumpId] }, headers: DESKTOP });
    expect(r.json.error.code).toBe('MIXED_INTERVAL');
  });

  it('sends zero-decimal amounts to Stripe unchanged', async () => {
    const { h, owner, t, buy, stripe } = await store();
    const yen = (await create(h, owner.token, { name: 'Yen', price: { currency: 'JPY', unitAmount: 4980 } })).json;
    const bumpYen = (await create(h, owner.token, { name: 'Yen bump', price: { currency: 'JPY', unitAmount: 500 } })).json;
    await editBlocks(h, owner.token, t.funnelId, t.salesStepId, (props) => Object.assign(props, props.orderBump ? { productId: bumpYen.id, priceId: bumpYen.prices[0].id } : { productId: yen.id, priceId: yen.prices[0].id }));
    const r = await buy();
    expect(r.status, r.text).toBe(200);
    const p = stripe.called('POST', /checkout\/sessions$/).at(-1)!.params;
    const lines = [0, 1].map((i) => stripe.prices.get(p[`line_items[${i}][price]`]!)!);
    expect(lines.map((l) => [l.currency, l.unit_amount])).toEqual([['jpy', 4980], ['jpy', 500]]);
  });
});
