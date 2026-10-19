import { z } from 'zod';
import type { Deps } from '../deps.js';
import { badRequest } from '../errors.js';
import { listSteps, requireFunnel, requireStep } from '../repos/funnels.js';
import { addDays, dayKey, eachDay, isDay, isValidTimeZone, pct, ratio, round2, startOfDayUtc } from '../util/time.js';

export const AnalyticsQuery = z.object({
  from: z.string().refine(isDay, 'Use YYYY-MM-DD').optional(),
  to: z.string().refine(isDay, 'Use YYYY-MM-DD').optional(),
  tz: z.string().max(64).optional(),
});

export interface Metrics {
  pageViews: { all: number; unique: number };
  optIns: { all: number; conversionRate: number };
  sales: { orders: number; conversionRate: number; gross: number };
  earningsPerView: { all: number; unique: number };
}

export function computeMetrics(raw: { views: number; uniques: number; optins: number; orders: number; cents: number }): Metrics {
  const gross = round2(raw.cents / 100);
  return {
    pageViews: { all: raw.views, unique: raw.uniques },
    optIns: { all: raw.optins, conversionRate: pct(raw.optins, raw.uniques) },
    sales: { orders: raw.orders, conversionRate: pct(raw.orders, raw.uniques), gross },
    earningsPerView: { all: ratio(raw.cents / 100, raw.views), unique: ratio(raw.cents / 100, raw.uniques) },
  };
}

export interface Range {
  from: string;
  to: string;
  tz: string;
  startUtc: string;
  endUtc: string;
}

/** Resolves the inclusive local-day range [from, to] in `tz` into an exclusive UTC instant range. Defaults to the last 30 days. */
export function resolveRange(deps: Deps, q: z.infer<typeof AnalyticsQuery>): Range {
  const tz = q.tz ?? 'UTC';
  if (!isValidTimeZone(tz)) throw badRequest('INVALID_TIMEZONE', `Unknown time zone "${tz}"`);
  const to = q.to ?? dayKey(deps.now(), tz);
  const from = q.from ?? addDays(to, -29);
  if (from > to) throw badRequest('INVALID_RANGE', '"from" must not be after "to"');
  if (eachDay(from, to).length > 366) throw badRequest('INVALID_RANGE', 'The range may span at most 366 days');
  return { from, to, tz, startUtc: startOfDayUtc(from, tz).toISOString(), endUtc: startOfDayUtc(addDays(to, 1), tz).toISOString() };
}

interface StepAgg {
  step_id: string;
  views: number;
  uniques: number;
  optins: number;
  orders: number;
  cents: number;
}

const AGG = `COALESCE(SUM(type = 'page_view'), 0) AS views, COALESCE(SUM(type = 'page_view' AND unique_visit = 1), 0) AS uniques,
             COALESCE(SUM(type = 'optin'), 0) AS optins, COALESCE(SUM(type = 'order'), 0) AS orders,
             COALESCE(SUM(CASE WHEN type = 'order' THEN amount_cents ELSE 0 END), 0) AS cents`;

function series(deps: Deps, ws: string, funnelId: string, range: Range, stepId?: string) {
  const rows = deps.db.all<{ minute: string; type: string; unique_visit: number; n: number; cents: number }>(
    `SELECT substr(created_at, 1, 16) AS minute, type, unique_visit, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents
     FROM events WHERE workspace_id = ? AND funnel_id = ? AND created_at >= ? AND created_at < ? ${stepId ? 'AND step_id = ?' : ''}
     GROUP BY minute, type, unique_visit`,
    ws, funnelId, range.startUtc, range.endUtc, ...(stepId ? [stepId] : []),
  );
  const days = new Map(eachDay(range.from, range.to).map((d) => [d, { date: d, pageViews: 0, uniqueVisits: 0, optIns: 0, orders: 0, gross: 0, cents: 0 }]));
  for (const r of rows) {
    // Bucketing happens per minute in the requested zone so half-hour offsets and DST shifts land on the right local day.
    const day = days.get(dayKey(`${r.minute}:00.000Z`, range.tz));
    if (!day) continue;
    if (r.type === 'page_view') {
      day.pageViews += r.n;
      if (r.unique_visit === 1) day.uniqueVisits += r.n;
    } else if (r.type === 'optin') day.optIns += r.n;
    else {
      day.orders += r.n;
      day.cents += r.cents;
    }
  }
  return [...days.values()].map(({ cents, ...d }) => ({ ...d, gross: round2(cents / 100) }));
}

export function funnelAnalytics(deps: Deps, ws: string, funnelId: string, q: z.infer<typeof AnalyticsQuery>) {
  requireFunnel(deps.db, ws, funnelId);
  const range = resolveRange(deps, q);
  const params = [ws, funnelId, range.startUtc, range.endUtc];
  const where = 'workspace_id = ? AND funnel_id = ? AND created_at >= ? AND created_at < ?';
  const perStep = new Map(deps.db.all<StepAgg>(`SELECT step_id, ${AGG} FROM events WHERE ${where} GROUP BY step_id`, ...params).map((r) => [r.step_id, r]));
  const totals = deps.db.get<Omit<StepAgg, 'step_id'>>(`SELECT ${AGG} FROM events WHERE ${where}`, ...params)!;
  // Funnel-level uniques are distinct visitors, so someone who sees three steps is one visitor.
  const visitors = deps.db.get<{ n: number }>(`SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE ${where} AND type = 'page_view'`, ...params)!.n;
  const steps = listSteps(deps.db, ws, funnelId).map((s) => {
    const a = perStep.get(s.id);
    return { stepId: s.id, name: s.name, path: s.base_path, position: s.position, ...computeMetrics({ views: a?.views ?? 0, uniques: a?.uniques ?? 0, optins: a?.optins ?? 0, orders: a?.orders ?? 0, cents: a?.cents ?? 0 }) };
  });
  return {
    range: { from: range.from, to: range.to, tz: range.tz },
    summary: computeMetrics({ views: totals.views, uniques: visitors, optins: totals.optins, orders: totals.orders, cents: totals.cents }),
    steps,
    series: series(deps, ws, funnelId, range),
  };
}

export function stepAnalytics(deps: Deps, ws: string, funnelId: string, stepId: string, q: z.infer<typeof AnalyticsQuery>) {
  requireFunnel(deps.db, ws, funnelId);
  const step = requireStep(deps.db, ws, funnelId, stepId);
  const range = resolveRange(deps, q);
  const a = deps.db.get<Omit<StepAgg, 'step_id'>>(
    `SELECT ${AGG} FROM events WHERE workspace_id = ? AND funnel_id = ? AND step_id = ? AND created_at >= ? AND created_at < ?`, ws, funnelId, stepId, range.startUtc, range.endUtc,
  )!;
  return {
    range: { from: range.from, to: range.to, tz: range.tz },
    step: { stepId: step.id, name: step.name, path: step.base_path },
    ...computeMetrics({ views: a.views, uniques: a.uniques, optins: a.optins, orders: a.orders, cents: a.cents }),
    series: series(deps, ws, funnelId, range, stepId),
  };
}
