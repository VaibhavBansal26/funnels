import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Auth, Role } from '../auth/context.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signAccessToken } from '../auth/tokens.js';
import type { Deps } from '../deps.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { newId } from '../util/ids.js';
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

export function workspaceOf(deps: Deps, ws: string) {
  const w = deps.db.get<{ id: string; name: string; allow_custom_scripts: number; created_at: string }>('SELECT * FROM workspaces WHERE id = ?', ws);
  if (!w) throw notFound('Workspace');
  return { id: w.id, name: w.name, allowCustomScripts: w.allow_custom_scripts === 1, createdAt: w.created_at };
}

export async function register(deps: Deps, input: z.infer<typeof RegisterInput>) {
  const hash = await hashPassword(input.password);
  const at = deps.now().toISOString();
  const wsId = newId('ws');
  const userId = newId('usr');
  try {
    deps.db.tx(() => {
      deps.db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', wsId, input.workspaceName ?? `${input.name}'s workspace`, at);
      deps.db.run('INSERT INTO users (id, workspace_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', userId, wsId, input.email, input.name, hash, 'owner', at);
    });
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    throw e;
  }
  return { token: await signAccessToken(deps.config, userId, deps.now()), user: publicUser({ id: userId, email: input.email, name: input.name, role: 'owner', workspace_id: wsId }), workspace: workspaceOf(deps, wsId) };
}

// Verified against when the email is unknown, so response time does not reveal which emails exist.
let dummyHash: Promise<string> | null = null;

export async function login(deps: Deps, input: z.infer<typeof LoginInput>) {
  const u = deps.db.get<UserRow>('SELECT * FROM users WHERE email = ?', input.email);
  dummyHash ??= hashPassword('not-a-real-password');
  const ok = await verifyPassword(input.password, u?.password_hash ?? (await dummyHash));
  if (!u || !ok) throw unauthorized('Invalid email or password');
  return { token: await signAccessToken(deps.config, u.id, deps.now()), user: publicUser(u), workspace: workspaceOf(deps, u.workspace_id) };
}

export function me(deps: Deps, auth: Auth) {
  return { user: publicUser({ id: auth.userId, email: auth.email, name: auth.name, role: auth.role, workspace_id: auth.workspaceId }), workspace: workspaceOf(deps, auth.workspaceId) };
}

export function updateWorkspace(deps: Deps, auth: Auth, input: z.infer<typeof WorkspacePatch>) {
  const ws = auth.workspaceId;
  const before = workspaceOf(deps, ws);
  deps.db.tx(() => {
    if (input.name !== undefined) deps.db.run('UPDATE workspaces SET name = ? WHERE id = ?', input.name, ws);
    if (input.allowCustomScripts !== undefined) deps.db.run('UPDATE workspaces SET allow_custom_scripts = ? WHERE id = ?', input.allowCustomScripts ? 1 : 0, ws);
    if (input.allowCustomScripts !== undefined && input.allowCustomScripts !== before.allowCustomScripts) regenerateWorkspace(deps, ws);
  });
  return workspaceOf(deps, ws);
}

export function listMembers(deps: Deps, ws: string) {
  return { data: deps.db.all<UserRow>('SELECT * FROM users WHERE workspace_id = ? ORDER BY created_at', ws).map((u) => ({ ...publicUser(u), createdAt: u.created_at })) };
}

/** "Invite" = create the member with a one-time temporary password that the owner hands over. */
export async function createMember(deps: Deps, auth: Auth, input: z.infer<typeof MemberInput>) {
  const temp = randomBytes(9).toString('base64url');
  const id = newId('usr');
  const at = deps.now().toISOString();
  try {
    deps.db.run('INSERT INTO users (id, workspace_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, auth.workspaceId, input.email, input.name, await hashPassword(temp), input.role, at);
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    throw e;
  }
  return { user: { id, email: input.email, name: input.name, role: input.role, workspaceId: auth.workspaceId, createdAt: at }, temporaryPassword: temp };
}

export function changeRole(deps: Deps, auth: Auth, userId: string, role: 'admin' | 'member') {
  const u = deps.db.get<UserRow>('SELECT * FROM users WHERE workspace_id = ? AND id = ?', auth.workspaceId, userId);
  if (!u) throw notFound('Member');
  if (u.role === 'owner') throw forbidden('The owner role cannot be changed');
  deps.db.run('UPDATE users SET role = ? WHERE id = ?', role, userId);
  return { ...publicUser({ ...u, role }), createdAt: u.created_at };
}

export function removeMember(deps: Deps, auth: Auth, userId: string): void {
  const u = deps.db.get<UserRow>('SELECT * FROM users WHERE workspace_id = ? AND id = ?', auth.workspaceId, userId);
  if (!u) throw notFound('Member');
  if (u.role === 'owner' || u.id === auth.userId) throw badRequest('CANNOT_REMOVE', 'The owner and yourself cannot be removed');
  deps.db.run('DELETE FROM users WHERE id = ?', userId);
}
