import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import { verifyPassword } from '../auth/password.js';
import { decryptSecret, encryptSecret } from '../auth/secrets.js';
import { revokeAllSessions, type SessionMeta } from '../auth/sessions.js';
import { verifyChallengeToken } from '../auth/tokens.js';
import { newSecret, otpauthUri, verifyTotp } from '../auth/totp.js';
import type { Deps } from '../deps.js';
import { badRequest, conflict, notFound, unauthorized } from '../errors.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';
import { assertNotLockedOut, completeLogin, recordFailure, type UserRow } from './accounts.js';
import { assertCanGrant, findRole } from './roles.js';

export const CodeInput = z.object({ code: z.string().trim().min(6).max(30) });
export const VerifyLoginInput = z.object({ challengeToken: z.string().min(20).max(2000), code: z.string().trim().min(6).max(30) });
export const ConfirmInput = z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(30) });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const RECOVERY_COUNT = 10;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no lookalikes (i l o 0 1)

/** 16 characters from a 31-letter alphabet: about 79 bits, so a fast hash is enough to store them. */
function newRecoveryCode(): string {
  const bytes = randomBytes(16);
  const raw = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`;
}
const normalizeRecovery = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, '');

async function issueRecoveryCodes(deps: Deps, userId: string): Promise<string[]> {
  await deps.db.run('DELETE FROM recovery_codes WHERE user_id = ?', userId);
  const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
  for (const c of codes) await deps.db.run('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)', newId('rcv'), userId, sha(normalizeRecovery(c)));
  return codes;
}

interface TotpRow {
  user_id: string;
  secret_enc: string;
  confirmed_at: string | null;
  last_step: number;
}

const totpOf = (deps: Deps, userId: string) => deps.db.get<TotpRow>('SELECT * FROM user_totp WHERE user_id = ?', userId);

/** Starts enrolment: a fresh secret (stored encrypted, not active yet) and the otpauth:// URI an authenticator app scans or the secret to type in. */
export async function setup(deps: Deps, auth: Auth) {
  const existing = await totpOf(deps, auth.userId);
  if (existing?.confirmed_at) throw conflict('TWO_FACTOR_ENABLED', 'Two-factor authentication is already on; turn it off first to enrol a new device');
  const secret = newSecret();
  await deps.db.run('DELETE FROM user_totp WHERE user_id = ?', auth.userId);
  await deps.db.run('INSERT INTO user_totp (user_id, secret_enc, created_at) VALUES (?, ?, ?)', auth.userId, encryptSecret(deps.config, secret), deps.now().toISOString());
  return { secret, otpauthUri: otpauthUri(deps.config.TOTP_ISSUER, auth.email, secret) };
}

/** Checks a code against the stored secret and, when valid, records its step so the same code cannot be used again. */
async function checkCode(deps: Deps, row: TotpRow, code: string): Promise<boolean> {
  const step = verifyTotp(decryptSecret(deps.config, row.secret_enc), code, deps.now().getTime());
  if (step === null || step <= row.last_step) return false;
  return (await deps.db.run('UPDATE user_totp SET last_step = ? WHERE user_id = ? AND last_step < ?', step, row.user_id, step)).changes === 1;
}

/** Confirms enrolment with the first code and returns the one-time recovery codes (shown once). */
export async function enable(deps: Deps, auth: Auth, code: string, ip?: string) {
  const row = await totpOf(deps, auth.userId);
  if (!row) throw badRequest('NO_TWO_FACTOR_SETUP', 'Start setup first');
  if (row.confirmed_at) throw conflict('TWO_FACTOR_ENABLED', 'Two-factor authentication is already on');
  if (!(await checkCode(deps, row, code))) throw badRequest('INVALID_CODE', 'That code is not correct; check the time on your device and try again');
  await deps.db.run('UPDATE user_totp SET confirmed_at = ? WHERE user_id = ?', deps.now().toISOString(), auth.userId);
  const recoveryCodes = await issueRecoveryCodes(deps, auth.userId);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: '2fa.enabled', ip });
  return { recoveryCodes };
}

/** Proof of password plus a current TOTP or an unused recovery code, for the sensitive actions (turning 2FA off, new recovery codes). */
async function reauthenticate(deps: Deps, auth: Auth, input: z.infer<typeof ConfirmInput>, ip: string): Promise<void> {
  await assertNotLockedOut(deps, auth.email, ip);
  const u = (await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', auth.userId))!;
  const row = await totpOf(deps, auth.userId);
  if (!row?.confirmed_at) throw badRequest('NO_TWO_FACTOR', 'Two-factor authentication is not on');
  const okPassword = await verifyPassword(input.password, u.password_hash);
  const okSecond = okPassword && ((await checkCode(deps, row, input.code)) || (await useRecoveryCode(deps, auth.userId, input.code)));
  if (!okSecond) {
    await recordFailure(deps, u, auth.email, ip);
    throw badRequest('INVALID_CREDENTIALS', 'The password or the code is not correct');
  }
}

export async function disable(deps: Deps, auth: Auth, input: z.infer<typeof ConfirmInput>, ip: string) {
  await reauthenticate(deps, auth, input, ip);
  await deps.db.run('DELETE FROM user_totp WHERE user_id = ?', auth.userId);
  await deps.db.run('DELETE FROM recovery_codes WHERE user_id = ?', auth.userId);
  await revokeAllSessions(deps, auth.userId, '2fa_disabled', auth.sessionId);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: '2fa.disabled', ip });
  return { ok: true };
}

export async function regenerateRecoveryCodes(deps: Deps, auth: Auth, input: z.infer<typeof ConfirmInput>, ip: string) {
  await reauthenticate(deps, auth, input, ip);
  const recoveryCodes = await issueRecoveryCodes(deps, auth.userId);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: '2fa.recovery_codes_regenerated', ip });
  return { recoveryCodes };
}

async function useRecoveryCode(deps: Deps, userId: string, code: string): Promise<boolean> {
  const hash = sha(normalizeRecovery(code));
  const rows = await deps.db.all<{ id: string; code_hash: string }>('SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', userId);
  const hit = rows.find((r) => timingSafeEqual(Buffer.from(r.code_hash), Buffer.from(hash)));
  if (!hit) return false;
  return (await deps.db.run('UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', deps.now().toISOString(), hit.id)).changes === 1;
}

/**
 * Second step of a sign-in: the challenge from the password step plus a TOTP code or a recovery code. Wrong codes count against the same lockout budget as wrong
 * passwords (per account and per address), a TOTP code works once, a recovery code works once.
 */
export async function verifyLogin(deps: Deps, input: z.infer<typeof VerifyLoginInput>, meta: SessionMeta & { ip: string }) {
  const userId = await verifyChallengeToken(deps.config, input.challengeToken, deps.now());
  if (!userId) throw unauthorized('The sign-in attempt expired, start again');
  const u = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  const row = u ? await totpOf(deps, userId) : undefined;
  if (!u || !row?.confirmed_at) throw unauthorized('The sign-in attempt is no longer valid, start again');
  await assertNotLockedOut(deps, u.email, meta.ip);
  const viaTotp = /^\d{6}$/.test(input.code) && (await checkCode(deps, row, input.code));
  const viaRecovery = !viaTotp && (await useRecoveryCode(deps, userId, input.code));
  if (!viaTotp && !viaRecovery) {
    await recordFailure(deps, u, u.email, meta.ip);
    throw unauthorized('That code is not correct');
  }
  await audit(deps, { workspaceId: u.workspace_id, actorId: userId, action: viaRecovery ? '2fa.recovery_code_used' : 'auth.login', ip: meta.ip, detail: { twoFactor: viaRecovery ? 'recovery' : 'totp' } });
  return completeLogin(deps, userId, meta);
}

/**
 * Account recovery by an administrator: removes a member's second factor and ends their sessions so they can sign in with their password and enrol again.
 * Needs `members:manage`, and the actor must hold everything the target's role holds (an admin cannot reset an owner).
 */
export async function adminReset(deps: Deps, auth: Auth, userId: string, ip?: string) {
  const u = await deps.db.get<UserRow>('SELECT * FROM users WHERE workspace_id = ? AND id = ?', auth.workspaceId, userId);
  if (!u) throw notFound('Member');
  assertCanGrant(auth, (await findRole(deps, auth.workspaceId, u.role_id ?? u.role))?.permissions ?? []);
  await deps.db.run('DELETE FROM user_totp WHERE user_id = ?', userId);
  await deps.db.run('DELETE FROM recovery_codes WHERE user_id = ?', userId);
  await revokeAllSessions(deps, userId, '2fa_reset_by_admin');
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: '2fa.reset_by_admin', target: userId, ip });
  return { ok: true };
}

