import { AnthropicProvider } from './ai/anthropic.js';
import { HeuristicProvider } from './ai/heuristic.js';
import type { AiProvider } from './ai/types.js';
import type { Config } from './config.js';
import { openDb } from './db/db.js';
import type { Deps } from './deps.js';
import { NodeDnsResolver } from './dns/resolver.js';
import { type JobHandler, JobQueue, JobWorker } from './jobs/queue.js';
import { createLogger } from './logger.js';
import { NodeHttpClient, systemLookup } from './net/ssrf.js';
import { MockProvider } from './payments/provider.js';
import { deliverWebhook } from './services/webhooks.js';
import { verificationJob } from './services/domains.js';
import { seedTemplates } from './templates/seed.js';
import { EventBus } from './util/bus.js';
import { PageCache } from './util/pagecache.js';
import { RateLimiter } from './util/ratelimit.js';

export function createAi(config: Config): AiProvider {
  return config.ANTHROPIC_API_KEY ? new AnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL }) : new HeuristicProvider();
}

/** Wires the production dependencies. Every one of them can be replaced through `overrides` (tests do). */
export function createDeps(config: Config, overrides: Partial<Deps> = {}): Deps {
  const db = overrides.db ?? openDb(config.DATABASE_PATH);
  seedTemplates(db);
  const now = overrides.now ?? (() => new Date());
  return {
    config,
    db,
    log: createLogger(config.LOG_LEVEL),
    now,
    ai: createAi(config),
    dns: new NodeDnsResolver(),
    payments: new MockProvider(),
    http: new NodeHttpClient(),
    lookup: systemLookup,
    jobs: new JobQueue(db, () => now().getTime()),
    limiter: new RateLimiter(() => now().getTime()),
    bus: new EventBus(),
    pageCache: new PageCache(),
    ...overrides,
  };
}

export function createWorker(deps: Deps): JobWorker {
  const handlers: Record<string, JobHandler> = {
    'webhook.deliver': (payload, job) => deliverWebhook(deps, payload, job),
    'domain.verify': (payload) => verificationJob(deps, payload),
  };
  return new JobWorker(deps.jobs, handlers, deps.log);
}
