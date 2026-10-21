import { z } from 'zod';
import { isPlatformAdmin, platformRoleOf } from '../auth/platform.js';
import type { Auth } from '../auth/context.js';
import { startImpersonation as openImpersonation, type SessionMeta } from '../auth/sessions.js';
import { PLAN_DEFS } from '../billing/plans.js';
import { usageOf } from '../billing/limits.js';
import type { Deps } from '../deps.js';
import { workspaceTag } from '../monitoring/index.js';
import { inTx } from '../db/scope.js';
import { liveUrlsForFunnel, schedulePurge } from '../edge/purger.js';
import { onWorkspaceChanged } from './publishing.js';
import { AppError, conflict, notFound } from '../errors.js';
import { audit } from './audit.js';
import { forgetSuspensions } from './suspension.js';

/** Platform administration of workspaces (docs/ADMIN.md). Every function here is reached only through `auth: 'platform'` routes (see auth/platform.ts). */

const reason = z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500);

export const SuspendInput = z.object({ reason });
export const WRITE_REASON_MIN = 20;
export const ImpersonateInput = z.object({
  reason,
  userId: z.string().min(1).max(64).optional(),
  /** Off by default: a support session is read-only. Turning it on needs the `superadmin` platform role and a reason of at least 20 characters. */
  allow_writes: z.boolean().default(false),
});
export const DeleteWorkspaceInput = z.object({ confirmName: z.string().min(1).max(200), reason });
export const AdminAddInput = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(['support', 'superadmin']).default('support') });
export const WorkspaceQuery = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['all', 'active', 'suspended']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(120).optional(),
});
export const PlatformAuditQuery = z.object({
  workspace: z.string().max(64).optional(),
  actor: z.string().max(64).optional(),
  action: z.string().max(80).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(120).optional(),
});

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const num = (v: unknown) => Number(v ?? 0);

// ---- platform administrators --------------------------------------------------------------------------------------------------------------------------

export async function listAdmins(deps: Deps) {
  const rows = await deps.db.all<{ user_id: string; email: string; name: string; source: string; role: string; added_by: string | null; created_at: string; totp: number }>(
    `SELECT p.user_id, u.email, u.name, p.source, p.role, p.added_by, p.created_at, (SELECT COUNT(*) FROM user_totp t WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL) AS totp
     FROM platform_admins p JOIN users u ON u.id = p.user_id ORDER BY p.created_at, p.user_id`,
  );
  return { data: rows.map((r) => ({ userId: r.user_id, email: r.email, name: r.name, source: r.source, role: r.role, addedBy: r.added_by, createdAt: r.created_at, twoFactorEnabled: num(r.totp) > 0 })), requireTwoFactor: deps.config.ADMIN_REQUIRE_2FA };
}

export async function addAdmin(deps: Deps, auth: Auth, input: z.infer<typeof AdminAddInput>, ip?: string) {
  if (input.role === 'superadmin' && (await platformRoleOf(deps, auth.userId)) !== 'superadmin') throw new AppError(403, 'SUPERADMIN_REQUIRED', 'Only a superadmin can make someone a superadmin');
  const u = await deps.db.get<{ id: string; email: string }>('SELECT id, email FROM users WHERE email = ?', input.email);
  if (!u) throw notFound('User');
  if (await deps.db.get('SELECT 1 FROM platform_admins WHERE user_id = ?', u.id)) throw conflict('ALREADY_ADMIN', 'That user is already a platform administrator');
  await deps.db.run('INSERT INTO platform_admins (user_id, source, role, added_by, created_at) VALUES (?, ?, ?, ?, ?)', u.id, 'admin', input.role, auth.userId, deps.now().toISOString());
  await audit(deps, { workspaceId: null, actorId: auth.userId, action: 'admin.admin_added', target: u.id, detail: { email: u.email, role: input.role }, ip });
  return { userId: u.id, email: u.email, role: input.role };
}

