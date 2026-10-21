import type { Context, MiddlewareHandler } from 'hono';
import { AppError, forbidden, unauthorized } from '../errors.js';
import { audit } from '../services/audit.js';
import { assertPlatformAccess } from './platform.js';
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
  /** Set when a platform administrator is acting as this user (support access): their user id. */
  impersonatorId?: string;
  /** Support access only: the session was opened with `allow_writes` (otherwise every request but GET/HEAD and ending the session is refused). */
  impersonationWrites?: boolean;
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
  s_impersonator: string | null;
  s_writes: number | null;
  w_suspended: string | null;
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

/** What support staff may not do while acting as a user, whatever the user's role: change credentials, billing and money, access and ownership. */
export const IMPERSONATION_DENIED: readonly Permission[] = ['billing:manage', 'orders:refund', 'members:manage', 'roles:manage', 'workspace:manage', 'api_keys:manage', 'analytics_identity:manage', 'funnels:purge', 'integrations:manage', 'publishing:manage'];

async function loadAuth(deps: Deps, userId: string, sessionId: string): Promise<Auth & { suspended: boolean }> {
  const u = await deps.db.get<AuthRow>(
    `SELECT u.id, u.workspace_id, u.role, u.role_id, u.email, u.name, s.revoked_at AS s_revoked, s.expires_at AS s_expires, s.last_used_at AS s_last_used, s.impersonator_id AS s_impersonator, s.allow_writes AS s_writes, w.suspended_at AS w_suspended,
            r.name AS r_name, r.permissions_json AS r_permissions
     FROM users u JOIN sessions s ON s.user_id = u.id AND s.id = ? JOIN workspaces w ON w.id = u.workspace_id LEFT JOIN roles r ON r.id = u.role_id AND r.workspace_id = u.workspace_id WHERE u.id = ?`,
    sessionId, userId,
  );
  const now = deps.now();
  if (!u) throw unauthorized('Session no longer exists');
  if (u.s_revoked) throw unauthorized('This session was signed out');
  if (u.s_expires <= now.toISOString()) throw unauthorized('This session has expired, sign in again');
  if (now.getTime() - Date.parse(u.s_last_used) > TOUCH_MS) await deps.db.run('UPDATE sessions SET last_used_at = ? WHERE id = ?', now.toISOString(), sessionId);
  const roleId = u.role_id ?? u.role;
  const r = resolvePermissions(roleId, u.r_name && u.r_permissions ? { name: u.r_name, permissions_json: u.r_permissions } : null);
  const permissions = u.s_impersonator ? new Set([...r.permissions].filter((p) => !IMPERSONATION_DENIED.includes(p))) : r.permissions;
  return { userId: u.id, workspaceId: u.workspace_id, role: u.role, roleId, roleName: r.name, permissions, sessionId, email: u.email, name: u.name, ...(u.s_impersonator ? { impersonatorId: u.s_impersonator, impersonationWrites: Number(u.s_writes) === 1 } : {}), suspended: !!u.w_suspended };
}

/**
 * Verifies the Bearer token (or, for the SSE route only, a short-lived stream ticket), loads the user, role and session fresh so a role change or a revoked
 * session applies on the next request, and then enforces the permission the route declares in `routes/spec.ts` (the only place a route's authorization is
 * decided: a test fails for an authenticated route without one).
 */
/** Routes a suspended workspace's members can still call: to learn why they are locked out, and to sign out. */
const SUSPENDED_OK = new Set(['GET /api/auth/me', 'POST /api/auth/logout', 'GET /api/announcements']);
/** Credential and session management stays with the user, even for support staff. */
/** The only non-read requests a read-only support session may make: ending itself, and opening the notification stream (no data changes). */
export const IMPERSONATION_SAFE: ReadonlySet<string> = new Set(['POST /api/auth/logout', 'POST /api/events/ticket']);
const NO_IMPERSONATION = /^\/api\/auth\/(password|2fa|sessions)/;

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
    const loaded = await loadAuth(deps, who.userId, who.sessionId);
    const { suspended, ...auth } = loaded;
    c.set('auth', auth);
    const op = rlOf(c)?.op;
    if (suspended && !SUSPENDED_OK.has(`${c.req.method} ${op?.path}`)) throw new AppError(403, 'WORKSPACE_SUSPENDED', 'This account is suspended. Contact support.');
    if (op?.auth === 'platform') await assertPlatformAccess(deps, auth);
    if (auth.impersonatorId) {
      if (op && NO_IMPERSONATION.test(op.path) && !/^\/api\/auth\/(me|logout)$/.test(op.path)) throw new AppError(403, 'IMPERSONATION_FORBIDDEN', 'This is not available while acting as another user');
      // Support access is read-only unless the session was opened with allow_writes: refuse before anything else can run (the one exception ends the session).
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !auth.impersonationWrites && !IMPERSONATION_SAFE.has(`${c.req.method} ${op?.path}`)) {
        throw new AppError(403, 'IMPERSONATION_READ_ONLY', 'This support session is read-only: it cannot change anything. Ask a superadmin for a write-enabled session if a change is really needed.');
      }
    }
    const required = op?.permission;
    if (required && required !== 'any' && !auth.permissions.has(required)) throw forbidden(`This action requires the "${required}" permission`);
    for (const p of op?.also ?? []) if (!auth.permissions.has(p)) throw forbidden(`This action also requires the "${p}" permission`);
    // Every write that goes through in a write-enabled support session is on record, in the customer's own audit log, with the administrator's id.
    if (auth.impersonatorId && c.req.method !== 'GET' && c.req.method !== 'HEAD' && !IMPERSONATION_SAFE.has(`${c.req.method} ${op?.path}`)) {
      await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.impersonatorId, action: 'admin.impersonation.action', target: auth.userId, detail: { method: c.req.method, path: op?.path ?? c.req.path, sessionId: auth.sessionId, mode: 'read_write' } });
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') deps.db.noteWrite(auth.workspaceId); // reads right after a change must see it, even with read replicas
    // Per-user and per-workspace limits need to know who is calling, so they run here, right after authentication.
    await (c.get('rl' as never) as { afterAuth?: (a: Auth) => Promise<void> } | undefined)?.afterAuth?.(auth);
    await next();
  };
}

export const authOf = (c: Context<AppEnv>): Auth => c.get('auth');

