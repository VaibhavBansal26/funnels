import { childrenOf, wrapperOf, type GjsNode, type GjsProject } from '../pagemodel/shared/clean.js';
import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { badRequest, notFound } from '../errors.js';
import { ratio, round2 } from '../util/time.js';
import { addDays, dayKey, isValidTimeZone, startOfDayUtc } from '../util/time.js';
import { audit } from './audit.js';
import { bucketOf } from './rollups.js';
import type { ApiAuth } from './apikeys.js';

/**
 * Analytics API v1 queries (docs/ANALYTICS-API.md). Aggregates come from the 15-minute `event_rollups` (so a range is read at 15-minute granularity: `from` is
 * floored and `to` is ceiled to a bucket edge), raw exports from `events`/`leads`. Everything is scoped by the key's workspace and by its mode (`live` keys see
 * live funnels, `test` keys test funnels); trashed funnels are invisible; a funnel of another workspace or mode is a 404.
 */
const DAY = 86_400_000;
const MAX_RANGE_MS = 366 * DAY + 2 * 3_600_000; // 366 days, with room for a DST day
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const ApiRangeQuery = z.object({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  tz: z.string().max(64).optional(),
});
export const ApiListQuery = ApiRangeQuery.extend({ limit: z.coerce.number().int().min(1).max(1000).default(100), cursor: z.string().max(200).optional() });
export const TimeseriesQuery = ApiRangeQuery.extend({
  metric: z.enum(['visits', 'unique_visits', 'optins', 'orders', 'gross']).default('visits'),
  interval: z.enum(['hour', 'day', 'week', 'month']).default('day'),
});
export const ExportQuery = ApiRangeQuery.extend({
  limit: z.coerce.number().int().min(1).max(20_000).default(5000),
  cursor: z.string().max(300).optional(),
  funnel_id: z.string().max(64).optional(),
});

export interface ApiRange {
  tz: string;
  startMs: number;
  endMs: number;
  startUtc: string;
  endUtc: string;
  /** 15-minute bucket labels (`YYYY-MM-DDTHH:MM`) for rollup reads. */
  fromBucket: string;
  toBucket: string;
}

/**
 * `from`/`to` are dates (YYYY-MM-DD: the whole local day in `tz`, `to` inclusive) or datetimes with an offset (`to` exclusive). Default: the last 30 local days,
 * today included. Longer than 366 days is refused.
 */
export function resolveApiRange(deps: Deps, q: z.infer<typeof ApiRangeQuery>): ApiRange {
  const tz = q.tz ?? 'UTC';
  if (!isValidTimeZone(tz)) throw badRequest('INVALID_TIMEZONE', `Unknown time zone "${tz}"`);
  const parse = (v: string, end: boolean): number => {
    if (ISO_DAY.test(v)) {
      if (Number.isNaN(Date.parse(v))) throw badRequest('INVALID_RANGE', `"${v}" is not a valid date`);
      return startOfDayUtc(end ? addDays(v, 1) : v, tz).getTime();
    }
    if (!ISO_DATETIME.test(v) || Number.isNaN(Date.parse(v))) throw badRequest('INVALID_RANGE', `"${v}" is not an ISO date (YYYY-MM-DD) or datetime with an offset (2026-03-01T00:00:00Z)`);
    return Date.parse(v);
  };
  const today = dayKey(deps.now(), tz);
  const endMs = q.to ? parse(q.to, true) : startOfDayUtc(addDays(today, 1), tz).getTime();
  const startMs = q.from ? parse(q.from, false) : startOfDayUtc(addDays(today, -29), tz).getTime();
  if (startMs >= endMs) throw badRequest('INVALID_RANGE', '"from" must be before "to"');
  if (endMs - startMs > MAX_RANGE_MS) throw badRequest('INVALID_RANGE', 'The range may span at most 366 days');
  const startUtc = new Date(startMs).toISOString();
  const endUtc = new Date(endMs).toISOString();
  const ceil = endMs % 900_000 === 0 ? endUtc : new Date(Math.ceil(endMs / 900_000) * 900_000).toISOString();
  return { tz, startMs, endMs, startUtc, endUtc, fromBucket: bucketOf(startUtc), toBucket: bucketOf(ceil) };
}

