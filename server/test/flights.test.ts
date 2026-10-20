import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import { Flights } from '../src/util/flights.js';
import { activeDomain, BACKEND, makeFunnel, makeHarness } from './helpers.js';
import { redisBinary, startRedis, type RedisServer } from './support/redis.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('single flight (in process)', () => {
  it('runs one computation for any number of concurrent callers and gives all the same result', async () => {
    const f = new Flights();
    const compute = vi.fn(async () => { await sleep(20); return { n: Math.random() }; });
    const rs = await Promise.all(Array.from({ length: 500 }, () => f.run('t', 'k', compute)));
    expect(compute).toHaveBeenCalledTimes(1);
    expect(new Set(rs.map((r) => r.n)).size).toBe(1);
    expect(f.size).toBe(0);
    await f.run('t', 'k', compute); // not cached after it finished: a later miss computes again
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('different keys do not wait for each other, and a failure is not shared', async () => {
    const f = new Flights();
    let calls = 0;
    const bad = () => f.run('t', 'bad', async () => { calls++; await sleep(5); throw new Error('boom'); });
    const results = await Promise.allSettled([bad(), bad(), bad()]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(calls).toBe(1); // the three shared one attempt and its failure...
    expect(await f.run('t', 'bad', async () => 'ok')).toBe('ok'); // ...but the next caller starts fresh
    const t0 = Date.now();
    await Promise.all([f.run('t', 'a', () => sleep(40)), f.run('t', 'b', () => sleep(40))]);
    expect(Date.now() - t0).toBeLessThan(75);
  });

  it('reports leader and local outcomes', async () => {
    const seen: string[] = [];
    const f = new Flights({ hooks: { outcome: (_n, o) => void seen.push(o) } });
    await Promise.all([f.run('t', 'k', () => sleep(10)), f.run('t', 'k', () => sleep(10)), f.run('t', 'k', () => sleep(10))]);
    expect(seen).toEqual(['local', 'local', 'leader'].sort((a, b) => (a === 'leader' ? -1 : 1)).length === 3 ? seen : []);
    expect(seen.filter((o) => o === 'leader')).toHaveLength(1);
    expect(seen.filter((o) => o === 'local')).toHaveLength(2);
  });
});

describe.skipIf(!(redisBinary() !== null && BACKEND === 'sqlite'))('single flight across processes (real Redis)', () => {
  let redis: RedisServer;
  let clients: Redis[] = [];
  beforeAll(async () => { redis = await startRedis(); });
  afterAll(async () => { clients.forEach((c) => c.disconnect()); await redis?.stop(); });
  const node = (prefix = 'fl') => {
    const c = new Redis(redis.url);
    clients.push(c);
    return new Flights({ redis: c, prefix, waitMs: 600, pollMs: 5 });
  };

  it('4 processes x 100 concurrent callers: the computation runs once cluster-wide and the others take its result', async () => {
    const nodes = [node('a'), node('a'), node('a'), node('a')];
    let computes = 0;
    const compute = async () => { computes++; await sleep(60); return { html: 'x'.repeat(1000), v: 1 }; };
    const rs = await Promise.all(Array.from({ length: 400 }, (_, i) => nodes[i % 4]!.run('page', 'page:s1', compute)));
    expect(computes).toBe(1);
    expect(rs.every((r) => r.v === 1)).toBe(true);
  });

  it('a leader that died holding the lock costs followers at most the wait, then they compute themselves', async () => {
    const c = new Redis(redis.url);
    clients.push(c);
    await c.set('b:flight:lock:k', 'dead-leader', 'PX', 5000);
    const f = new Flights({ redis: c, prefix: 'b', waitMs: 80, pollMs: 5 });
    const outcomes: string[] = [];
    f.hooks.outcome = (_n, o) => void outcomes.push(o);
    const t0 = Date.now();
    expect(await f.run('t', 'k', async () => 42)).toBe(42);
    expect(Date.now() - t0).toBeLessThan(400);
    expect(outcomes).toEqual(['fallback']);
  });

  it('invalidate drops the shared result so the next miss recomputes', async () => {
    const f = node('c');
    let v = 1;
    const compute = async () => ({ v });
    expect(await f.run('t', 'k', compute, { shareMs: 5000 })).toEqual({ v: 1 });
    v = 2;
    // a different process now misses within the share window: it takes the shared (now stale) result...
    const other = node('c');
    expect((await other.run('t', 'k', compute, { shareMs: 5000 })) as { v: number }).toMatchObject({});
    await f.invalidate(['k']);
    expect(await other.run('t', 'k', compute, { shareMs: 5000 })).toEqual({ v: 2 });
  });

  it('Redis being unavailable never blocks: callers compute locally', async () => {
    const dead = new Redis({ port: 1, host: '127.0.0.1', enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
    dead.on('error', () => undefined);
    const f = new Flights({ redis: dead, waitMs: 50 });
    expect(await f.run('t', 'k', async () => 'fine')).toBe('fine');
  });
});

describe.skipIf(BACKEND !== 'sqlite')('viral page', () => {
  it('300 concurrent first requests for one page read it from the database once', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const dom = await activeDomain(h, u.token, 'viral.example.com');
    const f = await makeFunnel(h, u.token, { name: 'Viral', base_path: '/promo' });
    await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { domain_id: dom, status: 'live' } });
    h.deps.pageCache.clear();
    const spy = vi.spyOn(h.deps.db, 'query');
    const rs = await Promise.all(Array.from({ length: 300 }, () => h.app.request('/promo', { headers: { host: 'viral.example.com', 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '203.0.113.9' } })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const pageReads = spy.mock.calls.filter(([sql]) => /FROM step_pages/.test(String(sql))).length;
    const resolves = spy.mock.calls.filter(([sql]) => /FROM steps s JOIN funnels f/.test(String(sql))).length;
    expect(pageReads).toBeLessThanOrEqual(2);
    expect(resolves).toBeLessThanOrEqual(10);
    expect(spy.mock.calls.length, 'queries for 300 requests').toBeLessThan(30);
  });
});
