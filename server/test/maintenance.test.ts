import { describe, expect, it } from 'vitest';
import { ensureEventPartitions, pruneEventDedupe, runMaintenance, scheduleMaintenance } from '../src/services/maintenance.js';
import { EventBuffer } from '../src/services/eventbuffer.js';
import { silentLogger } from '../src/logger.js';
import { makeFunnel, makeHarness, seedEvents, IS_PG } from './helpers.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');

describe('idempotency keys and first views', () => {
  it('prunes event_dedupe rows past the window and keeps recent ones', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const base = { workspace_id: u.wsId, funnel_id: f.id, step_id: f.steps[0].id, type: 'optin' as const };
    await seedEvents(h, [
      { ...base, external_id: 'old', created_at: '2026-01-01T00:00:00.000Z' },
      { ...base, external_id: 'new', created_at: '2026-03-09T00:00:00.000Z' },
    ]);
    expect(await pruneEventDedupe(h.deps.db, NOW, 30)).toBe(1);
    expect((await h.deps.db.all<{ external_id: string }>('SELECT external_id FROM event_dedupe')).map((r) => r.external_id)).toEqual(['new']);
    // after the window a retry with the same key is accepted again; inside it, dropped
    await seedEvents(h, [{ ...base, external_id: 'old', created_at: '2026-03-10T00:00:00.000Z' }, { ...base, external_id: 'new', created_at: '2026-03-10T00:00:00.000Z' }]);
    expect(await h.deps.db.get("SELECT COUNT(*) AS n FROM events WHERE external_id = 'new'")).toEqual({ n: 1 });
    expect(await h.deps.db.get("SELECT COUNT(*) AS n FROM events WHERE external_id = 'old'")).toEqual({ n: 2 });
  });

  it('a duplicate key inside one batch counts once, in raw rows and in rollups', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const row = { workspace_id: u.wsId, funnel_id: f.id, step_id: f.steps[0].id, type: 'optin' as const, external_id: 'same', created_at: '2026-03-10T12:00:00.000Z' };
    await seedEvents(h, [row, row, { ...row, external_id: 'other' }]);
    expect(await h.deps.db.get('SELECT COUNT(*) AS n FROM events')).toEqual({ n: 2 });
    expect(await h.deps.db.get('SELECT SUM(optins) AS n FROM event_rollups')).toEqual({ n: 2 });
  });

  it('first views are claimed in visitor_steps: exact within a batch, across batches and across buffers that share a database', async () => {
    const h = await makeHarness({ env: { EVENT_BUFFER_MS: '60000' } });
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const mk = (visitor: string, i: number) => ({ id: `e${visitor}${i}${Math.random()}`, workspace_id: u.wsId, funnel_id: f.id, step_id: f.steps[0].id, type: 'page_view' as const, visitor_id: visitor, unique_visit: 0, lead_id: null, order_id: null, external_id: null, amount_cents: 0, currency: null, utm_json: null, url: null, created_at: '2026-03-10T12:00:00.000Z' });
    // two "replicas" (separate buffers, one database) both receive the first view of the same visitors
    const a = new EventBuffer(h.deps.db, silentLogger, { flushMs: 60000, maxQueue: 1000 });
    const b = new EventBuffer(h.deps.db, silentLogger, { flushMs: 60000, maxQueue: 1000 });
    for (const v of ['v1', 'v2', 'v1']) await a.add(mk(v, 0));
    for (const v of ['v1', 'v2', 'v3']) await b.add(mk(v, 1));
    await Promise.all([a.flush(), b.flush()]);
    await a.add(mk('v1', 2));
    await a.add(mk('v4', 2));
    await a.flush();
    const unique = await h.deps.db.get<{ n: number; all: number }>('SELECT SUM(unique_visit) AS n, COUNT(*) AS "all" FROM events');
    expect(unique).toEqual({ n: 4, all: 8 }); // v1..v4 once each, whichever buffer wrote first
    expect(await h.deps.db.get('SELECT COUNT(*) AS n FROM visitor_steps')).toEqual({ n: 4 });
    expect(await h.deps.db.get('SELECT SUM(unique_views) AS n, SUM(page_views) AS p FROM event_rollups')).toEqual({ n: 4, p: 8 });
  });
});

