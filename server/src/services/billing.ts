import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import { type Limited, PLAN_DEFS } from '../billing/plans.js';
import type { Deps } from '../deps.js';
import { AppError, conflict, notFound } from '../errors.js';
import { StripeApiError } from '../payments/stripe.js';
import type { Plan } from '../ratelimit/types.js';
import { audit } from './audit.js';
import { assertWithinLimit, usageOf } from '../billing/limits.js';
import { accountOf, requireStripe } from './stripepay.js';

export { assertWithinLimit, usageOf };

/** Connect onboarding, platform subscriptions and plan limits (docs/STRIPE.md). UNVERIFIED against the real Stripe API: tested against an in-process fake. */
export const SubscribeInput = z.object({ plan: z.enum(['pro', 'business']) });

interface WorkspaceBilling {
  id: string;
  name: string;
  plan: Plan;
  plan_status: string;
  plan_period_end: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

const workspaceRow = async (deps: Deps, ws: string): Promise<WorkspaceBilling> => {
  const w = await deps.db.get<WorkspaceBilling>('SELECT id, name, plan, plan_status, plan_period_end, stripe_customer_id, stripe_subscription_id FROM workspaces WHERE id = ?', ws);
  if (!w) throw notFound('Workspace');
  return w;
};

export async function overview(deps: Deps, ws: string) {
  const w = await workspaceRow(deps, ws);
  const acct = await accountOf(deps, ws);
  return {
    plan: w.plan, planName: PLAN_DEFS[w.plan].name, status: w.plan_status, periodEnd: w.plan_period_end, enforced: deps.config.BILLING_ENFORCE_LIMITS,
    limits: Object.fromEntries((['funnels', 'domains', 'members', 'apiKeys'] as Limited[]).map((k) => [k, PLAN_DEFS[w.plan][k]])),
    usage: await usageOf(deps, ws),
    applicationFeePercent: PLAN_DEFS[w.plan].feeBps / 100,
    plans: Object.values(PLAN_DEFS).map((p) => ({ id: p.id, name: p.name, funnels: p.funnels, domains: p.domains, members: p.members, apiKeys: p.apiKeys, applicationFeePercent: p.feeBps / 100, purchasable: p.id === 'pro' ? !!deps.config.STRIPE_PRICE_PRO : p.id === 'business' ? !!deps.config.STRIPE_PRICE_BUSINESS : false })),
    subscription: { hasCustomer: !!w.stripe_customer_id, hasSubscription: !!w.stripe_subscription_id },
    stripe: { configured: !!deps.stripe, provider: deps.config.PAYMENTS_PROVIDER, connect: acct ? { accountId: acct.stripe_account_id, chargesEnabled: acct.charges_enabled === 1, payoutsEnabled: acct.payouts_enabled === 1, detailsSubmitted: acct.details_submitted === 1 } : null },
  };
}

// ---- Connect ------------------------------------------------------------------------------------------------------------------------------------------

const appUrl = (deps: Deps, path: string) => `${deps.config.APP_PUBLIC_URL.replace(/\/$/, '')}${path}`;

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StripeApiError) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', e.message, { code: e.code });
    throw e;
  }
};

/** Starts (or resumes) Stripe onboarding: creates the workspace's Standard connected account on first use and returns a one-time onboarding link. */
export async function startConnect(deps: Deps, auth: Auth, ip?: string) {
  const stripe = requireStripe(deps);
  return wrap(async () => {
    let acct = await accountOf(deps, auth.workspaceId);
    if (!acct) {
      const created = await stripe.call<{ id: string }>('POST', '/v1/accounts', { type: 'standard', email: auth.email, metadata: { workspace_id: auth.workspaceId } }, { idempotencyKey: `acct:${auth.workspaceId}` });
      const at = deps.now().toISOString();
      await deps.db.run('INSERT INTO stripe_accounts (workspace_id, stripe_account_id, created_at, updated_at) VALUES (?, ?, ?, ?)', auth.workspaceId, created.id, at, at);
      await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'stripe.connect_started', target: created.id, ip });
      acct = (await accountOf(deps, auth.workspaceId))!;
    }
    const link = await stripe.call<{ url: string }>('POST', '/v1/account_links', { account: acct.stripe_account_id, refresh_url: appUrl(deps, '/billing?connect=refresh'), return_url: appUrl(deps, '/billing?connect=return'), type: 'account_onboarding' });
    return { url: link.url };
  });
}

/** The connected account's state, refreshed from Stripe (also keeps `charges_enabled` right if a webhook was missed). */
export async function connectStatus(deps: Deps, ws: string) {
  const acct = await accountOf(deps, ws);
  if (!acct) return { connected: false as const };
  if (deps.stripe) {
    await wrap(async () => {
      const a = await deps.stripe!.call<{ charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean; requirements?: { currently_due?: string[] } }>('GET', `/v1/accounts/${acct.stripe_account_id}`);
      await applyAccount(deps, acct.stripe_account_id, a);
    });
  }
  const fresh = (await accountOf(deps, ws))!;
  return { connected: true as const, accountId: fresh.stripe_account_id, chargesEnabled: fresh.charges_enabled === 1, payoutsEnabled: fresh.payouts_enabled === 1, detailsSubmitted: fresh.details_submitted === 1 };
}

