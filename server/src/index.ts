import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createDeps, createWorker } from './bootstrap.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const deps = createDeps(config);
if (config.JWT_SECRET_GENERATED) deps.log.warn('JWT_SECRET is not set: generated an ephemeral secret, sessions will not survive a restart');
if (!config.ANTHROPIC_API_KEY) deps.log.info('ANTHROPIC_API_KEY is not set: AI features use the offline heuristic provider');

const worker = createWorker(deps);
if (config.ENABLE_WORKER) worker.start(config.JOB_POLL_MS);

const server = serve({ fetch: createApp(deps).fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  deps.log.info('funnels listening', { port: info.port, env: config.NODE_ENV, db: config.DATABASE_PATH });
});

function shutdown(signal: string) {
  deps.log.info('shutting down', { signal });
  worker.stop();
  deps.events.close(); // flush buffered analytics events before exit
  server.close(() => {
    deps.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
