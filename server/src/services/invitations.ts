import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import { hashPassword } from '../auth/password.js';
import { startSession, type SessionMeta } from '../auth/sessions.js';
import type { Deps } from '../deps.js';
import { inTx } from '../db/scope.js';
import { conflict, notFound } from '../errors.js';
import { newId } from '../util/ids.js';
import { assertWithinLimit } from '../billing/limits.js';
import { audit } from './audit.js';
import { legacyRole, me, password, type UserRow } from './accounts.js';
import { assertCanGrant, findRole } from './roles.js';

export const InvitationInput = z.object({ email: z.string().trim().toLowerCase().email().max(254), roleId: z.string().min(1).max(64) });
export const AcceptInput = z.object({ token: z.string().min(20).max(200), name: z.string().trim().min(1).max(100), password });
export const LookupQuery = z.object({ token: z.string().min(20).max(200) });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const day = 86_400_000;

interface InvRow {
  id: string;
  workspace_id: string;
  email: string;
  role_id: string;
  token_hash: string;
  invited_by: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

const link = (deps: Deps, token: string) => `${deps.config.APP_PUBLIC_URL.replace(/\/$/, '')}/accept-invite?token=${token}`;

async function shape(deps: Deps, ws: string, r: InvRow) {
  const status = r.accepted_at ? 'accepted' : r.revoked_at ? 'revoked' : r.expires_at <= deps.now().toISOString() ? 'expired' : 'pending';
  return { id: r.id, email: r.email, roleId: r.role_id, roleName: (await findRole(deps, ws, r.role_id))?.name ?? 'Unknown role', status, invitedBy: r.invited_by, createdAt: r.created_at, expiresAt: r.expires_at };
}

async function send(deps: Deps, ws: string, to: string, token: string, roleName: string): Promise<{ delivered: boolean }> {
  const w = await deps.db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', ws);
  try {
    const delivered = await deps.mailer.send({ to, subject: `You are invited to ${w?.name ?? 'a workspace'} on Funnels`, text: `You have been invited to join "${w?.name ?? 'a workspace'}" as ${roleName}.\n\nAccept the invitation (the link works once and expires in ${deps.config.INVITATION_TTL_DAYS} days):\n${link(deps, token)}\n` });
    return { delivered };
  } catch (e) {
    deps.log.warn('invitation mail failed', { error: (e as Error).message });
    return { delivered: false };
  }
}

/**
 * Invites an email address into the workspace with a role the inviter is allowed to grant. The one-time link goes to the invitee by mail; when no mail
 * transport delivers it (MAIL_TRANSPORT=none, or the transport failed) the link is returned to the inviter instead so it can be shared another way.
 */
export async function createInvitation(deps: Deps, auth: Auth, input: z.infer<typeof InvitationInput>, ip?: string) {
  const role = await findRole(deps, auth.workspaceId, input.roleId);
  if (!role) throw notFound('Role');
  assertCanGrant(auth, role.permissions);
  if ((await deps.db.get('SELECT 1 FROM users WHERE email = ?', input.email)) !== undefined) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
  await assertWithinLimit(deps, auth.workspaceId, 'members');
  const token = randomBytes(32).toString('base64url');
  const id = newId('inv');
  const now = deps.now();
  await inTx(deps, async (d) => {
    // One pending invitation per address: a new one replaces the old.
    await d.db.run('UPDATE invitations SET revoked_at = ? WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL', now.toISOString(), auth.workspaceId, input.email);
    await d.db.run('INSERT INTO invitations (id, workspace_id, email, role_id, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, auth.workspaceId, input.email, role.id, sha(token), auth.userId, now.toISOString(), new Date(now.getTime() + deps.config.INVITATION_TTL_DAYS * day).toISOString());
  });
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'invitation.created', target: id, ip, detail: { email: input.email, roleId: role.id } });
  const { delivered } = await send(deps, auth.workspaceId, input.email, token, role.name);
  const inv = (await deps.db.get<InvRow>('SELECT * FROM invitations WHERE id = ?', id))!;
  return { invitation: await shape(deps, auth.workspaceId, inv), delivered, ...(delivered ? {} : { link: link(deps, token) }) };
}

export async function listInvitations(deps: Deps, ws: string) {
  const rows = await deps.db.all<InvRow>('SELECT * FROM invitations WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 200', ws);
  return { data: await Promise.all(rows.map((r) => shape(deps, ws, r))) };
}

