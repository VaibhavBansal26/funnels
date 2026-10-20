import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

/** Minimal Redis surface the cross-process tier needs (ioredis satisfies it; tests can fake it). */
export type FlightRedis = Pick<Redis, 'set' | 'get' | 'del'>;

export interface FlightHooks {
  /** leader: ran the computation; local: waited for one in this process; shared: took a result another process produced; fallback: waited, found nothing, computed itself. */
  outcome?(name: string, outcome: 'leader' | 'local' | 'shared' | 'fallback'): void;
}

export interface FlightOptions {
  /** How long a computed result stays shared across processes (ms). Keep it short: this is a stampede shield, not a cache. */
  shareMs?: number;
}

/**
 * Request coalescing ("single flight"): when many requests miss the same key at once, one computes and the rest wait for its result, so a viral
 * page costs one database read per process (and, with Redis, about one per cluster) instead of one per request.
 *
 *  - in process: a map of in-flight promises (always on);
 *  - across processes (REDIS_URL): the leader takes a short lock (`SET NX PX`), publishes the result under a short TTL, and followers poll for it
 *    for up to `waitMs` before computing themselves, so a dead leader costs a follower at most `waitMs`, never correctness.
 * Errors are not shared: every waiter retries on its own.
 */
export class Flights {
  private inflight = new Map<string, Promise<unknown>>();

  constructor(
    private o: { redis?: FlightRedis; prefix?: string; waitMs?: number; pollMs?: number; hooks?: FlightHooks } = {},
  ) {}

  get size(): number {
    return this.inflight.size;
  }

  get hooks(): FlightHooks {
    return (this.o.hooks ??= {});
  }

  private key(k: string, kind: 'lock' | 'res'): string {
    return `${this.o.prefix ?? 'funnels'}:flight:${kind}:${k}`;
  }

  async run<T>(name: string, key: string, compute: () => Promise<T>, opts: FlightOptions = {}): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) {
      this.o.hooks?.outcome?.(name, 'local');
      return existing;
    }
    const p = this.lead(name, key, compute, opts).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async lead<T>(name: string, key: string, compute: () => Promise<T>, opts: FlightOptions): Promise<T> {
    const redis = this.o.redis;
    if (!redis) {
      this.o.hooks?.outcome?.(name, 'leader');
      return compute();
    }
    const shareMs = opts.shareMs ?? 1000;
    const token = randomBytes(6).toString('base64url');
    let leader = false;
    try {
      leader = (await redis.set(this.key(key, 'lock'), token, 'PX', Math.max(shareMs * 3, 2000), 'NX')) === 'OK';
      if (!leader) {
        const deadline = Date.now() + (this.o.waitMs ?? 250);
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, this.o.pollMs ?? 8));
          const hit = await redis.get(this.key(key, 'res'));
          if (hit !== null) {
            this.o.hooks?.outcome?.(name, 'shared');
            return JSON.parse(hit) as T;
          }
        }
        this.o.hooks?.outcome?.(name, 'fallback');
        return await compute();
      }
    } catch {
      this.o.hooks?.outcome?.(name, 'fallback'); // Redis trouble never blocks serving
      return compute();
    }
    this.o.hooks?.outcome?.(name, 'leader');
    try {
      const value = await compute();
      await redis.set(this.key(key, 'res'), JSON.stringify(value), 'PX', shareMs).catch(() => undefined);
      return value;
    } finally {
      await redis.del(this.key(key, 'lock')).catch(() => undefined);
    }
  }

  /** Drops shared results (after a write that changed what they hold). The local in-flight map is deliberately untouched. */
  async invalidate(keys: string[]): Promise<void> {
    if (!this.o.redis || keys.length === 0) return;
    await Promise.all(keys.map((k) => this.o.redis!.del(this.key(k, 'res'), this.key(k, 'lock')).catch(() => undefined)));
  }
}