export async function removeAdmin(deps: Deps, auth: Auth, userId: string, ip?: string): Promise<void> {
  const row = await deps.db.get<{ source: string }>('SELECT source FROM platform_admins WHERE user_id = ?', userId);
  if (!row) throw notFound('Administrator');
  if (row.source === 'bootstrap') throw conflict('BOOTSTRAP_ADMIN', 'This administrator comes from PLATFORM_ADMIN_EMAILS: remove the address from the configuration');
  if (userId === auth.userId) throw conflict('CANNOT_REMOVE_SELF', 'Ask another administrator to remove you');
  await deps.db.run('DELETE FROM platform_admins WHERE user_id = ?', userId);
  await audit(deps, { workspaceId: null, actorId: auth.userId, action: 'admin.admin_removed', target: userId, ip });
}

// ---- overview and workspaces --------------------------------------------------------------------------------------------------------------------------

export async function stats(deps: Deps) {
  const n = async (sql: string, ...p: (string | number)[]) => num((await deps.db.get<{ n: number }>(sql, ...p))!.n);
  return {
    workspaces: await n('SELECT COUNT(*) AS n FROM workspaces'),
    suspended: await n('SELECT COUNT(*) AS n FROM workspaces WHERE suspended_at IS NOT NULL'),
    users: await n('SELECT COUNT(*) AS n FROM users'),
    funnels: await n('SELECT COUNT(*) AS n FROM funnels WHERE deleted_at IS NULL'),
    liveFunnels: await n("SELECT COUNT(*) AS n FROM funnels WHERE deleted_at IS NULL AND status = 'live'"),
    paidWorkspaces: await n("SELECT COUNT(*) AS n FROM workspaces WHERE plan <> 'free'"),
    deadJobs: await n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'dead'"),
    admins: await n('SELECT COUNT(*) AS n FROM platform_admins'),
  };
}

interface WsListRow { id: string; name: string; created_at: string; plan: string; plan_status: string; suspended_at: string | null; suspended_reason: string | null; owner_email: string | null; members: number; funnels: number }

