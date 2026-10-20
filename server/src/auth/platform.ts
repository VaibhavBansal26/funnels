import type { Deps } from '../deps.js';
import { AppError, forbidden } from '../errors.js';
import { audit } from '../services/audit.js';
import type { Auth } from './context.js';

/**
 * Platform administrators (docs/ADMIN.md). The source of truth is the `platform_admins` table. `PLATFORM_ADMIN_EMAILS` bootstraps the first ones: a listed user
 * who signs in and calls an admin route gets a row (source 'bootstrap'); removing the email from the list revokes that row on the next request. Administrators added
 * through the admin API have source 'admin' and do not depend on the list.
 */
export async function isPlatformAdmin(deps: Deps, who: { userId: string; email: string }): Promise<boolean> {
  const listed = deps.config.PLATFORM_ADMIN_EMAILS.some((e) => e.toLowerCase() === who.email.toLowerCase());
  const row = await deps.db.get<{ source: 'bootstrap' | 'admin' }>('SELECT source FROM platform_admins WHERE user_id = ?', who.userId);
  if (row) return row.source === 'admin' || listed;
  if (!listed) return false;
  await deps.db.run(`INSERT INTO platform_admins (user_id, source, added_by, created_at) VALUES (?, 'bootstrap', NULL, ?)${deps.db.dialect.onConflictDoNothing()}`, who.userId, deps.now().toISOString());
  await audit(deps, { workspaceId: null, actorId: who.userId, action: 'admin.bootstrap', detail: { email: who.email } });
  return true;
}

/**
 * Every `auth: 'platform'` route passes through here (called by authenticate()): the caller must be a platform administrator, must not be inside an impersonation
 * session, and, when ADMIN_REQUIRE_2FA is on (always in production), must have confirmed two-factor authentication. Sign-in already demands the second factor for
 * accounts that have it, so "enabled" means "this session passed it".
 */
export async function assertPlatformAccess(deps: Deps, auth: Auth): Promise<void> {
  if (auth.impersonatorId) throw new AppError(403, 'IMPERSONATION_FORBIDDEN', 'Admin functions are not available while acting as another user');
  if (!(await isPlatformAdmin(deps, auth))) throw forbidden('Only platform administrators can do this');
  if (deps.config.ADMIN_REQUIRE_2FA && (await deps.db.get('SELECT 1 FROM user_totp WHERE user_id = ? AND confirmed_at IS NOT NULL', auth.userId)) === undefined) {
    throw new AppError(403, 'ADMIN_2FA_REQUIRED', 'Enable two-factor authentication on your account to use the admin area');
  }
}
