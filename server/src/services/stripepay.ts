import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import { PLAN_DEFS } from '../billing/plans.js';
import type { CheckoutBlock } from '../blocks/index.js';
import { isUniqueViolation } from '../db/index.js';
import { inTx } from '../db/scope.js';
import type { Deps } from '../deps.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import type { ChargeRequest, ChargeResult } from '../payments/provider.js';
import { StripeApiError, type StripeClient } from '../payments/stripe.js';
import type { Plan } from '../ratelimit/types.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';
import { hasOpenDispute, orderStatus } from './disputes.js';
import { notify } from './notifications.js';
import { persistOrders, serializeLine, type CheckoutResult, type OrderRow } from './orders.js';
import { fireWebhookEvent } from './webhooks.js';

/**
 * Real payments through Stripe Connect (docs/STRIPE.md). Money goes straight to the workspace's own Stripe account (a "direct charge" on the connected account);
 * Funnels takes an application fee by plan. UNVERIFIED against the real Stripe API: tested against an in-process fake (see payments/stripe.ts).
 *
 * Why hosted Checkout: the published pages never see a card number (no PCI scope, no Stripe.js on customers' domains, 3-D Secure handled by Stripe). The visitor is
 * redirected to Stripe; the orders are created when the payment completes, by whichever comes first of the signed webhook and the visitor's return, safely both.
 */
export const requireStripe = (deps: Deps): StripeClient => {
  if (!deps.stripe) throw new AppError(503, 'STRIPE_NOT_CONFIGURED', 'Payments are not configured on this server');
  return deps.stripe;
};

interface AccountRow {
  workspace_id: string;
  stripe_account_id: string;
  charges_enabled: number;
  payouts_enabled: number;
  details_submitted: number;
}

export const accountOf = (deps: Deps, ws: string) => deps.db.get<AccountRow>('SELECT * FROM stripe_accounts WHERE workspace_id = ?', ws);

const cents = (price: number) => Math.round(price * 100);
const lower = (c: string) => c.toLowerCase();

async function workspacePlan(deps: Deps, ws: string): Promise<Plan> {
  return ((await deps.db.get<{ plan: Plan }>('SELECT plan FROM workspaces WHERE id = ?', ws))?.plan ?? 'free') as Plan;
}

interface Item {
  blockId: string;
  productName: string;
  description?: string;
  amountCents: number;
  currency: string;
  bump: boolean;
}

interface StartCtx {
  ws: string;
  funnel: { id: string; name: string; domain_id: string | null; status: string };
  step: { id: string; base_path: string; position: number };
  block: CheckoutBlock;
  bumps: CheckoutBlock[];
  email: string;
  name: string | null;
  visitorId?: string;
  utms?: unknown;
}

