import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.js';
import { migrate } from '../src/db/index.js';
import { JobQueue } from '../src/jobs/queue.js';
import { silentLogger } from '../src/logger.js';
import { EventBuffer } from '../src/services/eventbuffer.js';
import { activeDomain, formTarget, makeFunnel, makeHarness, type Harness } from './helpers.js';
import { createPg, wipe } from './support/backend.js';

// Real PostgreSQL, real multi-connection pool. Skipped unless TEST_PG_URL is set (CI runs it against a postgres:17 service container;
// locally: TEST_PG_URL=postgres://postgres:postgres@localhost:5432/postgres npm test -- pg-real).
// PGlite has a single connection, so row locks, deadlock detection and SKIP LOCKED can only be proven here.
const enabled = !!process.env.TEST_PG_URL;

describe.skipIf(!enabled)('concurrency on a real PostgreSQL pool', () => {
  let db: Db;
  beforeAll(async () => { db = await createPg(12); });
  afterEach(async () => { await wipe(db); });
  afterAll(async () => { await db?.close(); });

  const harness = (opts: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> => makeHarness({ ...opts, deps: { ...opts?.deps, db } });

  it('parallel saves from the same base version: exactly one 200, the rest 409 with the current version', async () => {
    const h = await harness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const url = `/api/funnels/${f.id}/steps/${f.steps[0].id}/page`;
    const base = (await h.call('GET', url, { token: u.token })).json.version;
    for (let round = 0; round < 3; round++) {
      const current = round === 0 ? base : (await h.call('GET', url, { token: u.token })).json.version;
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => h.call('PUT', url, { token: u.token, body: { version: current, doc: { version: 1, blocks: [{ id: `p${i}`, type: 'paragraph', text: `r${round}v${i}` }] } } })));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(11);
      expect(results.find((r) => r.status === 409)!.json.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: expect.any(Number) } });
    }
    expect(await h.deps.db.get('SELECT COUNT(*) AS n FROM step_backups')).toEqual({ n: 3 });
  });

  it('saves without a version serialise on the row lock: every one succeeds and every backup is kept', async () => {
    const h = await harness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const url = `/api/funnels/${f.id}/steps/${f.steps[0].id}/page`;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => h.call('PUT', url, { token: u.token, body: { doc: { version: 1, blocks: [{ id: `p${i}`, type: 'paragraph', text: `v${i}` }] } } })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.json.version)).size).toBe(8); // strictly increasing versions, no duplicates
    expect(await h.deps.db.get('SELECT COUNT(*) AS n FROM step_backups')).toEqual({ n: 8 });
  });

  it('parallel funnel and step duplicates stay distinct; parallel reorders leave a contiguous order; saves racing reorders do not deadlock', async () => {
    const h = await harness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token, { name: 'Race' });
    const dups = await Promise.all(Array.from({ length: 8 }, () => h.call('POST', `/api/funnels/${f.id}/duplicate`, { token: u.token })));
    expect(dups.every((r) => r.status === 201)).toBe(true);
    expect(new Set(dups.map((r) => r.json.name)).size).toBe(8);
    const sd = await Promise.all(Array.from({ length: 6 }, () => h.call('POST', `/api/funnels/${f.id}/steps/${f.steps[0].id}/duplicate`, { token: u.token })));
    expect(sd.every((r) => r.status === 201)).toBe(true);
    expect(new Set(sd.map((r) => r.json.path)).size).toBe(6);
    const ids = (await h.call('GET', `/api/funnels/${f.id}/steps`, { token: u.token })).json.data.map((s: any) => s.id);
    const orders = (rev: boolean) => (rev ? [...ids].reverse() : ids).map((stepId: string, i: number) => ({ stepId, order: i + 1 }));
    const saves = ids.slice(0, 4).map((sid: string, i: number) => h.call('PUT', `/api/funnels/${f.id}/steps/${sid}/page`, { token: u.token, body: { doc: { version: 1, blocks: [{ id: `s${i}`, type: 'paragraph', text: 'x' }] } } }));
    const reorders = Array.from({ length: 6 }, (_, i) => h.call('PUT', `/api/funnels/${f.id}/steps/order`, { token: u.token, body: { orders: orders(i % 2 === 0) } }));
    const all = await Promise.all([...saves, ...reorders]);
    expect(all.every((r) => r.status === 200), JSON.stringify(all.filter((r) => r.status !== 200).map((r) => r.text))).toBe(true);
    const after = (await h.call('GET', `/api/funnels/${f.id}/steps`, { token: u.token })).json.data;
    expect(after.map((s: any) => s.position)).toEqual(after.map((_: unknown, i: number) => i + 1));
  });

  it('parallel domain attach: only one of several funnels with the same path ends up on the domain', async () => {
    const h = await harness();
    const u = await h.register();
    const dom = await activeDomain(h, u.token);
    const fs = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((n) => makeFunnel(h, u.token, { name: n, base_path: '/same' })));
    const res = await Promise.all(fs.map((f) => h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { domain_id: dom } })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(4);
    const paths = await h.deps.db.all<{ p: string }>('SELECT s.path_key AS p FROM steps s JOIN funnels f ON f.id = s.funnel_id WHERE f.domain_id = ?', dom);
    expect(new Set(paths.map((x) => x.p)).size).toBe(paths.length);
  });

  it('parallel creates of funnels onto one domain with the same path: one keeps it, the others are told to pick another', async () => {
    const h = await harness();
    const u = await h.register();
    const dom = await activeDomain(h, u.token);
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => h.call('POST', '/api/funnels', { token: u.token, body: { name: `N${i}`, base_path: '/same', domain_id: dom } })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409).every((r) => r.json.error.code === 'PATH_CONFLICT')).toBe(true);
  });

  it('parallel identical submissions create one lead, one opt-in; parallel distinct ones for one email count every submission', async () => {
    const h = await harness({ env: { PUBLIC_FORMS_PER_MINUTE: '200' } });
    const u = await h.register();
    const t = await formTarget(h, u.token);
    const UA = { 'user-agent': 'Mozilla/5.0 Chrome/120' };
    const same = { fields: { name: 'Ada', email: 'ada@example.com', _consent: true }, consent: true, submissionId: 'same-submission-1' };
    const first = await Promise.all(Array.from({ length: 12 }, () => h.call('POST', t.path, { body: same, headers: UA })));
    expect(first.filter((r) => r.json.recorded === true)).toHaveLength(1);
    expect(await h.deps.db.get('SELECT COUNT(*) AS n FROM leads')).toEqual({ n: 1 });
    expect(await h.deps.db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'optin'")).toEqual({ n: 1 });
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => h.call('POST', t.path, { body: { fields: { name: 'Same', email: 'same@example.com', _consent: true }, consent: true, submissionId: `distinct-sub-${i}` }, headers: UA })));
    expect(many.every((r) => r.status === 200)).toBe(true);
    expect(await h.deps.db.get("SELECT submissions FROM leads WHERE email = 'same@example.com'")).toEqual({ submissions: 20 });
    expect(await h.deps.db.get("SELECT COUNT(*) AS n FROM leads WHERE email = 'same@example.com'")).toEqual({ n: 1 });
  });

  it('rate limiting is exact under parallel requests', async () => {
    const h = await harness({ env: { PUBLIC_EVENTS_PER_MINUTE: '20' } });
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const rs = await Promise.all(Array.from({ length: 60 }, () => h.call('POST', '/api/public/events', { body: { funnelId: f.id, stepId: f.steps[0].id, type: 'page_view', visitorId: 'v' }, headers: { 'user-agent': 'Mozilla/5.0 Chrome/120' } })));
    expect(rs.filter((r) => r.status === 202)).toHaveLength(20);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(40);
  });

  it('a burst of parallel events is counted exactly in raw rows and in the rollups, with exact uniqueness', async () => {
    const h = await harness({ env: { PUBLIC_EVENTS_PER_MINUTE: '5000', EVENT_BUFFER_MS: '30' } });
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    await Promise.all(Array.from({ length: 800 }, (_, i) => h.call('POST', '/api/public/events', { body: { funnelId: f.id, stepId: f.steps[0].id, type: 'page_view', visitorId: `v${i % 100}` }, headers: { 'user-agent': 'Mozilla/5.0 Chrome/120' } })));
    const a = (await h.call('GET', `/api/funnels/${f.id}/analytics`, { token: u.token })).json;
    expect(a.summary.pageViews.all).toBe(800);
    expect(a.summary.pageViews.unique).toBe(100);
    expect(await h.deps.db.get('SELECT COUNT(*) AS n FROM events')).toEqual({ n: 800 });
    expect(await h.deps.db.get('SELECT SUM(page_views) AS n, SUM(unique_views) AS u FROM event_rollups')).toEqual({ n: 800, u: expect.any(Number) });
  });

  it('first views stay exact when several buffers (replicas) flush the same visitors at the same moment', async () => {
    const h = await harness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const buffers = Array.from({ length: 6 }, () => new EventBuffer(db, silentLogger, { flushMs: 60_000, maxQueue: 100_000 }));
    const row = (v: string, i: number) => ({ id: `e${i}_${v}_${Math.random()}`, workspace_id: u.wsId, funnel_id: f.id, step_id: f.steps[0].id, type: 'page_view' as const, visitor_id: v, unique_visit: 0, lead_id: null, order_id: null, external_id: null, amount_cents: 0, currency: null, utm_json: null, url: null, created_at: '2026-03-10T12:00:00.000Z' });
    for (const [i, b] of buffers.entries()) for (let v = 0; v < 150; v++) await b.add(row(`v${(v * 7 + i * 13) % 200}`, i)); // overlapping visitor sets, shuffled differently per buffer
    await Promise.all(buffers.map((b) => b.flush()));
    expect(await h.deps.db.get('SELECT COUNT(*) AS n, SUM(unique_visit) AS u FROM events')).toEqual({ n: 900, u: 200 });
    expect(await h.deps.db.get('SELECT COUNT(*) AS n FROM visitor_steps')).toEqual({ n: 200 });
    expect(await h.deps.db.get('SELECT SUM(page_views) AS p, SUM(unique_views) AS u FROM event_rollups')).toEqual({ p: 900, u: 200 });
  });

  it('the AI daily cap is enforced atomically across parallel requests', async () => {
    const h = await harness({ env: { AI_DAILY_CAP: '5', AI_RATE_LIMIT_PER_MINUTE: '100' } });
    const u = await h.register();
    const rs = await Promise.all(Array.from({ length: 25 }, () => h.call('POST', '/api/ai/rewrite', { token: u.token, body: { text: 'Hello there', tone: 'concise' } })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(5);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(20);
  });

  it('opposite-order lock acquisition deadlocks on the server and is retried transparently, so both transactions finish', async () => {
    await db.run(`INSERT INTO workspaces (id, name, created_at) VALUES ('a', 'a', 'now'), ('b', 'b', 'now')`);
    let attempts = 0;
    let barrier = 0;
    const lockBoth = (first: string, second: string) => db.transaction(async (tx) => {
      attempts++;
      await tx.run('UPDATE workspaces SET name = name || ? WHERE id = ?', '1', first);
      if (barrier++ < 2) await new Promise((r) => setTimeout(r, 150)); // both hold their first lock before asking for the second
      await tx.run('UPDATE workspaces SET name = name || ? WHERE id = ?', '2', second);
    });
    await Promise.all([lockBoth('a', 'b'), lockBoth('b', 'a')]);
    expect(attempts).toBeGreaterThanOrEqual(3); // at least one victim re-ran
    const names = (await db.all<{ name: string }>('SELECT name FROM workspaces ORDER BY id')).map((r) => r.name);
    // Each row was updated exactly twice, in whichever order the retry produced.
    expect(names.map((n) => [...n].sort().join(''))).toEqual(['12a', '12b']);
  });

  it('job claiming uses SKIP LOCKED: concurrent workers never claim the same job', async () => {
    const q = new JobQueue(db, () => Date.now());
    for (let i = 0; i < 40; i++) await q.enqueue('t', { i });
    const claims = await Promise.all(Array.from({ length: 6 }, () => q.claimDue(10)));
    const ids = claims.flat().map((j) => j.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  it('concurrent migration runs on a fresh database apply each migration exactly once', async () => {
    const { createPg: fresh } = await import('./support/backend.js');
    const raw = await fresh(4);
    await raw.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const results = await Promise.all([migrate(raw), migrate(raw), migrate(raw)]);
    expect(results.flat().sort()).toEqual([...new Set(results.flat())].sort());
    expect((await raw.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations'))!.n).toBeGreaterThan(0);
    await raw.close();
  });

  it('a burst of parallel queries beyond the pool size completes and leaves no leaked connections', async () => {
    const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => db.get<{ n: number }>('SELECT ?::int AS n', i)));
    expect(rs.map((r) => r!.n)).toEqual(Array.from({ length: 200 }, (_, i) => i));
    const active = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle' AND pid <> pg_backend_pid()`);
    expect(active!.n).toBe(0);
  });
});
