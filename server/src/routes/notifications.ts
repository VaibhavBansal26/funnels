import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import * as notifications from '../services/notifications.js';

export function notificationRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.get('/', (c) => c.json(notifications.listNotifications(deps, authOf(c).workspaceId, Number(c.req.query('limit') ?? 50) || 50)));
  r.post('/read-all', (c) => {
    notifications.markAllRead(deps, authOf(c).workspaceId);
    return c.body(null, 204);
  });
  r.post('/:id/read', (c) => {
    notifications.markRead(deps, authOf(c).workspaceId, c.req.param('id'));
    return c.body(null, 204);
  });
  return r;
}

/** GET /api/events/stream: server-sent events for the caller's workspace. Auth by Bearer header or a short-lived ticket (EventSource cannot set headers). */
export function streamRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps, { allowTicket: true }));
  r.get('/stream', (c) => {
    const ws = authOf(c).workspaceId;
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ ok: true }) });
      const off = deps.bus.subscribe(ws, (e) => void stream.writeSSE({ event: e.type, data: JSON.stringify(e.data) }).catch(() => undefined));
      const heartbeat = setInterval(() => void stream.writeSSE({ event: 'ping', data: '1' }).catch(() => undefined), 25_000);
      heartbeat.unref();
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(heartbeat);
      off();
    });
  });
  return r;
}
