import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createDeps, createWorker } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createMonitor } from './monitoring/index.js';
import { startQueues } from './queue/runtime.js';

const config = loadConfig();
// Error monitoring starts before anything else can fail (and is a no-op without SENTRY_DSN).
const monitor = await createMonitor(config, { log: createLogger(config.LOG_LEVEL) });
const deps = await createDeps(config, { monitor });
if (config.JWT_SECRET_GENERATED) deps.log.warn('JWT_SECRET is not set: generated an ephemeral secret, sessions will not survive a restart');
if (!config.DATA_ENCRYPTION_KEY) {
  if (config.NODE_ENV === 'production') deps.log.warn('DATA_ENCRYPTION_KEY is not set: the analytics identity pepper (and so every analytics export) is refused until it is configured');
  else deps.log.warn('DATA_ENCRYPTION_KEY is not set: derived a development key from JWT_SECRET (an identity pepper stored now is unreadable if JWT_SECRET changes)');
}
if (!config.ANTHROPIC_API_KEY) deps.log.info('ANTHROPIC_API_KEY is not set: AI features use the offline heuristic provider');

const worker = createWorker(deps);
if (config.ENABLE_WORKER) worker.start(config.JOB_POLL_MS);
const queues = config.ENABLE_WORKER ? await startQueues(deps) : undefined;

const server = serve({ fetch: createApp(deps).fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  deps.log.info('funnels listening', { port: info.port, env: config.NODE_ENV, db: config.DATABASE_URL ? 'postgres' : config.DATABASE_PATH });
});

function shutdown(signal: string) {
  deps.log.info('shutting down', { signal });
  worker.stop();
  // Flush buffered analytics events before the pool closes; in-flight requests finish first.
  server.close(() => {
    Promise.resolve(queues?.stop())
      .then(() => deps.events.close())
      .finally(() => deps.eventBus.close().finally(() => deps.db.close().finally(() => monitor.close(2000).finally(() => process.exit(0)))));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