/** Creates the Stripe Checkout Session on the connected account and answers with the URL to send the visitor to. Prices come from the stored blocks. */
export async function startHostedCheckout(deps: Deps, c: StartCtx): Promise<CheckoutResult> {
  const stripe = requireStripe(deps);
  const account = await accountOf(deps, c.ws);
  if (!account || !account.charges_enabled) throw conflict('STRIPE_NOT_CONNECTED', 'This store cannot take payments yet: the owner has not finished connecting Stripe');
  const domain = c.funnel.domain_id && c.funnel.status === 'live' ? await deps.db.get<{ hostname: string }>("SELECT hostname FROM domains WHERE id = ? AND status = 'active'", c.funnel.domain_id) : undefined;
  if (!domain) throw conflict('FUNNEL_NOT_LIVE', 'Payments are only taken on live funnels');
  const items: Item[] = [c.block, ...c.bumps].map((b, i) => ({ blockId: b.id, productName: b.productName, description: b.description, amountCents: cents(b.price), currency: b.currency, bump: i > 0 }));
  if (new Set(items.map((i) => i.currency)).size > 1) throw badRequest('MIXED_CURRENCY', 'The offer and its bumps must use the same currency');
  if (items.some((i) => i.amountCents <= 0)) throw badRequest('NOT_PURCHASABLE', 'A free offer cannot be paid for');
  const total = items.reduce((a, i) => a + i.amountCents, 0);
  const fee = Math.floor((total * PLAN_DEFS[await workspacePlan(deps, c.ws)].feeBps) / 10_000);
  const base = `https://${domain.hostname}`;
  const next = await deps.db.get<{ base_path: string }>('SELECT base_path FROM steps WHERE funnel_id = ? AND position > ? ORDER BY position LIMIT 1', c.funnel.id, c.step.position);
  const success = c.block.success;
  const nextUrl = success?.type === 'url' ? success.url : success?.type === 'message' || !next ? `${base}${c.step.base_path}?purchase=success` : `${base}${next.base_path}`;
  const cancelUrl = `${base}${c.step.base_path}?purchase=cancelled`;
  const id = newId('cks');
  const at = deps.now().toISOString();
  await deps.db.run(
    'INSERT INTO checkout_sessions (id, workspace_id, funnel_id, step_id, block_id, items_json, email, name, visitor_id, utms_json, next_url, cancel_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, c.ws, c.funnel.id, c.step.id, c.block.id, JSON.stringify(items), c.email.toLowerCase(), c.name, c.visitorId ?? null, c.utms ? JSON.stringify(c.utms) : null, nextUrl, cancelUrl, at,
  );
  const wantsUpsell = (await deps.db.all<{ doc_json: string }>('SELECT doc_json FROM step_pages WHERE funnel_id = ?', c.funnel.id)).some((p) => /"oneClickUpsell"\s*:\s*true/.test(p.doc_json));
  let session: { id: string; url: string };
  try {
    session = await stripe.call<{ id: string; url: string }>('POST', '/v1/checkout/sessions', {
      mode: 'payment',
      customer_email: c.email,
      customer_creation: 'always',
      line_items: items.map((i) => ({ quantity: 1, price_data: { currency: lower(i.currency), unit_amount: i.amountCents, product_data: { name: i.productName, ...(i.description ? { description: i.description } : {}) } } })),
      payment_intent_data: { description: `${c.block.productName} (${c.funnel.name})`, ...(fee > 0 ? { application_fee_amount: fee } : {}), ...(wantsUpsell ? { setup_future_usage: 'off_session' } : {}), metadata: { checkout_id: id } },
      success_url: `${deps.config.APP_PUBLIC_URL.replace(/\/$/, '')}/api/public/checkout/return?cs={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      client_reference_id: id,
      metadata: { checkout_id: id, workspace_id: c.ws },
    }, { account: account.stripe_account_id, idempotencyKey: id });
  } catch (e) {
    await deps.db.run("UPDATE checkout_sessions SET status = 'failed' WHERE id = ?", id);
    if (e instanceof StripeApiError) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider could not start the checkout, try again shortly', { code: e.code });
    throw e;
  }
  await deps.db.run('UPDATE checkout_sessions SET stripe_session_id = ? WHERE id = ?', session.id, id);
  return { ok: true, recorded: false, redirect: session.url, orders: [], declined: [] };
}

interface SessionRow {
  id: string;
  workspace_id: string;
  funnel_id: string;
  step_id: string;
  block_id: string;
  stripe_session_id: string;
  items_json: string;
  email: string;
  name: string | null;
  visitor_id: string | null;
  utms_json: string | null;
  next_url: string;
  cancel_url: string;
  status: string;
}

interface StripeSession {
  id: string;
  status: string;
  payment_status: string;
  amount_total: number;
  currency: string;
  customer: string | null;
  payment_intent: { id: string; payment_method: string | null } | string | null;
}

export interface Finalized {
  paid: boolean;
  orders: OrderRow[];
  nextUrl: string;
  cancelUrl: string;
}

/**
 * Turns a paid Checkout Session into orders. Safe to call any number of times from the webhook and from the visitor's return, concurrently: the session is
 * re-read from Stripe (nothing in the request is trusted), the amounts are checked against what the server stored, and orders carry an idempotency key per
 * session and block, so the unique index makes a second finalisation a no-op that returns the first one's orders.
 */
export async function finalizeSession(deps: Deps, stripeSessionId: string, account?: string): Promise<Finalized | null> {
  const row = await deps.db.get<SessionRow>('SELECT * FROM checkout_sessions WHERE stripe_session_id = ?', stripeSessionId);
  if (!row) return null;
  const existing = () => deps.db.all<OrderRow>("SELECT * FROM orders WHERE workspace_id = ? AND idem_key LIKE ? ORDER BY created_at, id", row.workspace_id, `cs:${row.id}:%`);
  const done = (orders: OrderRow[]): Finalized => ({ paid: true, orders, nextUrl: row.next_url, cancelUrl: row.cancel_url });
  const have = await existing();
  if (have.length) return done(have);
  const stripe = requireStripe(deps);
  const acct = account ?? (await accountOf(deps, row.workspace_id))?.stripe_account_id;
  if (!acct) return { paid: false, orders: [], nextUrl: row.next_url, cancelUrl: row.cancel_url };
  const s = await stripe.call<StripeSession>('GET', `/v1/checkout/sessions/${stripeSessionId}`, { expand: ['payment_intent'] }, { account: acct });
  if (s.status !== 'complete' || s.payment_status !== 'paid') return { paid: false, orders: [], nextUrl: row.next_url, cancelUrl: row.cancel_url };
  const items = JSON.parse(row.items_json) as Item[];
  const total = items.reduce((a, i) => a + i.amountCents, 0);
  if (s.amount_total !== total || lower(s.currency) !== lower(items[0]!.currency)) {
    deps.log.error('stripe session amount does not match the stored checkout', { session: stripeSessionId, stripe: s.amount_total, stored: total });
    throw new AppError(409, 'CHECKOUT_MISMATCH', 'The paid amount does not match the order');
  }
  const pi = typeof s.payment_intent === 'object' && s.payment_intent ? s.payment_intent : { id: String(s.payment_intent ?? ''), payment_method: null };
  const funnel = (await deps.db.get<{ id: string; name: string }>('SELECT id, name FROM funnels WHERE id = ?', row.funnel_id))!;
  const step = (await deps.db.get<{ id: string; name: string }>('SELECT id, name FROM steps WHERE id = ?', row.step_id))!;
  const at = deps.now().toISOString();
  let parent: string | null = null;
  const created: OrderRow[] = items.map((i) => {
    const o: OrderRow = {
      id: newId('ord'), workspace_id: row.workspace_id, funnel_id: row.funnel_id, step_id: row.step_id, block_id: i.blockId, lead_id: null, email: row.email, name: row.name,
      product_name: i.productName, amount_cents: i.amountCents, currency: i.currency, is_bump: i.bump ? 1 : 0, is_upsell: 0, parent_order_id: parent, provider: 'stripe',
      provider_ref: pi.id, payment_method_ref: pi.payment_method, idem_key: `cs:${row.id}:${i.blockId}`, created_at: at, provider_customer: s.customer, provider_account: acct,
    };
    parent ??= o.id;
    return o;
  });
  try {
    await persistOrders(deps, { ws: row.workspace_id, funnel, step, created, email: row.email, name: row.name, visitorId: row.visitor_id ?? undefined, utms: row.utms_json ? JSON.parse(row.utms_json) : undefined });
  } catch (e) {
    if (isUniqueViolation(e)) return done(await existing()); // the other finaliser won
    throw e;
  }
  await deps.db.run("UPDATE checkout_sessions SET status = 'completed', completed_at = ? WHERE id = ?", at, row.id);
  return done(created);
}

/** One-click upsell: charges the saved payment method of the original order off-session on the same connected account. 3-D Secure cannot be answered off-session, so that is a decline. */
export async function stripeUpsellCharge(deps: Deps, ws: string, prev: OrderRow, req: ChargeRequest): Promise<ChargeResult> {
  const stripe = requireStripe(deps);
  if (prev.provider !== 'stripe' || !prev.payment_method_ref || !prev.provider_customer || !prev.provider_account) return { status: 'failed', reason: 'no_saved_payment_method' };
  const fee = Math.floor((req.amountCents * PLAN_DEFS[await workspacePlan(deps, ws)].feeBps) / 10_000);
  try {
    const pi = await stripe.call<{ id: string; status: string; payment_method: string }>('POST', '/v1/payment_intents', {
      amount: req.amountCents, currency: lower(req.currency), customer: prev.provider_customer, payment_method: prev.payment_method_ref, off_session: true, confirm: true,
      description: req.description, ...(fee > 0 ? { application_fee_amount: fee } : {}),
    }, { account: prev.provider_account, idempotencyKey: createHash('sha256').update(req.idempotencyKey).digest('hex').slice(0, 40) });
    if (pi.status !== 'succeeded') {
      await stripe.call('POST', `/v1/payment_intents/${pi.id}/cancel`, {}, { account: prev.provider_account }).catch(() => undefined);
      return { status: 'failed', reason: pi.status === 'requires_action' ? 'authentication_required' : pi.status };
    }
    return { status: 'succeeded', providerRef: pi.id, paymentMethodRef: pi.payment_method ?? prev.payment_method_ref, provider: 'stripe', customerRef: prev.provider_customer, account: prev.provider_account };
  } catch (e) {
    if (e instanceof StripeApiError && e.type === 'card_error') return { status: 'failed', reason: e.declineCode ?? e.code ?? 'card_declined' };
    if (e instanceof StripeApiError) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider is unavailable, try again shortly', { code: e.code });
    throw e;
  }
}

// ---- refunds ------------------------------------------------------------------------------------------------------------------------------------------

export const RefundInput = z.object({
  amountCents: z.number().int().min(1).max(100_000_000).optional(),
  reason: z.enum(['requested_by_customer', 'duplicate', 'fraudulent']).optional(),
});

/**
 * Refunds an order, in full or in part. The refundable amount is reserved with one conditional UPDATE BEFORE Stripe is called, so two clicks (or two admins)
 * can never refund more than was paid; if Stripe refuses, the reservation is released.
 */
export async function refundOrder(deps: Deps, auth: Auth, orderId: string, input: z.infer<typeof RefundInput>, ip?: string) {
  const o = await deps.db.get<OrderRow>('SELECT * FROM orders WHERE workspace_id = ? AND id = ?', auth.workspaceId, orderId);
  if (!o) throw notFound('Order');
  const lost = o.disputed_lost_cents ?? 0; // taken back by a lost dispute: not ours to refund any more
  const remaining = o.amount_cents - (o.refunded_cents ?? 0) - lost;
  if (remaining <= 0) throw lost > 0 ? conflict('ORDER_CHARGED_BACK', 'This order was charged back (a dispute was lost), so there is nothing left to refund') : conflict('ALREADY_REFUNDED', 'This order is already fully refunded');
  const amount = input.amountCents ?? remaining;
  if (amount > remaining) throw badRequest('INVALID_AMOUNT', `At most ${(remaining / 100).toFixed(2)} ${o.currency} can still be refunded`);
  const reserved = await deps.db.run('UPDATE orders SET refunded_cents = refunded_cents + ? WHERE id = ? AND refunded_cents + disputed_lost_cents + ? <= amount_cents', amount, o.id, amount);
  if (reserved.changes !== 1) throw conflict('REFUND_IN_PROGRESS', 'The order was refunded meanwhile; reload and check the remaining amount');
  const release = () => deps.db.run('UPDATE orders SET refunded_cents = refunded_cents - ? WHERE id = ?', amount, o.id);
  const id = newId('rfd');
  let providerRef: string;
  if (o.provider === 'stripe') {
    try {
      const r = await requireStripe(deps).call<{ id: string }>('POST', '/v1/refunds', { payment_intent: o.provider_ref, amount, ...(input.reason ? { reason: input.reason } : {}), metadata: { order_id: o.id, refund_id: id } }, { account: o.provider_account ?? undefined, idempotencyKey: id });
      providerRef = `${r.id}:${o.id}`;
    } catch (e) {
      await release();
      if (e instanceof StripeApiError) throw e.code === 'charge_already_refunded' ? conflict('ALREADY_REFUNDED', 'Stripe reports this charge as already refunded') : new AppError(502, 'REFUND_FAILED', e.message, { code: e.code });
      throw e;
    }
  } else providerRef = `mock_re_${id}:${o.id}`;
  const at = deps.now().toISOString();
  const refunded = (o.refunded_cents ?? 0) + amount;
  await inTx(deps, async (d) => {
    await d.db.run('INSERT INTO refunds (id, workspace_id, order_id, amount_cents, currency, provider, provider_ref, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, o.workspace_id, o.id, amount, o.currency, o.provider, providerRef, input.reason ?? null, auth.userId, at);
    await d.db.run('UPDATE orders SET status = ? WHERE id = ?', orderStatus(o, await hasOpenDispute(d, o), refunded), o.id);
    await audit(d, { workspaceId: o.workspace_id, actorId: auth.userId, action: 'order.refunded', target: o.id, ip, detail: { refundId: id, amountCents: amount, currency: o.currency, provider: o.provider } });
    await notify(d, o.workspace_id, { type: 'refund', title: 'Order refunded', body: `${(amount / 100).toFixed(2)} ${o.currency} refunded to ${o.email}`, data: { orderId: o.id, refundId: id } });
    await fireWebhookEvent(d, o.workspace_id, 'funnel.refund', { order: { id: o.id, productName: o.product_name, amount: o.amount_cents / 100, currency: o.currency, email: o.email }, refund: { id, amount: amount / 100, currency: o.currency, remaining: (o.amount_cents - refunded) / 100 } });
  });
  return { refund: { id, orderId: o.id, amountCents: amount, currency: o.currency, createdAt: at }, order: { ...serializeLine({ ...o, refunded_cents: refunded, status: orderStatus(o, await hasOpenDispute(deps, o), refunded) }) } };
}

/**
 * Brings refunds made in the Stripe dashboard (or by Stripe) into the orders. A Stripe refund applies to a PaymentIntent that can cover several orders (the offer and its
 * bumps): it is allocated to those orders in creation order, up to what each has left. Refunds this app made itself are recognised by id and skipped.
 */
export async function syncChargeRefunds(deps: Deps, charge: { payment_intent: string | null; refunds?: { data?: { id: string; amount: number; reason?: string | null }[] } }): Promise<number> {
  if (!charge.payment_intent) return 0;
  let applied = 0;
  for (const r of charge.refunds?.data ?? []) {
    const esc = r.id.replace(/[\\%_]/g, (c) => `\\${c}`);
    const known = await deps.db.get("SELECT 1 FROM refunds WHERE provider_ref = ? OR provider_ref LIKE ? ESCAPE '\\'", r.id, `${esc}:%`);
    if (known) continue;
    let left = r.amount;
    const orders = await deps.db.all<OrderRow>("SELECT * FROM orders WHERE provider = 'stripe' AND provider_ref = ? ORDER BY created_at, id", charge.payment_intent);
    for (const o of orders) {
      if (left <= 0) break;
      const take = Math.min(left, o.amount_cents - (o.refunded_cents ?? 0) - (o.disputed_lost_cents ?? 0));
      if (take <= 0) continue;
      left -= take;
      const refunded = (o.refunded_cents ?? 0) + take;
      await inTx(deps, async (d) => {
        await d.db.run('INSERT INTO refunds (id, workspace_id, order_id, amount_cents, currency, provider, provider_ref, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', newId('rfd'), o.workspace_id, o.id, take, o.currency, 'stripe', `${r.id}:${o.id}`, r.reason ?? null, null, d.now().toISOString());
        await d.db.run('UPDATE orders SET refunded_cents = ?, status = ? WHERE id = ?', refunded, orderStatus(o, await hasOpenDispute(d, o), refunded), o.id);
        await audit(d, { workspaceId: o.workspace_id, actorId: 'stripe', action: 'order.refunded', target: o.id, detail: { source: 'stripe', amountCents: take, refund: r.id } });
        await fireWebhookEvent(d, o.workspace_id, 'funnel.refund', { order: { id: o.id, productName: o.product_name, amount: o.amount_cents / 100, currency: o.currency, email: o.email }, refund: { id: r.id, amount: take / 100, currency: o.currency, remaining: (o.amount_cents - refunded) / 100 } });
      });
      applied++;
    }
  }
  return applied;
}
