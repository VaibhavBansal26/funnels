import { describe, expect, it } from 'vitest';
import { HyperLogLog, STANDARD_ERROR_PCT } from '../src/util/hll.js';
import { resolveRange } from '../src/services/analytics.js';
import { makeFunnel, makeHarness, seedEvents, BACKEND } from './helpers.js';

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const err = (est: number, truth: number) => Math.abs(est - truth) / truth;

describe('HyperLogLog', () => {
  it('estimates within a few standard errors from 100 to 1,000,000 distinct ids', () => {
    for (const n of [100, 1000, 10_000, 100_000, 1_000_000]) {
      const h = new HyperLogLog();
      for (const id of ids('visitor-', n)) h.add(id);
      expect(err(h.estimate(), n), `n=${n} estimate=${h.estimate()}`).toBeLessThan(Math.max(0.05, (4 * STANDARD_ERROR_PCT) / 100));
    }
  });

  it('is idempotent for repeated ids and exact enough for tiny sets', () => {
    const h = new HyperLogLog();
    for (let i = 0; i < 5; i++) for (const id of ids('a', 20)) h.add(id);
    expect(h.estimate()).toBe(20);
    expect(new HyperLogLog().estimate()).toBe(0);
  });

  it('merges as a union: overlapping sets are counted once, merge is commutative and idempotent', () => {
    const a = new HyperLogLog();
    const b = new HyperLogLog();
    for (const id of ids('x', 30_000)) a.add(id);
    for (const id of ids('x', 50_000).slice(20_000)) b.add(id);
    const ab = a.clone().merge(b);
    const ba = b.clone().merge(a);
    expect(ab.regs).toEqual(ba.regs);
    expect(ab.clone().merge(a).regs).toEqual(ab.regs);
    expect(err(ab.estimate(), 50_000)).toBeLessThan(0.06);
  });

  it('round-trips dense and sparse serialisations', () => {
    const sparse = new HyperLogLog();
    for (const id of ids('s', 50)) sparse.add(id);
    const dense = new HyperLogLog();
    for (const id of ids('d', 50_000)) dense.add(id);
    for (const h of [sparse, dense]) expect(HyperLogLog.deserialize(h.serialize()).regs).toEqual(h.regs);
    expect(sparse.serialize().length).toBeLessThan(400);
    expect(dense.serialize().length).toBeLessThan(5600);
    expect(HyperLogLog.deserialize('').estimate()).toBe(0);
  });
});

describe('distinct visitors in analytics: exact for small ranges, sketches for big ones', () => {
  const setup = async (env: Record<string, string>) => {
    const h = await makeHarness({ env });
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const rows = [];
    // 6,000 visitors over 12 days (hours chosen to straddle local midnight in several zones); each visits 1-3 times, some on several days.
    for (let v = 0; v < 6000; v++) {
      for (let k = 0; k < 1 + (v % 3); k++) {
        const day = 1 + ((v * 7 + k * 5) % 12);
        const hour = (v * 13 + k * 11) % 24;
        rows.push({ workspace_id: u.wsId, funnel_id: f.id, step_id: f.steps[0].id, type: 'page_view' as const, visitor_id: `v${v}`, unique_visit: k === 0 ? 1 : 0, created_at: `2026-03-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String((v * 7) % 60).padStart(2, '0')}:00.000Z` });
      }
    }
    await seedEvents(h, rows);
    return { h, u, f };
  };
  const get = (h: Awaited<ReturnType<typeof makeHarness>>, token: string, fid: string, q: Record<string, string>) => h.call('GET', `/api/funnels/${fid}/analytics?${new URLSearchParams(q)}`, { token });

  it('auto mode is exact below the threshold and says so', async () => {
    const { h, u, f } = await setup({});
    const r = (await get(h, u.token, f.id, { from: '2026-03-01', to: '2026-03-12' })).json;
    expect(r.distinct).toEqual({ method: 'exact', standardErrorPct: 0 });
    const truth = (await h.deps.db.get<{ n: number }>(`SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE funnel_id = ? AND type = 'page_view'`, f.id))!.n;
    expect(r.summary.pageViews.unique).toBe(truth);
  });

  it('sketch mode stays within the stated error of the exact count for UTC and offset zones, including partial edge days', async () => {
    const { h, u, f } = await setup({ ANALYTICS_DISTINCT_MODE: 'sketch' });
    for (const tz of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland']) {
      for (const range of [{ from: '2026-03-01', to: '2026-03-12' }, { from: '2026-03-03', to: '2026-03-09' }, { from: '2026-03-05', to: '2026-03-05' }]) {
        const r = (await get(h, u.token, f.id, { ...range, tz })).json;
        const q = resolveRange(h.deps, { ...range, tz });
        const truth = (await h.deps.db.get<{ n: number }>(`SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE funnel_id = ? AND type = 'page_view' AND created_at >= ? AND created_at < ?`, f.id, q.startUtc, q.endUtc))!.n;
        expect(err(r.summary.pageViews.unique, truth), `${tz} ${JSON.stringify(range)}: ${r.summary.pageViews.unique} vs ${truth} (${r.distinct.method})`).toBeLessThan(0.055);
      }
    }
  });

  it('auto mode switches to sketches when the range has more page views than the threshold', async () => {
    const { h, u, f } = await setup({ ANALYTICS_EXACT_DISTINCT_MAX: '1000' });
    const r = (await get(h, u.token, f.id, { from: '2026-03-01', to: '2026-03-12' })).json;
    expect(r.distinct.method).toBe('hll');
    expect(r.distinct.standardErrorPct).toBeCloseTo(1.63, 1);
    expect(err(r.summary.pageViews.unique, 6000)).toBeLessThan(0.06);
  });
});
