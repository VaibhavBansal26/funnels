import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createDeps, createWorker } from './bootstrap.js';
import { loadConfig } from './config.js';
import { startQueues } from './queue/runtime.js';

const config = loadConfig();
const deps = await createDeps(config);
if (config.JWT_SECRET_GENERATED) deps.log.warn('JWT_SECRET is not set: generated an ephemeral secret, sessions will not survive a restart');
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
      .finally(() => deps.eventBus.close().finally(() => deps.db.close().finally(() => process.exit(0))));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