export async function applyAccount(deps: Deps, accountId: string, a: { charges_enabled?: boolean; payouts_enabled?: boolean; details_submitted?: boolean; requirements?: { currently_due?: string[] } }): Promise<void> {
  await deps.db.run('UPDATE stripe_accounts SET charges_enabled = ?, payouts_enabled = ?, details_submitted = ?, requirements_json = ?, updated_at = ? WHERE stripe_account_id = ?', a.charges_enabled ? 1 : 0, a.payouts_enabled ? 1 : 0, a.details_submitted ? 1 : 0, JSON.stringify(a.requirements?.currently_due ?? []), deps.now().toISOString(), accountId);
}

/** Forgets the connection here. Funnels stop taking payments for the workspace; the Stripe account itself is untouched (revoke access from the Stripe dashboard). */
export async function disconnect(deps: Deps, auth: Auth, ip?: string): Promise<void> {
  const acct = await accountOf(deps, auth.workspaceId);
  if (!acct) throw notFound('Stripe connection');
  await deps.db.run('DELETE FROM stripe_accounts WHERE workspace_id = ?', auth.workspaceId);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'stripe.disconnected', target: acct.stripe_account_id, ip });
}

// ---- platform subscriptions ---------------------------------------------------------------------------------------------------------------------------

const priceFor = (deps: Deps, plan: 'pro' | 'business') => (plan === 'pro' ? deps.config.STRIPE_PRICE_PRO : deps.config.STRIPE_PRICE_BUSINESS);

async function customerOf(deps: Deps, auth: Auth, w: WorkspaceBilling): Promise<string> {
  if (w.stripe_customer_id) return w.stripe_customer_id;
  const c = await requireStripe(deps).call<{ id: string }>('POST', '/v1/customers', { email: auth.email, name: w.name, metadata: { workspace_id: w.id } }, { idempotencyKey: `cus:${w.id}` });
  await deps.db.run('UPDATE workspaces SET stripe_customer_id = ? WHERE id = ?', c.id, w.id);
  return c.id;
}

export async function startSubscription(deps: Deps, auth: Auth, plan: 'pro' | 'business', ip?: string) {
  const price = priceFor(deps, plan);
  if (!price) throw conflict('PLAN_NOT_AVAILABLE', `The ${PLAN_DEFS[plan].name} plan is not available on this server`);
  const w = await workspaceRow(deps, auth.workspaceId);
  if (w.stripe_subscription_id && w.plan_status !== 'canceled') throw conflict('ALREADY_SUBSCRIBED', 'This workspace already has a subscription: change it in the billing portal');
  return wrap(async () => {
    const customer = await customerOf(deps, auth, w);
    const s = await requireStripe(deps).call<{ url: string }>('POST', '/v1/checkout/sessions', {
      mode: 'subscription', customer, line_items: [{ price, quantity: 1 }], client_reference_id: w.id,
      success_url: appUrl(deps, '/billing?checkout=success'), cancel_url: appUrl(deps, '/billing?checkout=cancelled'),
      metadata: { workspace_id: w.id, plan }, subscription_data: { metadata: { workspace_id: w.id, plan } },
    });
    await audit(deps, { workspaceId: w.id, actorId: auth.userId, action: 'billing.checkout_started', ip, detail: { plan } });
    return { url: s.url };
  });
}

export async function openPortal(deps: Deps, auth: Auth) {
  const w = await workspaceRow(deps, auth.workspaceId);
  if (!w.stripe_customer_id) throw conflict('NO_BILLING_ACCOUNT', 'There is no subscription to manage yet');
  return wrap(async () => ({ url: (await requireStripe(deps).call<{ url: string }>('POST', '/v1/billing_portal/sessions', { customer: w.stripe_customer_id, return_url: appUrl(deps, '/billing') })).url }));
}

/** Maps a Stripe subscription (any status) to the workspace's plan. Past-due keeps the plan (grace while Stripe retries the payment); ended subscriptions fall back to free. */
export async function applySubscription(deps: Deps, ws: string, sub: { id: string; status: string; current_period_end?: number; customer?: string; items?: { data?: { price?: { id?: string } }[] } }): Promise<void> {
  const priceId = sub.items?.data?.[0]?.price?.id;
  const planOf: Plan | undefined = priceId && priceId === deps.config.STRIPE_PRICE_PRO ? 'pro' : priceId && priceId === deps.config.STRIPE_PRICE_BUSINESS ? 'business' : undefined;
  const live = ['active', 'trialing', 'past_due'].includes(sub.status);
  const end = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
  if (live && !planOf) {
    deps.log.warn('stripe subscription with an unknown price: plan not changed', { workspace: ws, price: priceId });
    return;
  }
  const w = await workspaceRow(deps, ws);
  const next: Plan = live ? planOf! : 'free';
  await deps.db.run('UPDATE workspaces SET plan = ?, plan_status = ?, plan_period_end = ?, stripe_subscription_id = ?, stripe_customer_id = COALESCE(?, stripe_customer_id) WHERE id = ?', next, live ? sub.status : 'canceled', end, live ? sub.id : null, sub.customer ?? null, ws);
  if (w.plan !== next) await audit(deps, { workspaceId: ws, actorId: 'stripe', action: 'billing.plan_changed', detail: { from: w.plan, to: next, status: sub.status } });
}
