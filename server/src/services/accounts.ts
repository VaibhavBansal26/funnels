import { z } from 'zod';
import type { Auth, Role } from '../auth/context.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { isSystemRoleId, SYSTEM_ROLES } from '../auth/permissions.js';
import { revokeAllSessions, startSession, type SessionMeta, type Tokens } from '../auth/sessions.js';
import { signChallengeToken } from '../auth/tokens.js';
import type { Deps } from '../deps.js';
import { isUniqueViolation } from '../db/index.js';
import { inTx } from '../db/scope.js';
import { badRequest, conflict, notFound, unauthorized } from '../errors.js';
import { newId } from '../util/ids.js';
import { denyError } from '../ratelimit/response.js';
import { hashId } from '../ratelimit/subject.js';
import { isPlatformAdmin, platformRoleOf } from '../auth/platform.js';
import { audit } from './audit.js';
import { regenerateBuiltinFunnels, regenerateWorkspace } from './pages.js';
import { setWorkspaceSlug, SlugInput } from './addresses.js';
import { assertCanGrant, findRole } from './roles.js';

const email = z.string().trim().toLowerCase().email().max(254);
export const password = z.string().min(8, 'Password must be at least 8 characters').max(200);

export const RegisterInput = z.object({ email, password, name: z.string().trim().min(1).max(100), workspaceName: z.string().trim().min(1).max(100).optional() });
export const LoginInput = z.object({ email, password: z.string().min(1).max(200) });
export const MemberPatch = z.object({ roleId: z.string().min(1).max(64) });
export const WorkspacePatch = z.object({ name: z.string().trim().min(1).max(100).optional(), allowCustomScripts: z.boolean().optional(), slug: SlugInput.optional() });
export const PasswordChange = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password });

export interface UserRow {
  id: string;
  workspace_id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  role_id: string | null;
  last_login_at: string | null;
  created_at: string;
}

/** The legacy users.role column (CHECK owner|admin|member) mirrors a built-in role; custom roles and viewers store 'member'. */
export const legacyRole = (roleId: string): Role => (roleId === 'owner' || roleId === 'admin' ? roleId : 'member');

const roleIdOf = (u: Pick<UserRow, 'role' | 'role_id'>) => u.role_id ?? u.role;

async function publicUser(deps: Deps, u: Pick<UserRow, 'id' | 'email' | 'name' | 'role' | 'role_id' | 'workspace_id'>, withPermissions = false) {
  const role = await findRole(deps, u.workspace_id, roleIdOf(u));
  const twoFactor = (await deps.db.get('SELECT 1 FROM user_totp WHERE user_id = ? AND confirmed_at IS NOT NULL', u.id)) !== undefined;
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, roleId: roleIdOf(u), roleName: role?.name ?? 'Unknown role', workspaceId: u.workspace_id, twoFactorEnabled: twoFactor,
    ...(withPermissions ? { permissions: [...(role?.permissions ?? [])].sort() } : {}),
  };
}

export async function workspaceOf(deps: Deps, ws: string) {
  const w = await deps.db.get<{ id: string; name: string; allow_custom_scripts: number; created_at: string; slug: string | null }>('SELECT * FROM workspaces WHERE id = ?', ws);
  if (!w) throw notFound('Workspace');
  return { id: w.id, name: w.name, slug: w.slug, allowCustomScripts: w.allow_custom_scripts === 1, createdAt: w.created_at };
}

async function sessionResponse(deps: Deps, u: UserRow, tokens: Tokens) {
  return { token: tokens.token, refreshToken: tokens.refreshToken, expiresIn: tokens.expiresIn, user: await publicUser(deps, u, true), workspace: await workspaceOf(deps, u.workspace_id) };
}

