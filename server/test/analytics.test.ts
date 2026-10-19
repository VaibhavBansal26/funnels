import { describe, expect, it } from 'vitest';
import { computeMetrics, resolveRange } from '../src/services/analytics.js';
import { addDays, dayKey, eachDay, startOfDayUtc, isValidTimeZone, pct, ratio, round2 } from '../src/util/time.js';
import { makeFunnel, makeHarness, type Harness } from './helpers.js';

let n = 0;
function event(h: Harness, wsId: string, funnelId: string, stepId: string, type: 'page_view' | 'optin' | 'order', at: string, o: { visitor?: string; unique?: boolean; cents?: number } = {}) {
  h.deps.db.run(
    'INSERT INTO events (id, workspace_id, funnel_id, step_id, type, visitor_id, unique_visit, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    `evt_${++n}`, wsId, funnelId, stepId, type, o.visitor ?? `v${n}`, o.unique ? 1 : 0, o.cents ?? 0, at,
  );
}

async function setup() {
  const h = makeHarness();
  const u = await h.register();
  const f = await makeFunnel(h, u.token);
  const s2 = (await h.call('POST', `/api/funnels/${f.id}/steps`, { token: u.token, body: { name: 'Second' } })).json;
  const s1 = f.steps[0].id as string;
  const ev = (stepId: string, type: 'page_view' | 'optin' | 'order', at: string, o = {}) => event(h, u.wsId, f.id, stepId, type, at, o);
  const analytics = (q = '') => h.call('GET', `/api/funnels/${f.id}/analytics${q}`, { token: u.token });
  return { h, u, f, s1, s2: s2.id as string, ev, analytics };
}

describe('metric math', () => {
  it('is divide-by-zero safe', () => {
    expect(computeMetrics({ views: 0, uniques: 0, optins: 0, orders: 0, cents: 0 })).toEqual({
      pageViews: { all: 0, unique: 0 }, optIns: { all: 0, conversionRate: 0 }, sales: { orders: 0, conversionRate: 0, gross: 0 }, earningsPerView: { all: 0, unique: 0 },
    });
    // opt-ins without any unique visitors (e.g. imported data) must not produce Infinity/NaN
    const m = computeMetrics({ views: 5, uniques: 0, optins: 2, orders: 1, cents: 5000 });
    expect(m.optIns.conversionRate).toBe(0);
    expect(m.earningsPerView).toEqual({ all: 10, unique: 0 });
    expect(JSON.stringify(m)).not.toMatch(/null|NaN|Infinity/);
  });

  it('rounds to 2 decimals', () => {
    expect(pct(1, 3)).toBe(33.33);
    expect(pct(2, 3)).toBe(66.67);
    expect(pct(1, 8)).toBe(12.5);
    expect(round2(1.005)).toBe(1.01);
    expect(ratio(10, 3)).toBe(3.33);
    const m = computeMetrics({ views: 3, uniques: 3, optins: 1, orders: 2, cents: 1000 });
    expect(m).toMatchObject({ optIns: { conversionRate: 33.33 }, sales: { conversionRate: 66.67, gross: 10 }, earningsPerView: { all: 3.33, unique: 3.33 } });
  });
});

