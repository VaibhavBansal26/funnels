import { describe, expect, it } from 'vitest';
import { normalizeDoc, remapStepRefs, type ProjectDoc } from '../src/pagemodel/doc.js';
import { renderProject } from '../src/pagemodel/render.js';
import { createPageBuilder } from '../src/pagemodel/shared/build.js';
import { catalogCards, catalogInner, type CatalogItem, type MarkupCtx } from '../src/pagemodel/shared/markup.js';
import { CatalogPropsSchema, type CatalogProps } from '../src/pagemodel/shared/props.js';
import { stripCatalogLinks } from '../src/services/catalogdoc.js';
import { makeHarness } from './helpers.js';
import { DESKTOP, opId } from './support/shopworld.js';

// The Product catalog block (docs/PRODUCTS.md#product-catalog-block, ADR 0048): rendered from the catalog, adds through the cart's add path.

const props = (p: Partial<CatalogProps> = {}): CatalogProps => CatalogPropsSchema.parse(p);
const item = (id: string, name: string, amount: number, createdAt: string, over: Partial<CatalogItem> = {}): CatalogItem => ({
  id, name, description: `${name} description`, image: null, imageAlt: '', createdAt, defaultPriceId: `${id}_p`, prices: [{ id: `${id}_p`, amount, currency: 'USD' }], ...over,
});
const ctx = (catalog?: CatalogItem[], mode: MarkupCtx['mode'] = 'live'): MarkupCtx => ({ mode, funnelId: 'fun_1', stepId: 'stp_1', nextHref: '/next', stepHref: (id) => (id === 'stp_pay' ? '/pay' : undefined), catalog });
const names = (html: string) => [...html.matchAll(/<h3 class="fn-catalog-name">([^<]+)</g)].map((m) => m[1]);

