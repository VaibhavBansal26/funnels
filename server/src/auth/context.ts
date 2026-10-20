import type { Context, MiddlewareHandler } from 'hono';
import { forbidden, unauthorized } from '../errors.js';
import type { Deps } from '../deps.js';
import { rlOf } from '../ratelimit/http.js';
import { isPermission, isSystemRoleId, SYSTEM_ROLES, type Permission } from './permissions.js';
import { verifyAccessToken, verifyStreamTicket } from './tokens.js';

/** The legacy coarse role stored in users.role (it has a CHECK constraint). Authorization uses `permissions`; this is kept for display and for the seed. */
export type Role = 'owner' | 'admin' | 'member';

export interface Auth {
  userId: string;
  workspaceId: string;
  /** Legacy mirror of the built-in role ('member' for custom roles and viewers). Do not authorize on it. */
  role: Role;
  roleId: string;
  roleName: string;
  permissions: ReadonlySet<Permission>;
  sessionId: string;
  email: string;
  name: string;
}

export type AppEnv = { Variables: { auth: Auth } };

export const can = (auth: Auth, permission: Permission): boolean => auth.permissions.has(permission);

interface AuthRow {
  id: string;
  workspace_id: string;
  role: Role;
  role_id: string | null;
  email: string;
  name: string;
  s_revoked: string | null;
  s_expires: string;
  s_last_used: string;
  r_name: string | null;
  r_permissions: string | null;
}

/** Resolves a role id to its name and permissions: built-in roles from code, custom roles from the row joined in the same query. */
export function resolvePermissions(roleId: string, custom: { name: string; permissions_json: string } | null): { name: string; permissions: Set<Permission> } {
  if (isSystemRoleId(roleId)) return { name: SYSTEM_ROLES[roleId].name, permissions: new Set(SYSTEM_ROLES[roleId].permissions) };
  if (!custom) return { name: 'Unknown role', permissions: new Set() }; // a dangling role id grants nothing
  const list = (JSON.parse(custom.permissions_json) as string[]).filter(isPermission);
  return { name: custom.name, permissions: new Set(list) };
}

const TOUCH_MS = 5 * 60_000;

async function loadAuth(deps: Deps, userId: string, sessionId: string): Promise<Auth> {
  const u = await deps.db.get<AuthRow>(
    `SELECT u.id, u.workspace_id, u.role, u.role_id, u.email, u.name, s.revoked_at AS s_revoked, s.expires_at AS s_expires, s.last_used_at AS s_last_used,
            r.name AS r_name, r.permissions_json AS r_permissions
     FROM users u JOIN sessions s ON s.user_id = u.id AND s.id = ? LEFT JOIN roles r ON r.id = u.role_id AND r.workspace_id = u.workspace_id WHERE u.id = ?`,
    sessionId, userId,
  );
  const now = deps.now();
  if (!u) throw unauthorized('Session no longer exists');
  if (u.s_revoked) throw unauthorized('This session was signed out');
  if (u.s_expires <= now.toISOString()) throw unauthorized('This session has expired, sign in again');
  if (now.getTime() - Date.parse(u.s_last_used) > TOUCH_MS) await deps.db.run('UPDATE sessions SET last_used_at = ? WHERE id = ?', now.toISOString(), sessionId);
  const roleId = u.role_id ?? u.role;
  const r = resolvePermissions(roleId, u.r_name && u.r_permissions ? { name: u.r_name, permissions_json: u.r_permissions } : null);
  return { userId: u.id, workspaceId: u.workspace_id, role: u.role, roleId, roleName: r.name, permissions: r.permissions, sessionId, email: u.email, name: u.name };
}

/**
 * Verifies the Bearer token (or, for the SSE route only, a short-lived stream ticket), loads the user, role and session fresh so a role change or a revoked
 * session applies on the next request, and then enforces the permission the route declares in `routes/spec.ts` (the only place a route's authorization is
 * decided: a test fails for an authenticated route without one).
 */
export function authenticate(deps: Deps, opts: { allowTicket?: boolean } = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const bearer = /^Bearer (.+)$/i.exec(header)?.[1];
    let who: { userId: string; sessionId: string } | null = null;
    if (bearer) who = await verifyAccessToken(deps.config, bearer, deps.now());
    else if (opts.allowTicket) {
      const ticket = c.req.query('ticket');
      if (ticket) who = await verifyStreamTicket(deps.config, ticket, deps.now());
    }
    if (!who) throw unauthorized();
    const auth = await loadAuth(deps, who.userId, who.sessionId);
    c.set('auth', auth);
    const op = rlOf(c)?.op;
    const required = op?.permission;
    if (required && required !== 'any' && !auth.permissions.has(required)) throw forbidden(`This action requires the "${required}" permission`);
    for (const p of op?.also ?? []) if (!auth.permissions.has(p)) throw forbidden(`This action also requires the "${p}" permission`);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') deps.db.noteWrite(auth.workspaceId); // reads right after a change must see it, even with read replicas
    // Per-user and per-workspace limits need to know who is calling, so they run here, right after authentication.
    await (c.get('rl' as never) as { afterAuth?: (a: Auth) => Promise<void> } | undefined)?.afterAuth?.(auth);
    await next();
  };
}

export const authOf = (c: Context<AppEnv>): Auth => c.get('auth');

export function isPlatformAdmin(deps: Deps, auth: Auth): boolean {
  return deps.config.PLATFORM_ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(auth.email.toLowerCase());
}
