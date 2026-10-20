import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hashPassword } from '../auth/password.js';
import { revokeAllSessions } from '../auth/sessions.js';
import type { Deps } from '../deps.js';
import { badRequest } from '../errors.js';
import { hashId } from '../ratelimit/subject.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';
import { password, type UserRow } from './accounts.js';

export const ForgotInput = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
export const ResetInput = z.object({ token: z.string().min(20).max(200), password });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Starts a password reset. The answer is the same whether or not the address has an account, and a per-address budget (`auth.reset.email`, hashed key)
 * silently stops mail bombing, also without revealing anything. The link works once and expires after PASSWORD_RESET_TTL_MINUTES.
 */
export async function requestPasswordReset(deps: Deps, input: z.infer<typeof ForgotInput>, ip: string): Promise<{ ok: true }> {
  const budget = await deps.limiter.check('auth.reset.email', { ip, scope: hashId(input.email) });
  const u = await deps.db.get<UserRow>('SELECT * FROM users WHERE email = ?', input.email);
  if (!u || !budget.allowed) return { ok: true };
  const token = randomBytes(32).toString('base64url');
  const now = deps.now();
  await deps.db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', u.id);
  await deps.db.run('INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', newId('prs'), u.id, sha(token), now.toISOString(), new Date(now.getTime() + deps.config.PASSWORD_RESET_TTL_MINUTES * 60_000).toISOString());
  await audit(deps, { workspaceId: u.workspace_id, actorId: u.id, action: 'auth.password_reset_requested', ip });
  try {
    const delivered = await deps.mailer.send({
      to: u.email, subject: 'Reset your Funnels password',
      text: `Someone asked to reset the password of this account. If it was you, use this link within ${deps.config.PASSWORD_RESET_TTL_MINUTES} minutes (it works once):\n${deps.config.APP_PUBLIC_URL.replace(/\/$/, '')}/reset-password?token=${token}\n\nIf it was not you, ignore this message: nothing changes.\n`,
    });
    if (!delivered) deps.log.warn('password reset requested but MAIL_TRANSPORT delivers nothing: configure a mail transport');
  } catch (e) {
    deps.log.warn('password reset mail failed', { error: (e as Error).message });
  }
  return { ok: true };
}

/** Sets the new password, ends every session of the account and invalidates other pending resets. Two-factor authentication still applies at the next sign-in. */
export async function resetPassword(deps: Deps, input: z.infer<typeof ResetInput>, ip: string): Promise<{ ok: true }> {
  const row = await deps.db.get<{ id: string; user_id: string; expires_at: string; used_at: string | null; workspace_id: string }>(
    'SELECT p.id, p.user_id, p.expires_at, p.used_at, u.workspace_id FROM password_resets p JOIN users u ON u.id = p.user_id WHERE p.token_hash = ?', sha(input.token),
  );
  const now = deps.now().toISOString();
  if (!row || row.used_at || row.expires_at <= now) throw badRequest('INVALID_RESET_TOKEN', 'This reset link is invalid or has expired');
  if ((await deps.db.run('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL', now, row.id)).changes !== 1) throw badRequest('INVALID_RESET_TOKEN', 'This reset link is invalid or has expired');
  await deps.db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(input.password), row.user_id);
  await deps.db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', row.user_id);
  const ended = await revokeAllSessions(deps, row.user_id, 'password_reset');
  await audit(deps, { workspaceId: row.workspace_id, actorId: row.user_id, action: 'auth.password_reset', ip, detail: { sessionsEnded: ended } });
  return { ok: true };
}
