import { Hono, type Context } from 'hono';
import { authenticate, authOf, requireRole, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import * as hooks from '../services/webhooks.js';
import { bodyOf } from './util.js';

export function webhookRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps), requireRole('admin'));
  const ws = (c: Context<AppEnv>) => authOf(c).workspaceId;
  r.get('/', (c) => c.json(hooks.listWebhooks(deps, ws(c))));
  r.post('/', async (c) => c.json(await hooks.createWebhook(deps, ws(c), await bodyOf(c, hooks.WebhookInput)), 201));
  r.patch('/:id', async (c) => c.json(await hooks.updateWebhook(deps, ws(c), c.req.param('id'), await bodyOf(c, hooks.WebhookPatch))));
  r.delete('/:id', (c) => {
    hooks.deleteWebhook(deps, ws(c), c.req.param('id'));
    return c.body(null, 204);
  });
  r.post('/:id/rotate-secret', (c) => c.json(hooks.rotateSecret(deps, ws(c), c.req.param('id'))));
  r.post('/:id/test', (c) => c.json(hooks.sendTestEvent(deps, ws(c), c.req.param('id')), 202));
  r.get('/:id/deliveries', (c) => c.json(hooks.listDeliveries(deps, ws(c), c.req.param('id'))));
  r.post('/deliveries/:did/retry', (c) => c.json(hooks.retryDelivery(deps, ws(c), c.req.param('did'))));
  return r;
}