describe.skipIf(!IS_PG)('monthly partitions of events (PostgreSQL)', () => {
  const partitions = async (h: Awaited<ReturnType<typeof makeHarness>>) =>
    (await h.deps.db.all<{ name: string }>(`SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'events' ORDER BY c.relname`)).map((r) => r.name);

  it('creates the current month and the months ahead at boot, idempotently, and extends them as time moves', async () => {
    const h = await makeHarness();
    const ps = await partitions(h);
    expect(ps).toContain('events_default');
    expect(ps.filter((p) => /^events_\d{4}_\d{2}$/.test(p)).length).toBeGreaterThanOrEqual(4);
    expect(await ensureEventPartitions(h.deps.db, h.clock.now(), h.deps.config.PARTITION_MONTHS_AHEAD)).toEqual([]);
    const later = new Date(Date.UTC(2031, 0, 15));
    const made = await ensureEventPartitions(h.deps.db, later, 2);
    expect(made).toEqual(['events_2030_12', 'events_2031_01', 'events_2031_02', 'events_2031_03']);
    expect(await ensureEventPartitions(h.deps.db, later, 2)).toEqual([]);
    const both = await Promise.all([ensureEventPartitions(h.deps.db, new Date(Date.UTC(2032, 5, 1)), 1), ensureEventPartitions(h.deps.db, new Date(Date.UTC(2032, 5, 1)), 1)]);
    expect(both.flat().sort()).toEqual(['events_2032_05', 'events_2032_06', 'events_2032_07']); // each created exactly once
  });

  it('routes rows to their month, the default partition catches strays, and range queries prune to the months involved', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    await ensureEventPartitions(h.deps.db, new Date('2026-03-10T00:00:00Z'), 1);
    const base = { workspace_id: u.wsId, funnel_id: f.id, step_id: f.steps[0].id };
    await seedEvents(h, [
      { ...base, created_at: '2026-02-20T10:00:00.000Z' }, { ...base, created_at: '2026-03-01T00:00:00.000Z' }, { ...base, created_at: '2026-03-31T23:59:59.999Z' },
      { ...base, created_at: '2026-04-01T00:00:00.000Z' }, { ...base, created_at: '2040-01-01T00:00:00.000Z' },
    ]);
    const where = await h.deps.db.all<{ p: string; n: number }>('SELECT tableoid::regclass::text AS p, COUNT(*) AS n FROM events GROUP BY 1 ORDER BY 1');
    expect(where).toEqual([{ p: 'events_2026_02', n: 1 }, { p: 'events_2026_03', n: 2 }, { p: 'events_2026_04', n: 1 }, { p: 'events_default', n: 1 }]);
    const plan = (await h.deps.db.explain(`SELECT COUNT(DISTINCT visitor_id) FROM events WHERE funnel_id = ? AND type = 'page_view' AND created_at >= ? AND created_at < ?`, f.id, '2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z')).join('\n');
    expect(plan).toContain('events_2026_03');
    expect(plan).not.toMatch(/events_2026_02|events_2026_04|events_2026_05/); // other months are pruned at plan time
  });

  it('keeps idempotency across partitions: the same key a month later is still a duplicate', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    await ensureEventPartitions(h.deps.db, new Date('2026-03-10T00:00:00Z'), 2);
    const row = { workspace_id: u.wsId, funnel_id: f.id, step_id: f.steps[0].id, type: 'optin' as const, external_id: 'k' };
    await seedEvents(h, [{ ...row, created_at: '2026-03-31T23:00:00.000Z' }]);
    await seedEvents(h, [{ ...row, created_at: '2026-04-01T01:00:00.000Z' }]);
    expect(await h.deps.db.get('SELECT COUNT(*) AS n FROM events')).toEqual({ n: 1 });
  });
});

describe('maintenance job', () => {
  it('is queued once (dedupe key), runs, and queues its successor', async () => {
    const h = await makeHarness();
    expect(await scheduleMaintenance(h.deps, 3_600_000)).toBeTruthy(); // the harness runs without a worker, so boot queued none
    expect(await scheduleMaintenance(h.deps)).toBeNull(); // one pending job at a time, whichever replica asks
    h.clock.advance(2 * 3_600_000);
    expect(await h.worker.tick()).toBe(1);
    const queued = await h.deps.db.all<{ type: string }>("SELECT type FROM jobs WHERE type = 'maintenance.run' AND status = 'queued'");
    expect(queued).toHaveLength(1);
    expect(await runMaintenance(h.deps)).toMatchObject({ dedupePruned: 0 });
  });
});
