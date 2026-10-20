import { createHash, randomBytes } from 'node:crypto';
import type { Deps } from '../deps.js';
import { unauthorized } from '../errors.js';
import { newId } from '../util/ids.js';
import { audit } from '../services/audit.js';
import { signAccessToken } from './tokens.js';

/**
 * Sessions with rotating refresh tokens (docs/RBAC.md). A login creates a session; the access token (short, JWT) carries its id and the refresh token
 * (opaque, only its SHA-256 stored) renews it. Every refresh marks the presented token used and issues the next. Presenting a used token again means
 * two parties hold it, so the whole session is revoked, unless it happens within `REFRESH_REUSE_GRACE_SECONDS` of the first use, which is two tabs racing
 * (answered with 401 REFRESH_RACE; the client retries with the token the other tab stored).
 */
export interface Tokens {
  token: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();
const newRefreshToken = () => `rt_${randomBytes(32).toString('base64url')}`;

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

async function issue(deps: Deps, userId: string, sessionId: string, sessionExpiresAt: string): Promise<Tokens> {
  const now = deps.now();
  const refreshToken = newRefreshToken();
  const expires = Math.min(now.getTime() + deps.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000, Date.parse(sessionExpiresAt));
  await deps.db.run('INSERT INTO refresh_tokens (id, session_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', newId('rtk'), sessionId, sha(refreshToken), now.toISOString(), iso(expires));
  return { token: await signAccessToken(deps.config, userId, sessionId, now), refreshToken, expiresIn: deps.config.ACCESS_TOKEN_TTL_SECONDS, sessionId };
}

export async function startSession(deps: Deps, user: { id: string; workspace_id: string }, meta: SessionMeta = {}): Promise<Tokens> {
  const now = deps.now();
  const id = newId('ses');
  const expiresAt = iso(now.getTime() + deps.config.SESSION_MAX_DAYS * 86_400_000);
  await deps.db.run('INSERT INTO sessions (id, user_id, workspace_id, created_at, last_used_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, user.id, user.workspace_id, now.toISOString(), now.toISOString(), expiresAt, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null);
  await deps.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now.toISOString(), user.id);
  return issue(deps, user.id, id, expiresAt);
}

interface RefreshRow {
  rid: string;
  used_at: string | null;
  r_expires: string;
  session_id: string;
  user_id: string;
  workspace_id: string;
  s_expires: string;
  revoked_at: string | null;
}

export async function rotate(deps: Deps, refreshToken: string): Promise<Tokens> {
  const now = deps.now();
  const row = await deps.db.get<RefreshRow>(
    `SELECT r.id AS rid, r.used_at, r.expires_at AS r_expires, r.session_id, s.user_id, s.workspace_id, s.expires_at AS s_expires, s.revoked_at
     FROM refresh_tokens r JOIN sessions s ON s.id = r.session_id WHERE r.token_hash = ?`, sha(refreshToken),
  );
  if (!row || row.revoked_at || row.r_expires <= now.toISOString() || row.s_expires <= now.toISOString()) throw unauthorized('Invalid or expired refresh token');
  // Claim the token atomically: of two concurrent requests with the same token exactly one gets changes = 1.
  const claimed = (await deps.db.run('UPDATE refresh_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL', now.toISOString(), row.rid)).changes === 1;
  if (!claimed) {
    const first = row.used_at ?? (await deps.db.get<{ used_at: string }>('SELECT used_at FROM refresh_tokens WHERE id = ?', row.rid))?.used_at ?? now.toISOString();
    if (now.getTime() - Date.parse(first) <= deps.config.REFRESH_REUSE_GRACE_SECONDS * 1000) throw unauthorized('Refresh token was just used by another request', 'REFRESH_RACE');
    await revokeSession(deps, row.session_id, 'refresh_reuse');
    await audit(deps, { workspaceId: row.workspace_id, actorId: row.user_id, action: 'session.refresh_reuse_detected', target: row.session_id });
    throw unauthorized('Refresh token reuse detected: the session was revoked, sign in again');
  }
  await deps.db.run('UPDATE sessions SET last_used_at = ? WHERE id = ?', now.toISOString(), row.session_id);
  return issue(deps, row.user_id, row.session_id, row.s_expires);
}

export async function revokeSession(deps: Deps, sessionId: string, reason: string): Promise<void> {
  await deps.db.run('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL', deps.now().toISOString(), reason, sessionId);
  await deps.db.run('DELETE FROM refresh_tokens WHERE session_id = ?', sessionId);
}

/** Revokes every live session of a user (password change or reset, 2FA change, removal), optionally keeping the one making the request. */
export async function revokeAllSessions(deps: Deps, userId: string, reason: string, except?: string): Promise<number> {
  const live = await deps.db.all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL', userId);
  let n = 0;
  for (const s of live) if (s.id !== except) (await revokeSession(deps, s.id, reason), n++);
  return n;
}

export async function listSessions(deps: Deps, userId: string, currentSessionId: string) {
  const rows = await deps.db.all<{ id: string; created_at: string; last_used_at: string; expires_at: string; user_agent: string | null; ip: string | null }>(
    'SELECT id, created_at, last_used_at, expires_at, user_agent, ip FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at DESC, id', userId, deps.now().toISOString(),
  );
  return { data: rows.map((s) => ({ id: s.id, createdAt: s.created_at, lastUsedAt: s.last_used_at, expiresAt: s.expires_at, userAgent: s.user_agent, ip: s.ip, current: s.id === currentSessionId })) };
}

/**
 * Support access: a session for `user` opened by platform administrator `adminId`. It has no refresh token, the access token lives exactly as long as the
 * session (IMPERSONATION_TTL_MINUTES) and nothing can extend it; ending it (logout) revokes the session row. Permissions are reduced in auth/context.ts.
 */
export async function startImpersonation(deps: Deps, user: { id: string; workspace_id: string }, adminId: string, meta: SessionMeta = {}): Promise<{ token: string; sessionId: string; expiresAt: string }> {
  const now = deps.now();
  const id = newId('ses');
  const ttlMs = deps.config.IMPERSONATION_TTL_MINUTES * 60_000;
  const expiresAt = iso(now.getTime() + ttlMs);
  await deps.db.run('INSERT INTO sessions (id, user_id, workspace_id, created_at, last_used_at, expires_at, user_agent, ip, impersonator_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, user.id, user.workspace_id, now.toISOString(), now.toISOString(), expiresAt, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null, adminId);
  return { token: await signAccessToken(deps.config, user.id, id, now, Math.floor(ttlMs / 1000)), sessionId: id, expiresAt };
}