const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function decode<T>(c: string | undefined, valid: (v: unknown) => v is T): T | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString()) as unknown;
    if (valid(v)) return v;
  } catch {
    /* falls through */
  }
  throw badRequest('INVALID_CURSOR', 'The cursor is not valid; start again without one');
}

interface Agg {
  views: number;
  uniques: number;
  optins: number;
  orders: number;
  cents: number;
}
const zero = (): Agg => ({ views: 0, uniques: 0, optins: 0, orders: 0, cents: 0 });
const num = (v: unknown) => Number(v ?? 0);
const AGG = `COALESCE(SUM(page_views), 0) AS views, COALESCE(SUM(unique_views), 0) AS uniques, COALESCE(SUM(optins), 0) AS optins, COALESCE(SUM(orders), 0) AS orders, COALESCE(SUM(cents), 0) AS cents`;

const money = (cents: number) => round2(cents / 100);
const fraction = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : 0);

interface FunnelRow {
  id: string;
  name: string;
  status: 'live' | 'test';
  created_at: string;
}

async function visibleFunnel(deps: Deps, api: ApiAuth, id: string): Promise<FunnelRow> {
  const f = await deps.db.get<FunnelRow>('SELECT id, name, status, created_at FROM funnels WHERE workspace_id = ? AND id = ? AND status = ? AND deleted_at IS NULL', api.workspaceId, id, api.mode);
  if (!f) throw notFound('Funnel');
  return f;
}

const inList = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export async function listFunnels(deps: Deps, api: ApiAuth, q: z.infer<typeof ApiListQuery>) {
  const range = resolveApiRange(deps, q);
  const after = decode(q.cursor, (v): v is { id: string } => typeof (v as { id?: unknown })?.id === 'string')?.id ?? '';
  const rows = await deps.db.all<FunnelRow>(
    'SELECT id, name, status, created_at FROM funnels WHERE workspace_id = ? AND status = ? AND deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?', api.workspaceId, api.mode, after, q.limit + 1,
  );
  const page = rows.slice(0, q.limit);
  const ids = page.map((f) => f.id);
  const steps = ids.length ? await deps.db.all<{ funnel_id: string; id: string; position: number }>(`SELECT funnel_id, id, position FROM steps WHERE funnel_id IN (${inList(ids.length)}) ORDER BY funnel_id, position`, ...ids) : [];
  const entry = new Map<string, string>();
  const count = new Map<string, number>();
  for (const s of steps) {
    if (!entry.has(s.funnel_id)) entry.set(s.funnel_id, s.id);
    count.set(s.funnel_id, (count.get(s.funnel_id) ?? 0) + 1);
  }
  const rolled = ids.length
    ? await deps.db.all<Agg & { funnel_id: string; step_id: string }>(
        `SELECT funnel_id, step_id, ${AGG} FROM event_rollups WHERE workspace_id = ? AND funnel_id IN (${inList(ids.length)}) AND bucket >= ? AND bucket < ? GROUP BY funnel_id, step_id`, api.workspaceId, ...ids, range.fromBucket, range.toBucket,
      )
    : [];
  const totals = new Map<string, Agg>();
  for (const r of rolled) {
    const t = totals.get(r.funnel_id) ?? zero();
    t.views += num(r.views);
    t.optins += num(r.optins);
    t.orders += num(r.orders);
    t.cents += num(r.cents);
    if (entry.get(r.funnel_id) === r.step_id) t.uniques += num(r.uniques);
    totals.set(r.funnel_id, t);
  }
  const currencies = ids.length
    ? await deps.db.all<{ funnel_id: string; currency: string }>(`SELECT DISTINCT funnel_id, currency FROM orders WHERE workspace_id = ? AND funnel_id IN (${inList(ids.length)}) AND created_at >= ? AND created_at < ?`, api.workspaceId, ...ids, range.startUtc, range.endUtc)
    : [];
  const byCurrency = new Map<string, string[]>();
  for (const c of currencies) byCurrency.set(c.funnel_id, [...(byCurrency.get(c.funnel_id) ?? []), c.currency]);
  return {
    data: page.map((f) => {
      const t = totals.get(f.id) ?? zero();
      const cur = byCurrency.get(f.id) ?? [];
      return {
        id: f.id, name: f.name, status: f.status, steps_count: count.get(f.id) ?? 0, visits: t.views, unique_visits: t.uniques, optins: t.optins, optin_rate: fraction(t.optins, t.uniques),
        orders: t.orders, gross: money(t.cents), currency: cur.length === 1 ? cur[0]! : null, earnings_per_view: Math.round(ratio(t.cents / 100, t.views) * 10_000) / 10_000, created_at: f.created_at,
      };
    }),
    next_cursor: rows.length > q.limit && page.length ? encode({ id: page[page.length - 1]!.id }) : null,
  };
}

