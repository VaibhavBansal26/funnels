import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import { listSessions, revokeAllSessions, revokeSession, rotate, type SessionMeta } from '../auth/sessions.js';
import { signStreamTicket } from '../auth/tokens.js';
import type { Deps } from '../deps.js';
import * as accounts from '../services/accounts.js';
import { audit } from '../services/audit.js';
import * as invitations from '../services/invitations.js';
import * as recovery from '../services/recovery.js';
import * as twofactor from '../services/twofactor.js';
import { clientIp } from '../ratelimit/ip.js';
import { notFound } from '../errors.js';
import { bodyOf, queryOf } from './util.js';

export const RefreshInput = z.object({ refreshToken: z.string().min(20).max(200) });

export function authRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const ip = (c: Context) => clientIp(c, deps.config);
  const meta = (c: Context): SessionMeta & { ip: string } => ({ ip: ip(c), userAgent: c.req.header('user-agent') });

  // Public: credentials in, session out.
  r.post('/auth/register', async (c) => c.json(await accounts.register(deps, await bodyOf(c, accounts.RegisterInput), meta(c)), 201));
  r.post('/auth/login', async (c) => c.json(await accounts.login(deps, await bodyOf(c, accounts.LoginInput), meta(c))));
  r.post('/auth/2fa/verify', async (c) => c.json(await twofactor.verifyLogin(deps, await bodyOf(c, twofactor.VerifyLoginInput), meta(c))));
  r.post('/auth/refresh', async (c) => c.json(await rotate(deps, (await bodyOf(c, RefreshInput)).refreshToken)));
  r.post('/auth/password/forgot', async (c) => c.json(await recovery.requestPasswordReset(deps, await bodyOf(c, recovery.ForgotInput), ip(c))));
  r.post('/auth/password/reset', async (c) => c.json(await recovery.resetPassword(deps, await bodyOf(c, recovery.ResetInput), ip(c))));
  r.get('/auth/invitations/lookup', async (c) => c.json(await invitations.lookupInvitation(deps, queryOf(c, invitations.LookupQuery).token)));
  r.post('/auth/invitations/accept', async (c) => c.json(await invitations.acceptInvitation(deps, await bodyOf(c, invitations.AcceptInput), meta(c)), 201));

  const auth = authenticate(deps);
  r.get('/auth/me', auth, async (c) => c.json(await accounts.me(deps, authOf(c))));
  r.post('/events/ticket', auth, async (c) => c.json({ ticket: await signStreamTicket(deps.config, authOf(c).userId, authOf(c).sessionId, deps.now()), expiresInSeconds: 60 }));

  // Sessions: sign out, list, end one, end all others.
  r.post('/auth/logout', auth, async (c) => {
    await revokeSession(deps, authOf(c).sessionId, 'logout');
    return c.body(null, 204);
  });
  r.get('/auth/sessions', auth, async (c) => c.json(await listSessions(deps, authOf(c).userId, authOf(c).sessionId)));
  r.delete('/auth/sessions/:id', auth, async (c) => {
    const a = authOf(c);
    const own = await deps.db.get('SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL', c.req.param('id'), a.userId);
    if (!own) throw notFound('Session');
    await revokeSession(deps, c.req.param('id'), 'revoked_by_user');
    await audit(deps, { workspaceId: a.workspaceId, actorId: a.userId, action: 'session.revoked', target: c.req.param('id'), ip: ip(c) });
    return c.body(null, 204);
  });
  r.post('/auth/sessions/revoke-others', auth, async (c) => {
    const a = authOf(c);
    const n = await revokeAllSessions(deps, a.userId, 'revoked_by_user', a.sessionId);
    await audit(deps, { workspaceId: a.workspaceId, actorId: a.userId, action: 'session.revoked_others', ip: ip(c), detail: { count: n } });
    return c.json({ revoked: n });
  });

  r.post('/auth/password', auth, async (c) => c.json(await accounts.changePassword(deps, authOf(c), await bodyOf(c, accounts.PasswordChange), ip(c))));

  // Two-factor (TOTP).
  r.post('/auth/2fa/setup', auth, async (c) => c.json(await twofactor.setup(deps, authOf(c))));
  r.post('/auth/2fa/enable', auth, async (c) => c.json(await twofactor.enable(deps, authOf(c), (await bodyOf(c, twofactor.CodeInput)).code, ip(c))));
  r.post('/auth/2fa/disable', auth, async (c) => c.json(await twofactor.disable(deps, authOf(c), await bodyOf(c, twofactor.ConfirmInput), ip(c))));
  r.post('/auth/2fa/recovery-codes', auth, async (c) => c.json(await twofactor.regenerateRecoveryCodes(deps, authOf(c), await bodyOf(c, twofactor.ConfirmInput), ip(c))));

  r.get('/workspace', auth, async (c) => c.json(await accounts.workspaceOf(deps, authOf(c).workspaceId)));
  r.patch('/workspace', auth, async (c) => c.json(await accounts.updateWorkspace(deps, authOf(c), await bodyOf(c, accounts.WorkspacePatch))));
  return r;
}
