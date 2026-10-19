// A real app instance in its own process (in-memory SQLite, limiter state shared through REDIS_URL), for multi-node tests.
import { serve } from '@hono/node-server';
import { createApp } from '../../src/app.js';
import { createDeps } from '../../src/bootstrap.js';
import { loadConfig } from '../../src/config.js';

const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', JWT_SECRET: 'test-secret-test-secret-test-secret-123', LOG_LEVEL: 'silent', ENABLE_WORKER: 'false', EVENT_BUFFER_MS: '0', WEB_DIST: '/nonexistent', ...process.env } as Record<string, string>);
const deps = await createDeps(config);
const server = serve({ fetch: createApp(deps).fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
  process.stdout.write(`PORT ${info.port}\n`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