export async function funnelSteps(deps: Deps, api: ApiAuth, funnelId: string, q: z.infer<typeof ApiRangeQuery>) {
  const range = resolveApiRange(deps, q);
  await visibleFunnel(deps, api, funnelId);
  const steps = await deps.db.all<{ id: string; name: string; position: number }>('SELECT id, name, position FROM steps WHERE workspace_id = ? AND funnel_id = ? ORDER BY position', api.workspaceId, funnelId);
  const rolled = new Map(
    (await deps.db.all<Agg & { step_id: string }>(`SELECT step_id, ${AGG} FROM event_rollups WHERE workspace_id = ? AND funnel_id = ? AND bucket >= ? AND bucket < ? GROUP BY step_id`, api.workspaceId, funnelId, range.fromBucket, range.toBucket)).map((r) => [r.step_id, r]),
  );
  const data = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const a = rolled.get(s.id);
    const uniques = num(a?.uniques);
    let exit: number | null = null;
    if (i < steps.length - 1) {
      // Of the visitors who first saw this step in the range, how many never saw the next step (at any time)? Counted from visitor_steps, the exact first-view ledger.
      const r = await deps.db.get<{ reached: number; onward: number }>(
        `SELECT COUNT(*) AS reached, COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM visitor_steps b WHERE b.funnel_id = a.funnel_id AND b.step_id = ? AND b.visitor_id = a.visitor_id) THEN 1 ELSE 0 END), 0) AS onward
         FROM visitor_steps a WHERE a.funnel_id = ? AND a.step_id = ? AND a.first_seen >= ? AND a.first_seen < ?`, steps[i + 1]!.id, funnelId, s.id, range.startUtc, range.endUtc,
      );
      exit = num(r?.reached) > 0 ? fraction(num(r!.reached) - num(r!.onward), num(r!.reached)) : 0;
    }
    data.push({ step_id: s.id, name: s.name, order: i + 1, visits: num(a?.views), unique_visits: uniques, optins: num(a?.optins), optin_rate: fraction(num(a?.optins), uniques), orders: num(a?.orders), gross: money(num(a?.cents)), exit_rate: exit, avg_time_on_page_s: null });
  }
  return { data, next_cursor: null };
}

// ---- time series -------------------------------------------------------------------------------------------------------------------------------------

const partsFmt = new Map<string, Intl.DateTimeFormat>();
function localParts(ms: number, tz: string) {
  let f = partsFmt.get(tz);
  if (!f) partsFmt.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })));
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(ms)) o[p.type] = p.value;
  return { y: o.year!, m: o.month!, d: o.day!, minute: Number(o.minute), weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(o.weekday!) };
}

/** Start (UTC ms) of the local hour, day, ISO week (Monday) or month containing the instant. */
export function intervalStart(ms: number, tz: string, interval: 'hour' | 'day' | 'week' | 'month'): number {
  const p = localParts(ms, tz);
  const day = `${p.y}-${p.m}-${p.d}`;
  if (interval === 'hour') return Math.floor(ms / 60_000) * 60_000 - p.minute * 60_000;
  if (interval === 'day') return startOfDayUtc(day, tz).getTime();
  if (interval === 'week') return startOfDayUtc(addDays(day, -p.weekday), tz).getTime();
  return startOfDayUtc(`${p.y}-${p.m}-01`, tz).getTime();
}

/** Every interval start in [startMs, endMs), including the one that contains startMs, zero-filled by the caller. */
export function enumerateIntervals(startMs: number, endMs: number, tz: string, interval: 'hour' | 'day' | 'week' | 'month'): number[] {
  const out = new Set<number>();
  const step = interval === 'hour' ? 3_600_000 : 12 * 3_600_000; // half-days reach every local day, also across 23 and 25 hour days
  for (let t = startMs; t < endMs; t += step) out.add(intervalStart(t, tz, interval));
  out.add(intervalStart(endMs - 1, tz, interval));
  return [...out].filter((s) => s < endMs).sort((a, b) => a - b);
}