async function pending(deps: Deps, ws: string, id: string): Promise<InvRow> {
  const r = await deps.db.get<InvRow>('SELECT * FROM invitations WHERE workspace_id = ? AND id = ?', ws, id);
  if (!r) throw notFound('Invitation');
  if (r.accepted_at) throw conflict('ALREADY_ACCEPTED', 'This invitation was already accepted');
  return r;
}

export async function revokeInvitation(deps: Deps, auth: Auth, id: string, ip?: string): Promise<void> {
  const r = await pending(deps, auth.workspaceId, id);
  await deps.db.run('UPDATE invitations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', deps.now().toISOString(), r.id);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'invitation.revoked', target: id, ip, detail: { email: r.email } });
}

/** A fresh link and a fresh expiry for a pending invitation (the old link stops working). */
export async function resendInvitation(deps: Deps, auth: Auth, id: string, ip?: string) {
  const r = await pending(deps, auth.workspaceId, id);
  const role = await findRole(deps, auth.workspaceId, r.role_id);
  if (!role) throw notFound('Role');
  assertCanGrant(auth, role.permissions);
  const token = randomBytes(32).toString('base64url');
  const now = deps.now();
  await deps.db.run('UPDATE invitations SET token_hash = ?, expires_at = ?, revoked_at = NULL WHERE id = ?', sha(token), new Date(now.getTime() + deps.config.INVITATION_TTL_DAYS * day).toISOString(), r.id);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'invitation.resent', target: id, ip, detail: { email: r.email } });
  const { delivered } = await send(deps, auth.workspaceId, r.email, token, role.name);
  return { invitation: await shape(deps, auth.workspaceId, (await deps.db.get<InvRow>('SELECT * FROM invitations WHERE id = ?', id))!), delivered, ...(delivered ? {} : { link: link(deps, token) }) };
}

async function byToken(deps: Deps, token: string): Promise<InvRow> {
  const r = await deps.db.get<InvRow>('SELECT * FROM invitations WHERE token_hash = ?', sha(token));
  // One answer for unknown, used, revoked and expired: the token holder learns nothing beyond "does not work".
  if (!r || r.accepted_at || r.revoked_at || r.expires_at <= deps.now().toISOString()) throw notFound('Invitation');
  return r;
}

/** What the accept page shows before the invitee sets a password. */
export async function lookupInvitation(deps: Deps, token: string) {
  const r = await byToken(deps, token);
  const w = await deps.db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', r.workspace_id);
  return { email: r.email, workspaceName: w?.name ?? '', roleName: (await findRole(deps, r.workspace_id, r.role_id))?.name ?? '', expiresAt: r.expires_at };
}

export async function acceptInvitation(deps: Deps, input: z.infer<typeof AcceptInput>, meta: SessionMeta = {}) {
  const r = await byToken(deps, input.token);
  const role = await findRole(deps, r.workspace_id, r.role_id);
  if (!role) throw notFound('Invitation'); // the role was deleted after the invitation was made
  const userId = newId('usr');
  const hash = await hashPassword(input.password);
  const at = deps.now().toISOString();
  await inTx(deps, async (d) => {
    // Claim first: of two concurrent accepts exactly one gets changes = 1.
    if ((await d.db.run('UPDATE invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL', at, r.id)).changes !== 1) throw notFound('Invitation');
    if ((await d.db.get('SELECT 1 FROM users WHERE email = ?', r.email)) !== undefined) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    await d.db.run('INSERT INTO users (id, workspace_id, email, name, password_hash, role, role_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', userId, r.workspace_id, r.email, input.name, hash, legacyRole(role.id), role.id, at);
  });
  const u = (await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId))!;
  await audit(deps, { workspaceId: r.workspace_id, actorId: userId, action: 'invitation.accepted', target: r.id, ip: meta.ip, detail: { roleId: role.id } });
  const tokens = await startSession(deps, u, meta);
  return { token: tokens.token, refreshToken: tokens.refreshToken, expiresIn: tokens.expiresIn, ...(await me(deps, { userId, workspaceId: r.workspace_id, sessionId: tokens.sessionId, email: u.email, name: u.name, role: u.role, roleId: role.id, roleName: role.name, permissions: new Set(role.permissions) })) };
}
