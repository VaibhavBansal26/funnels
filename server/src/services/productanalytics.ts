import { z } from 'zod';
import type { Deps } from '../deps.js';
import { toCsv } from '../util/csv.js';
import { currencyExponent, fromMinor } from '../util/money.js';
import { dayKey } from '../util/time.js';
import { requireFunnel } from '../repos/funnels.js';
import { AnalyticsQuery, resolveRange } from './analytics.js';
import { enumerateIntervals, intervalStart } from './analyticsapi.js';
import { bucketOf } from './rollups.js';

/**
 * Product analytics (docs/ANALYTICS-API.md, "Product analytics"). Everything is computed in SQL from the orders table and the sales rollups; money is summed in
 * integer minor units per currency and NEVER across currencies (a product sold in two currencies has two rows, and the totals are one row per currency).
 *
 * Definitions (all amounts in the order currency):
 *   gross          what the orders brought in: the booked amount after promotion codes, minus amounts lost to lost disputes. This is the same `gross` the funnel and step
 *                  analytics report (they book dispute losses against the sales rollups), so the surfaces agree.
 *   refunded       refunds made on those orders (cumulative as of now, attributed to the ORDER's date, not the refund date)
 *   disputed_lost  amounts taken back by lost disputes on those orders (already out of `gross`; shown so the loss is visible)
 *   net            gross - refunded: what the products kept
 *   aov            gross / orders (a product line is an order here: a bump and its main offer are two orders)
 *   refund_rate    refunded / gross
 *   conversion     main-offer orders of the product / unique visitors of the steps that carry its checkout (0 when nobody visited)
 *   take rates     bump: bump orders / main orders on the steps where the bump is offered; upsell: upsell orders / main orders of the funnels that offer it;
 *                  downsell: downsell orders / main orders that did not take an upsell in those funnels (an approximation: the funnel has no per-visitor decline log)
 *   customers      distinct buyer emails; `new` first ordered anything in the workspace inside the range, `repeat` ordered before it
 */
export const INTERVALS = ['hour', 'day', 'week', 'month'] as const;

