import { z } from 'zod';
import { currencyExponent, fromMinor } from '../util/money.js';
import type { Deps } from '../deps.js';
import { inTx } from '../db/scope.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';
import { notify } from './notifications.js';
import type { OrderRow } from './orders.js';
import { adjustRollup } from './rollups.js';
import { fireWebhookEvent } from './webhooks.js';

/**
 * Stripe disputes (chargebacks), docs/STRIPE.md. A dispute is recorded per Stripe dispute id and linked, through the PaymentIntent, to the orders of the disputed
 * payment (an offer and its bumps share one). What it does to an order is DERIVED, never stored as "previous state", so winning a dispute puts the order back
 * exactly where its refunds say it is:
 *
 *   charged_back  the order lost money to a lost dispute (`orders.disputed_lost_cents > 0`)
 *   disputed      a dispute on its payment is still open and the order has value left (amount - refunded - lost)
 *   otherwise     paid / partially_refunded / refunded from `refunded_cents`
 *
 * A lost dispute takes `min(dispute amount, what is left of each order after refunds)` from the orders in creation order, so refund + dispute can never take more
 * than the order's amount. That amount is subtracted from the sales rollups (analytics, funnel stats, the analytics API) and cannot be refunded any more.
 * Events can arrive in any order and more than once: a terminal outcome (won/lost) is never reopened by a late `created`/`updated`, a stale `updated` is ignored,
 * and a dispute whose payment we do not know is kept as an orphan and linked when the order appears (`reconcileDisputes`, called whenever Stripe orders are created).
 */

export const DISPUTE_EVENTS = ['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'] as const;

