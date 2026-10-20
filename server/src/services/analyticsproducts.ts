import { z } from 'zod';
import { badRequest } from '../errors.js';
import type { Deps } from '../deps.js';
import type { ApiAuth } from './apikeys.js';
import { ApiRangeQuery, resolveApiRange } from './analyticsapi.js';
import { productReport } from './productanalytics.js';

/** `GET /api/v1/analytics/products` (docs/ANALYTICS-API.md): the product report for an API key, in the contract's snake_case, one row per product and currency. */
export const ApiProductsQuery = ApiRangeQuery.extend({
  interval: z.enum(['day', 'week', 'month']).default('day'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  funnel_id: z.string().max(64).optional(),
  include: z.enum(['series']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  cursor: z.string().max(200).optional(),
});

const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function dec(c: string | undefined): string | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString()) as { k?: unknown };
    if (typeof v.k === 'string') return v.k;
  } catch {
    /* falls through */
  }
  throw badRequest('INVALID_CURSOR', 'The cursor is not valid; start again without one');
}

const point = (p: { t: string; orders: number; units: number; gross: number; refunded: number; disputedLost: number; net: number }) => ({ t: p.t, orders: p.orders, units: p.units, gross: p.gross, refunded: p.refunded, disputed_lost: p.disputedLost, net: p.net });
const rates = (r: { offered: number; taken: number; rate: number }) => ({ offered: r.offered, taken: r.taken, rate: r.rate });

export async function apiProducts(deps: Deps, api: ApiAuth, q: z.infer<typeof ApiProductsQuery>) {
  const range = resolveApiRange(deps, q);
  if (q.interval === 'day' && range.endMs - range.startMs > 366 * 86_400_000 + 2 * 3_600_000) throw badRequest('INVALID_RANGE', 'The range may span at most 366 days');
  const report = await productReport(deps, { ws: api.workspaceId, mode: api.mode, funnelId: q.funnel_id, startUtc: range.startUtc, endUtc: range.endUtc, tz: range.tz, interval: q.interval, currency: q.currency });
  // Stable order for cursors: product id, then currency (rows without a catalog product sort by name).
  const keyOf = (p: { productId: string | null; name: string; currency: string }) => `${p.productId ?? `name:${p.name}`}|${p.currency}`;
  const sorted = [...report.products].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
  const after = dec(q.cursor);
  const rest = after === null ? sorted : sorted.filter((p) => keyOf(p) > after);
  const page = rest.slice(0, q.limit);
  const withSeries = q.include === 'series';
  return {
    data: page.map((p) => ({
      product_id: p.productId, name: p.name, currency: p.currency, exponent: p.exponent, orders: p.orders, units: p.units, gross: p.gross, refunded: p.refunded, disputed_lost: p.disputedLost, net: p.net, discount: p.discount,
      aov: p.aov, refund_rate: p.refundRate, refunded_orders: p.refundedOrders, roles: p.roles, customers: { total: p.customers.total, new: p.customers.new, repeat: p.customers.repeat },
      checkout: { visitors: p.checkout.visitors, orders: p.checkout.orders, conversion: p.checkout.conversion },
      take_rates: { bump: rates(p.takeRates.bump), upsell: rates(p.takeRates.upsell), downsell: rates(p.takeRates.downsell) },
      top_funnels: p.topFunnels.map((f) => ({ funnel_id: f.funnelId, name: f.name, orders: f.orders, gross: f.gross, refunded: f.refunded, net: f.net })),
      ...(withSeries ? { series: p.series.map(point) } : {}),
    })),
    next_cursor: rest.length > q.limit && page.length ? enc({ k: keyOf(page[page.length - 1]!) }) : null,
    from: report.range.from, to: report.range.to, tz: report.range.tz, interval: report.range.interval,
    totals: report.totals.map((t) => ({ currency: t.currency, exponent: t.exponent, orders: t.orders, units: t.units, gross: t.gross, refunded: t.refunded, disputed_lost: t.disputedLost, net: t.net, discount: t.discount, aov: t.aov, refund_rate: t.refundRate, customers: t.customers, ...(withSeries ? { series: t.series.map(point) } : {}) })),
  };
}
