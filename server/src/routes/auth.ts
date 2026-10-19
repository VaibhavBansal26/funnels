import { Hono } from 'hono';
import { authenticate, authOf, requireRole, type AppEnv } from '../auth/context.js';
import { signStreamTicket } from '../auth/tokens.js';
import type { Deps } from '../deps.js';
import * as accounts from '../services/accounts.js';
import { clientIp } from '../ratelimit/ip.js';
import { bodyOf } from './util.js';

export function authRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.post('/auth/register', async (c) => c.json(await accounts.register(deps, await bodyOf(c, accounts.RegisterInput)), 201));
  r.post('/auth/login', async (c) => c.json(await accounts.login(deps, await bodyOf(c, accounts.LoginInput), clientIp(c, deps.config))));

  const auth = authenticate(deps);
  const owner = requireRole('owner');
  r.get('/auth/me', auth, async (c) => c.json(await accounts.me(deps, authOf(c))));
  r.post('/events/ticket', auth, async (c) => c.json({ ticket: await signStreamTicket(deps.config, authOf(c).userId, deps.now()), expiresInSeconds: 60 }));

  r.get('/workspace', auth, async (c) => c.json(await accounts.workspaceOf(deps, authOf(c).workspaceId)));
  r.patch('/workspace', auth, owner, async (c) => c.json(await accounts.updateWorkspace(deps, authOf(c), await bodyOf(c, accounts.WorkspacePatch))));

  r.get('/members', auth, async (c) => c.json(await accounts.listMembers(deps, authOf(c).workspaceId)));
  r.post('/members', auth, owner, async (c) => c.json(await accounts.createMember(deps, authOf(c), await bodyOf(c, accounts.MemberInput)), 201));
  r.patch('/members/:id', auth, owner, async (c) => c.json(await accounts.changeRole(deps, authOf(c), c.req.param('id'), (await bodyOf(c, accounts.MemberPatch)).role)));
  r.delete('/members/:id', auth, owner, async (c) => {
    await accounts.removeMember(deps, authOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  return r;
}
