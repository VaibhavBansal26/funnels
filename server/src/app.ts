import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { aiRoutes } from './routes/ai.js';
import { authRoutes } from './routes/auth.js';
import { domainRoutes } from './routes/domains.js';
import { funnelRoutes } from './routes/funnels.js';
import { leadRoutes, orderRoutes } from './routes/leads.js';
import { notificationRoutes, streamRoutes } from './routes/notifications.js';
import { publicRoutes } from './routes/public.js';
import { hostRouting, messagePage, previewRoutes, staticRoutes } from './routes/serve.js';
import { tagRoutes } from './routes/tags.js';
import { adminTemplateRoutes, blockRoutes, templateRoutes } from './routes/templates.js';
import { webhookRoutes } from './routes/webhooks.js';
import type { Deps } from './deps.js';
import { AppError } from './errors.js';

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const started = Date.now();
    const id = c.req.header('x-request-id')?.slice(0, 64) || randomUUID();
    c.header('x-request-id', id);
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'strict-origin-when-cross-origin');
    await next();
    const path = new URL(c.req.url).pathname;
    if (path !== '/healthz' && path !== '/readyz') deps.log.info('request', { id, method: c.req.method, path, status: c.res.status, ms: Date.now() - started });
  });

  // Customer domains: serve published funnels by Host header before anything else can claim the path.
  app.use('*', hostRouting(deps));

  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', (c) => {
    deps.db.get('SELECT 1');
    return c.json({ status: 'ready', migrations: deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations')!.n });
  });

  app.route('/', publicRoutes(deps));
  app.route('/', previewRoutes(deps));

  const api = new Hono();
  if (deps.config.CORS_ORIGINS.length) {
    api.use('*', cors({ origin: deps.config.CORS_ORIGINS, allowHeaders: ['authorization', 'content-type'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], maxAge: 600 }));
  }
  api.use('*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: () => { throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large'); } }));
  api.route('/', authRoutes(deps));
  api.route('/funnels', funnelRoutes(deps));
  api.route('/tags', tagRoutes(deps));
  api.route('/domains', domainRoutes(deps));
  api.route('/templates', templateRoutes(deps));
  api.route('/admin', adminTemplateRoutes(deps));
  api.route('/blocks', blockRoutes(deps));
  api.route('/leads', leadRoutes(deps));
  api.route('/orders', orderRoutes(deps));
  api.route('/webhooks', webhookRoutes(deps));
  api.route('/notifications', notificationRoutes(deps));
  api.route('/events', streamRoutes(deps));
  api.route('/ai', aiRoutes(deps));
  app.route('/api', api);

  const web = staticRoutes(deps);
  if (web) app.use('*', web);

  app.notFound((c) => {
    if (new URL(c.req.url).pathname.startsWith('/api/')) return c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
    return messagePage(404, 'Not found', 'There is nothing here.');
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } }, err.status as 400, err.headers);
    }
    deps.log.error('unhandled error', { path: new URL(c.req.url).pathname, error: err instanceof Error ? err.stack ?? err.message : String(err) });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } }, 500);
  });

  return app;
}
