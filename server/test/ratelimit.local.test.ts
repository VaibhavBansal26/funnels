import { describe, expect, it } from 'vitest';
import { StoreUnavailable } from '../src/ratelimit/guarded.js';
import { RateLimiter } from '../src/ratelimit/limiter.js';
import type { Outcome, Policy, Store } from '../src/ratelimit/types.js';

/** A "redis" store whose every call fails, like a timed-out Redis behind an open breaker. */
const dead = new Proxy({ kind: 'redis' } as unknown as Store, { get: (t, k) => (k === 'kind' ? 'redis' : () => Promise.reject(new StoreUnavailable('redis timeout', 'timeout'))) });
const base = { layer: 'class', keyBy: 'ip', cost: 1, description: 'test' } as const;
const gcra = (onFail: Policy['onFail']): Policy => ({ ...base, id: 'p', algo: 'gcra', limit: 600, windowMs: 60_000, burst: 10, onFail }) as Policy;
const win = (onFail: Policy['onFail']): Policy => ({ ...base, id: 'w', algo: 'window', limit: 5, windowMs: 60_000, onFail }) as Policy;

function limiter(p: Policy, t = { now: 1_000_000 }) {
  const outcomes: Outcome[] = [];
  const l = new RateLimiter({ store: dead, policies: [p], now: () => t.now, hooks: { decision: (_id, o) => void outcomes.push(o) } });
  return { l, t, outcomes };
}

describe("onFail: 'local' (store failure falls back to this process's memory store)", () => {
  it('GCRA: still refuses beyond the burst, refills with time, and reports fallback', async () => {
    const { l, t, outcomes } = limiter(gcra('local'));
    const answers = [] as boolean[];
    for (let i = 0; i < 25; i++) answers.push((await l.check('p', { ip: '1.2.3.4' })).allowed);
    expect(answers.filter(Boolean)).toHaveLength(10); // exactly the burst, although the store is dead
    const refused = await l.check('p', { ip: '1.2.3.4' });
    expect(refused).toMatchObject({ allowed: false, status: 429 });
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    t.now += 1000; // 600/min = 10 per second
    expect((await l.check('p', { ip: '1.2.3.4' })).allowed).toBe(true);
    expect(outcomes).toContain('fallback');
    expect((await l.check('p', { ip: '9.9.9.9' })).allowed).toBe(true); // other subjects have their own bucket
  });

  it('sliding window: same', async () => {
    const { l } = limiter(win('local'));
    const ok = [] as boolean[];
    for (let i = 0; i < 9; i++) ok.push((await l.check('w', { ip: '1.2.3.4' })).allowed);
    expect(ok.filter(Boolean)).toHaveLength(5);
  });

  it("'open' still admits everything and 'closed' still answers 503 (unchanged)", async () => {
    const open = limiter(gcra('open'));
    for (let i = 0; i < 30; i++) expect((await open.l.check('p', { ip: 'x' })).outcome).toBe('fail_open');
    const closed = limiter(gcra('closed'));
    expect(await closed.l.check('p', { ip: 'x' })).toMatchObject({ allowed: false, status: 503, outcome: 'error' });
  });
});
