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

/** Reads come from `event_rollups` (15-minute UTC buckets written with every event batch, see rollups.ts), never from a scan of raw events. */
const bounds = (r: Range) => [r.startUtc.slice(0, 16), r.endUtc.slice(0, 16)] as const;

async function series(deps: Deps, ws: string, funnelId: string, range: Range, stepId?: string) {
  const [from, to] = bounds(range);
  const rows = await deps.db.all<{ bucket: string; views: number; uniques: number; optins: number; orders: number; cents: number }>(
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
 * Exact distinct page-view visitors for [start, end) by a scan of the funnel's raw events (`idx_events_funnel_time`).
 * A per-day distinct table was tried and removed: see docs/PERFORMANCE.md.
 */
export async function distinctVisitors(deps: Deps, funnelId: string, range: Range): Promise<number> {
  return (await deps.db.get<{ n: number }>(`SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE funnel_id = ? AND type = 'page_view' AND created_at >= ? AND created_at < ?`, funnelId, range.startUtc, range.endUtc))!.n;
}

export async function funnelAnalytics(deps: Deps, ws: string, funnelId: string, q: z.infer<typeof AnalyticsQuery>) {
  await requireFunnel(deps.db, ws, funnelId);
  await deps.events.flush();
  const range = resolveRange(deps, q);
  const [from, to] = bounds(range);
  const perStep = new Map(
    (await deps.db.all<StepAgg>(`SELECT step_id, ${AGG} FROM event_rollups WHERE funnel_id = ? AND workspace_id = ? AND bucket >= ? AND bucket < ? GROUP BY step_id`, funnelId, ws, from, to)).map((r) => [r.step_id, r] as const),
  );
  const totals = (await deps.db.get<Omit<StepAgg, 'step_id'>>(`SELECT ${AGG} FROM event_rollups WHERE funnel_id = ? AND workspace_id = ? AND bucket >= ? AND bucket < ?`, funnelId, ws, from, to))!;
  // Funnel-level uniques are distinct visitors, so someone who sees three steps is one visitor. This is the one query that needs raw events.
  const visitors = await distinctVisitors(deps, funnelId, range);
  const steps = (await listSteps(deps.db, ws, funnelId)).map((s) => {
    const a = perStep.get(s.id);
    return { stepId: s.id, name: s.name, path: s.base_path, position: s.position, ...computeMetrics({ views: a?.views ?? 0, uniques: a?.uniques ?? 0, optins: a?.optins ?? 0, orders: a?.orders ?? 0, cents: a?.cents ?? 0 }) };
  });
  return {
    range: { from: range.from, to: range.to, tz: range.tz },
    summary: computeMetrics({ views: totals.views, uniques: visitors, optins: totals.optins, orders: totals.orders, cents: totals.cents }),
    steps,
    series: await series(deps, ws, funnelId, range),
  };
}

export async function stepAnalytics(deps: Deps, ws: string, funnelId: string, stepId: string, q: z.infer<typeof AnalyticsQuery>) {
  await requireFunnel(deps.db, ws, funnelId);
  const step = await requireStep(deps.db, ws, funnelId, stepId);
  await deps.events.flush();
  const range = resolveRange(deps, q);
  const [from, to] = bounds(range);
  const a = (await deps.db.get<Omit<StepAgg, 'step_id'>>(
    `SELECT ${AGG} FROM event_rollups WHERE funnel_id = ? AND workspace_id = ? AND step_id = ? AND bucket >= ? AND bucket < ?`, funnelId, ws, stepId, from, to,
  ))!;
  return {
    range: { from: range.from, to: range.to, tz: range.tz },
    step: { stepId: step.id, name: step.name, path: step.base_path },
    ...computeMetrics({ views: a.views, uniques: a.uniques, optins: a.optins, orders: a.orders, cents: a.cents }),
    series: await series(deps, ws, funnelId, range, stepId),
  };
}
