import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Auth, Role } from '../auth/context.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signAccessToken } from '../auth/tokens.js';
import type { Deps } from '../deps.js';
import { isUniqueViolation } from '../db/index.js';
import { inTx } from '../db/scope.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { newId } from '../util/ids.js';
import { denyError } from '../ratelimit/response.js';
import { hashId } from '../ratelimit/subject.js';
import { regenerateWorkspace } from './pages.js';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8, 'Password must be at least 8 characters').max(200);

export const RegisterInput = z.object({ email, password, name: z.string().trim().min(1).max(100), workspaceName: z.string().trim().min(1).max(100).optional() });
export const LoginInput = z.object({ email, password: z.string().min(1).max(200) });
export const MemberInput = z.object({ email, name: z.string().trim().min(1).max(100), role: z.enum(['admin', 'member']) });
export const MemberPatch = z.object({ role: z.enum(['admin', 'member']) });
export const WorkspacePatch = z.object({ name: z.string().trim().min(1).max(100).optional(), allowCustomScripts: z.boolean().optional() });

interface UserRow {
  id: string;
  workspace_id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  created_at: string;
}

const publicUser = (u: Pick<UserRow, 'id' | 'email' | 'name' | 'role' | 'workspace_id'>) => ({ id: u.id, email: u.email, name: u.name, role: u.role, workspaceId: u.workspace_id });

export async function workspaceOf(deps: Deps, ws: string) {
  const w = await deps.db.get<{ id: string; name: string; allow_custom_scripts: number; created_at: string }>('SELECT * FROM workspaces WHERE id = ?', ws);
  if (!w) throw notFound('Workspace');
  return { id: w.id, name: w.name, allowCustomScripts: w.allow_custom_scripts === 1, createdAt: w.created_at };
}

export async function register(deps: Deps, input: z.infer<typeof RegisterInput>) {
  const hash = await hashPassword(input.password);
  const at = deps.now().toISOString();
  const wsId = newId('ws');
  const userId = newId('usr');
  try {
    await inTx(deps, async (d) => {
      await d.db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', wsId, input.workspaceName ?? `${input.name}'s workspace`, at);
      await d.db.run('INSERT INTO users (id, workspace_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', userId, wsId, input.email, input.name, hash, 'owner', at);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    throw e;
  }
  return { token: await signAccessToken(deps.config, userId, deps.now()), user: publicUser({ id: userId, email: input.email, name: input.name, role: 'owner', workspace_id: wsId }), workspace: await workspaceOf(deps, wsId) };
}

// Verified against when the email is unknown, so response time does not reveal which emails exist.
let dummyHash: Promise<string> | null = null;

/**
 * Failed logins are counted per account (hashed email) and per IP with their own sliding-window policies: once either budget is spent,
 * further attempts are refused (429) before any password work is done, so a lockout also stops credential guessing and scrypt abuse.
 * Successful logins are not counted. The lockout is keyed by the email whether or not it exists, so it reveals nothing about accounts.
 */
export async function login(deps: Deps, input: z.infer<typeof LoginInput>, ip = 'unknown') {
  const who = { ip, scope: hashId(input.email) };
  for (const id of ['auth.failures.account', 'auth.failures.ip']) {
    const d = await deps.limiter.check(id, who, { mode: 'check' });
    if (!d.allowed) throw denyError(d);
  }
  const u = await deps.db.get<UserRow>('SELECT * FROM users WHERE email = ?', input.email);
  dummyHash ??= hashPassword('not-a-real-password');
  const ok = await verifyPassword(input.password, u?.password_hash ?? (await dummyHash));
  if (!u || !ok) {
    await Promise.all(['auth.failures.account', 'auth.failures.ip'].map((id) => deps.limiter.check(id, who)));
    throw unauthorized('Invalid email or password');
  }
  return { token: await signAccessToken(deps.config, u.id, deps.now()), user: publicUser(u), workspace: await workspaceOf(deps, u.workspace_id) };
}

export async function me(deps: Deps, auth: Auth) {
  return { user: publicUser({ id: auth.userId, email: auth.email, name: auth.name, role: auth.role, workspace_id: auth.workspaceId }), workspace: await workspaceOf(deps, auth.workspaceId) };
}

export async function updateWorkspace(deps: Deps, auth: Auth, input: z.infer<typeof WorkspacePatch>) {
  const ws = auth.workspaceId;
  await inTx(deps, async (d) => {
    const before = await workspaceOf(d, ws);
    if (input.name !== undefined) await d.db.run('UPDATE workspaces SET name = ? WHERE id = ?', input.name, ws);
    if (input.allowCustomScripts !== undefined) await d.db.run('UPDATE workspaces SET allow_custom_scripts = ? WHERE id = ?', input.allowCustomScripts ? 1 : 0, ws);
    if (input.allowCustomScripts !== undefined && input.allowCustomScripts !== before.allowCustomScripts) await regenerateWorkspace(d, ws);
  });
  return workspaceOf(deps, ws);
}

export async function listMembers(deps: Deps, ws: string) {
  return { data: (await deps.db.all<UserRow>('SELECT * FROM users WHERE workspace_id = ? ORDER BY created_at, id', ws)).map((u) => ({ ...publicUser(u), createdAt: u.created_at })) };
}

/** "Invite" = create the member with a one-time temporary password that the owner hands over. */
export async function createMember(deps: Deps, auth: Auth, input: z.infer<typeof MemberInput>) {
  const temp = randomBytes(9).toString('base64url');
  const id = newId('usr');
  const at = deps.now().toISOString();
  try {
    await deps.db.run('INSERT INTO users (id, workspace_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, auth.workspaceId, input.email, input.name, await hashPassword(temp), input.role, at);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    throw e;
  }
  return { user: { id, email: input.email, name: input.name, role: input.role, workspaceId: auth.workspaceId, createdAt: at }, temporaryPassword: temp };
}

export async function changeRole(deps: Deps, auth: Auth, userId: string, role: 'admin' | 'member') {
  const u = await deps.db.get<UserRow>('SELECT * FROM users WHERE workspace_id = ? AND id = ?', auth.workspaceId, userId);
  if (!u) throw notFound('Member');
  if (u.role === 'owner') throw forbidden('The owner role cannot be changed');
  await deps.db.run('UPDATE users SET role = ? WHERE id = ?', role, userId);
  return { ...publicUser({ ...u, role }), createdAt: u.created_at };
}

export async function removeMember(deps: Deps, auth: Auth, userId: string): Promise<void> {
  const u = await deps.db.get<UserRow>('SELECT * FROM users WHERE workspace_id = ? AND id = ?', auth.workspaceId, userId);
  if (!u) throw notFound('Member');
  if (u.role === 'owner' || u.id === auth.userId) throw badRequest('CANNOT_REMOVE', 'The owner and yourself cannot be removed');
  await deps.db.run('DELETE FROM users WHERE id = ?', userId);
}