export async function funnelTimeseries(deps: Deps, api: ApiAuth, funnelId: string, q: z.infer<typeof TimeseriesQuery>) {
  const range = resolveApiRange(deps, q);
  if (q.interval === 'hour' && range.endMs - range.startMs > 31 * DAY + 2 * 3_600_000) throw badRequest('INVALID_RANGE', 'Hourly series may span at most 31 days');
  await visibleFunnel(deps, api, funnelId);
  let entryId: string | undefined;
  if (q.metric === 'unique_visits') {
    entryId = (await deps.db.get<{ id: string }>('SELECT id FROM steps WHERE workspace_id = ? AND funnel_id = ? ORDER BY position LIMIT 1', api.workspaceId, funnelId))?.id;
    if (!entryId) return { interval: q.interval, metric: q.metric, tz: range.tz, points: [] };
  }
  const rows = await deps.db.all<Agg & { bucket: string }>(
    `SELECT bucket, ${AGG} FROM event_rollups WHERE workspace_id = ? AND funnel_id = ? AND bucket >= ? AND bucket < ? ${entryId ? 'AND step_id = ?' : ''} GROUP BY bucket`,
    api.workspaceId, funnelId, range.fromBucket, range.toBucket, ...(entryId ? [entryId] : []),
  );
  const pick = (r: Agg): number => (q.metric === 'visits' ? num(r.views) : q.metric === 'unique_visits' ? num(r.uniques) : q.metric === 'optins' ? num(r.optins) : q.metric === 'orders' ? num(r.orders) : num(r.cents));
  const sums = new Map<number, number>();
  const utc = range.tz === 'UTC' && q.interval === 'hour';
  for (const r of rows) {
    const at = Date.parse(`${r.bucket}:00.000Z`);
    const key = utc ? Math.floor(at / 3_600_000) * 3_600_000 : intervalStart(at, range.tz, q.interval);
    sums.set(key, (sums.get(key) ?? 0) + pick(r));
  }
  return {
    interval: q.interval, metric: q.metric, tz: range.tz,
    points: enumerateIntervals(range.startMs, range.endMs, range.tz, q.interval).map((s) => ({ t: new Date(s).toISOString(), value: q.metric === 'gross' ? money(sums.get(s) ?? 0) : (sums.get(s) ?? 0) })),
  };
}

// ---- identity pepper and exports ---------------------------------------------------------------------------------------------------------------------

/** The workspace's secret for exported keys, created on first use. Whoever holds it can recompute `contact_key`s from emails, so it is only ever shown to people (never to API keys). */
export async function identityPepper(deps: Deps, ws: string): Promise<{ pepper: string; rotatedAt: string | null }> {
  const w = await deps.db.get<{ identity_pepper: string | null; identity_pepper_rotated_at: string | null }>('SELECT identity_pepper, identity_pepper_rotated_at FROM workspaces WHERE id = ?', ws);
  if (!w) throw notFound('Workspace');
  if (w.identity_pepper) return { pepper: w.identity_pepper, rotatedAt: w.identity_pepper_rotated_at };
  const fresh = randomBytes(32).toString('hex');
  // Two requests racing to create it: the conditional update means exactly one value wins, and both read it back.
  await deps.db.run('UPDATE workspaces SET identity_pepper = ? WHERE id = ? AND identity_pepper IS NULL', fresh, ws);
  const again = (await deps.db.get<{ identity_pepper: string }>('SELECT identity_pepper FROM workspaces WHERE id = ?', ws))!;
  return { pepper: again.identity_pepper, rotatedAt: null };
}

export async function rotatePepper(deps: Deps, auth: Auth, ip?: string) {
  const fresh = randomBytes(32).toString('hex');
  const at = deps.now().toISOString();
  await deps.db.run('UPDATE workspaces SET identity_pepper = ?, identity_pepper_rotated_at = ? WHERE id = ?', fresh, at, auth.workspaceId);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'analytics.pepper_rotated', ip });
  return { pepper: fresh, rotatedAt: at };
}