export const ProductsQuery = AnalyticsQuery.extend({
  interval: z.enum(['day', 'week', 'month']).default('day'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export interface ProductScope {
  ws: string;
  funnelId?: string;
  /** Only funnels in this mode (an API key sees its own mode). */
  mode?: 'live' | 'test';
  startUtc: string;
  endUtc: string;
  tz: string;
  interval: (typeof INTERVALS)[number];
  currency?: string;
}

interface Money {
  orders: number;
  units: number;
  gross: number;
  refunded: number;
  lost: number;
  discount: number;
  refundedOrders: number;
}
const zero = (): Money => ({ orders: 0, units: 0, gross: 0, refunded: 0, lost: 0, discount: 0, refundedOrders: 0 });
const add = (a: Money, b: Money) => {
  for (const k of Object.keys(a) as (keyof Money)[]) a[k] += b[k];
};
const num = (v: unknown) => Number(v ?? 0);
const frac = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : 0);

/** Output amounts: major units rounded to the currency exponent, plus the exponent so a client can recover the integers. */
const out = (m: Money, currency: string) => {
  const major = (v: number) => fromMinor(v, currency);
  const gross = m.gross;
  return {
    currency, exponent: currencyExponent(currency), orders: m.orders, units: m.units, gross: major(gross), refunded: major(m.refunded), disputedLost: major(m.lost), net: major(gross - m.refunded), discount: major(m.discount),
    aov: m.orders > 0 ? Number((major(gross) / m.orders).toFixed(currencyExponent(currency))) : 0, refundRate: frac(m.refunded, gross), refundedOrders: m.refundedOrders,
  };
};

interface Row {
  product_id: string | null;
  name: string;
  currency: string;
  role: string | null;
  funnel_id: string;
  step_id: string;
  bucket: string;
  orders: number;
  units: number;
  gross: number;
  refunded: number;
  lost: number;
  discount: number;
  refunded_orders: number;
}

interface Placement {
  productId: string;
  funnelId: string;
  stepId: string;
  role: 'main' | 'bump' | 'upsell' | 'downsell';
}

async function placements(deps: Deps, s: ProductScope): Promise<Placement[]> {
  const rows = await deps.db.all<{ step_id: string; funnel_id: string; doc_json: string }>(
    `SELECT p.step_id, p.funnel_id, p.doc_json FROM step_pages p JOIN funnels f ON f.id = p.funnel_id
     WHERE p.workspace_id = ? AND f.deleted_at IS NULL ${s.funnelId ? 'AND p.funnel_id = ?' : ''} ${s.mode ? 'AND f.status = ?' : ''} AND p.doc_json LIKE '%"fn-checkout"%' LIMIT 5000`,
    s.ws, ...(s.funnelId ? [s.funnelId] : []), ...(s.mode ? [s.mode] : []),
  );
  const found: Placement[] = [];
  for (const r of rows) {
    let doc: { products?: { productId?: string; orderBump?: boolean; oneClickUpsell?: boolean; downsell?: boolean }[] };
    try {
      doc = JSON.parse(r.doc_json);
    } catch {
      continue;
    }
    for (const p of doc.products ?? []) if (p.productId) found.push({ productId: p.productId, funnelId: r.funnel_id, stepId: r.step_id, role: p.orderBump ? 'bump' : p.oneClickUpsell ? (p.downsell ? 'downsell' : 'upsell') : 'main' });
  }
  return found;
}

export async function productReport(base: Deps, s: ProductScope) {
  await base.events.flush();
  const deps: Deps = { ...base, db: base.db.read(s.ws) };
  const startMs = Date.parse(s.startUtc);
  const endMs = Date.parse(s.endUtc);
  const filters = `o.workspace_id = ? AND o.created_at >= ? AND o.created_at < ? AND f.deleted_at IS NULL ${s.funnelId ? 'AND o.funnel_id = ?' : ''} ${s.mode ? 'AND f.status = ?' : ''} ${s.currency ? 'AND o.currency = ?' : ''}`;
  const params = [s.ws, s.startUtc, s.endUtc, ...(s.funnelId ? [s.funnelId] : []), ...(s.mode ? [s.mode] : []), ...(s.currency ? [s.currency] : [])];
  const rows = await deps.db.all<Row>(
    `SELECT o.product_id, MIN(o.product_name) AS name, o.currency, o.role, o.funnel_id, o.step_id, ${deps.db.dialect.bucket15('o.created_at')} AS bucket,
            COUNT(*) AS orders, COALESCE(SUM(o.quantity), 0) AS units, COALESCE(SUM(o.amount_cents - o.disputed_lost_cents), 0) AS gross, COALESCE(SUM(o.refunded_cents), 0) AS refunded,
            COALESCE(SUM(o.disputed_lost_cents), 0) AS lost, COALESCE(SUM(o.discount_cents), 0) AS discount, COALESCE(SUM(${deps.db.dialect.boolInt('o.refunded_cents > 0')}), 0) AS refunded_orders
     FROM orders o JOIN funnels f ON f.id = o.funnel_id WHERE ${filters}
     GROUP BY o.product_id, o.currency, o.role, o.funnel_id, o.step_id, ${deps.db.dialect.bucket15('o.created_at')}`,
    ...params,
  );

  const toMoney = (r: Row): Money => ({ orders: num(r.orders), units: num(r.units), gross: num(r.gross), refunded: num(r.refunded), lost: num(r.lost), discount: num(r.discount), refundedOrders: num(r.refunded_orders) });
  const key = (r: Row) => `${r.product_id ?? `name:${r.name.toLowerCase()}`}\u0000${r.currency}`;
  const points = enumerateIntervals(startMs, endMs, s.tz, s.interval);
  const blankSeries = () => new Map(points.map((t) => [t, zero()]));
  const at = (r: Row) => intervalStart(Date.parse(`${r.bucket}:00.000Z`), s.tz, s.interval);
  const series = (m: Map<number, Money>, currency: string) => [...m].map(([t, v]) => ({ t: new Date(t).toISOString(), ...(({ orders, units, gross, refunded, lost }) => ({ orders, units, gross: fromMinor(gross, currency), refunded: fromMinor(refunded, currency), disputedLost: fromMinor(lost, currency), net: fromMinor(gross - refunded, currency) }))(v) }));

  interface Acc {
    productId: string | null;
    name: string;
    currency: string;
    money: Money;
    roles: Record<string, number>;
    byInterval: Map<number, Money>;
    funnels: Map<string, Money>;
    steps: Map<string, Money & { funnelId: string }>;
  }
  const products = new Map<string, Acc>();
  const totals = new Map<string, { money: Money; byInterval: Map<number, Money> }>();
  const mainByStep = new Map<string, number>();
  const mainByFunnel = new Map<string, number>();
  const upsellByFunnel = new Map<string, number>();
  const roleOrders = new Map<string, number>(); // `${productId}\0${currency}\0${role}\0${funnel}\0${step}` -> orders
  for (const r of rows) {
    const k = key(r);
    const m = toMoney(r);
    const p = products.get(k) ?? { productId: r.product_id, name: r.name, currency: r.currency, money: zero(), roles: {} as Record<string, number>, byInterval: blankSeries(), funnels: new Map(), steps: new Map() };
    add(p.money, m);
    p.roles[r.role ?? 'main'] = (p.roles[r.role ?? 'main'] ?? 0) + m.orders;
    const iv = p.byInterval.get(at(r));
    if (iv) add(iv, m);
    const fm = p.funnels.get(r.funnel_id) ?? zero();
    add(fm, m);
    p.funnels.set(r.funnel_id, fm);
    const sm = p.steps.get(r.step_id) ?? { ...zero(), funnelId: r.funnel_id };
    add(sm, m);
    p.steps.set(r.step_id, sm);
    products.set(k, p);
    const t = totals.get(r.currency) ?? { money: zero(), byInterval: blankSeries() };
    add(t.money, m);
    const tv = t.byInterval.get(at(r));
    if (tv) add(tv, m);
    totals.set(r.currency, t);
    if ((r.role ?? 'main') === 'main') {
      mainByStep.set(r.step_id, (mainByStep.get(r.step_id) ?? 0) + m.orders);
      mainByFunnel.set(r.funnel_id, (mainByFunnel.get(r.funnel_id) ?? 0) + m.orders);
    }
    if (r.role === 'upsell') upsellByFunnel.set(r.funnel_id, (upsellByFunnel.get(r.funnel_id) ?? 0) + m.orders);
    const rk = `${r.product_id ?? r.name}\u0000${r.currency}\u0000${r.role ?? 'main'}\u0000${r.funnel_id}\u0000${r.step_id}`;
    roleOrders.set(rk, (roleOrders.get(rk) ?? 0) + m.orders);
  }

  // Customers: buyers in the range, and which of them had never ordered before it.
  const cust = await deps.db.all<{ product_id: string | null; name: string; currency: string; total: number; fresh: number }>(
    `SELECT o.product_id, MIN(o.product_name) AS name, o.currency, COUNT(DISTINCT o.email) AS total,
            COUNT(DISTINCT CASE WHEN first.first_at >= ? THEN o.email END) AS fresh
     FROM orders o JOIN funnels f ON f.id = o.funnel_id JOIN (SELECT email, MIN(created_at) AS first_at FROM orders WHERE workspace_id = ? GROUP BY email) first ON first.email = o.email
     WHERE ${filters} GROUP BY o.product_id, o.currency`,
    s.startUtc, s.ws, ...params,
  );
  const customers = new Map(cust.map((c) => [`${c.product_id ?? `name:${c.name.toLowerCase()}`}\u0000${c.currency}`, { total: num(c.total), new: num(c.fresh), repeat: num(c.total) - num(c.fresh) }]));
  const allCust = await deps.db.all<{ currency: string; total: number; fresh: number }>(
    `SELECT o.currency, COUNT(DISTINCT o.email) AS total, COUNT(DISTINCT CASE WHEN first.first_at >= ? THEN o.email END) AS fresh
     FROM orders o JOIN funnels f ON f.id = o.funnel_id JOIN (SELECT email, MIN(created_at) AS first_at FROM orders WHERE workspace_id = ? GROUP BY email) first ON first.email = o.email
     WHERE ${filters} GROUP BY o.currency`,
    s.startUtc, s.ws, ...params,
  );

  // Funnel and step names, and the unique visitors of the steps that carry each product's checkout.
  const place = await placements(deps, s);
  const stepIds = [...new Set([...place.map((p) => p.stepId), ...rows.map((r) => r.step_id)])];
  const names = stepIds.length ? await deps.db.all<{ id: string; name: string }>(`SELECT id, name FROM steps WHERE workspace_id = ? AND id IN (${stepIds.map(() => '?').join(',')})`, s.ws, ...stepIds) : [];
  const stepName = new Map(names.map((n) => [n.id, n.name]));
  const funnelIds = [...new Set(rows.map((r) => r.funnel_id))];
  const fnames = funnelIds.length ? await deps.db.all<{ id: string; name: string }>(`SELECT id, name FROM funnels WHERE workspace_id = ? AND id IN (${funnelIds.map(() => '?').join(',')})`, s.ws, ...funnelIds) : [];
  const funnelName = new Map(fnames.map((n) => [n.id, n.name]));
  const visitors = new Map<string, number>();
  const placeSteps = [...new Set(place.filter((p) => p.role === 'main').map((p) => p.stepId))];
  if (placeSteps.length) {
    for (const v of await deps.db.all<{ step_id: string; n: number }>(
      `SELECT step_id, COALESCE(SUM(unique_views), 0) AS n FROM event_rollups WHERE workspace_id = ? AND bucket >= ? AND bucket < ? AND step_id IN (${placeSteps.map(() => '?').join(',')}) GROUP BY step_id`,
      s.ws, bucketOf(s.startUtc), bucketOf(s.endUtc), ...placeSteps,
    )) visitors.set(v.step_id, num(v.n));
  }

  const mapped = [...products.values()].map((p) => {
    const mine = place.filter((x) => x.productId === p.productId);
    const stepsOf = (role: Placement['role']) => [...new Set(mine.filter((x) => x.role === role).map((x) => x.stepId))];
    const funnelsOf = (role: Placement['role']) => [...new Set(mine.filter((x) => x.role === role).map((x) => x.funnelId))];
    const taken = (role: string) => [...roleOrders].filter(([k]) => { const [pid, cur, r] = k.split('\u0000'); return pid === (p.productId ?? p.name) && cur === p.currency && r === role; }).reduce((a, [, n]) => a + n, 0);
    const rate = (offered: number, took: number) => ({ offered, taken: took, rate: frac(took, offered) });
    const mainSteps = stepsOf('main');
    const checkoutVisitors = mainSteps.reduce((a, id) => a + (visitors.get(id) ?? 0), 0);
    const mainOrders = taken('main');
    const bumpOffered = stepsOf('bump').reduce((a, id) => a + (mainByStep.get(id) ?? 0), 0);
    const upFunnels = funnelsOf('upsell');
    const upOffered = upFunnels.reduce((a, id) => a + (mainByFunnel.get(id) ?? 0), 0);
    const downFunnels = funnelsOf('downsell');
    const downOffered = downFunnels.reduce((a, id) => a + Math.max(0, (mainByFunnel.get(id) ?? 0) - (upsellByFunnel.get(id) ?? 0)), 0);
    const cu = customers.get(key({ product_id: p.productId, name: p.name, currency: p.currency } as Row)) ?? { total: 0, new: 0, repeat: 0 };
    const money3 = (v: Money) => ({ orders: v.orders, gross: fromMinor(v.gross, p.currency), refunded: fromMinor(v.refunded, p.currency), net: fromMinor(v.gross - v.refunded, p.currency) });
    const byGross = <T extends Money>(m: Map<string, T>) => [...m].sort((x, y) => y[1].gross - x[1].gross || x[0].localeCompare(y[0])).slice(0, 5);
    return {
      productId: p.productId, name: p.name, ...out(p.money, p.currency), roles: { main: p.roles.main ?? 0, bump: p.roles.bump ?? 0, upsell: p.roles.upsell ?? 0, downsell: p.roles.downsell ?? 0 },
      customers: cu, checkout: { visitors: checkoutVisitors, orders: mainOrders, conversion: frac(mainOrders, checkoutVisitors) },
      takeRates: { bump: rate(bumpOffered, taken('bump')), upsell: rate(upOffered, taken('upsell')), downsell: rate(downOffered, taken('downsell')) },
      series: series(p.byInterval, p.currency),
      topFunnels: byGross(p.funnels).map(([id, v]) => ({ funnelId: id, name: funnelName.get(id) ?? id, ...money3(v) })),
      topSteps: byGross(p.steps).map(([id, v]) => ({ stepId: id, name: stepName.get(id) ?? id, funnelId: v.funnelId, funnelName: funnelName.get(v.funnelId) ?? v.funnelId, ...money3(v) })),
    };
  }).sort((a, b) => b.gross - a.gross || a.name.localeCompare(b.name));

  return {
    range: { from: dayKey(s.startUtc, s.tz), to: dayKey(new Date(endMs - 1), s.tz), tz: s.tz, interval: s.interval },
    totals: [...totals].sort((a, b) => a[0].localeCompare(b[0])).map(([currency, t]) => {
      const c = allCust.find((x) => x.currency === currency);
      return { ...out(t.money, currency), customers: { total: num(c?.total), new: num(c?.fresh), repeat: num(c?.total) - num(c?.fresh) }, series: series(t.byInterval, currency) };
    }),
    products: mapped,
  };
}

export type ProductReport = Awaited<ReturnType<typeof productReport>>;

/** The user-session endpoints: `from`/`to` are local days in `tz`. */
export async function productAnalytics(deps: Deps, ws: string, q: z.infer<typeof ProductsQuery>, funnelId?: string) {
  if (funnelId) await requireFunnel(deps.db.read(ws), ws, funnelId);
  const r = resolveRange(deps, q);
  const report = await productReport(deps, { ws, funnelId, startUtc: r.startUtc, endUtc: r.endUtc, tz: r.tz, interval: q.interval, currency: q.currency });
  return { ...report, products: report.products.slice(0, q.limit) };
}

export const ProductsExportQuery = AnalyticsQuery.extend({ currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(), funnelId: z.string().max(64).optional() });

const HEADERS = ['Product', 'Currency', 'Orders', 'Units', 'Gross', 'Refunded', 'Disputed lost', 'Net', 'Discounts', 'AOV', 'Refund rate', 'Checkout visitors', 'Conversion', 'Bump take rate', 'Upsell take rate', 'Downsell take rate', 'New customers', 'Repeat customers'];

/** CSV of the product table. Cells that a spreadsheet would run as a formula (a product named `=HYPERLINK(...)`) are neutralised by the shared CSV writer. */
export async function productsCsv(deps: Deps, ws: string, q: z.infer<typeof ProductsExportQuery>): Promise<string> {
  if (q.funnelId) await requireFunnel(deps.db.read(ws), ws, q.funnelId);
  const r = resolveRange(deps, q);
  const report = await productReport(deps, { ws, funnelId: q.funnelId, startUtc: r.startUtc, endUtc: r.endUtc, tz: r.tz, interval: 'day', currency: q.currency });
  return toCsv(HEADERS, report.products.map((p) => [p.name, p.currency, p.orders, p.units, p.gross, p.refunded, p.disputedLost, p.net, p.discount, p.aov, p.refundRate, p.checkout.visitors, p.checkout.conversion, p.takeRates.bump.rate, p.takeRates.upsell.rate, p.takeRates.downsell.rate, p.customers.new, p.customers.repeat]));
}