describe('time zones and day ranges', () => {
  it('buckets instants into local days', () => {
    expect(dayKey('2026-03-10T03:30:00Z', 'America/New_York')).toBe('2026-03-09');
    expect(dayKey('2026-03-10T04:00:00Z', 'America/New_York')).toBe('2026-03-10');
    expect(dayKey('2026-03-09T18:29:59Z', 'Asia/Kolkata')).toBe('2026-03-09');
    expect(dayKey('2026-03-09T18:30:00Z', 'Asia/Kolkata')).toBe('2026-03-10');
    expect(dayKey('2026-03-10T00:00:00Z', 'UTC')).toBe('2026-03-10');
    expect(dayKey('2026-12-31T23:59:59Z', 'Pacific/Auckland')).toBe('2027-01-01');
  });

  it('finds local midnight across DST changes and half-hour offsets', () => {
    expect(startOfDayUtc('2026-03-10', 'UTC').toISOString()).toBe('2026-03-10T00:00:00.000Z');
    expect(startOfDayUtc('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z'); // EDT already (DST began 8 Mar)
    expect(startOfDayUtc('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z'); // still EST at midnight
    expect(startOfDayUtc('2026-03-10', 'Asia/Kolkata').toISOString()).toBe('2026-03-09T18:30:00.000Z');
    expect(startOfDayUtc('2026-03-29', 'Europe/Berlin').toISOString()).toBe('2026-03-28T23:00:00.000Z');
    const spring = startOfDayUtc('2026-03-30', 'Europe/Berlin').getTime() - startOfDayUtc('2026-03-29', 'Europe/Berlin').getTime();
    expect(spring / 3_600_000).toBe(23); // the clock-change day is 23 hours long
    const fall = startOfDayUtc('2026-10-26', 'Europe/Berlin').getTime() - startOfDayUtc('2026-10-25', 'Europe/Berlin').getTime();
    expect(fall / 3_600_000).toBe(25);
  });

  it('day arithmetic', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(eachDay('2026-03-30', '2026-04-02')).toEqual(['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02']);
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('resolves defaults to the last 30 days ending today in the zone', async () => {
    const { h } = await setup();
    const r = resolveRange(h.deps, {});
    expect(r).toMatchObject({ from: '2026-02-09', to: '2026-03-10', tz: 'UTC' });
    h.clock.set('2026-03-10T02:00:00Z');
    expect(resolveRange(h.deps, { tz: 'America/Los_Angeles' }).to).toBe('2026-03-09');
  });
});

describe('GET /funnels/:id/analytics', () => {
  it('returns zeros for a funnel with no traffic, one entry per step and a full series', async () => {
    const { analytics, s1, s2 } = await setup();
    const r = await analytics('?from=2026-03-01&to=2026-03-03');
    expect(r.status).toBe(200);
    expect(r.json.summary.pageViews).toEqual({ all: 0, unique: 0 });
    expect(r.json.steps.map((s: any) => s.stepId)).toEqual([s1, s2]);
    expect(r.json.series.map((d: any) => d.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
    expect(r.json.series.every((d: any) => d.pageViews === 0 && d.gross === 0)).toBe(true);
    expect(JSON.stringify(r.json)).not.toMatch(/NaN|Infinity/);
  });

  it('computes per-step and funnel metrics', async () => {
    const { analytics, ev, s1, s2 } = await setup();
    const at = '2026-03-05T10:00:00.000Z';
    // step 1: 4 views from 3 visitors (3 unique), 1 opt-in
    ev(s1, 'page_view', at, { visitor: 'a', unique: true });
    ev(s1, 'page_view', at, { visitor: 'a' });
    ev(s1, 'page_view', at, { visitor: 'b', unique: true });
    ev(s1, 'page_view', at, { visitor: 'c', unique: true });
    ev(s1, 'optin', at, { visitor: 'a' });
    // step 2: 2 views, 2 unique, 1 order of $33.33 plus an upsell of $0.01
    ev(s2, 'page_view', at, { visitor: 'a', unique: true });
    ev(s2, 'page_view', at, { visitor: 'b', unique: true });
    ev(s2, 'order', at, { visitor: 'a', cents: 3333 });
    ev(s2, 'order', at, { visitor: 'a', cents: 1 });
    const r = (await analytics('?from=2026-03-05&to=2026-03-05')).json;
    expect(r.steps[0]).toMatchObject({ pageViews: { all: 4, unique: 3 }, optIns: { all: 1, conversionRate: 33.33 }, sales: { orders: 0, conversionRate: 0, gross: 0 }, earningsPerView: { all: 0, unique: 0 } });
    expect(r.steps[1]).toMatchObject({ pageViews: { all: 2, unique: 2 }, sales: { orders: 2, conversionRate: 100, gross: 33.34 }, earningsPerView: { all: 16.67, unique: 16.67 } });
    // funnel level: unique = distinct visitors (a, b, c), not the sum of step uniques
    expect(r.summary).toMatchObject({ pageViews: { all: 6, unique: 3 }, optIns: { all: 1, conversionRate: 33.33 }, sales: { orders: 2, conversionRate: 66.67, gross: 33.34 }, earningsPerView: { all: 5.56, unique: 11.11 } });
    expect(r.series).toEqual([{ date: '2026-03-05', pageViews: 6, uniqueVisits: 5, optIns: 1, orders: 2, gross: 33.34 }]);
  });

  it('range edges are inclusive of the whole "to" day and exclusive of the next instant (UTC)', async () => {
    const { analytics, ev, s1 } = await setup();
    ev(s1, 'page_view', '2026-03-09T23:59:59.999Z');
    ev(s1, 'page_view', '2026-03-10T00:00:00.000Z');
    ev(s1, 'page_view', '2026-03-10T23:59:59.999Z');
    ev(s1, 'page_view', '2026-03-11T00:00:00.000Z');
    const one = (await analytics('?from=2026-03-10&to=2026-03-10')).json;
    expect(one.summary.pageViews.all).toBe(2);
    expect(one.series).toHaveLength(1);
    expect((await analytics('?from=2026-03-09&to=2026-03-11')).json.summary.pageViews.all).toBe(4);
    expect((await analytics('?from=2026-03-12&to=2026-03-12')).json.summary.pageViews.all).toBe(0);
  });

  it('day boundaries follow the requested time zone', async () => {
    const { analytics, ev, s1 } = await setup();
    ev(s1, 'page_view', '2026-03-10T03:30:00.000Z'); // Mar 9, 23:30 in New York; Mar 10, 09:00 in Kolkata
    ev(s1, 'page_view', '2026-03-10T04:00:00.000Z'); // Mar 10, 00:00 in New York
    ev(s1, 'page_view', '2026-03-09T18:29:00.000Z'); // Mar 9, 23:59 in Kolkata
    const ny = (await analytics('?from=2026-03-09&to=2026-03-09&tz=America/New_York')).json;
    expect(ny.summary.pageViews.all).toBe(2);
    expect(ny.range.tz).toBe('America/New_York');
    expect(ny.series[0].pageViews).toBe(2);
    const nyNext = (await analytics('?from=2026-03-10&to=2026-03-10&tz=America/New_York')).json;
    expect(nyNext.summary.pageViews.all).toBe(1);
    const kolkata = (await analytics('?from=2026-03-09&to=2026-03-10&tz=Asia/Kolkata')).json;
    expect(kolkata.series.map((d: any) => d.pageViews)).toEqual([1, 2]);
    const utc = (await analytics('?from=2026-03-10&to=2026-03-10')).json;
    expect(utc.summary.pageViews.all).toBe(2);
  });

  it('series buckets match the zone across a DST change', async () => {
    const { analytics, ev, s1 } = await setup();
    ev(s1, 'page_view', '2026-03-28T23:00:00.000Z'); // Berlin: Mar 29 00:00
    ev(s1, 'page_view', '2026-03-29T21:59:00.000Z'); // Berlin: Mar 29 23:59 (CEST)
    ev(s1, 'page_view', '2026-03-29T22:00:00.000Z'); // Berlin: Mar 30 00:00
    const r = (await analytics('?from=2026-03-29&to=2026-03-30&tz=Europe/Berlin')).json;
    expect(r.series.map((d: any) => [d.date, d.pageViews])).toEqual([['2026-03-29', 2], ['2026-03-30', 1]]);
  });

  it('validates the query', async () => {
    const { analytics } = await setup();
    for (const q of ['?from=2026-03-10&to=2026-03-01', '?from=bad', '?to=2026-13-40', '?tz=Mars/Olympus', '?from=2024-01-01&to=2026-03-10', '?from=2026-02-30&to=2026-03-01']) {
      expect([q, (await analytics(q)).status]).toEqual([q, 400]);
    }
    expect((await analytics('?from=2025-03-10&to=2026-03-10')).status).toBe(200); // 366 days is fine
  });

  it('per-step endpoint returns one step, and refuses steps of other funnels', async () => {
    const { h, u, f, ev, s2, analytics } = await setup();
    ev(s2, 'page_view', '2026-03-05T10:00:00.000Z', { visitor: 'a', unique: true });
    const r = await h.call('GET', `/api/funnels/${f.id}/steps/${s2}/analytics?from=2026-03-05&to=2026-03-05`, { token: u.token });
    expect(r.json).toMatchObject({ step: { stepId: s2 }, pageViews: { all: 1, unique: 1 } });
    expect(r.json.series).toHaveLength(1);
    const other = await makeFunnel(h, u.token, { name: 'O' });
    expect((await h.call('GET', `/api/funnels/${f.id}/steps/${other.steps[0].id}/analytics`, { token: u.token })).status).toBe(404);
    expect((await analytics()).status).toBe(200);
  });

  it('only counts the funnel in question', async () => {
    const { h, u, f, ev, s1, analytics } = await setup();
    const other = await makeFunnel(h, u.token, { name: 'Other' });
    ev(s1, 'page_view', '2026-03-05T10:00:00.000Z', { unique: true });
    event(h, u.wsId, other.id, other.steps[0].id, 'page_view', '2026-03-05T10:00:00.000Z', { unique: true });
    expect((await analytics('?from=2026-03-05&to=2026-03-05')).json.summary.pageViews.all).toBe(1);
    expect(f.id).not.toBe(other.id);
  });
});
