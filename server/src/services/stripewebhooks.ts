import type { Deps } from '../deps.js';
import { AppError } from '../errors.js';
import { verifyStripeSignature } from '../payments/stripe.js';
import { audit } from './audit.js';
import { applyAccount, applySubscription } from './billing.js';
import { notify } from './notifications.js';
import { applyDisputeEvent, DISPUTE_EVENTS } from './disputes.js';
import { finalizeSession, syncChargeRefunds } from './stripepay.js';

/**
 * Stripe webhooks (docs/STRIPE.md). Two endpoints with two signing secrets: the platform's own events (subscriptions, invoices) and the Connect events of the
 * workspaces' connected accounts (checkout, refunds, account changes). Verified over the RAW body, deduplicated by Stripe's event id, and a failure answers 500
 * so Stripe retries (a processed event is acknowledged without being run again; one that failed half way is run again).
 */
export type Source = 'platform' | 'connect';

interface StripeEvent {
  id: string;
  type: string;
  account?: string;
  data: { object: Record<string, any> };
}

export async function receiveStripeWebhook(deps: Deps, source: Source, rawBody: string, signature: string | undefined): Promise<{ received: true; duplicate?: boolean; ignored?: boolean }> {
  const secret = source === 'platform' ? deps.config.STRIPE_WEBHOOK_SECRET : deps.config.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) throw new AppError(503, 'STRIPE_NOT_CONFIGURED', 'Webhook signing is not configured');
  if (!verifyStripeSignature(secret, signature, rawBody, Math.floor(deps.now().getTime() / 1000), deps.config.STRIPE_WEBHOOK_TOLERANCE_SECONDS)) throw new AppError(400, 'INVALID_SIGNATURE', 'The webhook signature is not valid');
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'The webhook body is not JSON');
  }
  if (typeof event?.id !== 'string' || typeof event.type !== 'string' || !event.data?.object) throw new AppError(400, 'INVALID_EVENT', 'Not a Stripe event');
  const at = deps.now().toISOString();
  const claim = await deps.db.run(`INSERT INTO stripe_events (id, source, type, received_at) VALUES (?, ?, ?, ?)${deps.db.dialect.onConflictDoNothing()}`, event.id, source, event.type, at);
  if (claim.changes !== 1) {
    const seen = await deps.db.get<{ processed_at: string | null }>('SELECT processed_at FROM stripe_events WHERE id = ?', event.id);
    if (seen?.processed_at) return { received: true, duplicate: true };
  }
  try {
    const handled = source === 'platform' ? await platformEvent(deps, event) : await connectEvent(deps, event);
    await deps.db.run('UPDATE stripe_events SET processed_at = ?, error = NULL WHERE id = ?', deps.now().toISOString(), event.id);
    return handled ? { received: true } : { received: true, ignored: true };
  } catch (e) {
    await deps.db.run('UPDATE stripe_events SET error = ? WHERE id = ?', (e as Error).message.slice(0, 500), event.id);
    throw e;
  }
}

async function connectEvent(deps: Deps, ev: StripeEvent): Promise<boolean> {
  const o = ev.data.object;
  switch (ev.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      await finalizeSession(deps, String(o.id), ev.account);
      return true;
    case 'checkout.session.expired':
      await deps.db.run("UPDATE checkout_sessions SET status = 'expired' WHERE stripe_session_id = ? AND status = 'open'", String(o.id));
      return true;
    case 'charge.refunded':
    case 'charge.refund.updated':
      await syncChargeRefunds(deps, { payment_intent: o.payment_intent ?? null, refunds: o.refunds });
      return true;
    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed':
    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.funds_reinstated':
      await applyDisputeEvent(deps, ev as StripeEvent & { created?: number; livemode?: boolean });
      return true;
    case 'account.updated':
      await applyAccount(deps, String(o.id), o);
      return true;
    case 'account.application.deauthorized': {
      const accountId = ev.account ?? String(o.id);
      const row = await deps.db.get<{ workspace_id: string }>('SELECT workspace_id FROM stripe_accounts WHERE stripe_account_id = ?', accountId);
      if (row) {
        await deps.db.run('DELETE FROM stripe_accounts WHERE stripe_account_id = ?', accountId);
        await audit(deps, { workspaceId: row.workspace_id, actorId: 'stripe', action: 'stripe.deauthorized', target: accountId });
        await notify(deps, row.workspace_id, { type: 'billing', title: 'Stripe disconnected', body: 'Your Stripe account revoked access: payments are paused until you connect again.', data: {} });
      }
      return true;
    }
    default:
      return false;
  }
}

async function workspaceFor(deps: Deps, o: Record<string, any>): Promise<string | undefined> {
  const meta = o.metadata?.workspace_id ?? o.client_reference_id;
  if (typeof meta === 'string' && (await deps.db.get('SELECT 1 FROM workspaces WHERE id = ?', meta))) return meta;
  if (typeof o.customer === 'string') return (await deps.db.get<{ id: string }>('SELECT id FROM workspaces WHERE stripe_customer_id = ?', o.customer))?.id;
  return undefined;
}

async function platformEvent(deps: Deps, ev: StripeEvent): Promise<boolean> {
  const o = ev.data.object;
  const ws = await workspaceFor(deps, o);
  if (!ws) {
    deps.log.warn('stripe platform event for an unknown workspace', { event: ev.id, type: ev.type });
    return false;
  }
  switch (ev.type) {
    case 'checkout.session.completed':
      if (o.mode !== 'subscription' || typeof o.subscription !== 'string' || !deps.stripe) return false;
      // The session only says a subscription exists; its plan and status come from the subscription object itself.
      await applySubscription(deps, ws, await deps.stripe.call('GET', `/v1/subscriptions/${o.subscription}`));
      return true;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await applySubscription(deps, ws, ev.type === 'customer.subscription.deleted' ? { ...(o as { id: string }), status: 'canceled' } : (o as never));
      return true;
    case 'invoice.payment_failed':
      await deps.db.run("UPDATE workspaces SET plan_status = 'past_due' WHERE id = ? AND stripe_subscription_id IS NOT NULL", ws);
      await notify(deps, ws, { type: 'billing', title: 'Payment failed', body: 'We could not charge your card for the subscription. Update your payment method in the billing portal to keep your plan.', data: {} });
      return true;
    case 'invoice.paid':
      await deps.db.run("UPDATE workspaces SET plan_status = 'active' WHERE id = ? AND stripe_subscription_id IS NOT NULL AND plan_status = 'past_due'", ws);
      return true;
    default:
      return false;
  }
}
