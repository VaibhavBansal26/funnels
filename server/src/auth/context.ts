import type { Context, MiddlewareHandler } from 'hono';
import { forbidden, unauthorized } from '../errors.js';
import type { Deps } from '../deps.js';
import { verifyAccessToken, verifyStreamTicket } from './tokens.js';

export type Role = 'owner' | 'admin' | 'member';

export interface Auth {
  userId: string;
  workspaceId: string;
  role: Role;
  email: string;
  name: string;
}

export type AppEnv = { Variables: { auth: Auth } };

const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };
export const atLeast = (role: Role, min: Role): boolean => RANK[role] >= RANK[min];

interface UserRow {
  id: string;
  workspace_id: string;
  role: Role;
  email: string;
  name: string;
}

async function loadAuth(deps: Deps, userId: string): Promise<Auth> {
  const u = await deps.db.get<UserRow>('SELECT id, workspace_id, role, email, name FROM users WHERE id = ?', userId);
  if (!u) throw unauthorized('Account no longer exists');
  return { userId: u.id, workspaceId: u.workspace_id, role: u.role, email: u.email, name: u.name };
}

/** Verifies the Bearer token (or, for the SSE route only, a short-lived stream ticket) and loads the user fresh so role changes apply immediately. */
export function authenticate(deps: Deps, opts: { allowTicket?: boolean } = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const bearer = /^Bearer (.+)$/i.exec(header)?.[1];
    let userId: string | null = null;
    if (bearer) userId = (await verifyAccessToken(deps.config, bearer, deps.now()))?.userId ?? null;
    else if (opts.allowTicket) {
      const ticket = c.req.query('ticket');
      if (ticket) userId = await verifyStreamTicket(deps.config, ticket, deps.now());
    }
    if (!userId) throw unauthorized();
    const auth = await loadAuth(deps, userId);
    c.set('auth', auth);
    // Per-user and per-workspace limits need to know who is calling, so they run here, right after authentication.
    await (c.get('rl' as never) as { afterAuth?: (a: Auth) => Promise<void> } | undefined)?.afterAuth?.(auth);
    await next();
  };
}

export function requireRole(min: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!atLeast(c.get('auth').role, min)) throw forbidden(`This action requires the ${min} role or higher`);
    await next();
  };
}

export const authOf = (c: Context<AppEnv>): Auth => c.get('auth');

export function isPlatformAdmin(deps: Deps, auth: Auth): boolean {
  return deps.config.PLATFORM_ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(auth.email.toLowerCase());
}