describe('Product catalog markup (pure)', () => {
  const items = [item('prd_banana', 'Banana', 12, '2026-01-01'), item('prd_apple1', 'Apple', 30, '2026-01-03'), item('prd_cherry', 'Cherry', 5, '2026-01-02')];

  it('sorts all products by catalog order, price both ways and newest, and caps at the limit', () => {
    const order = (sort: CatalogProps['sort'], limit = 12) => catalogCards(props({ sort, limit }), items).map((c) => c.item.name);
    expect(order('catalog')).toEqual(['Banana', 'Cherry', 'Apple']);
    expect(order('price_asc')).toEqual(['Cherry', 'Banana', 'Apple']);
    expect(order('price_desc')).toEqual(['Apple', 'Banana', 'Cherry']);
    expect(order('newest')).toEqual(['Apple', 'Cherry', 'Banana']);
    expect(order('price_asc', 2)).toEqual(['Cherry', 'Banana']);
  });

  it('keeps hand-picked products in the order picked, skips the ones that are not sellable, and follows a replaced picked price', () => {
    const withTwo = [...items, item('prd_date01', 'Date', 8, '2026-01-04', { prices: [{ id: 'prc_eur001', amount: 7, currency: 'EUR' }, { id: 'prc_usd001', amount: 8, currency: 'USD', replaces: ['prc_old001'] }], defaultPriceId: 'prc_eur001' })];
    const picked = catalogCards(props({ source: 'picked', picks: [{ productId: 'prd_date01', priceId: 'prc_old001' }, { productId: 'prd_gone01' }, { productId: 'prd_banana' }] }), withTwo);
    expect(picked.map((c) => [c.item.name, c.price.id])).toEqual([['Date', 'prc_usd001'], ['Banana', 'prd_banana_p']]);
    expect(catalogCards(props({ source: 'picked', picks: [{ productId: 'prd_date01' }] }), withTwo)[0]!.price.id).toBe('prc_eur001'); // the default price
  });

  it('renders accessible cards: a list, a heading per product, a form per card and a button named with the product', () => {
    const html = catalogInner('cat1', props({ columns: 2, quantity: { enabled: true, min: 1, max: 3, default: 1 } }), ctx(items));
    expect(html).toContain('class="fn-catalog fn-catalog-c2"');
    expect(html).toContain('<ul class="fn-catalog-grid" aria-label="Products">');
    expect(names(html)).toEqual(['Banana', 'Cherry', 'Apple']);
    expect(html).toContain('aria-label="Add Banana to the cart"');
    expect(html).toContain('<button class="fn-btn fn-btn-primary fn-btn-block" type="submit" aria-label="Add to cart: Banana">Add to cart</button>');
    expect(html).toContain('data-product="prd_banana"');
    expect(html).toContain('action="/api/public/cart/fun_1/stp_1/cat1/add"');
    expect(html).toContain('<label for="cat-cat1-0-qty">Quantity</label><select id="cat-cat1-0-qty" name="quantity">');
    expect(html).toContain('<p class="fn-catalog-price">$12.00</p>');
    // Unique ids across cards (labels point at the right select).
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('honours the image, description and price toggles; images carry their alt text; unsafe images are dropped', () => {
    const pics = [item('prd_banana', 'Mug', 12, '1', { image: '/uploads/ast_1/mug.png', imageAlt: 'A white mug' }), item('prd_apple1', 'Tee', 9, '2', { image: 'javascript:alert(1)' })];
    const on = catalogInner('c', props(), ctx(pics));
    expect(on).toContain('<img class="fn-catalog-img" src="/uploads/ast_1/mug.png" alt="A white mug" loading="lazy"');
    expect(on).not.toContain('javascript:');
    expect(on).toContain('fn-catalog-noimg'); // no usable image: a placeholder keeps the grid even
    expect(on).toContain('Mug description');
    const off = catalogInner('c', props({ showImage: false, showDescription: false, showPrice: false }), ctx(pics));
    expect(off).not.toContain('fn-catalog-img');
    expect(off).not.toContain('Mug description');
    expect(off).not.toContain('fn-catalog-price');
  });

  it('Buy now goes to the chosen checkout step (default: the next step); Add to cart follows "after adding"', () => {
    expect(catalogInner('c', props({ action: 'buy', buttonLabel: 'Buy now', checkoutStepId: 'stp_pay' }), ctx(items))).toContain('data-href="/pay"');
    expect(catalogInner('c', props({ action: 'buy', buttonLabel: 'Buy now' }), ctx(items))).toContain('data-href="/next"');
    expect(catalogInner('c', props({ then: { type: 'stay' } }), ctx(items))).not.toContain('data-href');
    expect(catalogInner('c', props({ then: { type: 'step', stepId: 'stp_pay' } }), ctx(items))).toContain('data-href="/pay"');
  });

  it('escapes product content and shows the empty text; the builder shows labelled samples only when there is nothing to list', () => {
    const evil = [item('prd_xxxxxx', '<img src=x onerror=alert(1)>', 1, '1', { description: '"><script>alert(1)</script>' })];
    const html = catalogInner('c', props(), ctx(evil));
    expect(html).not.toMatch(/<script|<img src=x/);
    expect(catalogInner('c', props({ emptyText: 'Back soon' }), ctx([]))).toContain('<p class="fn-catalog-empty">Back soon</p>');
    expect(catalogInner('c', props(), ctx(undefined))).toContain('fn-catalog-empty');
    const sample = catalogInner('c', props(), ctx([], 'builder'));
    expect(names(sample)).toEqual(['Sample product', 'Another product', 'Third product']);
    expect(sample).toContain('Sample products (editor only)');
    expect(names(catalogInner('c', props(), ctx(items, 'builder')))).toEqual(['Banana', 'Cherry', 'Apple']);
  });

  it('the page renders it with the commerce runtime (not the beacon) and passes the page sanitiser', () => {
    const pm = createPageBuilder('t');
    const project = pm.project([pm.section([pm.stack([pm.catalog('shop')])])]);
    const { html, body } = renderProject(project, { funnelId: 'fun_1', stepId: 'stp_1', stepName: 'Shop', catalog: items });
    expect(names(body)).toEqual(['Banana', 'Cherry', 'Apple']);
    expect(body).toContain('data-product="prd_banana"'); // survives sanitizePageBody
    expect(body).toContain('aria-label="Add to cart: Banana"');
    expect(html).toContain('data-fn-commerce');
  });

  it('validates its settings: 1-4 columns, at most 24 items, a sensible quantity', () => {
    expect(CatalogPropsSchema.safeParse({ columns: 5 }).success).toBe(false);
    expect(CatalogPropsSchema.safeParse({ limit: 25 }).success).toBe(false);
    expect(CatalogPropsSchema.safeParse({ quantity: { enabled: true, min: 5, max: 2, default: 3 } }).success).toBe(false);
    expect(CatalogPropsSchema.safeParse({ picks: [{}] }).success).toBe(false);
    expect(CatalogPropsSchema.parse({})).toMatchObject({ source: 'all', sort: 'catalog', limit: 12, columns: 3, action: 'add', then: { type: 'stay' } });
  });

  it('template export keeps slot picks and drops workspace ids; step references follow a copy', () => {
    const pm = createPageBuilder('t');
    const doc = (c: Partial<CatalogProps>): ProjectDoc => {
      const r = normalizeDoc({ version: 2, project: pm.project([pm.section([pm.stack([pm.catalog('cat', c)])])]) });
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      return r.doc;
    };
    const picks = (d: ProjectDoc) => (d.commerce ?? []).find((c) => c.type === 'catalog') as Extract<NonNullable<ProjectDoc['commerce']>[number], { type: 'catalog' }>;
    const slotted = stripCatalogLinks(doc({ source: 'picked', picks: [{ slot: 'green', productId: 'prd_abcdefgh', priceId: 'prc_abcdefgh' }] }));
    expect(picks(slotted)).toMatchObject({ source: 'picked', picks: [{ slot: 'green' }] });
    expect(JSON.stringify(slotted)).not.toContain('prd_abcdefgh');
    expect(picks(stripCatalogLinks(doc({ source: 'picked', picks: [{ productId: 'prd_abcdefgh' }] })))).toMatchObject({ source: 'all', picks: [] });
    const moved = remapStepRefs(doc({ action: 'buy', checkoutStepId: 'old_pay', then: { type: 'step', stepId: 'old_cart' } }), new Map([['old_pay', 'new_pay']]));
    const node = JSON.stringify(moved.project);
    expect(node).toContain('"checkoutStepId":"new_pay"');
    expect(node).toContain('"then":{"type":"next_step"}');
  });
});

// ---- through the API ------------------------------------------------------------------------------------------------------------------------------------

async function world(env: Record<string, string> = {}) {
  const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', PUBLIC_FORMS_PER_MINUTE: '100000', PUBLIC_CART_PER_MINUTE: '100000', ...env } });
  const owner = await h.register();
  const token = owner.token;
  const product = async (name: string, amount: number, extra: Record<string, unknown> = {}, price: Record<string, unknown> = {}) => {
    const r = await h.call('POST', '/api/products', { token, body: { name, description: `About ${name}`, price: { currency: 'USD', amount, ...price }, ...extra } });
    expect(r.status, r.text).toBe(201);
    return { productId: r.json.id as string, priceId: r.json.prices[0].id as string };
  };
  const mug = await product('Mug', 24, { images: ['/uploads/ast_mug1/mug.png'], imageAlt: 'A white enamel mug' });
  h.clock.advance(1000);
  const tee = await product('T-shirt', 12);
  h.clock.advance(1000);
  const club = await product('Coffee club', 9, { type: 'subscription' }, { interval: 'month' });
  h.clock.advance(1000);
  const poster = await product('Euro poster', 10, {}, { currency: 'EUR' });
  const f = (await h.call('POST', '/api/funnels', { token, body: { name: 'Shop' } })).json;
  const step = (await h.call('GET', `/api/funnels/${f.id}/steps`, { token })).json.data[0];
  const pay = (await h.call('POST', `/api/funnels/${f.id}/steps`, { token, body: { name: 'Pay', base_path: '/pay' } })).json;
  const save = async (c: Partial<CatalogProps>) => {
    const pm = createPageBuilder('s');
    const project = pm.project([pm.section([pm.stack([pm.catalog('cat', c)])])]);
    const cur = (await h.call('GET', `/api/funnels/${f.id}/steps/${step.id}/page`, { token })).json;
    const r = await h.call('PUT', `/api/funnels/${f.id}/steps/${step.id}/page`, { token, body: { doc: { version: 2, project }, version: cur.version } });
    expect(r.status, r.text).toBe(200);
  };
  const html = async () => (await h.call('GET', `/api/funnels/${f.id}/steps/${step.id}/html`, { token })).json.html as string;
  const visitorId = `v${Math.random().toString(36).slice(2, 12)}`;
  let cart: string | undefined;
  const add = async (body: Record<string, unknown>) => {
    const r = await h.call('POST', `/api/public/cart/${f.id}/${step.id}/cat/add`, { body: { visitorId, token: cart, opId: opId(), ...body }, headers: DESKTOP });
    if (r.json?.token) cart = r.json.token;
    return r;
  };
  return { h, token, f, step, pay, mug, tee, club, poster, save, html, add };
}

describe('Product catalog block (API)', () => {
  it('lists active one-time products from the catalog: subscriptions, archived products and products without an active one-time price are left out', async () => {
    const w = await world();
    await w.save({ sort: 'price_desc' });
    const html = await w.html();
    expect(names(html)).toEqual(['Mug', 'T-shirt', 'Euro poster']); // 24, 12, 10 (Coffee club is a subscription)
    expect(html).toContain('<img class="fn-catalog-img" src="/uploads/ast_mug1/mug.png" alt="A white enamel mug" loading="lazy"');
    expect(html).toContain('<p class="fn-catalog-price">€10.00</p>');
    expect(html).toContain('/commerce.js');
    await w.h.call('POST', `/api/products/${w.tee.productId}/archive`, { token: w.token });
    expect(names(await w.html())).toEqual(['Mug', 'Euro poster']);
  });

  it('keeps published pages current: a new product, a changed price, an archive or a restore re-renders the page', async () => {
    const w = await world();
    await w.save({ sort: 'catalog' });
    expect(names(await w.html())).toEqual(['Mug', 'T-shirt', 'Euro poster']);
    w.h.clock.advance(5000);
    const lamp = await w.h.call('POST', '/api/products', { token: w.token, body: { name: 'Lamp', price: { currency: 'USD', amount: 40 } } });
    expect(names(await w.html())).toEqual(['Mug', 'T-shirt', 'Euro poster', 'Lamp']);
    await w.h.call('POST', `/api/products/${w.mug.productId}/prices/${w.mug.priceId}/replace`, { token: w.token, body: { currency: 'USD', amount: 30 } });
    expect(await w.html()).toContain('<p class="fn-catalog-price">$30.00</p>');
    await w.h.call('PATCH', `/api/products/${lamp.json.id}`, { token: w.token, body: { name: 'Desk lamp' } });
    expect(names(await w.html())).toContain('Desk lamp');
    await w.h.call('POST', `/api/products/${lamp.json.id}/archive`, { token: w.token });
    expect(names(await w.html())).not.toContain('Desk lamp');
    await w.h.call('POST', `/api/products/${lamp.json.id}/restore`, { token: w.token });
    expect(names(await w.html())).toContain('Desk lamp');
  });

  it('hand-picked products keep their order, and a picked price that was replaced shows its successor', async () => {
    const w = await world();
    await w.save({ source: 'picked', picks: [{ productId: w.tee.productId }, { productId: w.mug.productId, priceId: w.mug.priceId }, { productId: w.club.productId }] });
    expect(names(await w.html())).toEqual(['T-shirt', 'Mug']);
    await w.h.call('POST', `/api/products/${w.mug.productId}/prices/${w.mug.priceId}/replace`, { token: w.token, body: { currency: 'USD', amount: 26 } });
    expect(await w.html()).toContain('<p class="fn-catalog-price">$26.00</p>');
    // Not picked: refused, whatever the page says.
    expect((await w.add({ productId: w.poster.productId })).json.error.code).toBe('PRODUCT_UNAVAILABLE');
    const ok = await w.add({ productId: w.mug.productId });
    expect(ok.json.added).toMatchObject({ name: 'Mug', unitAmount: 2600 });
  });

  it('adds through the cart: the price is re-read from the catalog and anything priced by the request is ignored', async () => {
    const w = await world();
    await w.save({ quantity: { enabled: true, min: 1, max: 5, default: 1 } });
    const r = await w.add({ productId: w.mug.productId, quantity: 2, price: 0.01, amount: 1, unitAmount: 1, priceId: w.tee.priceId, currency: 'EUR' });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ added: { name: 'Mug', productId: w.mug.productId, priceId: w.mug.priceId, quantity: 2, unitAmount: 2400, currency: 'USD', value: 48 } });
    expect(r.json.cart).toMatchObject({ count: 2, subtotal: 4800, currency: 'USD' });
    expect((await w.add({ productId: w.tee.productId, quantity: 6 })).json.error.code).toBe('INVALID_QUANTITY');
    expect((await w.add({})).json.error.code).toBe('PRODUCT_REQUIRED');
    expect((await w.add({ productId: 'prd_doesnotexist' })).json.error.code).toBe('PRODUCT_UNAVAILABLE');
  });

  it('subscriptions are refused, archived products are unavailable and the one-currency rule still holds', async () => {
    const w = await world();
    await w.save({});
    expect((await w.add({ productId: w.club.productId })).json.error.code).toBe('SUBSCRIPTION_NOT_IN_CART');
    await w.h.call('POST', `/api/products/${w.tee.productId}/archive`, { token: w.token });
    expect((await w.add({ productId: w.tee.productId })).json.error.code).toBe('PRODUCT_UNAVAILABLE');
    expect((await w.add({ productId: w.mug.productId })).status).toBe(200);
    const eur = await w.add({ productId: w.poster.productId });
    expect(eur.status).toBe(409);
    expect(eur.json.error.code).toBe('CART_CURRENCY_MISMATCH');
    // A product of another workspace is not this block's to sell.
    const other = await w.h.register();
    const foreign = await w.h.call('POST', '/api/products', { token: other.token, body: { name: 'Theirs', price: { currency: 'USD', amount: 1 } } });
    expect((await w.add({ productId: foreign.json.id })).json.error.code).toBe('PRODUCT_UNAVAILABLE');
  });

  it('records the same add_to_cart event and server-side AddToCart as the Add to cart block; previews record nothing', async () => {
    const w = await world();
    const ig = await w.h.call('POST', '/api/integrations', { token: w.token, body: { provider: 'meta', name: 'm', pixelId: '123456789012345', secret: 'EAAB-secret-token-123456' } });
    expect(ig.status, ig.text).toBe(201);
    await w.save({});
    expect((await w.add({ productId: w.mug.productId, preview: true })).status).toBe(200);
    expect(Number((await w.h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'add_to_cart'"))!.n)).toBe(0);
    const add = (await w.add({ productId: w.mug.productId })).json;
    expect(add.eventId).toMatch(/^atc_/);
    const ev = await w.h.deps.db.all<{ step_id: string; funnel_id: string }>("SELECT step_id, funnel_id FROM events WHERE type = 'add_to_cart'");
    expect(ev).toEqual([{ step_id: w.step.id, funnel_id: w.f.id }]);
    const roll = await w.h.deps.db.get<{ adds: number }>('SELECT SUM(cart_adds) AS adds FROM event_rollups WHERE funnel_id = ?', w.f.id);
    expect(Number(roll!.adds)).toBe(1);
    const conv = await w.h.deps.db.all<{ event_name: string; event_id: string }>('SELECT event_name, event_id FROM conversion_deliveries');
    expect(conv).toEqual([expect.objectContaining({ event_name: 'AddToCart', event_id: add.eventId })]);
  });

  it('Cloudflare bundles and signed previews list the catalog as it is when they are built', async () => {
    const w = await world({ APP_PUBLIC_URL: 'https://app.funnels.test' });
    await w.save({ action: 'buy', buttonLabel: 'Buy now', checkoutStepId: w.pay.id });
    const { buildFunnelBundle } = await import('../src/services/publishing.js');
    const funnel = (await w.h.deps.db.get<any>('SELECT * FROM funnels WHERE id = ?', w.f.id))!;
    const bundle = await buildFunnelBundle(w.h.deps, funnel);
    const index = bundle.files.map((x) => Buffer.from(x.bytes).toString('utf8')).find((t) => t.includes('<ul class="fn-catalog-grid"'))!;
    expect(names(index)).toEqual(['Mug', 'T-shirt', 'Euro poster']);
    expect(index).toContain('action="https://app.funnels.test/api/public/cart/');
    expect(index).toContain('data-href="/pay"');
    expect(bundle.files.some((x) => /commerce/.test(x.path))).toBe(true);
  });

  it('product images have optional alt text in the API', async () => {
    const w = await world();
    const got = (await w.h.call('GET', `/api/products/${w.mug.productId}`, { token: w.token })).json;
    expect(got).toMatchObject({ images: ['/uploads/ast_mug1/mug.png'], imageAlt: 'A white enamel mug' });
    const patched = await w.h.call('PATCH', `/api/products/${w.mug.productId}`, { token: w.token, body: { imageAlt: 'Mug on a table' } });
    expect(patched.json.imageAlt).toBe('Mug on a table');
    expect((await w.h.call('PATCH', `/api/products/${w.mug.productId}`, { token: w.token, body: { imageAlt: 'x'.repeat(301) } })).status).toBe(400);
    expect((await w.h.call('GET', `/api/products/${w.tee.productId}`, { token: w.token })).json.imageAlt).toBe('');
  });
});

