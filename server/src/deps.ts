import type { Config } from './config.js';
import type { Db } from './db/db.js';
import type { Logger } from './logger.js';
import type { AiProvider } from './ai/types.js';
import type { DnsResolver } from './dns/resolver.js';
import type { PaymentProvider } from './payments/provider.js';
import type { HostLookup, HttpClient } from './net/ssrf.js';
import type { JobQueue } from './jobs/queue.js';
import type { RateLimiter } from './util/ratelimit.js';
import type { EventBus } from './util/bus.js';
import type { PageCache } from './util/pagecache.js';

/** Everything with side effects is injected, so tests swap in fakes and never touch the network. */
export interface Deps {
  config: Config;
  db: Db;
  log: Logger;
  now: () => Date;
  ai: AiProvider;
  dns: DnsResolver;
  payments: PaymentProvider;
  http: HttpClient;
  lookup: HostLookup;
  jobs: JobQueue;
  limiter: RateLimiter;
  bus: EventBus;
  pageCache: PageCache;
}
