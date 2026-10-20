import { Hono, type Context } from 'hono';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import * as hooks from '../services/webhooks.js';
import { bodyOf } from './util.js';

export function webhookRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  const ws = (c: Context<AppEnv>) => authOf(c).workspaceId;
  r.get('/', async (c) => c.json(await hooks.listWebhooks(deps, ws(c))));
  r.post('/', async (c) => c.json(await hooks.createWebhook(deps, ws(c), await bodyOf(c, hooks.WebhookInput)), 201));
  r.patch('/:id', async (c) => c.json(await hooks.updateWebhook(deps, ws(c), c.req.param('id'), await bodyOf(c, hooks.WebhookPatch))));
  r.delete('/:id', async (c) => {
    await hooks.deleteWebhook(deps, ws(c), c.req.param('id'));
    return c.body(null, 204);
  });
  r.post('/:id/rotate-secret', async (c) => c.json(await hooks.rotateSecret(deps, ws(c), c.req.param('id'))));
  r.post('/:id/test', async (c) => c.json(await hooks.sendTestEvent(deps, ws(c), c.req.param('id')), 202));
  r.get('/:id/deliveries', async (c) => c.json(await hooks.listDeliveries(deps, ws(c), c.req.param('id'))));
  r.post('/deliveries/:did/retry', async (c) => c.json(await hooks.retryDelivery(deps, ws(c), c.req.param('did'))));
  return r;
}
