import { z } from 'zod';
import type { CheckoutBlock } from '../blocks/index.js';
import type { Deps } from '../deps.js';
import { isUniqueViolation } from '../db/index.js';
import { inTx } from '../db/scope.js';
import { AppError, badRequest, notFound } from '../errors.js';
import { like } from '../repos/sql.js';
import { csvStream } from '../util/csv.js';
import { newId } from '../util/ids.js';
import { addDays, isDay, startOfDayUtc } from '../util/time.js';
import { upsertLead } from './leads.js';
import { disputesByPayment, reconcileDisputes } from './disputes.js';
import { notify } from './notifications.js';
import { domainEvent } from '../queue/outbox.js';
import { insertEvents } from './rollups.js';
import { EMAIL_RE, resolvePublicBlock, sanitizeUtms } from './publicblocks.js';
import { fireWebhookEvent } from './webhooks.js';
import { startHostedCheckout, stripeUpsellCharge } from './stripepay.js';

export const CheckoutInput = z.object({
  email: z.string().trim().max(254).optional(),
  name: z.string().trim().max(120).optional(),
  bumpBlockIds: z.array(z.string().max(64)).max(10).default([]),
  previousOrderId: z.string().max(64).optional(),
  submissionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  visitorId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  _hp: z.string().max(200).optional(),
  utms: z.unknown().optional(),
  preview: z.boolean().optional(),
});
  /** Units of the main offer when its block offers a quantity picker (checked against the block's own range). */
  quantity: z.number().int().min(1).max(99).optional(),

export interface OrderRow {
  id: string;
  workspace_id: string;
  funnel_id: string;
  step_id: string;
  block_id: string;
  lead_id: string | null;
  email: string;
  name: string | null;
  product_name: string;
  amount_cents: number;
  currency: string;
  is_bump: number;
  is_upsell: number;
  parent_order_id: string | null;
  provider: string;
  provider_ref: string;
  payment_method_ref: string | null;
  idem_key: string | null;
  created_at: string;
  status?: string;
  refunded_cents?: number;
  disputed_lost_cents?: number;
  provider_customer?: string | null;
  provider_account?: string | null;
}

export const serializeLine = (o: OrderRow) => ({ id: o.id, productName: o.product_name, amountCents: o.amount_cents, currency: o.currency, isBump: o.is_bump === 1, isUpsell: o.is_upsell === 1, status: o.status ?? 'paid', refundedCents: o.refunded_cents ?? 0, disputedLostCents: o.disputed_lost_cents ?? 0 });
  product_id?: string | null;
  price_id?: string | null;
  quantity?: number;
  discount_cents?: number;
  role?: string | null;

export interface CheckoutResult {
  ok: true;
  /** Hosted checkout: send the visitor here (Stripe Checkout); the orders are created when the payment completes. */
  redirect?: string;
  recorded: boolean;
  duplicate?: boolean;
  orderId?: string;
  orders: ReturnType<typeof serializeLine>[];
  declined: string[];
}

/**
 * Records orders through the PaymentProvider. The price always comes from the stored block, never from
 * the request, so a visitor cannot choose what they pay. Bumps ride along with the main offer; a
 * one-click upsell reuses the payment method of an earlier order in the same funnel.
 */
