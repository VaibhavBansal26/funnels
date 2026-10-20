import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { inTx } from '../db/scope.js';
import { notFound } from '../errors.js';
import { audit } from './audit.js';

/**
 * Personal-data tooling for platform administrators (docs/ADMIN.md): export everything held about one email address (a data-subject request), erase it, and export
 * a whole workspace as NDJSON (portability on closure). Erasure keeps what the books need (an order and its amount) and removes who it was about.
 * Not covered: data held by Stripe or by customers' own webhook receivers, backups, and audit rows (which carry user ids and IPs of the workspace's members, not leads).
 */
export const SubjectInput = z.object({ email: z.string().trim().toLowerCase().email().max(254), workspaceId: z.string().max(64).optional() });

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const digest = (email: string) => createHash('sha256').update(email).digest('hex').slice(0, 12);
const LIMIT = 1000;

export async function exportSubject(deps: Deps, auth: Auth, input: z.infer<typeof SubjectInput>, ip?: string) {
  const ws = input.workspaceId ? ' AND workspace_id = ?' : '';
  const p = (...a: string[]) => (input.workspaceId ? [...a, input.workspaceId] : a);
  const leads = await deps.db.all<Record<string, unknown>>(`SELECT * FROM leads WHERE lower(email) = ?${ws} ORDER BY created_at, id LIMIT ${LIMIT}`, ...p(input.email));
  const orders = await deps.db.all<Record<string, unknown>>(`SELECT id, workspace_id, funnel_id, email, name, product_name, amount_cents, currency, is_bump, is_upsell, status, refunded_cents, provider, created_at FROM orders WHERE lower(email) = ?${ws} ORDER BY created_at, id LIMIT ${LIMIT}`, ...p(input.email));
  const checkouts = await deps.db.all<Record<string, unknown>>(`SELECT id, workspace_id, funnel_id, email, name, visitor_id, status, created_at FROM checkout_sessions WHERE lower(email) = ?${ws} ORDER BY created_at, id LIMIT ${LIMIT}`, ...p(input.email));
  const member = await deps.db.get<{ id: string; workspace_id: string }>('SELECT id, workspace_id FROM users WHERE lower(email) = ?', input.email);
  await audit(deps, { workspaceId: input.workspaceId ?? null, actorId: auth.userId, action: 'admin.gdpr.export', detail: { subject: digest(input.email), leads: leads.length, orders: orders.length }, ip });
  return { subject: input.email, generatedAt: deps.now().toISOString(), leads, orders, checkoutSessions: checkouts, member: member ? { userId: member.id, workspaceId: member.workspace_id } : null, truncatedAt: LIMIT };
}

/**
 * Erases the subject: leads deleted (events keep a null lead id), orders and checkout sessions anonymised in place (amounts, products, dates and Stripe references for
 * refunds stay), notifications that mention the address deleted, webhook payloads that mention it blanked. A workspace member's own account is not touched here
 * (`member` in the answer tells you): remove them from their workspace instead. The audit row holds a short digest of the address, never the address.
 */
export async function eraseSubject(deps: Deps, auth: Auth, input: z.infer<typeof SubjectInput>, ip?: string) {
  const email = input.email;
  const anon = `erased-${digest(email)}@erased.invalid`;
  const like = `%${escapeLike(email)}%`;
  const wsAnd = input.workspaceId ? ' AND workspace_id = ?' : '';
  const a = (...x: string[]) => (input.workspaceId ? [...x, input.workspaceId] : x);
  const counts = await inTx(deps, async (d) => {
    const leadIds = (await d.db.all<{ id: string }>(`SELECT id FROM leads WHERE lower(email) = ?${wsAnd}`, ...a(email))).map((r) => r.id);
    for (const id of leadIds) await d.db.run('UPDATE events SET lead_id = NULL WHERE lead_id = ?', id);
    for (const id of leadIds) await d.db.run('DELETE FROM leads WHERE id = ?', id);
    const orders = (await d.db.run(`UPDATE orders SET email = ?, name = NULL, payment_method_ref = NULL, provider_customer = NULL, lead_id = NULL WHERE lower(email) = ?${wsAnd}`, ...[anon, ...a(email)])).changes;
    const checkouts = (await d.db.run(`UPDATE checkout_sessions SET email = ?, name = NULL, visitor_id = NULL, utms_json = NULL WHERE lower(email) = ?${wsAnd}`, ...[anon, ...a(email)])).changes;
    const notifications = (await d.db.run(`DELETE FROM notifications WHERE (lower(body) LIKE ? ESCAPE '\\' OR lower(data_json) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\')${wsAnd}`, ...[like, like, like, ...(input.workspaceId ? [input.workspaceId] : [])])).changes;
    const deliveries = (await d.db.run(`UPDATE webhook_deliveries SET payload_json = '{"erased":true}', status = CASE WHEN status = 'queued' THEN 'dead' ELSE status END WHERE lower(payload_json) LIKE ? ESCAPE '\\'${wsAnd}`, ...[like, ...(input.workspaceId ? [input.workspaceId] : [])])).changes;
    return { leads: leadIds.length, orders, checkoutSessions: checkouts, notifications, webhookDeliveries: deliveries };
  });
  const member = await deps.db.get<{ id: string }>('SELECT id FROM users WHERE lower(email) = ?', email);
  await audit(deps, { workspaceId: input.workspaceId ?? null, actorId: auth.userId, action: 'admin.gdpr.erase', detail: { subject: digest(email), ...counts }, ip });
  return { erased: counts, member: member ? { userId: member.id, note: 'This address belongs to a workspace member; their account was not removed' } : null };
}

