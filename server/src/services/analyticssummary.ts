import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import { guard, validated } from '../ai/service.js';
import { narrate, numberGuard, safeName, SummarySchema, type CurrencyEvidence, type ProductEvidence, type Summary, type SummaryEvidence } from '../ai/summary.js';
import type { Deps } from '../deps.js';
import { badRequest, notFound } from '../errors.js';
import { requireFunnel } from '../repos/funnels.js';
import { addDays, eachDay, startOfDayUtc } from '../util/time.js';
import { AnalyticsQuery, funnelAnalytics, resolveRange } from './analytics.js';
import { productReport, type ProductReport } from './productanalytics.js';

export const SummaryRequest = AnalyticsQuery.extend({
  scope: z.enum(['workspace', 'funnel', 'product']).default('workspace'),
  funnelId: z.string().min(1).max(64).optional(),
  productId: z.string().min(1).max(64).optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
});

const pctChange = (now: number, before: number): number | null => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null);

function currenciesOf(rows: ReportRow[], prev: ReportRow[], customers: Map<string, { new: number; repeat: number }>): CurrencyEvidence[] {
  const by = new Map<string, ReportRow[]>();
  for (const r of rows) by.set(r.currency, [...(by.get(r.currency) ?? []), r]);
  return [...by].sort((a, b) => a[0].localeCompare(b[0])).map(([currency, list]) => {
    const sum = (k: 'orders' | 'units' | 'gross' | 'refunded' | 'disputedLost' | 'net' | 'discount') => list.reduce((a, r) => a + r[k], 0);
    const gross = sum('gross');
    const exp = list[0]!.exponent;
    const r = (v: number) => Number(v.toFixed(exp));
    const before = prev.filter((p) => p.currency === currency);
    const prevGross = before.reduce((a, p) => a + p.gross, 0);
    const c = customers.get(currency) ?? { new: 0, repeat: 0 };
    const top = Math.max(...list.map((p) => p.gross));
    return {
      currency, orders: sum('orders'), units: sum('units'), gross: r(gross), refunded: r(sum('refunded')), disputedLost: r(sum('disputedLost')), net: r(sum('net')), discount: r(sum('discount')),
      aov: sum('orders') > 0 ? r(gross / sum('orders')) : 0, refundRate: gross > 0 ? Math.round((sum('refunded') / gross) * 10_000) / 10_000 : 0, customersNew: c.new, customersRepeat: c.repeat,
      previousGross: r(prevGross), previousOrders: before.reduce((a, p) => a + p.orders, 0), grossChangePercent: pctChange(gross, prevGross), topProductShare: gross > 0 ? Math.round((top / gross) * 10_000) / 10_000 : 0,
    };
  });
}

type ReportRow = ProductReport['products'][number];

function productEvidence(p: ReportRow): ProductEvidence {
  return {
    name: safeName(p.name), currency: p.currency, orders: p.orders, units: p.units, gross: p.gross, refunded: p.refunded, net: p.net, refundRate: p.refundRate, aov: p.aov,
    checkoutVisitors: p.checkout.visitors, conversion: p.checkout.conversion, bumpOffered: p.takeRates.bump.offered, bumpTaken: p.takeRates.bump.taken, bumpTakeRate: p.takeRates.bump.rate,
    upsellOffered: p.takeRates.upsell.offered, upsellTaken: p.takeRates.upsell.taken, upsellTakeRate: p.takeRates.upsell.rate, customersNew: p.customers.new, customersRepeat: p.customers.repeat,
  };
}