export async function checkout(deps: Deps, p: { funnelId: string; stepId: string; blockId: string; input: z.infer<typeof CheckoutInput> }): Promise<CheckoutResult> {
  const { funnel, step, block, workspaceId: ws, doc } = await resolvePublicBlock(deps, p.funnelId, p.stepId, p.blockId, 'checkout');
  const input = p.input;
  if (input._hp) return { ok: true, recorded: false, orders: [], declined: [] };
  if (block.orderBump) throw badRequest('NOT_PURCHASABLE', 'Order bumps are purchased together with the main offer');

  let email = input.email ?? '';
  let name = input.name ?? null;
  let paymentMethodRef: string | undefined;
  let parentOrderId: string | null = null;
  let prevOrder: OrderRow | undefined;
  if (block.oneClickUpsell) {
    const prev = input.previousOrderId ? await deps.db.get<OrderRow>('SELECT * FROM orders WHERE workspace_id = ? AND funnel_id = ? AND id = ?', ws, funnel.id, input.previousOrderId) : undefined;
    if (!prev) throw badRequest('PREVIOUS_ORDER_REQUIRED', 'A completed earlier order is required for a one-click upsell');
    prevOrder = prev;
    email = prev.email;
    name = prev.name;
    paymentMethodRef = prev.payment_method_ref ?? undefined;
    parentOrderId = prev.parent_order_id ?? prev.id;
  } else if (!EMAIL_RE.test(email)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Enter a valid email address', { fields: { email: 'Enter a valid email address' } });
  }

  const bumps: CheckoutBlock[] = [];
  for (const id of new Set(input.bumpBlockIds)) {
    const b = doc.products.find((p) => p.id === id);
    if (!b || !b.orderBump) throw badRequest('INVALID_BUMP', 'Unknown order bump');
    bumps.push(b);
  }
  if (input.preview) return { ok: true, recorded: false, orders: [], declined: [] };

  if (deps.config.PAYMENTS_PROVIDER === 'stripe' && !block.oneClickUpsell) {
    return startHostedCheckout(deps, { ws, funnel, step, block, offers, email, name, visitorId: input.visitorId, utms: input.utms, allowPromotionCodes: block.allowPromotionCodes === true });
  }

  // The server prices the basket: from the catalog price the blocks name (never from the request), with the quantity checked against the block.
  const offers: Offer[] = [await resolveOffer(deps, ws, block, checkQuantity(block, input.quantity))];
  for (const b of bumps) offers.push(await resolveOffer(deps, ws, b, 1));
  if (new Set(offers.map((o) => o.currency)).size > 1) throw badRequest('MIXED_CURRENCY', 'The offer and its bumps must use the same currency');
  if (offers.some((o) => o.recurring) && block.oneClickUpsell) throw badRequest('SUBSCRIPTION_UPSELL_UNSUPPORTED', 'A one-click offer cannot start a subscription');
  const recurring = offers.filter((o) => o.recurring);
  if (new Set(recurring.map((o) => `${o.recurring!.interval}/${o.recurring!.count}`)).size > 1) throw badRequest('MIXED_INTERVAL', 'Subscriptions in one order must bill on the same interval');

  const idemBase = input.submissionId ? `${block.id}:${input.submissionId}` : null;
  if (idemBase) {
    const main = await deps.db.get<OrderRow>('SELECT * FROM orders WHERE workspace_id = ? AND funnel_id = ? AND idem_key = ?', ws, funnel.id, `${idemBase}:${block.id}`);
    if (main) {
      const rest = await deps.db.all<OrderRow>('SELECT * FROM orders WHERE workspace_id = ? AND parent_order_id = ? ORDER BY created_at, id', ws, main.id);
      return { ok: true, recorded: false, duplicate: true, orderId: main.id, orders: [main, ...rest].map(serializeLine), declined: [] };
    }
  }

  const created: OrderRow[] = [];
  const declined: string[] = [];
  for (const o of offers) {
    const bump = o.role === 'bump';
    const idem = idemBase ? `${idemBase}:${o.blockId}` : null;
    const amount = o.unitAmount * o.quantity;
    const charge = {
      amountCents: amount,
      currency: o.currency,
      description: `${o.name} (${funnel.name})`,
      customer: { email, name: name ?? undefined },
      idempotencyKey: idem ?? newId('idem'),
      paymentMethodRef,
    };
    const result = deps.config.PAYMENTS_PROVIDER === 'stripe' ? await stripeUpsellCharge(deps, ws, prevOrder!, charge) : await deps.payments.charge(charge);
    if (result.status === 'failed') {
      if (!bump) throw new AppError(402, 'PAYMENT_FAILED', 'The payment was declined', { reason: result.reason });
      declined.push(o.blockId);
      continue;
    }
    paymentMethodRef = result.paymentMethodRef;
    const row: OrderRow = {
      id: newId('ord'), workspace_id: ws, funnel_id: funnel.id, step_id: step.id, block_id: o.blockId, lead_id: null, email: email.toLowerCase(), name,
      product_name: o.name, amount_cents: amount, currency: o.currency, is_bump: bump ? 1 : 0, is_upsell: block.oneClickUpsell && !bump ? 1 : 0,
      parent_order_id: parentOrderId, provider: result.provider ?? deps.payments.name, provider_ref: result.providerRef, payment_method_ref: result.paymentMethodRef, idem_key: idem, created_at: deps.now().toISOString(),
      provider_customer: result.customerRef ?? null, provider_account: result.account ?? null, product_id: o.productId, price_id: o.priceId, quantity: o.quantity, discount_cents: 0, role: o.role,
    };
    created.push(row);
    if (!bump && !parentOrderId) parentOrderId = row.id;
  }

  try {
    await persistOrders(deps, { ws, funnel, step, created, email, name, visitorId: input.visitorId, utms: input.utms });
  } catch (e) {
    // A concurrent request with the same submission id won the race; the provider call was idempotent too.
    if (isUniqueViolation(e) && idemBase) return { ok: true, recorded: false, duplicate: true, orders: [], declined: [] };
    throw e;
  }
  return { ok: true, recorded: true, orderId: created[0]?.id, orders: created.map(serializeLine), declined };
}