const keyer = (pepper: string) => (kind: 'v' | 'c', value: string) => createHmac('sha256', pepper).update(kind === 'c' ? value.trim().toLowerCase() : `v:${value}`).digest('hex');

const DEVICES = new Set(['desktop', 'mobile', 'tablet', 'unknown']);
const utmOf = (json: string | null): { source: string | null; medium: string | null; campaign: string | null } => {
  try {
    const u = JSON.parse(json ?? '{}') as Record<string, unknown>;
    const s = (k: string) => (typeof u[k] === 'string' && u[k] ? (u[k] as string) : null);
    return { source: s('source'), medium: s('medium'), campaign: s('campaign') };
  } catch {
    return { source: null, medium: null, campaign: null };
  }
};

interface ExportPage {
  /** NDJSON body: one JSON object per line, each newline-terminated. */
  body: string;
  nextCursor: string | null;
  rows: number;
}

const isCursor = (v: unknown): v is { t: string; id: string } => typeof (v as { t?: unknown })?.t === 'string' && typeof (v as { id?: unknown })?.id === 'string';

/** One page of events, ordered by (ts, id). Page, then ask again with `X-Next-Cursor`: resumable and stable (a row is never skipped or repeated). */
export async function exportEvents(deps: Deps, api: ApiAuth, q: z.infer<typeof ExportQuery>): Promise<ExportPage> {
  const range = resolveApiRange(deps, q);
  const cur = decode(q.cursor, isCursor);
  const { pepper } = await identityPepper(deps, api.workspaceId);
  const hmac = keyer(pepper);
  const rows = await deps.db.all<{
    id: string; created_at: string; type: 'page_view' | 'optin' | 'order'; funnel_id: string; step_id: string; visitor_id: string | null; unique_visit: number; utm_json: string | null;
    device: string | null; country: string | null; referrer_host: string | null; amount_cents: number; currency: string | null; lead_email: string | null;
  }>(
    `SELECT e.id, e.created_at, e.type, e.funnel_id, e.step_id, e.visitor_id, e.unique_visit, e.utm_json, e.device, e.country, e.referrer_host, e.amount_cents, e.currency, l.email AS lead_email
     FROM events e JOIN funnels f ON f.id = e.funnel_id AND f.workspace_id = e.workspace_id AND f.status = ? AND f.deleted_at IS NULL
     LEFT JOIN leads l ON l.id = e.lead_id AND l.workspace_id = e.workspace_id
     WHERE e.workspace_id = ? AND e.created_at >= ? AND e.created_at < ? ${q.funnel_id ? 'AND e.funnel_id = ?' : ''} ${cur ? 'AND (e.created_at > ? OR (e.created_at = ? AND e.id > ?))' : ''}
     ORDER BY e.created_at, e.id LIMIT ?`,
    api.mode, api.workspaceId, range.startUtc, range.endUtc, ...(q.funnel_id ? [q.funnel_id] : []), ...(cur ? [cur.t, cur.t, cur.id] : []), q.limit + 1,
  );
  const page = rows.slice(0, q.limit);
  const lines = page.map((r) => {
    const u = utmOf(r.utm_json);
    return JSON.stringify({
      id: r.id, ts: r.created_at, type: r.type, funnel_id: r.funnel_id, step_id: r.step_id,
      visitor_key: r.visitor_id ? hmac('v', r.visitor_id) : null, contact_key: r.lead_email ? hmac('c', r.lead_email) : null,
      utm_source: u.source, utm_medium: u.medium, utm_campaign: u.campaign,
      device: r.device && DEVICES.has(r.device) ? r.device : 'unknown', country: r.country, referrer_host: r.referrer_host,
      amount: r.type === 'order' ? money(num(r.amount_cents)) : null, currency: r.type === 'order' ? r.currency : null, unique_visit: r.unique_visit === 1,
    });
  });
  const last = page[page.length - 1];
  return { body: lines.length ? `${lines.join('\n')}\n` : '', nextCursor: rows.length > q.limit && last ? encode({ t: last.created_at, id: last.id }) : null, rows: lines.length };
}

