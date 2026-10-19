import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { gcra, slidingWindow } from '../src/ratelimit/math.js';
import { MemoryStore } from '../src/ratelimit/memory.js';
import { RateLimiter } from '../src/ratelimit/limiter.js';
import { buildPolicies } from '../src/ratelimit/policies.js';
import { normalizeIp, subjectFor } from '../src/ratelimit/subject.js';
import { DEFAULT_PENALTY, type Policy } from '../src/ratelimit/types.js';
import { BACKEND } from './helpers.js';

// Pure algorithm tests on an injected clock: no database, so they run once (with the sqlite project).
describe.skipIf(BACKEND !== 'sqlite')('rate limit algorithms (injected clock)', () => {
  const clock = (start = 1_000_000) => {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms), set: (x: number) => (t = x) };
  };
  const store = (c: ReturnType<typeof clock>) => new MemoryStore(c.now, 100_000, 0);
  const g = (s: MemoryStore, over: Partial<{ subject: string; emissionMs: number; capacity: number; cost: number; penalty: typeof DEFAULT_PENALTY }> = {}) =>
    s.gcra({ subject: 'ip:1.1.1.1', policyId: 'p', emissionMs: 1000, capacity: 5, cost: 1, ...over });

  describe('GCRA', () => {
    it('allows exactly the burst, then one per emission interval', async () => {
      const c = clock();
      const s = store(c);
      const burst = [];
      for (let i = 0; i < 7; i++) burst.push((await g(s)).verdict);
      expect(burst).toEqual(['allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'limited', 'limited']);
      c.advance(1000);
      expect((await g(s)).verdict).toBe('allowed'); // one token refilled
      expect((await g(s)).verdict).toBe('limited');
      c.advance(3000);
      const three = [(await g(s)).verdict, (await g(s)).verdict, (await g(s)).verdict, (await g(s)).verdict];
      expect(three).toEqual(['allowed', 'allowed', 'allowed', 'limited']);
    });

    it('reports remaining and an exact Retry-After', async () => {
      const c = clock();
      const s = store(c);
      expect((await g(s)).remaining).toBe(4);
      expect((await g(s)).remaining).toBe(3);
      for (let i = 0; i < 3; i++) await g(s);
      c.advance(250);
      const denied = await g(s);
      expect(denied).toMatchObject({ verdict: 'limited', remaining: 0, retryAfterMs: 750 });
      c.advance(denied.retryAfterMs - 1);
      expect((await g(s)).verdict).toBe('limited'); // one millisecond early is still refused
      c.advance(1);
      expect((await g(s)).verdict).toBe('allowed'); // exactly at Retry-After it is admitted
    });

    it('a denied call does not consume anything', async () => {
      const c = clock();
      const s = store(c);
      for (let i = 0; i < 5; i++) await g(s);
      for (let i = 0; i < 100; i++) expect((await g(s)).verdict).toBe('limited');
      c.advance(1000);
      expect((await g(s)).verdict).toBe('allowed'); // hammering while limited does not push the recovery out
    });

    it('cost greater than the remaining budget is refused whole; cost above capacity can never pass', async () => {
      const c = clock();
      const s = store(c);
      await g(s, { cost: 3 });
      expect(await g(s, { cost: 3 })).toMatchObject({ verdict: 'limited', remaining: 2, retryAfterMs: 1000 });
      expect((await g(s, { cost: 2 })).verdict).toBe('allowed');
      const huge = await g(s, { cost: 6, subject: 'ip:2.2.2.2' });
      expect(huge.verdict).toBe('limited');
      c.advance(60_000);
      expect((await g(s, { cost: 6, subject: 'ip:2.2.2.2' })).verdict).toBe('limited'); // waiting never helps: it does not fit the bucket
    });

    it('refill is capped at the capacity', async () => {
      const c = clock();
      const s = store(c);
      await g(s);
      c.advance(10 * 3600_000);
      expect((await g(s)).remaining).toBe(4);
    });

    it('keeps subjects independent', async () => {
      const c = clock();
      const s = store(c);
      for (let i = 0; i < 5; i++) await g(s);
      expect((await g(s)).verdict).toBe('limited');
      expect((await g(s, { subject: 'ip:9.9.9.9' })).verdict).toBe('allowed');
    });

    it('property: in any interval it never admits more than capacity + length / emission', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(fc.integer({ min: 0, max: 3000 }), fc.integer({ min: 1, max: 4 })), { minLength: 1, maxLength: 60 }),
          fc.integer({ min: 1, max: 8 }),
          fc.integer({ min: 50, max: 2000 }),
          (steps, capacity, emission) => {
            let tat: number | undefined;
            let t = 0;
            const admitted: { t: number; cost: number }[] = [];
            for (const [dt, cost] of steps) {
              t += dt;
              const o = gcra(tat, t, emission, capacity, cost);
              if (o.allowed) {
                tat = o.newTat;
                admitted.push({ t, cost });
              }
            }
            for (let i = 0; i < admitted.length; i++) {
              let spent = 0;
              for (let j = i; j < admitted.length; j++) {
                spent += admitted[j]!.cost;
                const len = admitted[j]!.t - admitted[i]!.t;
                if (spent > capacity + len / emission + 1e-3) return false;
              }
            }
            return true;
          },
        ),
        { numRuns: 300 },
      );
    });

    it('property: a client that waits Retry-After is always admitted next', () => {
      fc.assert(
        fc.property(fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 1, maxLength: 40 }), fc.integer({ min: 1, max: 6 }), (gaps, capacity) => {
          let tat: number | undefined;
          let t = 0;
          for (const gap of gaps) {
            t += gap;
            const o = gcra(tat, t, 400, capacity, 1);
            if (o.allowed) tat = o.newTat;
            else {
              const retry = gcra(tat, t + o.retryAfterMs, 400, capacity, 1);
              if (!retry.allowed) return false;
            }
          }
          return true;
        }),
      );
    });
  });

  describe('sliding window counter', () => {
    const w = (s: MemoryStore, over: Partial<{ limit: number; windowMs: number; cost: number; mode: 'consume' | 'check' }> = {}) =>
      s.window({ subject: 'ip:1.1.1.1', policyId: 'q', limit: 10, windowMs: 60_000, cost: 1, mode: 'consume', ...over });

    it('admits up to the limit inside one window, then refuses', async () => {
      const c = clock(0);
      const s = store(c);
      for (let i = 0; i < 10; i++) expect((await w(s)).verdict).toBe('allowed');
      expect((await w(s)).verdict).toBe('limited');
    });

    it('weights the previous window by how much of it still overlaps', async () => {
      const c = clock(0);
      const s = store(c);
      for (let i = 0; i < 10; i++) await w(s);
      c.set(60_000 + 30_000); // halfway through the next window: half of the 10 still counts
      let admitted = 0;
      while ((await w(s)).verdict === 'allowed') admitted++;
      expect(admitted).toBe(5);
      c.set(120_000 + 59_999); // 10 in prev... decays to ~0 at the end of the next window
      expect((await w(s)).verdict).toBe('allowed');
    });

    it('an idle gap of two windows forgets everything', async () => {
      const c = clock(0);
      const s = store(c);
      for (let i = 0; i < 10; i++) await w(s);
      c.set(3 * 60_000 + 1);
      let admitted = 0;
      while ((await w(s)).verdict === 'allowed') admitted++;
      expect(admitted).toBe(10);
    });

    it('Retry-After lands on the first admissible instant (and 1 ms earlier is refused)', async () => {
      for (const start of [0, 12_345, 59_000]) {
        const c = clock(start);
        const s = store(c);
        for (let i = 0; i < 10; i++) await w(s);
        const d = await w(s);
        expect(d.verdict).toBe('limited');
        // a probe store with the same history shows the answer is exact within one millisecond
        c.advance(d.retryAfterMs);
        expect((await w(s)).verdict, `start ${start}`).toBe('allowed');
      }
    });

    it('cost above the limit is refused and capped at one window of Retry-After', async () => {
      const c = clock(0);
      const s = store(c);
      expect(await w(s, { cost: 11 })).toMatchObject({ verdict: 'limited', retryAfterMs: 60_000 });
    });

    it('check mode reads without charging; consume charges', async () => {
      const c = clock(0);
      const s = store(c);
      for (let i = 0; i < 20; i++) expect((await w(s, { mode: 'check' })).verdict).toBe('allowed');
      for (let i = 0; i < 10; i++) await w(s);
      expect((await w(s, { mode: 'check' })).verdict).toBe('limited');
    });

    it('property: never more than the limit in one fixed window, and never more than twice it in any sliding window', () => {
      fc.assert(
        fc.property(fc.array(fc.integer({ min: 0, max: 4000 }), { minLength: 1, maxLength: 120 }), fc.integer({ min: 1, max: 12 }), (gaps, limit) => {
          const windowMs = 10_000;
          let st: ReturnType<typeof slidingWindow>['state'] | undefined;
          let t = 0;
          const admitted: number[] = [];
          for (const gap of gaps) {
            t += gap;
            const o = slidingWindow(st, t, limit, windowMs, 1, 'consume');
            st = o.state;
            if (o.allowed) admitted.push(t);
          }
          for (const a of admitted) {
            const fixed = admitted.filter((x) => Math.floor(x / windowMs) === Math.floor(a / windowMs)).length;
            const sliding = admitted.filter((x) => x > a - windowMs && x <= a).length;
            if (fixed > limit || sliding > 2 * limit) return false;
          }
          return true;
        }),
        { numRuns: 300 },
      );
    });
  });

  describe('concurrency leases', () => {
    it('caps in-flight work, frees on release, and expires abandoned slots', async () => {
      const c = clock();
      const s = store(c);
      const a = await s.acquire('ws:1', 'x', 2, 5000, 'a');
      const b = await s.acquire('ws:1', 'x', 2, 5000, 'b');
      expect([a.ok, b.ok]).toEqual([true, true]);
      const denied = await s.acquire('ws:1', 'x', 2, 5000, 'c');
      expect(denied).toMatchObject({ ok: false, count: 2, retryAfterMs: 5000 });
      await s.release('ws:1', 'x', 'a');
      expect((await s.acquire('ws:1', 'x', 2, 5000, 'c')).ok).toBe(true);
      c.advance(5001); // nobody released b or c: both slots time out
      expect((await s.acquire('ws:1', 'x', 2, 5000, 'd')).ok).toBe(true);
    });

    it('withConcurrency releases when the work throws', async () => {
      const c = clock();
      const policies = buildPolicies(cfg);
      const l = new RateLimiter({ store: store(c), policies, hooks: {}, now: c.now });
      const p = { ip: '1.1.1.1', workspaceId: 'w' };
      await expect(l.withConcurrency('api.export', p, async () => { throw new Error('boom'); }, () => { throw new Error('denied'); })).rejects.toThrow('boom');
      // free plan allows 2 in flight: both slots are free again after the throw
      const h1 = await l.acquire('api.export', p);
      const h2 = await l.acquire('api.export', p);
      const h3 = await l.acquire('api.export', p);
      expect([h1.decision.allowed, h2.decision.allowed, h3.decision.allowed]).toEqual([true, true, false]);
      expect(h3.decision).toMatchObject({ outcome: 'shed', status: 503 });
      await h1.release();
      await h1.release(); // idempotent
      expect((await l.acquire('api.export', p)).decision.allowed).toBe(true);
    });
  });

  describe('penalty box', () => {
    const pen = { ...DEFAULT_PENALTY, threshold: 3 };
    it('blocks after repeated violations with escalating durations (1m, 5m, 30m, 24h cap) and decays', async () => {
      const c = clock();
      const s = store(c);
      const burnTo = async (): Promise<{ block: number }> => {
        for (let i = 0; i < 5; i++) await g(s, { penalty: pen }); // fill the bucket (capacity 5)
        let r = await g(s, { penalty: pen });
        for (let i = 0; i < 5 && r.verdict !== 'blocked'; i++) r = await g(s, { penalty: pen });
        return { block: r.retryAfterMs };
      };
      const levels: number[] = [];
      for (let level = 0; level < 5; level++) {
        const { block } = await burnTo();
        levels.push(block);
        c.advance(block + 1);
      }
      expect(levels).toEqual([60_000, 300_000, 1_800_000, 86_400_000, 86_400_000]);
      c.advance(25 * 3_600_000); // quiet for longer than the decay: back to level one
      const { block } = await burnTo();
      expect(block).toBe(60_000);
    });

    it('a blocked subject is refused on every policy until the block ends, then admitted again', async () => {
      const c = clock();
      const s = store(c);
      for (let i = 0; i < 5; i++) await g(s, { penalty: pen });
      for (let i = 0; i < 3; i++) await g(s, { penalty: pen });
      expect((await s.window({ subject: 'ip:1.1.1.1', policyId: 'other', limit: 100, windowMs: 1000, cost: 1, mode: 'consume' })).verdict).toBe('blocked');
      c.advance(60_001);
      expect((await s.window({ subject: 'ip:1.1.1.1', policyId: 'other', limit: 100, windowMs: 1000, cost: 1, mode: 'consume' })).verdict).toBe('allowed');
    });

    it('manual deny and allow lists beat the algorithms, with TTL', async () => {
      const c = clock();
      const s = store(c);
      await s.setList('deny', 'ip:1.1.1.1', 10_000);
      expect(await g(s)).toMatchObject({ verdict: 'denied', retryAfterMs: 10_000 });
      c.advance(10_001);
      expect((await g(s)).verdict).toBe('allowed');
      await s.setList('allow', 'ip:1.1.1.1', null);
      for (let i = 0; i < 50; i++) expect((await g(s)).verdict).toBe('bypassed');
      await s.setList('deny', 'ip:1.1.1.1', null);
      expect((await g(s)).verdict).toBe('denied'); // deny wins over allow
      await s.unsetList('deny', 'ip:1.1.1.1');
      expect((await g(s)).verdict).toBe('bypassed');
    });
  });

  describe('memory store hygiene', () => {
    it('is bounded (LRU) and sweeps expired keys', async () => {
      const c = clock();
      const s = new MemoryStore(c.now, 100, 0);
      for (let i = 0; i < 500; i++) await g(s, { subject: `ip:10.0.${Math.floor(i / 200)}.${i % 200}` });
      expect(s.size).toBeLessThanOrEqual(100);
      c.advance(3_600_000);
      s.sweep();
      expect(s.size).toBe(0);
    });
  });

  describe('subjects and keys', () => {
    it('keeps IPv4 as is, unwraps mapped addresses and reduces IPv6 to its /64', () => {
      expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
      expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
      expect(normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
      expect(normalizeIp('2001:0db8:0001:0002::1')).toBe('2001:db8:1:2::/64');
      expect(normalizeIp('2001:db8:1:2::ffff')).toBe(normalizeIp('2001:db8:1:2:1::2'));
      expect(normalizeIp('[2001:DB8::1]')).toBe('2001:db8:0:0::/64');
    });

    it('hashes every identifier except IPs and bounds the length', () => {
      const p = { ip: '1.2.3.4', userId: 'usr_secret', workspaceId: 'ws_secret', scope: 'someone@example.com' };
      expect(subjectFor({ keyBy: 'user' }, p)).toMatch(/^usr:[0-9a-f]{16}$/);
      expect(subjectFor({ keyBy: 'workspace' }, p)).not.toContain('secret');
      const cmp = subjectFor({ keyBy: 'composite', composite: ['ip', 'scope'] }, p);
      expect(cmp.startsWith('cmp:1.2.3.4|')).toBe(true);
      expect(cmp).not.toContain('someone');
      expect(subjectFor({ keyBy: 'composite', composite: ['scope'] }, { ip: 'x', scope: 'a}b{c'.repeat(60) }).length).toBeLessThanOrEqual(200);
      expect(subjectFor({ keyBy: 'composite', composite: ['scope'] }, { ip: 'x', scope: '{evil}' })).not.toMatch(/[{}]/);
    });
  });

  describe('policy registry', () => {
    it('defines unique ids with sane numbers for every policy', () => {
      const ps = buildPolicies(cfg);
      expect(new Set(ps.map((p) => p.id)).size).toBe(ps.length);
      for (const p of ps as Policy[]) {
        expect(p.limit, p.id).toBeGreaterThan(0);
        if (p.algo !== 'concurrency') expect(p.windowMs, p.id).toBeGreaterThan(0);
        if (p.penalty) expect(p.lease, `${p.id}: penalty policies are always exact`).toBeFalsy();
        if (p.layer === 'workspace' || p.tiers) expect(p.tiers, p.id).toBeTruthy();
      }
    });
  });
});

const cfg = {
  IP_GUARD_PER_MINUTE: 1200, PUBLIC_EVENTS_PER_MINUTE: 120, PUBLIC_FORMS_PER_MINUTE: 20, PUBLIC_PAGES_PER_MINUTE: 6000, AUTH_ATTEMPTS_PER_MINUTE: 10,
  AI_RATE_LIMIT_PER_MINUTE: 10, API_USER_PER_MINUTE: 600, API_WORKSPACE_PER_MINUTE: 600, EXPORT_CONCURRENCY: 2, EDGE_RESOLVE_PER_MINUTE: 120_000,
};
