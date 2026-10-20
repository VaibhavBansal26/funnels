import { describe, expect, it } from 'vitest';
import { MemoryBus, type EventBus } from '../src/queue/eventbus.js';
import { relayOutbox, TOPIC_INGEST, writeOutbox } from '../src/queue/outbox.js';
import { startQueues } from '../src/queue/runtime.js';
import { makeFunnel, makeHarness } from './helpers.js';

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(15);
  }
  throw new Error('condition not met in time');
}

describe('noisy neighbour: one workspace at 100x the others', () => {
  it('the heavy tenant is limited (429 + Retry-After); every other tenant is fully accepted and fully stored', async () => {
    // 6,000/min gives each free workspace a burst of 100 events; the clock is frozen, so there is no refill during the test.
    const h = await makeHarness({ env: { INGEST_QUEUE: 'true', INGEST_WORKSPACE_PER_MINUTE: '6000' }, deps: { eventBus: new MemoryBus(8) } });
    const tenants = [] as { funnelId: string; stepId: string }[];
    for (let i = 0; i < 10; i++) {
      const u = await h.register();
      const f = await makeFunnel(h, u.token);
      tenants.push({ funnelId: f.id, stepId: f.steps[0].id });
    }
    const send = (t: { funnelId: string; stepId: string }, v: string) => h.call('POST', '/api/public/events', { body: { funnelId: t.funnelId, stepId: t.stepId, type: 'page_view', visitorId: v }, headers: UA });
    const HEAVY = 2000; // 100 x the 20 each of the others
    const results: { tenant: number; status: number; retryAfter: string | null; code?: string }[] = [];
    // Interleaved: for every heavy request the others send theirs, so the heavy tenant's flood is in flight while they are served.
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < HEAVY; i++) {
      jobs.push(send(tenants[0]!, `heavy-${i}`).then((r) => void results.push({ tenant: 0, status: r.status, retryAfter: r.headers.get('retry-after'), code: r.json?.error?.code })));
      if (i < 20) for (let t = 1; t < 10; t++) jobs.push(send(tenants[t]!, `t${t}-${i}`).then((r) => void results.push({ tenant: t, status: r.status, retryAfter: r.headers.get('retry-after'), code: r.json?.error?.code })));
    }
    await Promise.all(jobs);

    const heavy = results.filter((r) => r.tenant === 0);
    expect(heavy.filter((r) => r.status === 202)).toHaveLength(100); // exactly its burst
    const refused = heavy.filter((r) => r.status === 429);
    expect(refused).toHaveLength(HEAVY - 100);
    expect(refused.every((r) => r.code === 'RATE_LIMITED' && Number(r.retryAfter) >= 1)).toBe(true);
    for (let t = 1; t < 10; t++) expect(results.filter((r) => r.tenant === t).map((r) => r.status), `tenant ${t}`).toEqual(Array(20).fill(202));

    const q = await startQueues(h.deps);
    const stored = async (funnelId: string) => Number((await h.deps.db.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM events WHERE funnel_id = ?', funnelId))!.n);
    await until(async () => (await stored(tenants[9]!.funnelId)) === 20 && (await stored(tenants[0]!.funnelId)) === 100);
    for (let t = 1; t < 10; t++) expect(await stored(tenants[t]!.funnelId), `tenant ${t} stored`).toBe(20);
    expect(await h.deps.eventBus.lag(TOPIC_INGEST, 'ingest')).toBe(0);
    await q.stop();
  });

  it('plan tiers scale the quota: a pro workspace admits 5x the free burst', async () => {
    const h = await makeHarness({ env: { INGEST_QUEUE: 'true', INGEST_WORKSPACE_PER_MINUTE: '600' }, deps: { eventBus: new MemoryBus(4) } });
    const free = await h.register();
    const pro = await h.register();
    await h.deps.db.run("UPDATE workspaces SET plan = 'pro' WHERE id = ?", pro.wsId);
    const run = async (u: typeof free) => {
      const f = await makeFunnel(h, u.token);
      let ok = 0;
      for (let i = 0; i < 80; i++) if ((await h.call('POST', '/api/public/events', { body: { funnelId: f.id, stepId: f.steps[0].id, type: 'page_view', visitorId: `v${i}` }, headers: UA })).status === 202) ok++;
      return ok;
    };
    expect(await run(free)).toBe(10); // 600/min -> burst 10
    expect(await run(pro)).toBe(50); // x5
  });
});

describe('fair claims', () => {
  it('jobs: a tenant with a huge backlog does not starve the others, and a lone tenant still fills the claim', async () => {
    const h = await makeHarness();
    const jobs = h.deps.jobs;
    for (let i = 0; i < 300; i++) await jobs.enqueue('noop', { i }, { group: 'ws_big' });
    for (const g of ['ws_a', 'ws_b', 'ws_c', 'ws_d']) await jobs.enqueue('noop', { g }, { group: g }); // enqueued AFTER the 300, so FIFO would serve them last
    const first = await jobs.claimDue(10);
    const groups = first.map((j) => (j.payload as { g?: string }).g ?? 'ws_big');
    for (const g of ['ws_a', 'ws_b', 'ws_c', 'ws_d']) expect(groups, g).toContain(g);
    expect(first).toHaveLength(10);
    // a lone group fills the whole claim (no artificial per-group cap)
    const second = await jobs.claimDue(10);
    expect(second).toHaveLength(10);
    expect(second.every((j) => (j.payload as { g?: string }).g === undefined)).toBe(true);
  });

  it('outbox relay: a tenant with a huge backlog does not delay the others, and per-key order is kept', async () => {
    const h = await makeHarness();
    const at = h.clock.now().toISOString();
    await h.deps.db.transaction(async (tx) => {
      for (let i = 0; i < 400; i++) await writeOutbox(tx, 't', 'ws_big', { i }, at);
      for (const k of ['ws_a', 'ws_b', 'ws_c']) await writeOutbox(tx, 't', k, { k }, at);
    });
    const seen: { key: string; i?: number }[] = [];
    const bus = { publish: async (_t: string, key: string, p: { i?: number }) => void seen.push({ key, i: p.i }) } as unknown as EventBus;
    await relayOutbox(h.deps.db, bus, h.clock.now, 50);
    expect(seen).toHaveLength(50);
    for (const k of ['ws_a', 'ws_b', 'ws_c']) expect(seen.map((s) => s.key)).toContain(k); // FIFO would have published 50 of ws_big only
    const big = seen.filter((s) => s.key === 'ws_big').map((s) => s.i);
    expect(big).toEqual([...Array(big.length).keys()]); // ws_big's own rows are the oldest ones, in order
    while ((await relayOutbox(h.deps.db, bus, h.clock.now, 50)) > 0);
    expect(seen.filter((s) => s.key === 'ws_big').map((s) => s.i)).toEqual([...Array(400).keys()]); // nothing lost, still in order
  });
});