export async function exportLeads(deps: Deps, api: ApiAuth, q: z.infer<typeof ExportQuery>): Promise<ExportPage> {
  const range = resolveApiRange(deps, q);
  const cur = decode(q.cursor, isCursor);
  const { pepper } = await identityPepper(deps, api.workspaceId);
  const hmac = keyer(pepper);
  const leads = await deps.db.all<{ id: string; email: string; created_at: string; first_funnel_id: string | null }>(
    `SELECT l.id, l.email, l.created_at, l.first_funnel_id FROM leads l JOIN funnels f ON f.id = l.first_funnel_id AND f.workspace_id = l.workspace_id AND f.status = ? AND f.deleted_at IS NULL
     WHERE l.workspace_id = ? AND l.created_at >= ? AND l.created_at < ? ${q.funnel_id ? 'AND l.first_funnel_id = ?' : ''} ${cur ? 'AND (l.created_at > ? OR (l.created_at = ? AND l.id > ?))' : ''}
     ORDER BY l.created_at, l.id LIMIT ?`,
    api.mode, api.workspaceId, range.startUtc, range.endUtc, ...(q.funnel_id ? [q.funnel_id] : []), ...(cur ? [cur.t, cur.t, cur.id] : []), q.limit + 1,
  );
  const page = leads.slice(0, q.limit);
  const events = new Map<string, { step_id: string; type: string; utm_json: string | null; created_at: string }>();
  const orders = new Map<string, { n: number; cents: number; first: string }>();
  for (let i = 0; i < page.length; i += 500) {
    const ids = page.slice(i, i + 500).map((l) => l.id);
    for (const e of await deps.db.all<{ lead_id: string; step_id: string; type: string; utm_json: string | null; created_at: string }>(`SELECT lead_id, step_id, type, utm_json, created_at FROM events WHERE workspace_id = ? AND lead_id IN (${inList(ids.length)}) ORDER BY created_at, id`, api.workspaceId, ...ids)) {
      if (!events.has(e.lead_id)) events.set(e.lead_id, e); // the earliest event of the lead: how it first arrived
    }
    for (const o of await deps.db.all<{ lead_id: string; n: number; cents: number; first: string }>(`SELECT lead_id, COUNT(*) AS n, COALESCE(SUM(amount_cents - disputed_lost_cents), 0) AS cents, MIN(created_at) AS first FROM orders WHERE workspace_id = ? AND lead_id IN (${inList(ids.length)}) GROUP BY lead_id`, api.workspaceId, ...ids)) {
      orders.set(o.lead_id, { n: num(o.n), cents: num(o.cents), first: o.first });
    }
  }
  const lines = page.map((l) => {
    const e = events.get(l.id);
    const o = orders.get(l.id);
    const u = utmOf(e?.utm_json ?? null);
    return JSON.stringify({
      id: l.id, created_at: l.created_at, funnel_id: l.first_funnel_id, step_id: e?.step_id ?? null, contact_key: hmac('c', l.email), source: e?.type === 'order' ? 'checkout' : 'form',
      utm_source: u.source, utm_campaign: u.campaign, converted_to_order: !!o, order_total: money(o?.cents ?? 0), first_order_at: o?.first ?? null,
    });
  });
  const last = page[page.length - 1];
  return { body: lines.length ? `${lines.join('\n')}\n` : '', nextCursor: leads.length > q.limit && last ? encode({ t: last.created_at, id: last.id }) : null, rows: lines.length };
}

// ---- funnel structure --------------------------------------------------------------------------------------------------------------------------------

interface Blk {
  type?: string;
  text?: string;
  items?: unknown[];
  orderBump?: boolean;
  oneClickUpsell?: boolean;
  children?: Blk[];
  columns?: { children?: Blk[] }[];
}

const words = (s: unknown) => (typeof s === 'string' ? s.trim().split(/\s+/).filter(Boolean).length : 0);

