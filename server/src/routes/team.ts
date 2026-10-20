import { Hono, type Context } from 'hono';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import * as accounts from '../services/accounts.js';
import { AuditQuery, listAudit } from '../services/audit.js';
import * as invitations from '../services/invitations.js';
import * as roles from '../services/roles.js';
import * as twofactor from '../services/twofactor.js';
import { clientIp } from '../ratelimit/ip.js';
import { bodyOf, queryOf } from './util.js';

/** Members, invitations, roles, permissions and the audit log. Every route's required permission is declared in routes/spec.ts and enforced by authenticate(). */
export function teamRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // Scoped to this router's own paths: the router is mounted at the API root, and a `*` here would authenticate every route mounted after it.
  const auth = authenticate(deps);
  for (const path of ['/members', '/members/*', '/invitations', '/invitations/*', '/permissions', '/roles', '/roles/*', '/audit']) r.use(path, auth);
  const ws = (c: Context<AppEnv>) => authOf(c).workspaceId;
  const ip = (c: Context) => clientIp(c, deps.config);

  r.get('/members', async (c) => c.json(await accounts.listMembers(deps, ws(c))));
  r.patch('/members/:id', async (c) => c.json(await accounts.changeRole(deps, authOf(c), c.req.param('id'), (await bodyOf(c, accounts.MemberPatch)).roleId, ip(c))));
  r.delete('/members/:id', async (c) => {
    await accounts.removeMember(deps, authOf(c), c.req.param('id'), ip(c));
    return c.body(null, 204);
  });
  r.post('/members/:id/reset-2fa', async (c) => c.json(await twofactor.adminReset(deps, authOf(c), c.req.param('id'), ip(c))));

  r.get('/invitations', async (c) => c.json(await invitations.listInvitations(deps, ws(c))));
  r.post('/invitations', async (c) => c.json(await invitations.createInvitation(deps, authOf(c), await bodyOf(c, invitations.InvitationInput), ip(c)), 201));
  r.post('/invitations/:id/resend', async (c) => c.json(await invitations.resendInvitation(deps, authOf(c), c.req.param('id'), ip(c))));
  r.delete('/invitations/:id', async (c) => {
    await invitations.revokeInvitation(deps, authOf(c), c.req.param('id'), ip(c));
    return c.body(null, 204);
  });

  r.get('/permissions', (c) => c.json(roles.permissionCatalogue()));
  r.get('/roles', async (c) => c.json(await roles.listRoles(deps, ws(c))));
  r.post('/roles', async (c) => c.json(await roles.createRole(deps, authOf(c), await bodyOf(c, roles.RoleInput), ip(c)), 201));
  r.patch('/roles/:id', async (c) => c.json(await roles.updateRole(deps, authOf(c), c.req.param('id'), await bodyOf(c, roles.RolePatch), ip(c))));
  r.delete('/roles/:id', async (c) => {
    await roles.deleteRole(deps, authOf(c), c.req.param('id'), ip(c));
    return c.body(null, 204);
  });

  r.get('/audit', async (c) => c.json(await listAudit(deps, ws(c), queryOf(c, AuditQuery))));
  return r;
}
