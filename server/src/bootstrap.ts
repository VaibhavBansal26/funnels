import { AnthropicProvider } from './ai/anthropic.js';
import { HeuristicProvider } from './ai/heuristic.js';
import type { AiProvider } from './ai/types.js';
import type { Config } from './config.js';
import { openDb } from './db/index.js';
import type { Deps } from './deps.js';
import { NodeDnsResolver } from './dns/resolver.js';
import { type JobHandler, JobQueue, JobWorker } from './jobs/queue.js';
import { createLogger } from './logger.js';
import { NodeHttpClient, systemLookup } from './net/ssrf.js';
import { CloudflareDomainProvider, ManualDomainProvider, type DomainProvider } from './edge/domainProvider.js';
import { CloudflareApiPurger, NoopPurger, purgeJob, type CloudflarePurger } from './edge/purger.js';
import { EventBuffer } from './services/eventbuffer.js';
import { MockProvider } from './payments/provider.js';
import { deliverWebhook } from './services/webhooks.js';
import { verificationJob } from './services/domains.js';
import { seedTemplates } from './templates/seed.js';
import { EventBus } from './util/bus.js';
import { PageCache } from './util/pagecache.js';
import { createLimiter } from './ratelimit/index.js';

export function createAi(config: Config): AiProvider {
  return config.ANTHROPIC_API_KEY ? new AnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL }) : new HeuristicProvider();
}

export function createPurger(config: Config): CloudflarePurger {
  return config.CF_API_TOKEN && config.CF_ZONE_ID ? new CloudflareApiPurger({ zoneId: config.CF_ZONE_ID, token: config.CF_API_TOKEN, base: config.CF_API_BASE }) : new NoopPurger();
}

export function createDomainProvider(config: Config): DomainProvider {
  if (config.DOMAIN_PROVIDER === 'cloudflare') {
    if (!config.CF_API_TOKEN || !config.CF_ZONE_ID) throw new Error('DOMAIN_PROVIDER=cloudflare needs CF_API_TOKEN and CF_ZONE_ID');
    return new CloudflareDomainProvider({ zoneId: config.CF_ZONE_ID, token: config.CF_API_TOKEN, base: config.CF_API_BASE });
  }
  return new ManualDomainProvider();
}

/** Wires the production dependencies. Every one of them can be replaced through `overrides` (tests do). */
export async function createDeps(config: Config, overrides: Partial<Deps> = {}): Promise<Deps> {
  const now = overrides.now ?? (() => new Date());
  const log = overrides.log ?? createLogger(config.LOG_LEVEL);
  const db = overrides.db ?? (await openDb({ url: config.DATABASE_URL, sqlitePath: config.DATABASE_PATH, poolMax: config.DATABASE_POOL_MAX, log: (m, meta) => log.warn(m, meta) }));
  await seedTemplates(db);
  return {
    config,
    db,
    log,
    now,
    ai: createAi(config),
    dns: new NodeDnsResolver(),
    payments: new MockProvider(),
    http: new NodeHttpClient(),
    lookup: systemLookup,
    jobs: new JobQueue(db, () => now().getTime()),
    limiter: overrides.limiter ?? (await createLimiter(config, { db, log, now: () => now().getTime() })),
    bus: new EventBus(),
    pageCache: new PageCache(),
    events: new EventBuffer(db, log, { flushMs: config.EVENT_BUFFER_MS, maxQueue: config.EVENT_BUFFER_MAX }),
    purger: createPurger(config),
    domainProvider: createDomainProvider(config),
    ...overrides,
  };
}

export function createWorker(deps: Deps): JobWorker {
  const handlers: Record<string, JobHandler> = {
    'webhook.deliver': (payload, job) => deliverWebhook(deps, payload, job),
    'domain.verify': (payload) => verificationJob(deps, payload),
    'edge.purge': (payload) => purgeJob(deps, payload),
  };
  return new JobWorker(deps.jobs, handlers, deps.log);
}
