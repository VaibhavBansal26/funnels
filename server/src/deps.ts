import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Logger } from './logger.js';
import type { AiProvider } from './ai/types.js';
import type { DnsResolver } from './dns/resolver.js';
import type { PaymentProvider } from './payments/provider.js';
import type { HostLookup, HttpClient } from './net/ssrf.js';
import type { JobQueue } from './jobs/queue.js';
import type { RateLimiter } from './ratelimit/limiter.js';
import type { EventBus } from './util/bus.js';
import type { PageCache } from './util/pagecache.js';
import type { EventBuffer } from './services/eventbuffer.js';
import type { CloudflarePurger } from './edge/purger.js';
import type { DomainProvider } from './edge/domainProvider.js';

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
  events: EventBuffer;
  purger: CloudflarePurger;
  domainProvider: DomainProvider;
  /** Set only on transaction-scoped deps (see db/scope.ts): queues an effect to run after COMMIT. */
  defer?: (effect: () => void) => void;
}
