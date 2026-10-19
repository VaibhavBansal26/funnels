import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GuardedStore, StoreUnavailable } from '../src/ratelimit/guarded.js';
import { RateLimiter } from '../src/ratelimit/limiter.js';
import { MemoryStore } from '../src/ratelimit/memory.js';
import { buildPolicies } from '../src/ratelimit/policies.js';
import { RedisStore } from '../src/ratelimit/redis.js';
import type { Policy } from '../src/ratelimit/types.js';
import { DEFAULT_PENALTY } from '../src/ratelimit/types.js';
import { BACKEND } from './helpers.js';
import { redisBinary, startRedis, type RedisServer } from './support/redis.js';

const run = promisify(execFile);
const available = redisBinary() !== null && BACKEND === 'sqlite'; // once per run

// Real redis-server, not a mock: the claims here are about atomicity and failure behaviour of the Lua scripts and the client.
describe.skipIf(!available)('Redis rate limit store (real redis-server)', () => {
  let redis: RedisServer;
  let admin: ReturnType<RedisServer['client']>;
  beforeAll(async () => {
    redis = await startRedis();
    admin = redis.client();
  });
  afterAll(async () => {
    await redis?.stop();
  });
  const store = (clock?: () => number) => new RedisStore({ url: redis.url, prefix: `t${Math.random().toString(36).slice(2, 8)}`, clock });

  it('gives the same answers as the in-memory store for random call sequences, including penalty escalation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom('gcra', 'window', 'check'), fc.integer({ min: 0, max: 1500 }), fc.integer({ min: 1, max: 3 })), { minLength: 5, maxLength: 60 }),
        fc.boolean(),
        async (ops, withPenalty) => {
          let t = 1_700_000_000_000;
          const mem = new MemoryStore(() => t, 1000, 0);
          const red = store(() => t);
          const penalty = withPenalty ? { ...DEFAULT_PENALTY, threshold: 3, strikeWindowMs: 30_000 } : undefined;
          try {
            for (const [op, dt, cost] of ops) {
              t += dt;
              const args = { subject: 'ip:1.2.3.4', policyId: 'p', cost, penalty };
              const [a, b] =
                op === 'gcra'
                  ? await Promise.all([mem.gcra({ ...args, emissionMs: 700, capacity: 4 }), red.gcra({ ...args, emissionMs: 700, capacity: 4 })])
                  : await Promise.all([
                      mem.window({ ...args, limit: 6, windowMs: 5000, mode: op === 'check' ? 'check' : 'consume' }),
                      red.window({ ...args, limit: 6, windowMs: 5000, mode: op === 'check' ? 'check' : 'consume' }),
                    ]);
              expect(b).toEqual(a);
            }
          } finally {
            await red.close();
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it('1,000 concurrent calls over 8 connections admit exactly the burst', async () => {
    const stores = Array.from({ length: 8 }, () => new RedisStore({ url: redis.url, prefix: 'atomic' }));
    await Promise.all(stores.map((s) => s.preload()));
    const results = await Promise.all(Array.from({ length: 1000 }, (_, i) => stores[i % 8]!.gcra({ subject: 'ip:atomic', policyId: 'p', emissionMs: 3_600_000, capacity: 100, cost: 1 })));
    expect(results.filter((r) => r.verdict === 'allowed')).toHaveLength(100);
    expect(results.filter((r) => r.verdict === 'limited')).toHaveLength(900);
    await Promise.all(stores.map((s) => s.close()));
  });

  it('sliding-window and concurrency scripts are atomic too', async () => {
    const stores = Array.from({ length: 4 }, () => new RedisStore({ url: redis.url, prefix: 'atomic2' }));
    const w = await Promise.all(Array.from({ length: 400 }, (_, i) => stores[i % 4]!.window({ subject: 'ws:w', policyId: 'q', limit: 50, windowMs: 3_600_000, cost: 1, mode: 'consume' })));
    expect(w.filter((r) => r.verdict === 'allowed')).toHaveLength(50);
    const a = await Promise.all(Array.from({ length: 200 }, (_, i) => stores[i % 4]!.acquire('ws:c', 'x', 7, 60_000, `lease${i}`)));
    expect(a.filter((r) => r.ok)).toHaveLength(7);
    await Promise.all(stores.map((s) => s.close()));
  });

  it('4 separate OS processes sharing the store admit exactly the burst', async () => {
    const calls = 250;
    const outs = await Promise.all(
      Array.from({ length: 4 }, () => run(process.execPath, ['--import', 'tsx', 'test/support/rl-child.ts', redis.url, String(calls), '300', '3600000'], { cwd: process.cwd() })),
    );
    const allowed = outs.reduce((n, o) => n + (JSON.parse(o.stdout) as { allowed: number }).allowed, 0);
    expect(allowed).toBe(300);
  }, 60_000);

  it('recovers when the script cache is flushed (NOSCRIPT) or Redis restarts empty', async () => {
    const s = store();
    await s.preload();
    expect((await s.gcra({ subject: 'ip:f', policyId: 'p', emissionMs: 1000, capacity: 2, cost: 1 })).verdict).toBe('allowed');
    await admin.script('FLUSH');
    expect((await s.gcra({ subject: 'ip:f', policyId: 'p', emissionMs: 1000, capacity: 2, cost: 1 })).verdict).toBe('allowed');
    expect((await s.gcra({ subject: 'ip:f', policyId: 'p', emissionMs: 1000, capacity: 2, cost: 1 })).verdict).toBe('limited');
    await s.close();
  });

  it('puts a TTL on every key and keeps every key of a decision under one hash tag (Redis Cluster safe)', async () => {
    const prefix = `ttl${Math.random().toString(36).slice(2, 6)}`;
    const s = new RedisStore({ url: redis.url, prefix });
    const pen = { threshold: 1, strikeWindowMs: 500, stepsMs: [400], decayMs: 400 };
    for (let i = 0; i < 4; i++) await s.gcra({ subject: 'ip:ttl', policyId: 'g', emissionMs: 50, capacity: 2, cost: 1, penalty: pen });
    await s.window({ subject: 'ip:ttl', policyId: 'w', limit: 2, windowMs: 300, cost: 1, mode: 'consume' });
    await s.acquire('ip:ttl', 'c', 2, 400, 'lease');
    await s.once('ip:ttl', 'i', 'token', 400);
    await s.recordLimited('g', 'ip:ttl');
    const keys = await admin.keys(`${prefix}:*`);
    expect(keys.length).toBeGreaterThan(4);
    for (const k of keys) {
      expect(k, k).toMatch(new RegExp(`^${prefix}:\\{[^}]+\\}:`));
      if (!k.includes('{admin}')) expect(await admin.pttl(k), `${k} must expire`).toBeGreaterThan(0);
    }
    await new Promise((r) => setTimeout(r, 2200));
    expect((await admin.keys(`${prefix}:*`)).filter((k) => !k.includes('{admin}'))).toEqual([]); // nothing is left behind
    await s.close();
  });

  it('does not depend on the caller clock (Redis TIME is used): a process whose clock is an hour off decides identically', async () => {
    const s = store();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    try {
      const r = [];
      for (let i = 0; i < 5; i++) r.push(await s.gcra({ subject: 'ip:skew', policyId: 'p', emissionMs: 1000, capacity: 3, cost: 1 }));
      expect(r.map((x) => x.verdict)).toEqual(['allowed', 'allowed', 'allowed', 'limited', 'limited']);
      expect(r[3]!.retryAfterMs).toBeLessThanOrEqual(1000);
    } finally {
      spy.mockRestore();
      await s.close();
    }
  });

  it('idempotency markers admit a token once', async () => {
    const s = store();
    expect(await s.once('ip:i', 'p', 'key-1', 5000)).toBe(true);
    expect(await s.once('ip:i', 'p', 'key-1', 5000)).toBe(false);
    expect(await s.once('ip:i', 'p', 'key-2', 5000)).toBe(true);
    await s.close();
  });

  it('manual lists are visible to the scripts and enumerable for the admin view', async () => {
    const s = store();
    await s.setList('deny', 'ip:9.9.9.9', 60_000);
    expect(await s.gcra({ subject: 'ip:9.9.9.9', policyId: 'p', emissionMs: 1000, capacity: 5, cost: 1 })).toMatchObject({ verdict: 'denied' });
    expect((await s.lists()).find((l) => l.subject === 'ip:9.9.9.9')).toMatchObject({ kind: 'deny' });
    await s.unsetList('deny', 'ip:9.9.9.9');
    expect((await s.gcra({ subject: 'ip:9.9.9.9', policyId: 'p', emissionMs: 1000, capacity: 5, cost: 1 })).verdict).toBe('allowed');
    await s.recordLimited('p', 'ip:9.9.9.9');
    expect((await s.limited(5))[0]).toMatchObject({ policyId: 'p', subject: 'ip:9.9.9.9' });
    await s.close();
  });
});

const policiesCfg = {
  IP_GUARD_PER_MINUTE: 1200, PUBLIC_EVENTS_PER_MINUTE: 120, PUBLIC_FORMS_PER_MINUTE: 20, PUBLIC_PAGES_PER_MINUTE: 6000, AUTH_ATTEMPTS_PER_MINUTE: 10,
  AI_RATE_LIMIT_PER_MINUTE: 10, API_USER_PER_MINUTE: 600, API_WORKSPACE_PER_MINUTE: 600, EXPORT_CONCURRENCY: 2, EDGE_RESOLVE_PER_MINUTE: 120_000,
};
const lim = (over: Partial<Policy>): Policy[] => [{ id: 'x.open', description: '', layer: 'class', keyBy: 'ip', algo: 'gcra', limit: 3, windowMs: 60_000, cost: 1, onFail: 'open', ...over }, { id: 'x.closed', description: '', layer: 'class', keyBy: 'ip', algo: 'gcra', limit: 3, windowMs: 60_000, cost: 1, onFail: 'closed' }];

describe.skipIf(!available)('failure behaviour', () => {
  let redis: RedisServer;
  beforeAll(async () => { redis = await startRedis(); });
  afterAll(async () => { await redis?.stop(); });

  const guarded = (o: Partial<ConstructorParameters<typeof GuardedStore>[1]> = {}) => {
    const inner = new RedisStore({ url: redis.url, prefix: 'fail', options: { retryStrategy: () => 200, maxRetriesPerRequest: 0 } });
    return new GuardedStore(inner, { timeoutMs: 40, failureThreshold: 3, openMs: 400, ...o });
  };

  it('fail-open policies admit and fail-closed policies refuse with 503 when Redis is down; the breaker then stops calling it', async () => {
    const g = guarded();
    const limiter = new RateLimiter({ store: g, policies: lim({}), hooks: {} });
    expect((await limiter.check('x.open', { ip: '1.1.1.1' })).outcome).toBe('allowed');
    await redis.stop();
    for (let i = 0; i < 3; i++) {
      expect(await limiter.check('x.open', { ip: '1.1.1.1' })).toMatchObject({ allowed: true, outcome: 'fail_open' });
      expect(await limiter.check('x.closed', { ip: '1.1.1.1' })).toMatchObject({ allowed: false, outcome: 'error', status: 503 });
    }
    expect(g.breaker).toBe('open');
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) await limiter.check('x.open', { ip: '1.1.1.1' });
    expect(performance.now() - t0, '50 calls while the circuit is open must be near free').toBeLessThan(40);
    await redis.start();
    await new Promise((r) => setTimeout(r, 450)); // openMs elapsed: one probe is let through
    for (let i = 0; i < 20 && g.breaker !== 'closed'; i++) {
      await limiter.check('x.open', { ip: '1.1.1.1' });
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(g.breaker).toBe('closed');
    expect((await limiter.check('x.closed', { ip: '2.2.2.2' })).outcome).toBe('allowed');
  }, 30_000);

  it('abandons a call that exceeds the timeout budget and counts it as a failure', async () => {
    const g = guarded({ timeoutMs: 30, failureThreshold: 100 });
    const admin = redis.client();
    await g.ping();
    await admin.call('CLIENT', 'PAUSE', '300', 'ALL');
    const t0 = performance.now();
    const err = await g.ping().catch((e) => e);
    const took = performance.now() - t0;
    expect(err).toBeInstanceOf(StoreUnavailable);
    expect((err as StoreUnavailable).reason).toBe('timeout');
    expect(took).toBeLessThan(150);
    await new Promise((r) => setTimeout(r, 350));
    await g.ping();
  });

  it('with the lease tier on, one Redis call serves a whole batch of requests and the total never exceeds the burst', async () => {
    const store = new RedisStore({ url: redis.url, prefix: 'lease' });
    await store.preload();
    const policies = buildPolicies(policiesCfg).map((p) => (p.id === 'public.events' ? { ...p, limit: 600, windowMs: 3_600_000 } : p)); // 600 burst, refills slowly
    const counts = { hit: 0, refill: 0, direct: 0 };
    const limiter = new RateLimiter({ store, policies, hooks: { lease: (_p, r) => void counts[r]++ }, leaseFraction: 0.1 });
    const before = Number(/total_commands_processed:(\d+)/.exec(await redis.client().info('stats'))![1]);
    let allowed = 0;
    for (let i = 0; i < 1000; i++) if ((await limiter.check('public.events', { ip: '5.5.5.5', scope: 'fn' })).allowed) allowed++;
    const used = Number(/total_commands_processed:(\d+)/.exec(await redis.client().info('stats'))![1]) - before;
    expect(allowed).toBeLessThanOrEqual(600); // pre-paid tokens: the cluster never admits more than the burst
    expect(allowed).toBeGreaterThanOrEqual(600 - 60); // at most one lease (10% of the burst) stranded
    expect(counts.hit).toBeGreaterThan(400);
    expect(used, `redis commands for 1000 calls (${JSON.stringify(counts)})`).toBeLessThan(150);
    await store.close();
  });
});
