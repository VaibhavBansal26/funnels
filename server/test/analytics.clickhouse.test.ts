import { describe, expect, it } from 'vitest';
import { writeOutbox } from '../src/queue/outbox.js';
import { analyticsReadStats } from '../src/services/analytics.js';
import { ClickHouseEventStore } from '../src/store/clickhouse.js';
import { ClickHouseReader } from '../src/store/clickhousereader.js';
import { makeFunnel, makeHarness, seedEvents, type Harness } from './helpers.js';

// A fake ClickHouse HTTP endpoint. It records every request and answers the reader's queries from the primary database's own rollups and events, so
// "ClickHouse path == primary path" can be asserted on real numbers. It does NOT execute the ClickHouse SQL: that is unverified until run on a real server.
interface Call { sql: string; params: Record<string, string>; query: URLSearchParams }
function fakeClickHouse(h: () => Harness, opts: { fail?: () => boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const params: Record<string, string> = {};
    for (const [k, v] of u.searchParams) if (k.startsWith('param_')) params[k.slice(6)] = v;
    const sql = String(init.body);
    calls.push({ sql, params, query: u.searchParams });
    if (opts.fail?.()) return new Response('Code: 241. DB::Exception: Memory limit exceeded', { status: 500 });
    const db = h().deps.db;
    const label = (iso: string) => iso.slice(0, 16);
    let data: unknown[];
    if (/GROUP BY step_id/.test(sql)) {
      data = await db.all('SELECT step_id, SUM(page_views) AS views, SUM(unique_views) AS uniques, SUM(optins) AS optins, SUM(orders) AS orders, SUM(cents) AS cents FROM event_rollups WHERE workspace_id = ? AND funnel_id = ? AND bucket >= ? AND bucket < ? GROUP BY step_id', params.ws!, params.f!, label(params.from!), label(params.to!));
    } else if (/GROUP BY bucket/.test(sql)) {
      data = await db.all(`SELECT bucket, SUM(page_views) AS views, SUM(unique_views) AS uniques, SUM(optins) AS optins, SUM(orders) AS orders, SUM(cents) AS cents FROM event_rollups WHERE workspace_id = ? AND funnel_id = ? AND bucket >= ? AND bucket < ? ${params.s ? 'AND step_id = ?' : ''} GROUP BY bucket ORDER BY bucket`, params.ws!, params.f!, label(params.from!), label(params.to!), ...(params.s ? [params.s] : []));
    } else if (/uniq(Exact|HLL12)/.test(sql)) {
      data = await db.all(`SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE workspace_id = ? AND funnel_id = ? AND type = 'page_view' AND created_at >= ? AND created_at < ?`, params.ws!, params.f!, params.from!, params.to!);
    } else {
      data = await db.all(`SELECT SUM(page_views) AS views, SUM(unique_views) AS uniques, SUM(optins) AS optins, SUM(orders) AS orders, SUM(cents) AS cents FROM event_rollups WHERE workspace_id = ? AND funnel_id = ? AND bucket >= ? AND bucket < ? ${params.s ? 'AND step_id = ?' : ''}`, params.ws!, params.f!, label(params.from!), label(params.to!), ...(params.s ? [params.s] : []));
    }
    // ClickHouse JSON format: counts of UInt64 may come back as strings depending on settings; the reader must cope with both.
    const rows = (data as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' && k !== 'cents' ? String(v) : v])));
    return new Response(JSON.stringify({ data: rows }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}

async function world(env: Record<string, string> = {}, fake: { fail?: () => boolean } = {}) {
  let hRef: Harness;
  const ch = fakeClickHouse(() => hRef, fake);
  const reader = new ClickHouseReader(new ClickHouseEventStore({ url: 'http://ch.test:8123', database: 'funnels', fetch: ch.fetch }), { exactMax: Number(env.ANALYTICS_EXACT_DISTINCT_MAX ?? 200_000), mode: 'auto' });
  const h = (hRef = await makeHarness({ env: { CLICKHOUSE_URL: 'http://ch.test:8123', ANALYTICS_READ_STORE: 'clickhouse', ...env }, deps: { analyticsReader: reader } }));
  const u = await h.register();
  const f = await makeFunnel(h, u.token);
  const [s1, s2] = [f.steps[0].id as string, (await h.call('POST', `/api/funnels/${f.id}/steps`, { token: u.token, body: { name: 'Second', base_path: '/second' } })).json.id as string];
  const ev = (step: string, visitor: string, at: string, extra: object = {}) => ({ workspace_id: u.wsId, funnel_id: f.id as string, step_id: step, visitor_id: visitor, created_at: at, ...extra });
  await seedEvents(h, [
    ev(s1, 'a', '2026-03-09T10:00:00.000Z', { unique_visit: 1 }), ev(s1, 'a', '2026-03-09T10:05:00.000Z'), ev(s1, 'b', '2026-03-10T09:00:00.000Z', { unique_visit: 1 }),
    ev(s2, 'a', '2026-03-10T09:30:00.000Z', { unique_visit: 1 }), ev(s2, 'c', '2026-03-10T11:00:00.000Z', { unique_visit: 1 }),
    ev(s2, 'a', '2026-03-10T11:30:00.000Z', { type: 'optin' }), ev(s2, 'c', '2026-03-10T11:45:00.000Z', { type: 'order', amount_cents: 4700 }),
  ]);
  const get = (path: string) => h.call('GET', `/api/funnels/${f.id}${path}`, { token: u.token });
  return { h, u, f, s1, s2, ch, get };
}
const Q = '?from=2026-03-09&to=2026-03-10';

describe('ClickHouse analytics read path (fake HTTP server; the ClickHouse SQL itself is unverified against a real server)', () => {
  it('answers exactly what the primary answers: summary, per-step metrics and the daily series', async () => {
    const w = await world();
    const viaCh = await w.get(`/analytics${Q}`);
    expect(viaCh.status).toBe(200);
    expect(w.ch.calls.length).toBeGreaterThanOrEqual(4); // per-step, totals, distinct, series: all from "ClickHouse"
    const primary = await world({ ANALYTICS_READ_STORE: 'postgres' });
    const viaPg = await primary.get(`/analytics${Q}`);
    expect(primary.ch.calls).toHaveLength(0);
    const strip = (j: any) => ({ ...j, distinct: undefined, steps: j.steps.map((s: any) => ({ ...s, stepId: undefined, path: s.path })) });
    expect(strip(viaCh.json)).toEqual(strip(viaPg.json)); // two fresh worlds with identical data and identical ids except generated ones
    expect(viaCh.json.distinct).toEqual({ method: 'clickhouse_exact', standardErrorPct: 0 });
    expect(viaCh.json.summary.pageViews).toEqual({ all: 5, unique: 3 }); // visitors a, b, c
    expect(viaCh.json.summary.sales).toMatchObject({ orders: 1, gross: 47 });
  });

  it('step analytics too', async () => {
    const w = await world();
    const r = await w.get(`/steps/${w.s2}/analytics${Q}`);
    expect(r.status).toBe(200);
    expect(r.json.pageViews).toEqual({ all: 2, unique: 2 });
    expect(r.json.series.find((d: any) => d.date === '2026-03-10')).toMatchObject({ pageViews: 2, optIns: 1, orders: 1, gross: 47 });
    expect(w.ch.calls.every((c) => c.params.s === w.s2)).toBe(true);
  });

  it('every query is parameterised, read-only and scoped by workspace and funnel; no id appears in the SQL text', async () => {
    const w = await world();
    await w.get(`/analytics${Q}`);
    expect(w.ch.calls.length).toBeGreaterThan(0);
    for (const c of w.ch.calls) {
      expect(c.sql).toMatch(/workspace_id = \{ws:String\}/);
      expect(c.sql).toMatch(/funnel_id = \{f:String\}/);
      expect(c.sql).not.toContain(w.f.id);
      expect(c.sql).not.toContain(w.u.wsId);
      expect(c.params.ws).toBe(w.u.wsId);
      expect(c.params.f).toBe(w.f.id);
      expect(c.query.get('readonly')).toBe('1');
      expect(c.params.from).toBe('2026-03-09T00:00:00.000Z');
    }
  });

  it('an unknown or foreign funnel is a 404 before ClickHouse is asked anything', async () => {
    const w = await world();
    const other = await w.h.register();
    const r = await w.h.call('GET', `/api/funnels/${w.f.id}/analytics${Q}`, { token: other.token });
    expect(r.status).toBe(404);
    expect((await w.h.call('GET', `/api/funnels/fn_x'; DROP TABLE events;--/analytics`, { token: w.u.token })).status).toBe(404);
    expect(w.ch.calls).toHaveLength(0);
  });

  it('falls back to the primary on a ClickHouse error and counts it; with fallback off the request fails with 503', async () => {
    const before = analyticsReadStats.fallback;
    const w = await world({}, { fail: () => true });
    const r = await w.get(`/analytics${Q}`);
    expect(r.status).toBe(200);
    expect(r.json.summary.pageViews).toEqual({ all: 5, unique: 3 });
    expect(r.json.distinct.method).toBe('exact'); // answered by the primary
    expect(analyticsReadStats.fallback).toBe(before + 1);
    const strict = await world({ ANALYTICS_CLICKHOUSE_FALLBACK: 'false' }, { fail: () => true });
    const e = await strict.get(`/analytics${Q}`);
    expect(e.status).toBe(503);
    expect(e.json.error.code).toBe('ANALYTICS_STORE_UNAVAILABLE');
  });

  it('is not used while the mirror is stale (oldest unpublished outbox row older than ANALYTICS_CLICKHOUSE_MAX_LAG_S)', async () => {
    const w = await world({ ANALYTICS_CLICKHOUSE_MAX_LAG_S: '60' });
    await w.h.deps.db.transaction((tx) => writeOutbox(tx, 'events.stored', 'k', [], w.h.clock.now().toISOString()));
    const fresh = await w.get(`/analytics${Q}`);
    expect(fresh.json.distinct.method).toBe('clickhouse_exact'); // 0 seconds old: fine
    const calls = w.ch.calls.length;
    w.h.clock.advance(120_000);
    const stale = await w.get(`/analytics${Q}`);
    expect(stale.status).toBe(200);
    expect(stale.json.distinct.method).toBe('exact');
    expect(w.ch.calls).toHaveLength(calls); // not asked
  });

  it('is off by default: the reader is never called with ANALYTICS_READ_STORE=postgres', async () => {
    const w = await world({ ANALYTICS_READ_STORE: 'postgres' });
    expect((await w.get(`/analytics${Q}`)).status).toBe(200);
    expect(w.ch.calls).toHaveLength(0);
  });

  it('above ANALYTICS_EXACT_DISTINCT_MAX the distinct count is an HLL estimate and says so', async () => {
    const w = await world({ ANALYTICS_EXACT_DISTINCT_MAX: '1' });
    const r = await w.get(`/analytics${Q}`);
    expect(r.json.distinct).toEqual({ method: 'clickhouse_hll', standardErrorPct: 1.6 });
    expect(w.ch.calls.some((c) => c.sql.includes('uniqHLL12('))).toBe(true);
  });
});
