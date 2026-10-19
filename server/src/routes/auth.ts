import { Hono } from 'hono';
import { authenticate, authOf, requireRole, type AppEnv } from '../auth/context.js';
import { signStreamTicket } from '../auth/tokens.js';
import type { Deps } from '../deps.js';
import * as accounts from '../services/accounts.js';
import { clientIp, rateLimit } from '../util/ratelimit.js';
import { bodyOf } from './util.js';

export function authRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const perMinute = deps.config.AUTH_ATTEMPTS_PER_MINUTE;
  const limit = rateLimit(deps.limiter, 'auth', { capacity: perMinute, perMinute }, (c) => clientIp(c, deps.config.TRUST_PROXY));

  r.post('/auth/register', limit, async (c) => c.json(await accounts.register(deps, await bodyOf(c, accounts.RegisterInput)), 201));
  r.post('/auth/login', limit, async (c) => c.json(await accounts.login(deps, await bodyOf(c, accounts.LoginInput))));

  const authed = new Hono<AppEnv>();
  authed.use('*', authenticate(deps));
  authed.get('/auth/me', (c) => c.json(accounts.me(deps, authOf(c))));
  authed.post('/events/ticket', async (c) => c.json({ ticket: await signStreamTicket(deps.config, authOf(c).userId, deps.now()), expiresInSeconds: 60 }));

  authed.get('/workspace', (c) => c.json(accounts.workspaceOf(deps, authOf(c).workspaceId)));
  authed.patch('/workspace', requireRole('owner'), async (c) => c.json(accounts.updateWorkspace(deps, authOf(c), await bodyOf(c, accounts.WorkspacePatch))));

  authed.get('/members', (c) => c.json(accounts.listMembers(deps, authOf(c).workspaceId)));
  authed.post('/members', requireRole('owner'), async (c) => c.json(await accounts.createMember(deps, authOf(c), await bodyOf(c, accounts.MemberInput)), 201));
  authed.patch('/members/:id', requireRole('owner'), async (c) => c.json(accounts.changeRole(deps, authOf(c), c.req.param('id'), (await bodyOf(c, accounts.MemberPatch)).role)));
  authed.delete('/members/:id', requireRole('owner'), (c) => {
    accounts.removeMember(deps, authOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  r.route('/', authed);
  return r;
}
