import { z } from 'zod';
import type { Deps } from '../deps.js';
import { badRequest } from '../errors.js';
import { listSteps, requireFunnel, requireStep } from '../repos/funnels.js';
import { HyperLogLog, STANDARD_ERROR_PCT } from '../util/hll.js';
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

export interface Distinct {
  value: number;
  method: 'exact' | 'hll';
  /** Standard error of the estimate in percent (0 for exact). About 95% of estimates are within twice this. */
  standardErrorPct: number;
}

const exactDistinct = async (deps: Deps, funnelId: string, from: string, to: string): Promise<number> =>
  (await deps.db.get<{ n: number }>(`SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE funnel_id = ? AND type = 'page_view' AND created_at >= ? AND created_at < ?`, funnelId, from, to))!.n;

/**
 * Distinct page-view visitors for [start, end). Exact (a scan of the funnel's events in the range, which prunes to the months involved) when the range
 * has at most `ANALYTICS_EXACT_DISTINCT_MAX` page views or the mode says so. Above that it unions the per-day HyperLogLog sketches of the whole UTC days
 * in the range (1.6% standard error) and adds the visitors of the partial days at either edge (zone offsets) exactly; the result says which it was.
 * `totalViews` comes from the rollups, so choosing costs nothing.
 */
export async function distinctVisitors(deps: Deps, funnelId: string, range: Range, totalViews = 0): Promise<Distinct> {
  const mode = deps.config.ANALYTICS_DISTINCT_MODE;
  const day = (iso: string) => iso.slice(0, 10);
  const startsAtMidnight = range.startUtc.endsWith('T00:00:00.000Z');
  const endsAtMidnight = range.endUtc.endsWith('T00:00:00.000Z');
  const firstWhole = startsAtMidnight ? day(range.startUtc) : addDays(day(range.startUtc), 1);
  const lastWholeExclusive = day(range.endUtc);
  const useSketch = mode === 'sketch' || (mode === 'auto' && totalViews > deps.config.ANALYTICS_EXACT_DISTINCT_MAX);
  if (!useSketch || firstWhole >= lastWholeExclusive) return { value: await exactDistinct(deps, funnelId, range.startUtc, range.endUtc), method: 'exact', standardErrorPct: 0 };
  const merged = new HyperLogLog();
  for (const r of await deps.db.all<{ regs: string }>('SELECT regs FROM visitor_sketches WHERE funnel_id = ? AND day >= ? AND day < ?', funnelId, firstWhole, lastWholeExclusive)) {
    if (r.regs) merged.merge(HyperLogLog.deserialize(r.regs));
  }
  const edges: [string, string][] = [];
  if (!startsAtMidnight) edges.push([range.startUtc, `${firstWhole}T00:00:00.000Z`]);
  if (!endsAtMidnight) edges.push([`${lastWholeExclusive}T00:00:00.000Z`, range.endUtc]);
  for (const [from, to] of edges) {
    for (const r of await deps.db.all<{ visitor_id: string }>(`SELECT DISTINCT visitor_id FROM events WHERE funnel_id = ? AND type = 'page_view' AND visitor_id IS NOT NULL AND created_at >= ? AND created_at < ?`, funnelId, from, to)) merged.add(r.visitor_id);
  }
  return { value: merged.estimate(), method: 'hll', standardErrorPct: Math.round(STANDARD_ERROR_PCT * 100) / 100 };
}

export async function funnelAnalytics(base: Deps, ws: string, funnelId: string, q: z.infer<typeof AnalyticsQuery>) {
  await base.events.flush();
  const deps: Deps = { ...base, db: base.db.read(ws) }; // analytics tolerate replica lag (see REPLICA_MAX_LAG_MS); a recent write pins this workspace to the primary
  await requireFunnel(deps.db, ws, funnelId);
  const range = resolveRange(deps, q);
  const [from, to] = bounds(range);
  const perStep = new Map(
    (await deps.db.all<StepAgg>(`SELECT step_id, ${AGG} FROM event_rollups WHERE funnel_id = ? AND workspace_id = ? AND bucket >= ? AND bucket < ? GROUP BY step_id`, funnelId, ws, from, to)).map((r) => [r.step_id, r] as const),
  );
  const totals = (await deps.db.get<Omit<StepAgg, 'step_id'>>(`SELECT ${AGG} FROM event_rollups WHERE funnel_id = ? AND workspace_id = ? AND bucket >= ? AND bucket < ?`, funnelId, ws, from, to))!;
  // Funnel-level uniques are distinct visitors, so someone who sees three steps is one visitor. This is the one query that needs raw events.
  const visitors = await distinctVisitors(deps, funnelId, range, totals.views);
  const steps = (await listSteps(deps.db, ws, funnelId)).map((s) => {
    const a = perStep.get(s.id);
    return { stepId: s.id, name: s.name, path: s.base_path, position: s.position, ...computeMetrics({ views: a?.views ?? 0, uniques: a?.uniques ?? 0, optins: a?.optins ?? 0, orders: a?.orders ?? 0, cents: a?.cents ?? 0 }) };
  });
  return {
    range: { from: range.from, to: range.to, tz: range.tz },
    distinct: { method: visitors.method, standardErrorPct: visitors.standardErrorPct },
    summary: computeMetrics({ views: totals.views, uniques: visitors.value, optins: totals.optins, orders: totals.orders, cents: totals.cents }),
    steps,
    series: await series(deps, ws, funnelId, range),
  };
}

export async function stepAnalytics(base: Deps, ws: string, funnelId: string, stepId: string, q: z.infer<typeof AnalyticsQuery>) {
  await base.events.flush();
  const deps: Deps = { ...base, db: base.db.read(ws) };
  await requireFunnel(deps.db, ws, funnelId);
  const step = await requireStep(deps.db, ws, funnelId, stepId);
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