/** Counts what the content-aware ranking needs from a page document: block counts, visible copy (headings, paragraphs, buttons, lists, FAQ) and offer features. */
export function summarizeDoc(doc: { blocks?: Blk[]; project?: GjsProject }) {
  if (doc.project) return summarizeProject(doc.project);
  const counts = { form: 0, checkout: 0, video: 0, countdown: 0 };
  let wordCount = 0;
  let bump = false;
  let upsell = false;
  const walk = (list: Blk[] | undefined) => {
    for (const b of list ?? []) {
      if (b.type === 'form' || b.type === 'checkout' || b.type === 'video' || b.type === 'countdown') counts[b.type]++;
      if (b.type === 'heading' || b.type === 'paragraph' || b.type === 'button') wordCount += words(b.text);
      if (b.type === 'list') for (const i of b.items ?? []) wordCount += words(i);
      if (b.type === 'faq') for (const i of b.items ?? []) wordCount += words((i as { q?: unknown }).q) + words((i as { a?: unknown }).a);
      if (b.type === 'checkout') {
        bump ||= b.orderBump === true;
        upsell ||= b.oneClickUpsell === true;
      }
      walk(b.children);
      for (const c of b.columns ?? []) walk(c.children);
    }
  };
  walk(doc.blocks);
  return { blocks: counts, word_count: wordCount, has_order_bump: bump, has_upsell: upsell };
}

export async function funnelStructure(deps: Deps, api: ApiAuth, q: z.infer<typeof ApiListQuery>) {
  const after = decode(q.cursor, (v): v is { id: string } => typeof (v as { id?: unknown })?.id === 'string')?.id ?? '';
  const rows = await deps.db.all<FunnelRow>('SELECT id, name, status, created_at FROM funnels WHERE workspace_id = ? AND status = ? AND deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?', api.workspaceId, api.mode, after, q.limit + 1);
  const page = rows.slice(0, q.limit);
  const ids = page.map((f) => f.id);
  const steps = ids.length
    ? await deps.db.all<{ funnel_id: string; id: string; name: string; base_path: string; position: number; doc_json: string | null }>(
        `SELECT s.funnel_id, s.id, s.name, s.base_path, s.position, p.doc_json FROM steps s LEFT JOIN step_pages p ON p.step_id = s.id WHERE s.workspace_id = ? AND s.funnel_id IN (${inList(ids.length)}) ORDER BY s.funnel_id, s.position`, api.workspaceId, ...ids,
      )
    : [];
  const by = new Map<string, typeof steps>();
  for (const s of steps) by.set(s.funnel_id, [...(by.get(s.funnel_id) ?? []), s]);
  return {
    data: page.map((f) => {
      const list = (by.get(f.id) ?? []).map((s, i) => {
        let doc: { blocks?: Blk[]; project?: GjsProject } = {};
        try {
          doc = s.doc_json ? (JSON.parse(s.doc_json) as { blocks?: Blk[]; project?: GjsProject }) : {};
        } catch {
          /* an unreadable document counts as empty */
        }
        return { step_id: s.id, name: s.name, order: i + 1, path: s.base_path, ...summarizeDoc(doc) };
      });
      return { id: f.id, name: f.name, status: f.status, steps: list, has_order_bump: list.some((s) => s.has_order_bump), has_upsell: list.some((s) => s.has_upsell), word_count: list.reduce((a, s) => a + s.word_count, 0) };
    }),
    next_cursor: rows.length > q.limit && page.length ? encode({ id: page[page.length - 1]!.id }) : null,
  };
}
const FN_COUNT: Record<string, 'form' | 'checkout' | 'video' | 'countdown'> = { 'fn-form': 'form', 'fn-checkout': 'checkout', 'fn-video': 'video', 'fn-countdown': 'countdown' };

/** The same summary for GrapesJS project documents: element counts by type and the words of all visible text. */
function summarizeProject(project: GjsProject) {
  const counts = { form: 0, checkout: 0, video: 0, countdown: 0 };
  let wordCount = 0;
  let bump = false;
  let upsell = false;
  const visit = (n: GjsNode) => {
    if (n.type === 'textnode') wordCount += words(n.content);
    const kind = typeof n.type === 'string' ? FN_COUNT[n.type] : undefined;
    if (kind) counts[kind]++;
    if (n.type === 'fn-checkout') {
      const p = n.fnProduct as { orderBump?: boolean; oneClickUpsell?: boolean } | undefined;
      bump ||= p?.orderBump === true;
      upsell ||= p?.oneClickUpsell === true;
    }
    for (const c of childrenOf(n)) visit(c);
  };
  visit(wrapperOf(project));
  return { blocks: counts, word_count: wordCount, has_order_bump: bump, has_upsell: upsell };
}

