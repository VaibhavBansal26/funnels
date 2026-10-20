import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Logger } from './logger.js';
import type { AiProvider } from './ai/types.js';
import type { DnsResolver } from './dns/resolver.js';
import type { PaymentProvider } from './payments/provider.js';
import type { StripeClient } from './payments/stripe.js';
import type { HostLookup, HttpClient } from './net/ssrf.js';
import type { JobQueue } from './jobs/queue.js';
import type { RateLimiter } from './ratelimit/limiter.js';
import type { EventBus } from './util/bus.js';
import type { PageCache } from './util/pagecache.js';
import type { Flights } from './util/flights.js';
import type { RefCache } from './util/refcache.js';
import type { EventBuffer } from './services/eventbuffer.js';
import type { EventBus as DurableEventBus } from './queue/eventbus.js';
import type { Mailer } from './mail/mailer.js';
import type { AnalyticsReader } from './services/analytics.js';
import type { EventStore } from './store/eventstore.js';
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
  /** Stripe API client (PAYMENTS_PROVIDER=stripe or subscriptions); absent when no STRIPE_SECRET_KEY is set. */
  stripe?: StripeClient;
  http: HttpClient;
  lookup: HostLookup;
  jobs: JobQueue;
  limiter: RateLimiter;
  bus: EventBus;
  pageCache: PageCache;
  flights: Flights;
  /** Positive cache for the public events endpoint (see util/refcache.ts). */
  eventRefs: RefCache;
  events: EventBuffer;
  /** Durable bus (Redis Streams, or in-process memory): ingest queue, outbox relay, secondary store feed. `bus` above is the in-process SSE bus. */
  eventBus: DurableEventBus;
  /** Secondary analytics store (ClickHouse) when EVENTSTORE_MIRROR is on. */
  /** Outbound mail (invitations, password reset). See mail/mailer.ts. */
  mailer: Mailer;
  secondaryStore?: EventStore;
  /** Analytics reads from ClickHouse (ANALYTICS_READ_STORE=clickhouse); the primary database answers when absent, stale or failing. */
  analyticsReader?: AnalyticsReader;
  purger: CloudflarePurger;
  domainProvider: DomainProvider;
  /** Set only on transaction-scoped deps (see db/scope.ts): queues an effect to run after COMMIT. */
  defer?: (effect: () => void) => void;
}
