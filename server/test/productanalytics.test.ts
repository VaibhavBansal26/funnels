import { describe, expect, it } from 'vitest';
import { newId } from '../src/util/ids.js';
import { checkoutTarget, makeHarness, seedEvents, type Harness } from './helpers.js';

interface O {
  funnelId: string;
  stepId: string;
  blockId?: string;
  product: { id: string; name: string } | null;
  amount: number;
  currency?: string;
  at: string;
  role?: 'main' | 'bump' | 'upsell' | 'downsell';
  quantity?: number;
  email?: string;
  refunded?: number;
  lost?: number;
  discount?: number;
}

async function order(h: Harness, ws: string, o: O) {
  const role = o.role ?? 'main';
  await h.deps.db.run(
    `INSERT INTO orders (id, workspace_id, funnel_id, step_id, block_id, email, product_name, amount_cents, currency, is_bump, is_upsell, provider, provider_ref, created_at, product_id, quantity, discount_cents, role, refunded_cents, disputed_lost_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mock', ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('ord'), ws, o.funnelId, o.stepId, o.blockId ?? 'blk', o.email ?? `c${Math.random()}@example.com`, o.product?.name ?? 'Legacy item', o.amount, o.currency ?? 'USD', role === 'bump' ? 1 : 0, role === 'upsell' || role === 'downsell' ? 1 : 0,
    `ref_${Math.random()}`, o.at, o.product?.id ?? null, o.quantity ?? 1, o.discount ?? 0, role, o.refunded ?? 0, o.lost ?? 0,
  );
}

async function world(env: Record<string, string> = {}) {
  const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', ANALYTICS_API_PER_MINUTE: '100000', ...env } });
  const owner = await h.register();
  const t = await checkoutTarget(h, owner.token);
  const products = (await h.call('GET', '/api/products', { token: owner.token })).json.data as { id: string; name: string }[];
  const by = (name: string) => products.find((p) => p.name.startsWith(name))!;
  const [main, bump, up] = [by('Email Marketing'), by('Done-for-you'), by('1:1 coaching')];
  const base = { funnelId: t.funnelId, stepId: t.salesStepId };
  const get = async (q = '', token = owner.token) => (await h.call('GET', `/api/analytics/products${q}`, { token })).json;
  const range = 'from=2026-03-01&to=2026-03-31';
  return { h, owner, t, main, bump, up, base, get, range, o: (x: Partial<O> & Pick<O, 'amount' | 'at'>) => order(h, owner.wsId, { ...base, product: main, ...x }) };
}

describe('product analytics: math', () => {
  it('computes orders, units, gross, refunded, disputed lost, net, AOV and refund rate from integer minor units', async () => {
    const w = await world();
    await w.o({ amount: 9700, at: '2026-03-05T10:00:00Z' });
    await w.o({ amount: 9700, at: '2026-03-06T10:00:00Z', refunded: 3000 });
    await w.o({ amount: 10_000, at: '2026-03-07T10:00:00Z', quantity: 2, discount: 500, refunded: 3000, lost: 7000 }); // refund and dispute on one order: nothing left
    const r = await w.get(`?${w.range}`);
    expect(r.totals).toHaveLength(1);
    const p = r.products.find((x: any) => x.productId === w.main.id);
    expect(p).toMatchObject({ currency: 'USD', exponent: 2, orders: 3, units: 4, refundedOrders: 2, discount: 5 });
    // gross = booked minus lost disputes: 97 + 97 + (100 - 70)
    expect(p.gross).toBe(224);
    expect(p.refunded).toBe(60);
    expect(p.disputedLost).toBe(70);
    expect(p.net).toBe(164); // gross - refunded
    expect(p.aov).toBe(74.67);
    expect(p.refundRate).toBe(0.2679);
    expect(r.totals[0]).toMatchObject({ currency: 'USD', gross: 224, refunded: 60, net: 164, orders: 3 });
  });

  it('is zero-division safe: empty ranges, products without gross, funnels without visitors', async () => {
    const w = await world();
    const empty = await w.get(`?${w.range}`);
    expect(empty.products).toEqual([]);
    expect(empty.totals).toEqual([]);
    await w.o({ amount: 5000, at: '2026-03-05T10:00:00Z', lost: 5000 }); // fully charged back: gross 0
    const r = await w.get(`?${w.range}`);
    expect(r.products[0]).toMatchObject({ gross: 0, net: 0, aov: 0, refundRate: 0, checkout: { visitors: 0, conversion: 0 }, takeRates: { bump: { rate: 0 }, upsell: { rate: 0 }, downsell: { rate: 0 } } });
    expect(JSON.stringify(r)).not.toMatch(/NaN|Infinity/);
  });

  it('rounds major units with the currency exponent', async () => {
    const w = await world();
    await w.o({ amount: 3333, at: '2026-03-05T10:00:00Z' });
    await w.o({ amount: 3333, at: '2026-03-05T11:00:00Z' });
    await w.o({ amount: 3334, at: '2026-03-05T12:00:00Z' });
    const p = (await w.get(`?${w.range}`)).products[0];
    expect(p.gross).toBe(100);
    expect(p.aov).toBe(33.33);
  });

  it('never sums currencies: one row per product and currency, one total per currency', async () => {
    const w = await world();
    await w.o({ amount: 9700, at: '2026-03-05T10:00:00Z' });
    await w.o({ amount: 8900, currency: 'EUR', at: '2026-03-05T11:00:00Z' });
    await w.o({ amount: 4980, currency: 'JPY', at: '2026-03-05T12:00:00Z' });
    await w.o({ amount: 1500, currency: 'KWD', at: '2026-03-05T13:00:00Z', product: w.bump, role: 'bump' });
    const r = await w.get(`?${w.range}`);
    expect(r.products.map((p: any) => [p.name.slice(0, 5), p.currency, p.gross]).sort()).toEqual([['Done-', 'KWD', 1.5], ['Email', 'EUR', 89], ['Email', 'JPY', 4980], ['Email', 'USD', 97]]);
    expect(r.totals.map((t: any) => [t.currency, t.gross, t.exponent])).toEqual([['EUR', 89, 2], ['JPY', 4980, 0], ['KWD', 1.5, 3], ['USD', 97, 2]]);
    expect((await w.get(`?${w.range}&currency=EUR`)).products).toHaveLength(1);
  });

  it('counts orders without a catalog link as their own row by name', async () => {
    const w = await world();
    await w.o({ amount: 1000, at: '2026-03-05T10:00:00Z', product: null });
    const r = await w.get(`?${w.range}`);
    expect(r.products[0]).toMatchObject({ productId: null, name: 'Legacy item', gross: 10 });
  });
});

describe('product analytics: time', () => {
  it('buckets by local day in the requested time zone and zero-fills the range', async () => {
    const w = await world();
    await w.o({ amount: 1000, at: '2026-03-10T23:30:00Z' });
    const day = async (tz: string) => {
      const r = await w.get(`?from=2026-03-08&to=2026-03-12&tz=${encodeURIComponent(tz)}`);
      const pts = r.products[0].series as { t: string; orders: number }[];
      return { n: pts.length, at: pts.find((p) => p.orders === 1)!.t };
    };
    expect(await day('UTC')).toEqual({ n: 5, at: '2026-03-10T00:00:00.000Z' });
    expect(await day('Pacific/Auckland')).toEqual({ n: 5, at: '2026-03-10T11:00:00.000Z' }); // 12:30 on the 11th local (UTC+13): the 11th starts at 11:00Z on the 10th
    expect(await day('America/Los_Angeles')).toEqual({ n: 5, at: '2026-03-10T07:00:00.000Z' }); // 16:30 on the 10th local (UTC-7): the 10th starts at 07:00Z
    const r = await w.get('?from=2026-03-08&to=2026-03-12');
    expect(r.products[0].series.map((p: any) => p.orders)).toEqual([0, 0, 1, 0, 0]);
    expect(r.totals[0].series.reduce((a: number, p: any) => a + p.gross, 0)).toBe(10);
  });

  it('excludes orders outside the local range and handles week and month intervals and a DST change', async () => {
    const w = await world();
    await w.o({ amount: 1000, at: '2026-03-07T23:59:59Z' }); // 23:59 UTC on the 7th is the 8th in Berlin? no: 00:59 on the 8th (UTC+1)
    await w.o({ amount: 2000, at: '2026-03-09T12:00:00Z' });
    await w.o({ amount: 4000, at: '2026-03-31T23:00:00Z' }); // 01:00 on 1 April in Berlin (DST began 29 March: UTC+2): outside March
    const berlin = await w.get('?from=2026-03-08&to=2026-03-31&tz=Europe/Berlin');
    expect(berlin.products[0].orders).toBe(2);
    expect(berlin.products[0].gross).toBe(30);
    const weekly = await w.get('?from=2026-03-02&to=2026-03-15&interval=week');
    expect(weekly.products[0].series).toHaveLength(2);
    expect(weekly.products[0].series.map((p: any) => p.orders)).toEqual([1, 1]); // Monday 2 March and Monday 9 March start the weeks
    const monthly = await w.get('?from=2026-02-01&to=2026-04-30&interval=month');
    expect(monthly.products[0].series.map((p: any) => p.orders)).toEqual([0, 3, 0]);
    expect((await w.get('?tz=Mars/Base')).error.code).toBe('INVALID_TIMEZONE');
    expect((await w.get('?from=2026-03-10&to=2026-03-01')).error.code).toBe('INVALID_RANGE');
    expect((await w.get('?interval=hour')).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('product analytics: funnel behaviour', () => {
  it('conversion is main orders over unique visitors of the checkout steps; take rates are taken over offered', async () => {
    const w = await world();
    const ws = w.owner.wsId;
    await seedEvents(w.h, ['v1', 'v2', 'v3', 'v4'].map((v) => ({ workspace_id: ws, funnel_id: w.t.funnelId, step_id: w.t.salesStepId, type: 'page_view', visitor_id: v, unique_visit: 1, created_at: '2026-03-05T10:00:00.000Z' })));
    for (let i = 0; i < 2; i++) await w.o({ amount: 9700, at: '2026-03-05T11:00:00Z' });
    await w.o({ amount: 1700, at: '2026-03-05T11:00:00Z', product: w.bump, role: 'bump' });
    await w.o({ amount: 9700, at: '2026-03-05T11:00:00Z', product: w.up, role: 'upsell', stepId: w.t.upsellStepId });
    const r = await w.get(`?${w.range}`);
    const main = r.products.find((p: any) => p.productId === w.main.id);
    expect(main.checkout).toEqual({ visitors: 4, orders: 2, conversion: 0.5 });
    const bump = r.products.find((p: any) => p.productId === w.bump.id);
    expect(bump.takeRates.bump).toEqual({ offered: 2, taken: 1, rate: 0.5 });
    expect(bump.roles).toEqual({ main: 0, bump: 1, upsell: 0, downsell: 0 });
    const up = r.products.find((p: any) => p.productId === w.up.id);
    expect(up.takeRates.upsell).toEqual({ offered: 2, taken: 1, rate: 0.5 });
  });

  it('splits new and repeat customers by whether their first ever order falls in the range', async () => {
    const w = await world();
    await w.o({ amount: 1000, at: '2026-02-01T10:00:00Z', email: 'old@example.com' }); // before the range
    await w.o({ amount: 1000, at: '2026-03-05T10:00:00Z', email: 'old@example.com' });
    await w.o({ amount: 1000, at: '2026-03-06T10:00:00Z', email: 'new@example.com' });
    await w.o({ amount: 1000, at: '2026-03-07T10:00:00Z', email: 'new@example.com' });
    const r = await w.get(`?${w.range}`);
    expect(r.products[0].customers).toEqual({ total: 2, new: 1, repeat: 1 });
    expect(r.totals[0].customers).toEqual({ total: 2, new: 1, repeat: 1 });
  });

  it('lists the top funnels and steps per product', async () => {
    const w = await world();
    await w.o({ amount: 9700, at: '2026-03-05T10:00:00Z' });
    await w.o({ amount: 2000, at: '2026-03-05T10:00:00Z', stepId: w.t.upsellStepId });
    const p = (await w.get(`?${w.range}`)).products[0];
    expect(p.topFunnels).toEqual([expect.objectContaining({ funnelId: w.t.funnelId, orders: 2, gross: 117, net: 117 })]);
    expect(p.topSteps.map((s: any) => [s.stepId, s.gross])).toEqual([[w.t.salesStepId, 97], [w.t.upsellStepId, 20]]);
  });

  it('the funnel endpoint is limited to its funnel', async () => {
    const w = await world();
    await w.o({ amount: 9700, at: '2026-03-05T10:00:00Z' });
    const other = (await w.h.call('POST', '/api/funnels', { token: w.owner.token, body: { name: 'Other' } })).json;
    await w.o({ amount: 500, at: '2026-03-05T10:00:00Z', funnelId: other.id, stepId: other.steps[0].id });
    const mine = (await w.h.call('GET', `/api/funnels/${w.t.funnelId}/analytics/products?${w.range}`, { token: w.owner.token })).json;
    expect(mine.totals[0].gross).toBe(97);
    expect((await w.get(`?${w.range}`)).totals[0].gross).toBe(102);
  });

  it('adds refunded, disputedLost and net next to the unchanged gross on funnel analytics', async () => {
    const w = await world();
    const ws = w.owner.wsId;
    await w.o({ amount: 9700, at: '2026-03-05T10:00:00Z', refunded: 2000 });
    await w.h.deps.db.run('INSERT INTO event_rollups (workspace_id, funnel_id, step_id, bucket, page_views, unique_views, optins, orders, cents) VALUES (?, ?, ?, ?, 0, 0, 0, 1, 9700)', ws, w.t.funnelId, w.t.salesStepId, '2026-03-05T10:00');
    const a = (await w.h.call('GET', `/api/funnels/${w.t.funnelId}/analytics?${w.range}`, { token: w.owner.token })).json;
    expect(a.summary.sales).toMatchObject({ orders: 1, gross: 97, refunded: 20, disputedLost: 0, net: 77 });
    expect(a.steps[0].sales).toMatchObject({ gross: 97, refunded: 20, net: 77 });
    const s = (await w.h.call('GET', `/api/funnels/${w.t.funnelId}/steps/${w.t.salesStepId}/analytics?${w.range}`, { token: w.owner.token })).json;
    expect(s.sales).toMatchObject({ gross: 97, refunded: 20, net: 77 });
  });
});

describe('product analytics: access', () => {
  it('needs analytics:read; viewers can read; tenants are isolated', async () => {
    const w = await world();
    await w.o({ amount: 9700, at: '2026-03-05T10:00:00Z' });
    expect((await w.h.call('GET', '/api/analytics/products')).status).toBe(401);
    const viewer = await w.h.member(w.owner, 'viewer');
    const blind = await w.h.memberWith(w.owner, ['funnels:read']);
    expect((await w.h.call('GET', `/api/analytics/products?${w.range}`, { token: viewer.token })).status).toBe(200);
    expect((await w.h.call('GET', `/api/analytics/products?${w.range}`, { token: blind.token })).status).toBe(403);
    expect((await w.h.call('GET', `/api/analytics/products/export?${w.range}`, { token: blind.token })).status).toBe(403);
    const other = await w.h.register();
    expect((await w.get(`?${w.range}`, other.token)).products).toEqual([]);
    expect((await w.h.call('GET', `/api/funnels/${w.t.funnelId}/analytics/products`, { token: other.token })).status).toBe(404);
  });

  it('exports the table as CSV and neutralises formulas in product names', async () => {
    const w = await world();
    const evil = (await w.h.call('POST', '/api/products', { token: w.owner.token, body: { name: '=HYPERLINK("http://evil.example","click")', price: { currency: 'USD', amount: 5 } } })).json;
    await w.o({ amount: 500, at: '2026-03-05T10:00:00Z', product: evil });
    const r = await w.h.call('GET', `/api/analytics/products/export?${w.range}`, { token: w.owner.token });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    const [head, ...rows] = r.text.trim().split('\r\n');
    expect(head).toBe('Product,Currency,Orders,Units,Gross,Refunded,Disputed lost,Net,Discounts,AOV,Refund rate,Checkout visitors,Conversion,Bump take rate,Upsell take rate,Downsell take rate,New customers,Repeat customers');
    expect(rows[0]).toMatch(/^"'=HYPERLINK\(""http:\/\/evil\.example"",""click""\)",USD,1,1,5,0,0,5,/);
    expect(r.text).not.toMatch(/(^|,)=HYPERLINK/m);
  });
});

describe('Analytics API v1: products', () => {
  const keyed = async () => {
    const w = await world();
    const key = (await w.h.call('POST', '/api/v1/api-keys', { token: w.owner.token, body: { name: 'k', scopes: ['analytics:read'] } })).json.key as string;
    await w.h.deps.db.run("UPDATE funnels SET status = 'live'"); // live keys see live funnels
    const exportOnly = (await w.h.call('POST', '/api/v1/api-keys', { token: w.owner.token, body: { name: 'x', scopes: ['analytics:export'] } })).json.key as string;
    return { ...w, key, exportOnly, v1: (q = '', k = key) => w.h.call('GET', `/api/v1/analytics/products${q}`, { token: k }) };
  };

  it('answers in snake_case with explicit refunded, disputed_lost and net, one row per product and currency, and pages with a cursor', async () => {
    const w = await keyed();
    await w.o({ amount: 9700, at: '2026-03-05T10:00:00Z', refunded: 1000 });
    await w.o({ amount: 8900, currency: 'EUR', at: '2026-03-05T10:00:00Z' });
    await w.o({ amount: 1700, at: '2026-03-05T10:00:00Z', product: w.bump, role: 'bump' });
    const r = await w.v1(`?${w.range}&tz=UTC`);
    expect(r.status, r.text).toBe(200);
    expect(r.json.data).toHaveLength(3);
    const usd = r.json.data.find((p: any) => p.currency === 'USD' && p.product_id === w.main.id);
    expect(usd).toMatchObject({ gross: 97, refunded: 10, disputed_lost: 0, net: 87, exponent: 2, orders: 1, refund_rate: 0.1031 });
    expect(usd.take_rates).toHaveProperty('bump.offered');
    expect(r.json.totals.map((t: any) => t.currency)).toEqual(['EUR', 'USD']);
    expect(r.json.data[0]).not.toHaveProperty('series');
    const p1 = await w.v1(`?${w.range}&limit=2`);
    expect(p1.json.data).toHaveLength(2);
    expect(p1.json.next_cursor).toBeTruthy();
    const p2 = await w.v1(`?${w.range}&limit=2&cursor=${p1.json.next_cursor}`);
    expect(p2.json.data).toHaveLength(1);
    expect(p2.json.next_cursor).toBeNull();
    expect([...p1.json.data, ...p2.json.data].map((p: any) => `${p.product_id}|${p.currency}`)).toEqual([...new Set([...p1.json.data, ...p2.json.data].map((p: any) => `${p.product_id}|${p.currency}`))]);
    expect((await w.v1('?cursor=garbage')).json.error.code).toBe('INVALID_CURSOR');
    const withSeries = await w.v1(`?${w.range}&include=series&interval=week`);
    expect(withSeries.json.data[0].series.length).toBeGreaterThanOrEqual(4);
    expect(withSeries.json.data[0].series[0]).toHaveProperty('disputed_lost');
  });

  it('needs the analytics:read scope, is scoped to the key workspace and mode, and adds the explicit fields to funnels and steps', async () => {
    const w = await keyed();
    await w.o({ amount: 9700, at: '2026-03-05T10:00:00Z', refunded: 500, lost: 200 });
    expect((await w.v1('', w.exportOnly)).status).toBe(403);
    expect((await w.h.call('GET', '/api/v1/analytics/products')).status).toBe(401);
    const other = await w.h.register();
    const otherKey = (await w.h.call('POST', '/api/v1/api-keys', { token: other.token, body: { name: 'k', scopes: ['analytics:read'] } })).json.key as string;
    expect((await w.v1(`?${w.range}`, otherKey)).json.data).toEqual([]);
    const funnels = (await w.h.call('GET', `/api/v1/analytics/funnels?${w.range}`, { token: w.key })).json.data[0];
    expect(funnels).toHaveProperty('refunded', 5);
    expect(funnels).toHaveProperty('disputed_lost', 2);
    expect(funnels).toHaveProperty('net');
    const steps = (await w.h.call('GET', `/api/v1/analytics/funnels/${w.t.funnelId}/steps?${w.range}`, { token: w.key })).json.data;
    expect(steps[0]).toMatchObject({ refunded: 5, disputed_lost: 2 });
    // a live key does not see orders of a test funnel
    const test = (await w.h.call('POST', '/api/funnels', { token: w.owner.token, body: { name: 'Test funnel' } })).json;
    await order(w.h, w.owner.wsId, { funnelId: test.id, stepId: test.steps[0].id, product: w.main, amount: 123_400, at: '2026-03-05T10:00:00Z' });
    expect((await w.v1(`?${w.range}`)).json.totals[0].gross).toBe(97 - 2);
    expect((await w.get(`?${w.range}`)).totals[0].gross).toBe(97 - 2 + 1234);
  });
});
