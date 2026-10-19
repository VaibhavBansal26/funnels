import { Hono, type Context } from 'hono';
import { authenticate, authOf, requireRole, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import * as domains from '../services/domains.js';
import { bodyOf } from './util.js';

/** Members may list domains (needed to pick one in a funnel) but only admins and owners manage them. */
export function domainRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  const ws = (c: Context<AppEnv>) => authOf(c).workspaceId;
  r.get('/', (c) => c.json(domains.listDomains(deps, ws(c))));
  r.get('/:id', (c) => c.json(domains.getDomain(deps, ws(c), c.req.param('id'))));
  r.get('/:id/routes', (c) => c.json(domains.domainRoutes(deps, ws(c), c.req.param('id'))));
  r.post('/', requireRole('admin'), async (c) => c.json(await domains.createDomain(deps, ws(c), await bodyOf(c, domains.DomainInput)), 201));
  r.post('/:id/verify', requireRole('admin'), async (c) => c.json(await domains.verifyDomain(deps, ws(c), c.req.param('id'))));
  r.put('/:id/default-pages', requireRole('admin'), async (c) => c.json(domains.setDefaultPages(deps, ws(c), c.req.param('id'), await bodyOf(c, domains.DefaultPagesInput))));
  r.delete('/:id', requireRole('admin'), async (c) => {
    await domains.deleteDomain(deps, ws(c), c.req.param('id'));
    return c.body(null, 204);
  });
  return r;
}
