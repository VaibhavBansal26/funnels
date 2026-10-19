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

const AGG = `COALESCE(SUM(page_views), 0) AS views, COALESCE(SUM(unique_views), 0) AS uniques, COALESCE(SUM(optins), 0) AS optins,
             COALESCE(SUM(orders), 0) AS orders, COALESCE(SUM(cents), 0) AS cents`;

/** Reads come from `event_rollups` (15-minute UTC buckets kept by a trigger), never from a scan of raw events. */
const bounds = (r: Range) => [r.startUtc.slice(0, 16), r.endUtc.slice(0, 16)] as const;

function series(deps: Deps, ws: string, funnelId: string, range: Range, stepId?: string) {
  const [from, to] = bounds(range);
  const rows = deps.db.all<{ bucket: string; views: number; uniques: number; optins: number; orders: number; cents: number }>(
    `SELECT bucket, ${AGG} FROM event_rollups WHERE funnel_id = ? AND workspace_id = ? AND bucket >= ? AND bucket < ? ${stepId ? 'AND step_id = ?' : ''} GROUP BY bucket`,
    funnelId, ws, from, to, ...(stepId ? [stepId] : []),
  );
  const days = new Map(eachDay(range.from, range.to).map((d) => [d, { date: d, pageViews: 0, uniqueVisits: 0, optIns: 0, orders: 0, gross: 0, cents: 0 }]));
  for (const r of rows) {
    // Buckets are 15-minute UTC slices, so every real-world zone offset lands on a bucket edge and a day boundary never splits one.
    const day = days.get(dayKey(`${r.bucket}:00.000Z`, range.tz));
    if (!day) continue;
    day.pageViews += r.views;
    day.uniqueVisits += r.uniques;
    day.optIns += r.optins;
    day.orders += r.orders;
    day.cents += r.cents;
  }
  return [...days.values()].map(({ cents, ...d }) => ({ ...d, gross: round2(cents / 100) }));
}

/**
 * Exact distinct visitors for [start, end): whole UTC days come from `visitor_days` (one row per visitor per day),
 * the partial days at either edge (at most 24 h each, from time-zone offsets) come from raw events; the two sets are unioned.
 */
export function distinctVisitors(deps: Deps, funnelId: string, range: Range): number {
  const day = (iso: string) => iso.slice(0, 10);
  const startDay = range.startUtc.endsWith('T00:00:00.000Z') ? day(range.startUtc) : addDays(day(range.startUtc), 1);
  const endDay = day(range.endUtc); // exclusive: days before it end inside the range
  const slices: [string, string][] = [];
  let fullFrom = startDay;
  if (startDay > day(range.startUtc)) slices.push([range.startUtc, `${startDay}T00:00:00.000Z`]);
  if (!range.endUtc.endsWith('T00:00:00.000Z')) slices.push([`${endDay}T00:00:00.000Z`, range.endUtc]);
  if (fullFrom >= endDay) return deps.db.get<{ n: number }>(`SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE funnel_id = ? AND type = 'page_view' AND created_at >= ? AND created_at < ?`, funnelId, range.startUtc, range.endUtc)!.n;
  const raw = slices.map(() => `SELECT visitor_id FROM events WHERE funnel_id = ? AND type = 'page_view' AND created_at >= ? AND created_at < ?`);
  return deps.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (SELECT DISTINCT visitor_id FROM visitor_days WHERE funnel_id = ? AND day >= ? AND day < ? ${raw.map((r) => `UNION ${r}`).join(' ')})`,
    funnelId, fullFrom, endDay, ...slices.flatMap(([a, b]) => [funnelId, a, b]),
  )!.n;
}

export function funnelAnalytics(deps: Deps, ws: string, funnelId: string, q: z.infer<typeof AnalyticsQuery>) {
  requireFunnel(deps.db, ws, funnelId);
  deps.events.flush();
  const range = resolveRange(deps, q);
  const [from, to] = bounds(range);
  const perStep = new Map(
    deps.db.all<StepAgg>(`SELECT step_id, ${AGG} FROM event_rollups WHERE funnel_id = ? AND workspace_id = ? AND bucket >= ? AND bucket < ? GROUP BY step_id`, funnelId, ws, from, to).map((r) => [r.step_id, r]),
  );
  const totals = deps.db.get<Omit<StepAgg, 'step_id'>>(`SELECT ${AGG} FROM event_rollups WHERE funnel_id = ? AND workspace_id = ? AND bucket >= ? AND bucket < ?`, funnelId, ws, from, to)!;
  // Funnel-level uniques are distinct visitors, so someone who sees three steps is one visitor. This is the one query that needs raw events.
  const visitors = distinctVisitors(deps, funnelId, range);
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
  deps.events.flush();
  const range = resolveRange(deps, q);
  const [from, to] = bounds(range);
  const a = deps.db.get<Omit<StepAgg, 'step_id'>>(
    `SELECT ${AGG} FROM event_rollups WHERE funnel_id = ? AND workspace_id = ? AND step_id = ? AND bucket >= ? AND bucket < ?`, funnelId, ws, stepId, from, to,
  )!;
  return {
    range: { from: range.from, to: range.to, tz: range.tz },
    step: { stepId: step.id, name: step.name, path: step.base_path },
    ...computeMetrics({ views: a.views, uniques: a.uniques, optins: a.optins, orders: a.orders, cents: a.cents }),
    series: series(deps, ws, funnelId, range, stepId),
  };
}