type PersistInput = { ws: string; funnel: { id: string; name: string }; step: { id: string; name: string }; created: OrderRow[]; email: string; name: string | null; visitorId?: string; utms?: unknown };

/**
 * Writes orders, their `order` events (and rollups), the buyer lead, notifications and webhook deliveries in one transaction. Afterwards, disputes that Stripe
 * announced for these payments before the orders existed (orphans) are linked to them.
 */
export async function persistOrders(deps: Deps, p: PersistInput): Promise<void> {
  await persistTx(deps, p);
  await reconcileDisputes(deps, p.created.filter((o) => o.provider === 'stripe').map((o) => o.provider_ref));
}

function persistTx(deps: Deps, p: PersistInput): Promise<void> {
  const { ws, funnel, step, created } = p;
  deps.db.noteWrite(ws);
  return inTx(deps, async (d) => {
    const lead = await upsertLead(d, ws, { email: p.email, name: p.name, funnelId: funnel.id, countSubmission: false });
    for (const o of created) {
      o.lead_id = lead.id;
      await d.db.run(
        `INSERT INTO orders (id, workspace_id, funnel_id, step_id, block_id, lead_id, email, name, product_name, amount_cents, currency, is_bump, is_upsell, parent_order_id, provider, provider_ref, payment_method_ref, idem_key, created_at, provider_customer, provider_account, product_id, price_id, quantity, discount_cents, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        o.id, o.workspace_id, o.funnel_id, o.step_id, o.block_id, o.lead_id, o.email, o.name, o.product_name, o.amount_cents, o.currency, o.is_bump, o.is_upsell, o.parent_order_id, o.provider, o.provider_ref, o.payment_method_ref, o.idem_key, o.created_at, o.provider_customer ?? null, o.provider_account ?? null,
      );
      await insertEvents(d.db, [{
        id: newId('evt'), workspace_id: ws, funnel_id: funnel.id, step_id: step.id, type: 'order', visitor_id: p.visitorId ?? null, unique_visit: 0, lead_id: lead.id, order_id: o.id,
        external_id: `order:${o.id}`, amount_cents: o.amount_cents, currency: o.currency, utm_json: JSON.stringify(sanitizeUtms(p.utms)), url: null, created_at: o.created_at,
        o.product_id ?? null, o.price_id ?? null, o.quantity ?? 1, o.discount_cents ?? 0, o.role ?? null,
      }]);
      await domainEvent(d, 'order.created', funnel.id, { workspaceId: ws, stepId: step.id, orderId: o.id, leadId: lead.id, amountCents: o.amount_cents, currency: o.currency });
      await notify(d, ws, { type: 'new_sale', title: 'New sale', body: `${o.email} bought ${o.product_name}`, data: { orderId: o.id, funnelId: funnel.id, amountCents: o.amount_cents, currency: o.currency } });
      await fireWebhookEvent(d, ws, 'funnel.purchase', {
        funnel: { id: funnel.id, name: funnel.name },
        step: { id: step.id, name: step.name },
        order: { id: o.id, productName: o.product_name, amount: o.amount_cents / 100, currency: o.currency, isBump: o.is_bump === 1, isUpsell: o.is_upsell === 1, email: o.email, name: o.name },
      });
    }
  });
}

export const OrderQuery = z.object({
  search: z.string().max(100).optional(),
  funnelId: z.string().max(64).optional(),
  from: z.string().refine(isDay, 'Use YYYY-MM-DD').optional(),
  to: z.string().refine(isDay, 'Use YYYY-MM-DD').optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function filter(deps: Deps, ws: string, q: z.infer<typeof OrderQuery>) {
  const where = ['o.workspace_id = ?'];
  const params: (string | number)[] = [ws];
  if (q.search?.trim()) {
    where.push(`(${deps.db.dialect.ilike('o.email')} OR ${deps.db.dialect.ilike('o.product_name')})`);
    params.push(like(q.search.trim()), like(q.search.trim()));
  }
  if (q.funnelId) {
    where.push('o.funnel_id = ?');
    params.push(q.funnelId);
  }
  if (q.from) {
    where.push('o.created_at >= ?');
    params.push(startOfDayUtc(q.from, 'UTC').toISOString());
  }
  if (q.to) {
    where.push('o.created_at < ?');
    params.push(startOfDayUtc(addDays(q.to, 1), 'UTC').toISOString());
  }
  return { clause: where.join(' AND '), params };
}

type Joined = OrderRow & { funnel_name: string | null; step_name: string | null };
const SELECT = `SELECT o.*, f.name AS funnel_name, s.name AS step_name FROM orders o LEFT JOIN funnels f ON f.id = o.funnel_id LEFT JOIN steps s ON s.id = o.step_id`;

export async function listOrders(base: Deps, ws: string, q: z.infer<typeof OrderQuery>) {
  const deps: Deps = { ...base, db: base.db.read(ws) };
  const { clause, params } = filter(deps, ws, q);
  const total = (await deps.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM orders o WHERE ${clause}`, ...params))!.n;
  const rows = await deps.db.all<Joined>(`${SELECT} WHERE ${clause} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`, ...params, q.limit, (q.page - 1) * q.limit);
  const disputes = await disputesByPayment(deps, ws, rows.filter((o) => o.provider === 'stripe').map((o) => o.provider_ref));
  return {
    data: rows.map((o) => ({ ...serializeLine(o), funnelId: o.funnel_id, funnelName: o.funnel_name, stepName: o.step_name, email: o.email, name: o.name, amount: fromMinor(o.amount_cents, o.currency), productId: o.product_id ?? null, priceId: o.price_id ?? null, quantity: o.quantity ?? 1, discountCents: o.discount_cents ?? 0, provider: o.provider, providerRef: o.provider_ref, createdAt: o.created_at, dispute: (o.provider === 'stripe' ? disputes.get(o.provider_ref) : undefined) ?? null })),
    pagination: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
  };
}

export function ordersCsvStream(base: Deps, ws: string, q: z.infer<typeof OrderQuery>): ReadableStream<Uint8Array> {
  const deps: Deps = { ...base, db: base.db.read(ws) };
  const { clause, params } = filter(deps, ws, q);
  return csvStream<{ at: string; id: string }>(['Order', 'Date', 'Funnel', 'Step', 'Product', 'Amount', 'Currency', 'Bump', 'Upsell', 'Email', 'Name', 'Provider reference'], async (cursor) => {
    const rows = await deps.db.all<Joined>(
      `SELECT o.*, f.name AS funnel_name, s.name AS step_name FROM orders o LEFT JOIN funnels f ON f.id = o.funnel_id LEFT JOIN steps s ON s.id = o.step_id
       WHERE ${clause} ${cursor ? 'AND (o.created_at < ? OR (o.created_at = ? AND o.id < ?))' : ''} ORDER BY o.created_at DESC, o.id DESC LIMIT 1000`,
      ...params, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []),
    );
    const last = rows[rows.length - 1];
    return {
      rows: rows.map((o) => [o.id, o.created_at, o.funnel_name, o.step_name, o.product_name, fromMinor(o.amount_cents, o.currency).toFixed(currencyExponent(o.currency)), o.currency, o.is_bump ? 'yes' : 'no', o.is_upsell ? 'yes' : 'no', o.email, o.name, o.provider_ref]),
      cursor: rows.length === 1000 && last ? { at: last.created_at, id: last.id } : null,
    };
  });
}

export async function getOrder(deps: Deps, ws: string, id: string) {
  const o = await deps.db.get<Joined>(`${SELECT} WHERE o.workspace_id = ? AND o.id = ?`, ws, id);
  if (!o) throw notFound('Order');
  const dispute = o.provider === 'stripe' ? (await disputesByPayment(deps, ws, [o.provider_ref])).get(o.provider_ref) : undefined;
  return { ...serializeLine(o), funnelId: o.funnel_id, email: o.email, name: o.name, provider: o.provider, createdAt: o.created_at, dispute: dispute ?? null };
}