/** Everything the narrator or the model may say, from the database: this period and the one before it, per currency, plus the top products and (for a funnel) its step metrics. */
export async function buildEvidence(deps: Deps, ws: string, req: z.infer<typeof SummaryRequest>): Promise<SummaryEvidence> {
  const range = resolveRange(deps, req);
  const days = eachDay(range.from, range.to).length;
  const prevFrom = addDays(range.from, -days);
  const prevTo = addDays(range.from, -1);
  let subject = 'Workspace';
  let funnelId: string | undefined;
  if (req.scope === 'funnel') {
    if (!req.funnelId) throw badRequest('FUNNEL_REQUIRED', 'Send funnelId for a funnel summary');
    const f = await requireFunnel(deps.db.read(ws), ws, req.funnelId);
    funnelId = f.id;
    subject = safeName(f.name);
  }
  let productId: string | undefined;
  if (req.scope === 'product') {
    if (!req.productId) throw badRequest('PRODUCT_REQUIRED', 'Send productId for a product summary');
    const p = await deps.db.read(ws).get<{ id: string; name: string }>('SELECT id, name FROM products WHERE workspace_id = ? AND id = ?', ws, req.productId);
    if (!p) throw notFound('Product');
    productId = p.id;
    subject = safeName(p.name);
  }
  const scope = (from: string, to: string) => ({ ws, funnelId, startUtc: startOfDayUtc(from, range.tz).toISOString(), endUtc: startOfDayUtc(addDays(to, 1), range.tz).toISOString(), tz: range.tz, interval: 'month' as const, currency: req.currency });
  const [now, before] = await Promise.all([productReport(deps, scope(range.from, range.to)), productReport(deps, scope(prevFrom, prevTo))]);
  const keep = (rows: ReportRow[]) => (productId ? rows.filter((p) => p.productId === productId) : rows);
  const rows = keep(now.products);
  const customers = new Map<string, { new: number; repeat: number }>();
  if (productId) for (const r of rows) customers.set(r.currency, { new: r.customers.new, repeat: r.customers.repeat });
  else for (const t of now.totals) customers.set(t.currency, { new: t.customers.new, repeat: t.customers.repeat });
  const evidence: SummaryEvidence = {
    scope: req.scope, subject, range: { from: range.from, to: range.to, days }, previousRange: { from: prevFrom, to: prevTo },
    currencies: currenciesOf(rows, keep(before.products), customers), products: rows.slice(0, 5).map(productEvidence), counts: { products: rows.length, shown: Math.min(5, rows.length) },
  };
  if (funnelId) {
    const a = await funnelAnalytics(deps, ws, funnelId, { from: range.from, to: range.to, tz: range.tz });
    const steps = a.steps.map((s, i) => {
      const prev = a.steps[i - 1];
      return { name: safeName(s.name), dropOff: prev && prev.pageViews.unique > 0 ? Math.max(0, Math.round((1 - s.pageViews.unique / prev.pageViews.unique) * 1000) / 10) : null, uniques: s.pageViews.unique };
    });
    const weak = steps.filter((s) => s.dropOff !== null).sort((x, y) => y.dropOff! - x.dropOff!)[0];
    evidence.funnel = {
      views: a.summary.pageViews.all, uniqueVisitors: a.summary.pageViews.unique, optIns: a.summary.optIns.all, optInRatePercent: a.summary.optIns.conversionRate, orders: a.summary.sales.orders, gross: a.summary.sales.gross,
      salesRatePercent: a.summary.sales.conversionRate, weakestStep: weak ? { name: weak.name, dropOffPercent: weak.dropOff } : null,
    };
  }
  return evidence;
}

export async function summarizePeriod(deps: Deps, auth: Auth, req: z.infer<typeof SummaryRequest>) {
  const ws = auth.workspaceId;
  const evidence = await buildEvidence(deps, ws, req);
  await guard(deps, ws);
  const provider = deps.ai;
  const { value, source } = await validated<Summary>(
    deps, 'summary', () => (provider.summary ? provider.summary(evidence) : Promise.resolve(narrate(evidence))), SummarySchema, () => narrate(evidence),
    (v) => {
      const g = numberGuard([v.narrative, ...v.actions.flatMap((a) => [a.title, a.detail])], evidence);
      if (!g.ok) deps.log.warn('ai summary rejected by the number guard', { problem: g.problem });
      return g.ok;
    },
  );
  const actions = [...value.actions].sort((a, b) => a.priority - b.priority).map((a, i) => ({ ...a, priority: i + 1 }));
  return { narrative: value.narrative, actions, source, evidence };
}