export async function register(deps: Deps, input: z.infer<typeof RegisterInput>, meta: SessionMeta = {}) {
  const hash = await hashPassword(input.password);
  const at = deps.now().toISOString();
  const wsId = newId('ws');
  const userId = newId('usr');
  try {
    await inTx(deps, async (d) => {
      await d.db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', wsId, input.workspaceName ?? `${input.name}'s workspace`, at);
      await d.db.run('INSERT INTO users (id, workspace_id, email, name, password_hash, role, role_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', userId, wsId, input.email, input.name, hash, 'owner', 'owner', at);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    throw e;
  }
  const u = (await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId))!;
  await audit(deps, { workspaceId: wsId, actorId: userId, action: 'auth.register', ip: meta.ip });
  return sessionResponse(deps, u, await startSession(deps, u, meta));
}

// Verified against when the email is unknown, so response time does not reveal which emails exist.
let dummyHash: Promise<string> | null = null;

const FAILURE_POLICIES = ['auth.failures.account', 'auth.failures.ip'];

/** Refuses (429) before any credential work when the account or the address has used its failure budget. */
export async function assertNotLockedOut(deps: Deps, emailAddr: string, ip: string): Promise<void> {
  const who = { ip, scope: hashId(emailAddr) };
  for (const id of FAILURE_POLICIES) {
    const d = await deps.limiter.check(id, who, { mode: 'check' });
    if (!d.allowed) throw denyError(d);
  }
}

/** Counts one failed credential check (password or second factor) against the account and the address; audits the moment an account becomes locked. */
export async function recordFailure(deps: Deps, u: { id: string; workspace_id: string; email: string } | undefined, emailAddr: string, ip: string): Promise<void> {
  const who = { ip, scope: hashId(emailAddr) };
  const results = await Promise.all(FAILURE_POLICIES.map((id) => deps.limiter.check(id, who)));
  if (u && results[0] && results[0].allowed && results[0].remaining === 0) await audit(deps, { workspaceId: u.workspace_id, actorId: u.id, action: 'auth.locked_out', ip, detail: { policy: 'auth.failures.account' } });
}

/**
 * Failed logins are counted per account (hashed email) and per IP with their own sliding-window policies: once either budget is spent,
 * further attempts are refused (429) before any password work is done, so a lockout also stops credential guessing and scrypt abuse.
 * Successful logins are not counted. The lockout is keyed by the email whether or not it exists, so it reveals nothing about accounts.
 * With 2FA enabled the password step returns a challenge instead of a session; `twofactor.verifyLogin` completes it.
 */
export async function login(deps: Deps, input: z.infer<typeof LoginInput>, meta: SessionMeta & { ip: string }) {
  await assertNotLockedOut(deps, input.email, meta.ip);
  const u = await deps.db.get<UserRow>('SELECT * FROM users WHERE email = ?', input.email);
  dummyHash ??= hashPassword('not-a-real-password');
  const ok = await verifyPassword(input.password, u?.password_hash ?? (await dummyHash));
  if (!u || !ok) {
    await recordFailure(deps, u, input.email, meta.ip);
    throw unauthorized('Invalid email or password');
  }
  if ((await deps.db.get('SELECT 1 FROM user_totp WHERE user_id = ? AND confirmed_at IS NOT NULL', u.id)) !== undefined) {
    return { twoFactorRequired: true as const, challengeToken: await signChallengeToken(deps.config, u.id, deps.now()) };
  }
  await audit(deps, { workspaceId: u.workspace_id, actorId: u.id, action: 'auth.login', ip: meta.ip });
  return sessionResponse(deps, u, await startSession(deps, u, meta));
}

/** Used after the second factor passed: the same response a password-only login gives. */
export async function completeLogin(deps: Deps, userId: string, meta: SessionMeta) {
  const u = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  if (!u) throw unauthorized('Account no longer exists');
  return sessionResponse(deps, u, await startSession(deps, u, meta));
}

export async function me(deps: Deps, auth: Auth) {
  const u = (await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', auth.userId))!;
  const w = (await deps.db.get<{ suspended_at: string | null; suspended_reason: string | null }>('SELECT suspended_at, suspended_reason FROM workspaces WHERE id = ?', auth.workspaceId))!;
  const session = auth.impersonatorId ? await deps.db.get<{ expires_at: string }>('SELECT expires_at FROM sessions WHERE id = ?', auth.sessionId) : undefined;
  const by = auth.impersonatorId ? await deps.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', auth.impersonatorId) : undefined;
  return {
    user: await publicUser(deps, u, true),
    workspace: { ...(await workspaceOf(deps, auth.workspaceId)), suspended: !!w.suspended_at, suspendedReason: w.suspended_reason },
    sessionId: auth.sessionId,
    platformAdmin: !auth.impersonatorId && (await isPlatformAdmin(deps, auth)),
    impersonation: auth.impersonatorId ? { by: by?.email ?? auth.impersonatorId, expiresAt: session?.expires_at ?? null, readOnly: !auth.impersonationWrites, allowWrites: !!auth.impersonationWrites } : null,
    platformRole: !auth.impersonatorId ? await platformRoleOf(deps, auth.userId) : null,
  };
}

export async function changePassword(deps: Deps, auth: Auth, input: z.infer<typeof PasswordChange>, ip: string) {
  await assertNotLockedOut(deps, auth.email, ip);
  const u = (await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', auth.userId))!;
  if (!(await verifyPassword(input.currentPassword, u.password_hash))) {
    await recordFailure(deps, u, auth.email, ip);
    throw badRequest('WRONG_PASSWORD', 'The current password is not correct');
  }
  await deps.db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(input.newPassword), auth.userId);
  const ended = await revokeAllSessions(deps, auth.userId, 'password_changed', auth.sessionId);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'auth.password_changed', ip, detail: { otherSessionsEnded: ended } });
  return { ok: true, otherSessionsEnded: ended };
}

export async function updateWorkspace(deps: Deps, auth: Auth, input: z.infer<typeof WorkspacePatch>) {
  const ws = auth.workspaceId;
  await inTx(deps, async (d) => {
    const before = await workspaceOf(d, ws);
    if (input.name !== undefined) await d.db.run('UPDATE workspaces SET name = ? WHERE id = ?', input.name, ws);
    if (input.allowCustomScripts !== undefined) await d.db.run('UPDATE workspaces SET allow_custom_scripts = ? WHERE id = ?', input.allowCustomScripts ? 1 : 0, ws);
    if (input.allowCustomScripts !== undefined && input.allowCustomScripts !== before.allowCustomScripts) await regenerateWorkspace(d, ws);
    if (input.slug !== undefined && input.slug !== before.slug) {
      await setWorkspaceSlug(d, ws, input.slug);
      await regenerateBuiltinFunnels(d, ws); // every internal link and canonical URL of built-in funnels carries the workspace name
    }
  });
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'workspace.updated', detail: { ...(input.slug !== undefined ? { slug: input.slug } : {}), ...(input.name !== undefined ? { name: input.name } : {}), ...(input.allowCustomScripts !== undefined ? { allowCustomScripts: input.allowCustomScripts } : {}) } });
  return workspaceOf(deps, ws);
}

export async function listMembers(deps: Deps, ws: string) {
  const rows = await deps.db.all<UserRow & { r_name: string | null; totp: string | null }>(
    `SELECT u.*, r.name AS r_name, t.confirmed_at AS totp FROM users u LEFT JOIN roles r ON r.id = u.role_id AND r.workspace_id = u.workspace_id LEFT JOIN user_totp t ON t.user_id = u.id
     WHERE u.workspace_id = ? ORDER BY u.created_at, u.id`, ws,
  );
  return {
    data: rows.map((u) => {
      const id = roleIdOf(u);
      return { id: u.id, email: u.email, name: u.name, role: u.role, roleId: id, roleName: isSystemRoleId(id) ? SYSTEM_ROLES[id].name : (u.r_name ?? 'Unknown role'), workspaceId: u.workspace_id, twoFactorEnabled: !!u.totp, lastLoginAt: u.last_login_at, createdAt: u.created_at };
    }),
  };
}

const ownerCount = async (deps: Deps, ws: string) => Number((await deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE workspace_id = ? AND COALESCE(role_id, role) = 'owner'", ws))!.n);

async function targetOf(deps: Deps, ws: string, userId: string): Promise<UserRow> {
  const u = await deps.db.get<UserRow>('SELECT * FROM users WHERE workspace_id = ? AND id = ?', ws, userId);
  if (!u) throw notFound('Member');
  return u;
}

/**
 * Changes a member's role. The actor must hold every permission of the target's current role and of the new one (so a `members:manage` holder cannot demote an
 * owner or promote anyone above themselves), and a workspace always keeps at least one owner.
 */
export async function changeRole(deps: Deps, auth: Auth, userId: string, roleId: string, ip?: string) {
  const u = await targetOf(deps, auth.workspaceId, userId);
  const next = await findRole(deps, auth.workspaceId, roleId);
  if (!next) throw notFound('Role');
  const current = await findRole(deps, auth.workspaceId, roleIdOf(u));
  assertCanGrant(auth, [...(current?.permissions ?? []), ...next.permissions]);
  if (roleIdOf(u) === 'owner' && next.id !== 'owner' && (await ownerCount(deps, auth.workspaceId)) <= 1) throw conflict('LAST_OWNER', 'A workspace needs at least one owner: make someone else an owner first');
  await deps.db.run('UPDATE users SET role = ?, role_id = ? WHERE id = ?', legacyRole(next.id), next.id, userId);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'member.role_changed', target: userId, ip, detail: { from: roleIdOf(u), to: next.id } });
  return { id: u.id, email: u.email, name: u.name, role: legacyRole(next.id), roleId: next.id, roleName: next.name, workspaceId: u.workspace_id, createdAt: u.created_at };
}

export async function removeMember(deps: Deps, auth: Auth, userId: string, ip?: string): Promise<void> {
  const u = await targetOf(deps, auth.workspaceId, userId);
  if (u.id === auth.userId) throw badRequest('CANNOT_REMOVE', 'You cannot remove yourself');
  const current = await findRole(deps, auth.workspaceId, roleIdOf(u));
  assertCanGrant(auth, current?.permissions ?? []);
  if (roleIdOf(u) === 'owner' && (await ownerCount(deps, auth.workspaceId)) <= 1) throw conflict('LAST_OWNER', 'The last owner cannot be removed');
  await deps.db.run('DELETE FROM users WHERE id = ?', userId); // sessions, TOTP and reset tokens cascade
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'member.removed', target: userId, ip, detail: { email: u.email } });
}

