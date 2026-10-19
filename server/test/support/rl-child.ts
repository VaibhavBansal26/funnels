// Child process for the multi-process atomicity test: hammers one shared limiter key and prints how many calls were admitted.
import { RedisStore } from '../../src/ratelimit/redis.js';

const [url, calls, capacity, emission] = process.argv.slice(2) as [string, string, string, string];
const store = new RedisStore({ url, prefix: 'test:rl' });
await store.preload();
const results = await Promise.all(
  Array.from({ length: Number(calls) }, () => store.gcra({ subject: 'ip:shared', policyId: 'p', emissionMs: Number(emission), capacity: Number(capacity), cost: 1 })),
);
process.stdout.write(JSON.stringify({ allowed: results.filter((r) => r.verdict === 'allowed').length }));
await store.close();
