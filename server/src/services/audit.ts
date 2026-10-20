import { z } from 'zod';
import type { Deps } from '../deps.js';
import { newId } from '../util/ids.js';

/**
 * The audit trail: who did what, to what, from where. Security-relevant actions write a row (sign-in problems, 2FA, passwords, sessions, roles, members,
 * invitations, API keys, settings, billing); the same rows are visible to `audit:read` holders (`GET /api/audit`). Never put secrets in `detail`.
 */
export interface AuditEvent {
  workspaceId: string | null;
  actorId: string;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(deps: Pick<Deps, 'db' | 'now'>, e: AuditEvent): Promise<void> {
  await deps.db.run('INSERT INTO audit_log (id, workspace_id, actor_id, action, detail_json, created_at, target, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', newId('aud'), e.workspaceId, e.actorId, e.action, JSON.stringify(e.detail ?? {}), deps.now().toISOString(), e.target ?? null, e.ip ?? null);
}

export const AuditQuery = z.object({
  action: z.string().max(80).optional(),
  actor: z.string().max(64).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(80).optional(),
});

/** Newest first, keyset-paginated by (created_at, id). Workspace-scoped: other workspaces' rows (and platform rows with no workspace) never appear. */
export async function listAudit(deps: Deps, ws: string, q: z.infer<typeof AuditQuery>) {
  const where = ['workspace_id = ?'];
  const params: (string | number)[] = [ws];
  if (q.action) (where.push('action = ?'), params.push(q.action));
  if (q.actor) (where.push('actor_id = ?'), params.push(q.actor));
  if (q.from) (where.push('created_at >= ?'), params.push(q.from));
  if (q.to) (where.push('created_at < ?'), params.push(q.to));
  if (q.cursor) {
    const [at, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (at && id) (where.push('(created_at < ? OR (created_at = ? AND id < ?))'), params.push(at, at, id));
  }
  const rows = await deps.db.all<{ id: string; actor_id: string; action: string; target: string | null; detail_json: string; ip: string | null; created_at: string }>(
    `SELECT id, actor_id, action, target, detail_json, ip, created_at FROM audit_log WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, q.limit + 1,
  );
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((r) => ({ id: r.id, actorId: r.actor_id, action: r.action, target: r.target, detail: JSON.parse(r.detail_json) as Record<string, unknown>, ip: r.ip, createdAt: r.created_at, ...supportMarker(r.action) })),
    nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.created_at}|${last.id}`).toString('base64url') : null,
  };
}

/** Rows written by platform staff acting in the workspace (support access) are labelled for the customer: `actorId` is the administrator, not one of their members. */
const supportMarker = (action: string): { supportAccess: boolean; label?: string } =>
  action.startsWith('admin.impersonation.') ? { supportAccess: true, label: ({ started: 'Support access started', action: 'Support access: change made', ended: 'Support access ended' } as Record<string, string>)[action.slice('admin.impersonation.'.length)] ?? 'Support access' } : { supportAccess: false };