// ---- workspace export ---------------------------------------------------------------------------------------------------------------------------------

interface Table { name: string; sql: string; keyOf?: string }

const TABLES: Table[] = [
  { name: 'workspace', sql: 'SELECT id, name, allow_custom_scripts, created_at, plan, plan_status, plan_period_end, suspended_at, suspended_reason FROM workspaces WHERE id = ?' },
  { name: 'users', sql: 'SELECT id, email, name, role, role_id, created_at, last_login_at FROM users WHERE workspace_id = ?' },
  { name: 'roles', sql: 'SELECT id, name, description, permissions_json, created_at FROM roles WHERE workspace_id = ?' },
  { name: 'domains', sql: 'SELECT id, hostname, status, verified_at, created_at FROM domains WHERE workspace_id = ?' },
  { name: 'funnels', sql: 'SELECT id, name, base_path, domain_id, status, created_by, created_at, updated_at, deleted_at FROM funnels WHERE workspace_id = ?' },
  { name: 'steps', sql: 'SELECT * FROM steps WHERE workspace_id = ?' },
  { name: 'step_pages', sql: 'SELECT p.step_id AS id, p.doc_json FROM step_pages p JOIN steps s ON s.id = p.step_id WHERE s.workspace_id = ?', keyOf: 'p.step_id' },
  { name: 'leads', sql: 'SELECT * FROM leads WHERE workspace_id = ?' },
  { name: 'orders', sql: 'SELECT id, funnel_id, email, name, product_name, amount_cents, currency, is_bump, is_upsell, status, refunded_cents, provider, provider_ref, created_at FROM orders WHERE workspace_id = ?' },
  { name: 'disputes', sql: 'SELECT id, order_id, stripe_dispute_id, amount_cents, currency, reason, status, outcome, evidence_due_by, lost_cents, created_at, closed_at FROM disputes WHERE workspace_id = ?' },
  { name: 'refunds', sql: 'SELECT id, order_id, amount_cents, currency, reason, created_by, created_at FROM refunds WHERE workspace_id = ?' },
  { name: 'webhooks', sql: 'SELECT id, url, events_json, active, created_at FROM webhooks WHERE workspace_id = ?' },
  { name: 'audit_log', sql: 'SELECT id, actor_id, action, target, detail_json, ip, created_at FROM audit_log WHERE workspace_id = ?' },
];

/** One JSON object per line, `{"table":..., "row":{...}}`, read in keyset pages of 1000 so memory stays flat however large the workspace is. Events are not included (use the analytics export). */
export function workspaceExportStream(deps: Deps, ws: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let t = 0;
  let after: string | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (t < TABLES.length) {
        const table = TABLES[t]!;
        const key = table.keyOf ?? 'id';
        const rows: Record<string, unknown>[] = await deps.db.all(`${table.sql}${after ? ` AND ${key} > ?` : ''} ORDER BY ${key} LIMIT ${LIMIT}`, ws, ...(after ? [after] : []));
        if (rows.length === 0) {
          t++;
          after = null;
          continue;
        }
        after = rows.length === LIMIT ? String(rows[rows.length - 1]!.id) : null;
        if (!after) t++;
        controller.enqueue(enc.encode(rows.map((row) => JSON.stringify({ table: table.name, row })).join('\n') + '\n'));
        return;
      }
      controller.close();
    },
  });
}

export async function exportWorkspace(deps: Deps, auth: Auth, ws: string, ip?: string): Promise<ReadableStream<Uint8Array>> {
  if (!(await deps.db.get('SELECT 1 FROM workspaces WHERE id = ?', ws))) throw notFound('Workspace');
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'admin.workspace.exported', ip });
  return workspaceExportStream(deps, ws);
}