export async function listWorkspaces(deps: Deps, q: z.infer<typeof WorkspaceQuery>) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.status === 'suspended') where.push('w.suspended_at IS NOT NULL');
  if (q.status === 'active') where.push('w.suspended_at IS NULL');
  if (q.search) {
    const like = `%${escapeLike(q.search.toLowerCase())}%`;
    where.push("(lower(w.name) LIKE ? ESCAPE '\\' OR w.id = ? OR EXISTS (SELECT 1 FROM users su WHERE su.workspace_id = w.id AND lower(su.email) LIKE ? ESCAPE '\\'))");
    params.push(like, q.search, like);
  }
  if (q.cursor) {
    const [at, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (at && id) (where.push('(w.created_at < ? OR (w.created_at = ? AND w.id < ?))'), params.push(at, at, id));
  }
  const rows = await deps.db.all<WsListRow>(
    `SELECT w.id, w.name, w.created_at, w.plan, w.plan_status, w.suspended_at, w.suspended_reason,
            (SELECT u.email FROM users u WHERE u.workspace_id = w.id AND u.role = 'owner' ORDER BY u.created_at, u.id LIMIT 1) AS owner_email,
            (SELECT COUNT(*) FROM users u WHERE u.workspace_id = w.id) AS members,
            (SELECT COUNT(*) FROM funnels f WHERE f.workspace_id = w.id AND f.deleted_at IS NULL) AS funnels
     FROM workspaces w ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY w.created_at DESC, w.id DESC LIMIT ?`,
    ...params, q.limit + 1,
  );
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, plan: r.plan, planStatus: r.plan_status, suspended: !!r.suspended_at, suspendedReason: r.suspended_reason, ownerEmail: r.owner_email, members: num(r.members), funnels: num(r.funnels) })),
    nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.created_at}|${last.id}`).toString('base64url') : null,
  };
}

async function workspaceRow(deps: Deps, id: string) {
  const w = await deps.db.get<{ id: string; name: string; created_at: string; plan: keyof typeof PLAN_DEFS; plan_status: string; suspended_at: string | null; suspended_reason: string | null; suspended_by: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null }>('SELECT id, name, created_at, plan, plan_status, suspended_at, suspended_reason, suspended_by, stripe_customer_id, stripe_subscription_id FROM workspaces WHERE id = ?', id);
  if (!w) throw notFound('Workspace');
  return w;
}

export async function getWorkspace(deps: Deps, id: string) {
  const w = await workspaceRow(deps, id);
  const members = await deps.db.all<{ id: string; email: string; name: string; role_id: string | null; role: string; last_login_at: string | null; totp: number }>(
    `SELECT u.id, u.email, u.name, u.role_id, u.role, u.last_login_at, (SELECT COUNT(*) FROM user_totp t WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL) AS totp FROM users u WHERE u.workspace_id = ? ORDER BY u.created_at, u.id LIMIT 200`, id,
  );
  const recent = await deps.db.all<{ id: string; actor_id: string; action: string; target: string | null; detail_json: string; created_at: string }>('SELECT id, actor_id, action, target, detail_json, created_at FROM audit_log WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 20', id);
  const flags = await deps.db.all<{ flag_key: string; enabled: number }>('SELECT flag_key, enabled FROM feature_flag_overrides WHERE workspace_id = ? ORDER BY flag_key', id);
  return {
    id: w.id, name: w.name, monitoringId: workspaceTag(w.id), createdAt: w.created_at, plan: w.plan, planName: PLAN_DEFS[w.plan].name, planStatus: w.plan_status,
    suspended: !!w.suspended_at, suspendedAt: w.suspended_at, suspendedReason: w.suspended_reason, suspendedBy: w.suspended_by,
    hasStripeCustomer: !!w.stripe_customer_id, hasSubscription: !!w.stripe_subscription_id,
    usage: await usageOf(deps, id), limits: Object.fromEntries((['funnels', 'domains', 'members', 'apiKeys'] as const).map((k) => [k, PLAN_DEFS[w.plan][k]])),
    members: members.map((m) => ({ id: m.id, email: m.email, name: m.name, roleId: m.role_id ?? m.role, lastLoginAt: m.last_login_at, twoFactorEnabled: num(m.totp) > 0 })),
    overrides: flags.map((f) => ({ flag: f.flag_key, enabled: f.enabled === 1 })),
    recentAudit: recent.map((r) => ({ id: r.id, actorId: r.actor_id, action: r.action, target: r.target, detail: JSON.parse(r.detail_json) as Record<string, unknown>, createdAt: r.created_at })),
  };
}

// ---- suspension ---------------------------------------------------------------------------------------------------------------------------------------

/**
 * Suspends a workspace: members are signed out and refused (403 WORKSPACE_SUSPENDED), its domains stop serving, its public forms, checkouts, events and API keys
 * are refused, and the edge cache is purged for every live page so the Cloudflare edge stops serving them too. Nothing is deleted; `unsuspend` undoes it.
 * Payments already in flight still finalize (a customer who paid must get an order), and webhooks already queued are still delivered.
 */
export async function suspendWorkspace(deps: Deps, auth: Auth, id: string, input: z.infer<typeof SuspendInput>, ip?: string) {
  if (id === auth.workspaceId) throw conflict('CANNOT_SUSPEND_OWN', 'You cannot suspend your own workspace');
  const w = await workspaceRow(deps, id);
  if (w.suspended_at) throw conflict('ALREADY_SUSPENDED', 'This workspace is already suspended');
  const at = deps.now().toISOString();
  const urls: string[] = [];
  await inTx(deps, async (d) => {
    await d.db.run('UPDATE workspaces SET suspended_at = ?, suspended_reason = ?, suspended_by = ? WHERE id = ?', at, input.reason, auth.userId, id);
    const { changes } = await d.db.run('UPDATE sessions SET revoked_at = ? WHERE workspace_id = ? AND revoked_at IS NULL', at, id);
    const live = await d.db.all<{ id: string }>("SELECT id FROM funnels WHERE workspace_id = ? AND status = 'live' AND deleted_at IS NULL", id);
    for (const f of live) urls.push(...(await liveUrlsForFunnel(d, f.id)));
    await schedulePurge(d, urls);
    const steps = await d.db.all<{ id: string }>('SELECT id FROM steps WHERE workspace_id = ?', id);
    d.pageCache.invalidate(steps.map((s) => s.id));
    await onWorkspaceChanged(d, id); // funnels published to Cloudflare Pages are replaced by the paused page
    await audit(d, { workspaceId: id, actorId: auth.userId, action: 'admin.workspace.suspended', detail: { reason: input.reason, sessionsEnded: changes, purgedUrls: urls.length }, ip });
  });
  deps.eventRefs.clear();
  forgetSuspensions();
  return { id, suspended: true, purgedUrls: urls.length };
}

export async function unsuspendWorkspace(deps: Deps, auth: Auth, id: string, ip?: string) {
  const w = await workspaceRow(deps, id);
  if (!w.suspended_at) throw conflict('NOT_SUSPENDED', 'This workspace is not suspended');
  await inTx(deps, async (d) => {
    await d.db.run('UPDATE workspaces SET suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL WHERE id = ?', id);
    await onWorkspaceChanged(d, id);
    await audit(d, { workspaceId: id, actorId: auth.userId, action: 'admin.workspace.unsuspended', ip });
  });
  forgetSuspensions();
  return { id, suspended: false };
}

// ---- impersonation ------------------------------------------------------------------------------------------------------------------------------------

/**
 * Support access: a time-limited session as one of the workspace's users (default: its owner) with a reason on record. It is READ-ONLY by default: every request
 * other than GET and HEAD is refused with 403 IMPERSONATION_READ_ONLY (except ending the session). `allow_writes` lifts that for one session and needs the `superadmin`
 * platform role, a reason of at least 20 characters, and gets the shorter IMPERSONATION_WRITE_TTL_MINUTES lifetime. The user's workspace sees the start (and whether
 * writes were enabled) in its own audit log, every write made in a write-enabled session is audited with the administrator's id, the session cannot be refreshed, and
 * it can neither change credentials, billing, members or API keys nor use the admin area (see IMPERSONATION_DENIED in auth/context.ts). Administrators cannot be impersonated.
 */
export async function impersonate(deps: Deps, auth: Auth, wsId: string, input: z.infer<typeof ImpersonateInput>, meta: SessionMeta) {
  if (input.allow_writes) {
    if ((await platformRoleOf(deps, auth.userId)) !== 'superadmin') throw new AppError(403, 'SUPERADMIN_REQUIRED', 'Only a superadmin can open a support session that may change data');
    if (input.reason.length < WRITE_REASON_MIN) throw new AppError(400, 'WRITE_REASON_REQUIRED', `A write-enabled support session needs a written reason of at least ${WRITE_REASON_MIN} characters`);
  }
  const w = await workspaceRow(deps, wsId);
  if (w.suspended_at) throw conflict('WORKSPACE_SUSPENDED', 'Unsuspend the workspace first: a suspended workspace cannot be acted in');
  const target = input.userId
    ? await deps.db.get<{ id: string; workspace_id: string; email: string; name: string }>('SELECT id, workspace_id, email, name FROM users WHERE id = ? AND workspace_id = ?', input.userId, wsId)
    : await deps.db.get<{ id: string; workspace_id: string; email: string; name: string }>("SELECT id, workspace_id, email, name FROM users WHERE workspace_id = ? AND role = 'owner' ORDER BY created_at, id LIMIT 1", wsId);
  if (!target) throw notFound('User');
  if (await isPlatformAdmin(deps, { userId: target.id, email: target.email })) throw new AppError(403, 'CANNOT_IMPERSONATE_ADMIN', 'Platform administrators cannot be impersonated');
  const ttlMinutes = input.allow_writes ? Math.min(deps.config.IMPERSONATION_WRITE_TTL_MINUTES, deps.config.IMPERSONATION_TTL_MINUTES) : deps.config.IMPERSONATION_TTL_MINUTES;
  const s = await openImpersonation(deps, target, auth.userId, meta, { allowWrites: input.allow_writes, ttlMinutes });
  await audit(deps, { workspaceId: wsId, actorId: auth.userId, action: 'admin.impersonation.started', target: target.id, detail: { reason: input.reason, as: target.email, expiresAt: s.expiresAt, sessionId: s.sessionId, mode: input.allow_writes ? 'read_write' : 'read_only' }, ip: meta.ip });
  return { token: s.token, expiresAt: s.expiresAt, allowWrites: input.allow_writes, user: { id: target.id, email: target.email, name: target.name }, workspace: { id: w.id, name: w.name } };
}

// ---- deletion -----------------------------------------------------------------------------------------------------------------------------------------

/**
 * Permanently deletes a workspace and everything in it (funnels, steps, pages, leads, orders, events, members, keys...: foreign keys cascade). Guard rails: it must
 * be suspended first, the caller must type its name, nobody in it may be a platform administrator, and an active Funnels subscription must be cancelled first.
 * The audit trail of the workspace is kept (rows without a workspace to point to), including who deleted it and why. Stripe data is not touched.
 */
export async function deleteWorkspace(deps: Deps, auth: Auth, id: string, input: z.infer<typeof DeleteWorkspaceInput>, ip?: string) {
  if (id === auth.workspaceId) throw conflict('CANNOT_DELETE_OWN', 'You cannot delete your own workspace');
  const w = await workspaceRow(deps, id);
  if (!w.suspended_at) throw conflict('NOT_SUSPENDED', 'Suspend the workspace first; deletion is a second, deliberate step');
  if (input.confirmName !== w.name) throw conflict('CONFIRMATION_MISMATCH', 'The confirmation does not match the workspace name');
  if (w.stripe_subscription_id) throw conflict('HAS_SUBSCRIPTION', 'Cancel the workspace subscription first');
  const users = await deps.db.all<{ id: string; email: string }>('SELECT id, email FROM users WHERE workspace_id = ?', id);
  for (const u of users) if (await isPlatformAdmin(deps, { userId: u.id, email: u.email })) throw conflict('CONTAINS_ADMIN', 'A platform administrator belongs to this workspace');
  const domains = await deps.db.all<{ id: string; provider: string | null; provider_ref: string | null }>('SELECT id, provider, provider_ref FROM domains WHERE workspace_id = ?', id);
  for (const d of domains) if (d.provider === 'cloudflare' && d.provider_ref) await deps.domainProvider.remove(d.provider_ref).catch((e) => deps.log.warn('provider delete failed', { error: (e as Error).message }));
  const steps = await deps.db.all<{ id: string }>('SELECT id FROM steps WHERE workspace_id = ?', id);
  await inTx(deps, async (d) => {
    await d.db.run('UPDATE domains SET default_home_step_id = NULL, default_404_step_id = NULL WHERE workspace_id = ?', id);
    await d.db.run('DELETE FROM funnels WHERE workspace_id = ?', id);
    await d.db.run('DELETE FROM workspaces WHERE id = ?', id);
    d.pageCache.invalidate(steps.map((s) => s.id));
    await audit(d, { workspaceId: id, actorId: auth.userId, action: 'admin.workspace.deleted', detail: { name: w.name, reason: input.reason, members: users.length, domains: domains.length }, ip });
  });
  deps.eventRefs.clear();
  forgetSuspensions();
}

// ---- platform audit -----------------------------------------------------------------------------------------------------------------------------------

export async function listPlatformAudit(deps: Deps, q: z.infer<typeof PlatformAuditQuery>) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.workspace) (where.push('workspace_id = ?'), params.push(q.workspace));
  if (q.actor) (where.push('actor_id = ?'), params.push(q.actor));
  if (q.action) (where.push(q.action.endsWith('*') ? "action LIKE ? ESCAPE '\\'" : 'action = ?'), params.push(q.action.endsWith('*') ? `${escapeLike(q.action.slice(0, -1))}%` : q.action));
  if (q.from) (where.push('created_at >= ?'), params.push(q.from));
  if (q.to) (where.push('created_at < ?'), params.push(q.to));
  if (q.cursor) {
    const [at, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (at && id) (where.push('(created_at < ? OR (created_at = ? AND id < ?))'), params.push(at, at, id));
  }
  const rows = await deps.db.all<{ id: string; workspace_id: string | null; actor_id: string; action: string; target: string | null; detail_json: string; ip: string | null; created_at: string }>(
    `SELECT id, workspace_id, actor_id, action, target, detail_json, ip, created_at FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, q.limit + 1,
  );
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((r) => ({ id: r.id, workspaceId: r.workspace_id, actorId: r.actor_id, action: r.action, target: r.target, detail: JSON.parse(r.detail_json) as Record<string, unknown>, ip: r.ip, createdAt: r.created_at })),
    nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.created_at}|${last.id}`).toString('base64url') : null,
  };
}
