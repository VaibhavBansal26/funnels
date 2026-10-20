import { Hono, type Context } from 'hono';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import * as domains from '../services/domains.js';
import { bodyOf } from './util.js';

/** Members may list domains (needed to pick one in a funnel) but only admins and owners manage them. */
export function domainRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  const ws = (c: Context<AppEnv>) => authOf(c).workspaceId;
  r.get('/', async (c) => c.json(await domains.listDomains(deps, ws(c))));
  r.get('/:id', async (c) => c.json(await domains.getDomain(deps, ws(c), c.req.param('id'))));
  r.get('/:id/routes', async (c) => c.json(await domains.domainRoutes(deps, ws(c), c.req.param('id'))));
  r.post('/', async (c) => c.json(await domains.createDomain(deps, ws(c), await bodyOf(c, domains.DomainInput)), 201));
  r.post('/:id/verify', async (c) => c.json(await domains.verifyDomain(deps, ws(c), c.req.param('id'))));
  r.put('/:id/default-pages', async (c) => c.json(await domains.setDefaultPages(deps, ws(c), c.req.param('id'), await bodyOf(c, domains.DefaultPagesInput))));
  r.delete('/:id', async (c) => {
    await domains.deleteDomain(deps, ws(c), c.req.param('id'));
    return c.body(null, 204);
  });
  return r;
}