export interface DisputeRow {
  id: string;
  workspace_id: string | null;
  stripe_dispute_id: string;
  stripe_account: string | null;
  charge_id: string | null;
  payment_intent: string | null;
  order_id: string | null;
  amount_cents: number;
  currency: string;
  reason: string | null;
  status: string;
  outcome: 'open' | 'won' | 'lost';
  livemode: number;
  evidence_due_by: string | null;
  funds_withdrawn_at: string | null;
  funds_reinstated_at: string | null;
  lost_cents: number;
  loss_applied_at: string | null;
  last_event_at: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

type Evt = { id: string; type: string; account?: string; created?: number; livemode?: boolean; data: { object: Record<string, any> } };

const iso = (unixSeconds: unknown): string | null => (typeof unixSeconds === 'number' && Number.isFinite(unixSeconds) ? new Date(unixSeconds * 1000).toISOString() : null);

/** Stripe statuses: warning_needs_response, warning_under_review, warning_closed (an inquiry that never became a dispute), needs_response, under_review, won, lost. */
const outcomeOf = (status: string): DisputeRow['outcome'] => (status === 'lost' ? 'lost' : status === 'won' || status === 'warning_closed' ? 'won' : 'open');

export const refundStatus = (amount: number, refunded: number) => (refunded <= 0 ? 'paid' : refunded >= amount ? 'refunded' : 'partially_refunded');

/** The status an order should show, from its money columns and whether a dispute on its payment is open. */
export function orderStatus(o: { amount_cents: number; refunded_cents?: number; disputed_lost_cents?: number }, openDispute: boolean, refunded = o.refunded_cents ?? 0): string {
  const lost = o.disputed_lost_cents ?? 0;
  if (lost > 0) return 'charged_back';
  if (openDispute && o.amount_cents - refunded - lost > 0) return 'disputed';
  return refundStatus(o.amount_cents, refunded);
}

/** Whether a dispute on this Stripe payment is open (used when a refund recomputes an order's status). */
export async function hasOpenDispute(deps: Deps, order: Pick<OrderRow, 'provider' | 'provider_ref' | 'workspace_id'>): Promise<boolean> {
  if (order.provider !== 'stripe') return false;
  return !!(await deps.db.get("SELECT 1 FROM disputes WHERE payment_intent = ? AND workspace_id = ? AND outcome = 'open'", order.provider_ref, order.workspace_id));
}

/** Stripe's dashboard page of a dispute. Standard connected accounts look at their own dashboard; test and live data live under different paths. */
export const dashboardUrl = (d: Pick<DisputeRow, 'stripe_dispute_id' | 'livemode'>) => `https://dashboard.stripe.com/${d.livemode ? '' : 'test/'}disputes/${d.stripe_dispute_id}`;

const stripeOrders = (deps: Deps, paymentIntent: string) => deps.db.all<OrderRow & { disputed_lost_cents: number }>("SELECT * FROM orders WHERE provider = 'stripe' AND provider_ref = ? ORDER BY created_at, id", paymentIntent);

async function resolveWorkspace(deps: Deps, account: string | undefined): Promise<string | null> {
  if (!account) return null;
  return (await deps.db.get<{ workspace_id: string }>('SELECT workspace_id FROM stripe_accounts WHERE stripe_account_id = ?', account))?.workspace_id ?? null;
}

/** Orders a dispute applies to: those of its PaymentIntent, in the dispute's connected account when both are known. */
async function ordersOf(deps: Deps, d: Pick<DisputeRow, 'payment_intent' | 'stripe_account' | 'workspace_id'>) {
  if (!d.payment_intent) return [];
  return (await stripeOrders(deps, d.payment_intent)).filter((o) => (!d.stripe_account || !o.provider_account || o.provider_account === d.stripe_account) && (!d.workspace_id || o.workspace_id === d.workspace_id));
}

/** Recomputes the status of every order of the dispute's payment. */
async function refreshStatuses(deps: Deps, d: DisputeRow): Promise<void> {
  const open = !!(await deps.db.get("SELECT 1 FROM disputes WHERE payment_intent = ? AND workspace_id = ? AND outcome = 'open'", d.payment_intent, d.workspace_id));
  for (const o of await ordersOf(deps, d)) {
    const status = orderStatus(o, open);
    if (status !== (o.status ?? 'paid')) await deps.db.run('UPDATE orders SET status = ? WHERE id = ?', status, o.id);
  }
}

/** Takes the lost amount from the orders (once per dispute) and books it against the sales rollups. */
async function applyLoss(deps: Deps, d: DisputeRow): Promise<number> {
  if (d.outcome !== 'lost' || d.loss_applied_at) return 0;
  const at = deps.now().toISOString();
  // Claim first: a concurrent or repeated delivery sees loss_applied_at set and does nothing.
  const claim = await deps.db.run('UPDATE disputes SET loss_applied_at = ? WHERE id = ? AND loss_applied_at IS NULL', at, d.id);
  if (claim.changes !== 1) return 0;
  let left = d.amount_cents;
  let total = 0;
  for (const o of await ordersOf(deps, d)) {
    if (left <= 0) break;
    const take = Math.min(left, o.amount_cents - (o.refunded_cents ?? 0) - o.disputed_lost_cents);
    if (take <= 0) continue;
    left -= take;
    total += take;
    await deps.db.run('UPDATE orders SET disputed_lost_cents = disputed_lost_cents + ? WHERE id = ?', take, o.id);
    await adjustRollup(deps.db, { workspace_id: o.workspace_id, funnel_id: o.funnel_id, step_id: o.step_id, at, orders: take === o.amount_cents ? -1 : 0, cents: -take });
  }
  await deps.db.run('UPDATE disputes SET lost_cents = ? WHERE id = ?', total, d.id);
  return total;
}

const serializeForHook = (d: DisputeRow) => ({
  id: d.stripe_dispute_id, status: d.status, outcome: d.outcome, reason: d.reason, amount: fromMinor(d.amount_cents, d.currency), currency: d.currency, evidenceDueBy: d.evidence_due_by,
  lostAmount: fromMinor(d.lost_cents, d.currency), fundsWithdrawn: !!d.funds_withdrawn_at && !d.funds_reinstated_at,
});

/** Notification, webhook and audit row for a change, once the dispute belongs to a workspace. */
async function announce(deps: Deps, d: DisputeRow, kind: 'opened' | 'updated' | 'won' | 'lost' | 'funds_withdrawn' | 'funds_reinstated' | 'reconciled', orders: OrderRow[]) {
  if (!d.workspace_id) return;
  const main = orders[0];
  const money = `${fromMinor(d.amount_cents, d.currency).toFixed(currencyExponent(d.currency))} ${d.currency}`;
  await audit(deps, { workspaceId: d.workspace_id, actorId: 'stripe', action: `dispute.${kind}`, target: d.order_id ?? d.stripe_dispute_id, detail: { dispute: d.stripe_dispute_id, status: d.status, amountCents: d.amount_cents, currency: d.currency, reason: d.reason, lostCents: d.lost_cents, orphan: !main } });
  if (kind === 'opened' || kind === 'won' || kind === 'lost') {
    const title = kind === 'opened' ? 'Payment disputed' : kind === 'won' ? 'Dispute won' : 'Dispute lost';
    const who = main ? ` by ${main.email}` : '';
    const body = kind === 'opened' ? `${money} disputed${who}${d.evidence_due_by ? `; submit evidence in Stripe by ${d.evidence_due_by.slice(0, 10)}` : ''}` : kind === 'won' ? `You won the ${money} dispute${who}; the order is back to its previous state` : `You lost the ${money} dispute${who}; the amount is deducted from your sales`;
    await notify(deps, d.workspace_id, { type: 'dispute', title, body, data: { disputeId: d.id, stripeDisputeId: d.stripe_dispute_id, orderId: d.order_id, amountCents: d.amount_cents, currency: d.currency, outcome: d.outcome } });
  }
  if (kind !== 'reconciled') {
    await fireWebhookEvent(deps, d.workspace_id, 'funnel.dispute', {
      event: kind,
      dispute: serializeForHook(d),
      order: main ? { id: main.id, productName: main.product_name, amount: fromMinor(main.amount_cents, main.currency), currency: main.currency, email: main.email } : null,
    });
  }
}

/**
 * Handles one `charge.dispute.*` Connect event. One transaction, so a failure leaves nothing half applied and Stripe's retry is safe; the caller has already
 * deduplicated by event id, and everything here is idempotent by state as well (a replay under a different event id changes nothing).
 */
export async function applyDisputeEvent(base: Deps, ev: Evt): Promise<void> {
  const o = ev.data.object;
  const sid = typeof o.id === 'string' ? o.id : '';
  if (!sid) return;
  await inTx(base, async (deps) => {
    const now = deps.now().toISOString();
    const eventAt = iso(ev.created) ?? now;
    const status = typeof o.status === 'string' ? o.status : 'needs_response';
    const incoming = outcomeOf(status);
    const paymentIntent = typeof o.payment_intent === 'string' ? o.payment_intent : typeof o.payment_intent?.id === 'string' ? o.payment_intent.id : null;
    const charge = typeof o.charge === 'string' ? o.charge : typeof o.charge?.id === 'string' ? o.charge.id : null;
    const dueBy = iso(o.evidence_details?.due_by);
    let row = await deps.db.get<DisputeRow>('SELECT * FROM disputes WHERE stripe_dispute_id = ?', sid);
    let kind: Parameters<typeof announce>[2] | null = null;

    if (!row) {
      const ws = await resolveWorkspace(deps, ev.account);
      const id = newId('dsp');
      const fresh: DisputeRow = {
        id, workspace_id: ws, stripe_dispute_id: sid, stripe_account: ev.account ?? null, charge_id: charge, payment_intent: paymentIntent, order_id: null, amount_cents: Number(o.amount ?? 0), currency: String(o.currency ?? 'usd').toUpperCase(),
        reason: typeof o.reason === 'string' ? o.reason : null, status, outcome: incoming, livemode: ev.livemode ?? o.livemode ? 1 : 0, evidence_due_by: dueBy, funds_withdrawn_at: null, funds_reinstated_at: null, lost_cents: 0, loss_applied_at: null,
        last_event_at: eventAt, created_at: iso(o.created) ?? now, updated_at: now, closed_at: incoming === 'open' ? null : now,
      };
      await deps.db.run(
        `INSERT INTO disputes (id, workspace_id, stripe_dispute_id, stripe_account, charge_id, payment_intent, order_id, amount_cents, currency, reason, status, outcome, livemode, evidence_due_by, funds_withdrawn_at, funds_reinstated_at, lost_cents, loss_applied_at, last_event_at, created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        fresh.id, fresh.workspace_id, fresh.stripe_dispute_id, fresh.stripe_account, fresh.charge_id, fresh.payment_intent, fresh.order_id, fresh.amount_cents, fresh.currency, fresh.reason, fresh.status, fresh.outcome, fresh.livemode, fresh.evidence_due_by,
        fresh.funds_withdrawn_at, fresh.funds_reinstated_at, fresh.lost_cents, fresh.loss_applied_at, fresh.last_event_at, fresh.created_at, fresh.updated_at, fresh.closed_at,
      );
      row = fresh;
      kind = incoming === 'won' ? 'won' : incoming === 'lost' ? 'lost' : ev.type === 'charge.dispute.updated' ? 'updated' : 'opened';
    } else if (row.outcome === 'open') {
      // A stale update (older than what we already applied) must not move the dispute back; a closing event always counts.
      const stale = incoming === 'open' && eventAt < row.last_event_at;
      if (!stale && ev.type !== 'charge.dispute.funds_withdrawn' && ev.type !== 'charge.dispute.funds_reinstated') {
        const changed = status !== row.status || incoming !== row.outcome || dueBy !== row.evidence_due_by || Number(o.amount ?? row.amount_cents) !== row.amount_cents;
        if (changed) {
          await deps.db.run('UPDATE disputes SET status = ?, outcome = ?, evidence_due_by = COALESCE(?, evidence_due_by), amount_cents = ?, reason = COALESCE(?, reason), last_event_at = ?, updated_at = ?, closed_at = ?, payment_intent = COALESCE(payment_intent, ?), charge_id = COALESCE(charge_id, ?) WHERE id = ?',
            status, incoming, dueBy, Number(o.amount ?? row.amount_cents), typeof o.reason === 'string' ? o.reason : null, eventAt > row.last_event_at ? eventAt : row.last_event_at, now, incoming === 'open' ? null : now, paymentIntent, charge, row.id);
          row = (await deps.db.get<DisputeRow>('SELECT * FROM disputes WHERE id = ?', row.id))!;
          kind = incoming === 'won' ? 'won' : incoming === 'lost' ? 'lost' : 'updated';
        }
      }
    } else if (incoming !== 'open' && incoming !== row.outcome) {
      deps.log.warn('stripe dispute already closed with a different outcome; keeping the first', { dispute: sid, kept: row.outcome, event: ev.id });
    }

    if (ev.type === 'charge.dispute.funds_withdrawn' && !row.funds_withdrawn_at) {
      await deps.db.run('UPDATE disputes SET funds_withdrawn_at = ?, updated_at = ? WHERE id = ?', eventAt, now, row.id);
      row = { ...row, funds_withdrawn_at: eventAt };
      kind ??= 'funds_withdrawn';
    }
    if (ev.type === 'charge.dispute.funds_reinstated' && !row.funds_reinstated_at) {
      await deps.db.run('UPDATE disputes SET funds_reinstated_at = ?, updated_at = ? WHERE id = ?', eventAt, now, row.id);
      row = { ...row, funds_reinstated_at: eventAt };
      kind ??= 'funds_reinstated';
    }

    const linked = await link(deps, row);
    row = linked.row;
    if (linked.newlyLinked && !kind) kind = 'reconciled';
    if (row.outcome === 'lost' && linked.orders.length) await applyLoss(deps, row);
    row = (await deps.db.get<DisputeRow>('SELECT * FROM disputes WHERE id = ?', row.id))!;
    await refreshStatuses(deps, row);
    if (kind) await announce(deps, row, kind, linked.orders);
  });
}

/** Attaches the dispute to its orders (and workspace) once they exist. */
async function link(deps: Deps, d: DisputeRow): Promise<{ row: DisputeRow; orders: OrderRow[]; newlyLinked: boolean }> {
  const orders = await ordersOf(deps, d);
  const first = orders[0];
  if (!first) return { row: d, orders, newlyLinked: false };
  const newly = !d.order_id;
  if (newly || d.workspace_id !== first.workspace_id) {
    await deps.db.run('UPDATE disputes SET order_id = ?, workspace_id = ?, updated_at = ? WHERE id = ?', first.id, first.workspace_id, deps.now().toISOString(), d.id);
  }
  return { row: { ...d, order_id: first.id, workspace_id: first.workspace_id }, orders, newlyLinked: newly };
}

/**
 * Called when Stripe orders have just been created: links orphan disputes of those payments, applies a loss that was waiting for them and fixes the statuses.
 * Runs in its own transaction; safe to call any number of times.
 */
export async function reconcileDisputes(base: Deps, paymentIntents: string[]): Promise<number> {
  let n = 0;
  for (const pi of new Set(paymentIntents.filter(Boolean))) {
    const orphans = await base.db.all<DisputeRow>('SELECT * FROM disputes WHERE payment_intent = ? AND order_id IS NULL ORDER BY created_at, id', pi);
    for (const orphan of orphans) {
      await inTx(base, async (deps) => {
        const fresh = (await deps.db.get<DisputeRow>('SELECT * FROM disputes WHERE id = ? AND order_id IS NULL', orphan.id));
        if (!fresh) return; // another process reconciled it
        const linked = await link(deps, fresh);
        if (!linked.newlyLinked) return;
        let row = linked.row;
        if (row.outcome === 'lost') await applyLoss(deps, row);
        row = (await deps.db.get<DisputeRow>('SELECT * FROM disputes WHERE id = ?', row.id))!;
        await refreshStatuses(deps, row);
        await announce(deps, row, 'reconciled', linked.orders);
        n++;
      });
    }
  }
  return n;
}

// ---- reading ------------------------------------------------------------------------------------------------------------------------------------------

export const DisputeQuery = z.object({
  outcome: z.enum(['open', 'won', 'lost']).optional(),
  orderId: z.string().max(64).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const serializeDispute = (d: DisputeRow) => ({
  id: d.id, stripeDisputeId: d.stripe_dispute_id, orderId: d.order_id, orphan: !d.order_id, chargeId: d.charge_id, paymentIntent: d.payment_intent,
  amountCents: d.amount_cents, amount: fromMinor(d.amount_cents, d.currency), currency: d.currency, reason: d.reason, status: d.status, outcome: d.outcome, evidenceDueBy: d.evidence_due_by,
  fundsWithdrawnAt: d.funds_withdrawn_at, fundsReinstatedAt: d.funds_reinstated_at, lostCents: d.lost_cents, dashboardUrl: dashboardUrl(d), createdAt: d.created_at, updatedAt: d.updated_at, closedAt: d.closed_at,
});

export async function listDisputes(base: Deps, ws: string, q: z.infer<typeof DisputeQuery>) {
  const deps: Deps = { ...base, db: base.db.read(ws) };
  const where = ['d.workspace_id = ?'];
  const params: (string | number)[] = [ws];
  if (q.outcome) (where.push('d.outcome = ?'), params.push(q.outcome));
  if (q.orderId) (where.push('d.order_id = ?'), params.push(q.orderId));
  const clause = where.join(' AND ');
  const total = (await deps.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM disputes d WHERE ${clause}`, ...params))!.n;
  const rows = await deps.db.all<DisputeRow & { o_product: string | null; o_email: string | null; o_status: string | null }>(
    `SELECT d.*, o.product_name AS o_product, o.email AS o_email, o.status AS o_status FROM disputes d LEFT JOIN orders o ON o.id = d.order_id AND o.workspace_id = d.workspace_id
     WHERE ${clause} ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`, ...params, q.limit, (q.page - 1) * q.limit,
  );
  return {
    data: rows.map((r) => ({ ...serializeDispute(r), order: r.order_id ? { id: r.order_id, productName: r.o_product, email: r.o_email, status: r.o_status } : null })),
    pagination: { page: q.page, limit: q.limit, total: Number(total), totalPages: Math.max(1, Math.ceil(Number(total) / q.limit)) },
  };
}

/** The latest dispute per payment, for the order list. */
export async function disputesByPayment(deps: Deps, ws: string, paymentIntents: string[]): Promise<Map<string, ReturnType<typeof serializeDispute>>> {
  const out = new Map<string, ReturnType<typeof serializeDispute>>();
  const pis = [...new Set(paymentIntents.filter(Boolean))];
  if (!pis.length) return out;
  const rows = await deps.db.all<DisputeRow>(`SELECT * FROM disputes WHERE workspace_id = ? AND payment_intent IN (${pis.map(() => '?').join(', ')}) ORDER BY created_at, id`, ws, ...pis);
  for (const r of rows) out.set(r.payment_intent!, serializeDispute(r)); // later rows overwrite: the newest dispute wins
  return out;
}
