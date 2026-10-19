import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import { GuardedStore } from './guarded.js';
import { RateLimiter, type LimiterHooks } from './limiter.js';
import { MemoryStore } from './memory.js';
import { buildPolicies } from './policies.js';
import { RedisStore } from './redis.js';
import { TierResolver } from './tiers.js';
import type { Store } from './types.js';

export { RateLimiter } from './limiter.js';
export type { Decision, Policy, Principal } from './types.js';

/**
 * Builds the limiter from config: Redis when REDIS_URL is set (behind a timeout budget and circuit breaker, with the local lease tier on),
 * in-memory otherwise. Metrics attach later through `limiter.hooks`.
 */
export async function createLimiter(config: Config, o: { db: Db; log: Logger; now?: () => number; store?: Store }): Promise<RateLimiter> {
  const hooks: LimiterHooks = {};
  let store: Store;
  if (o.store) store = o.store;
  else if (config.REDIS_URL && config.RATELIMIT_ENABLED) {
    const redis = new RedisStore({ url: config.REDIS_URL, prefix: `${config.REDIS_KEY_PREFIX}:rl` });
    await redis.preload().catch((e) => o.log.warn('rate limit script preload failed; will load on first use', { error: (e as Error).message }));
    store = new GuardedStore(redis, {
      timeoutMs: config.REDIS_TIMEOUT_MS,
      failureThreshold: 5,
      openMs: 2000,
      onState: (s) => {
        o.log.warn('rate limit store circuit', { state: s });
        hooks.breaker?.(s);
      },
      onLatency: (s, ok) => hooks.store?.(s, ok),
    });
  } else store = new MemoryStore(o.now);
  const tiers = new TierResolver(o.db, 30_000, o.now);
  const limiter = new RateLimiter({
    store,
    policies: buildPolicies(config),
    now: o.now,
    hooks,
    tiers,
    leaseFraction: config.RATELIMIT_LEASE_FRACTION,
    enabled: config.RATELIMIT_ENABLED,
    logSample: 20,
  });
  return limiter;
}
