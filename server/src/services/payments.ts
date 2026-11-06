import type { Deps } from '../deps.js';
import { StripeApiError } from '../payments/stripe.js';
import { applyAccount } from './billing.js';
import { paymentSettings } from './paymentsettings.js';
import { accountOf } from './stripepay.js';

/** Stripe's documented test cards (docs/STRIPE.md). Only meaningful with a test-mode key (sk_test_...). */
export const TEST_CARDS = [
  { number: '4242 4242 4242 4242', outcome: 'Payment succeeds', note: 'Any future expiry, any CVC, any postal code.' },
  { number: '4000 0000 0000 0002', outcome: 'Card declined', note: 'A declined main offer shows the decline message; a declined bump is dropped.' },
  { number: '4000 0000 0000 9995', outcome: 'Declined: insufficient funds', note: 'Also declines one-click upsells charged off-session.' },
  { number: '4000 0025 0000 3155', outcome: 'Requires 3-D Secure', note: 'Stripe Checkout shows the authentication step; one-click upsells off-session cannot answer it and are declined.' },
  { number: '4000 0000 0000 3220', outcome: '3-D Secure 2 challenge', note: 'Complete or fail the challenge in the test window.' },
] as const;

export type ConnectState = 'unavailable' | 'not_connected' | 'onboarding_incomplete' | 'restricted' | 'connected';

interface StripeAccount {
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  country?: string;
  default_currency?: string;
  requirements?: { currently_due?: string[]; disabled_reason?: string | null };
  capabilities?: Record<string, string>;
  settings?: { payments?: { statement_descriptor?: string | null }; dashboard?: { display_name?: string | null } };
}

/**
 * Everything the Payments screen and the funnel wizard need in one answer: the server's mode (test or live, from the key), the connection state, what the
 * connected account can do (charges, payouts, payment methods, currency, statement descriptor, Stripe Tax), this workspace's checkout settings and the test cards.
 * The account is refreshed from Stripe when reachable; a Stripe outage degrades to the last stored state with `stale: true`.
 */
export async function paymentsStatus(deps: Deps, ws: string) {
  const r = await paymentsStatusCore(deps, ws);
  return { ...r, embedded: embeddedReadiness(deps, r.state, !!r.connect?.chargesEnabled) };
}

/**
 * Whether Payment forms can show the card fields on the page (docs/STRIPE.md#embedded-payment-form), with the steps still to do in plain words. Without Stripe the
 * form shows the labelled TEST card form (ready, no money moves); without a publishable key it falls back to the hosted Stripe Checkout redirect.
 */
export function embeddedReadiness(deps: Deps, state: ConnectState, chargesEnabled: boolean) {
  const stripe = deps.config.PAYMENTS_PROVIDER === 'stripe';
  const publishableKey = !!deps.config.STRIPE_PUBLISHABLE_KEY;
  const steps: string[] = [];
  if (!stripe) steps.push('Payments run in test mode on this server: Payment forms show a labelled TEST card form and no money moves. The server administrator sets PAYMENTS_PROVIDER=stripe to take real payments.');
  else {
    if (!publishableKey) steps.push('The server administrator adds STRIPE_PUBLISHABLE_KEY (the pk_ key of the same mode as the secret key). Until then Payment forms send buyers to Stripe Checkout instead.');
    if (state === 'not_connected' || state === 'unavailable') steps.push('Connect your Stripe account (button above).');
    else if (!chargesEnabled) steps.push('Finish the Stripe onboarding so that charges are enabled.');
    if (!deps.config.STRIPE_CONNECT_WEBHOOK_SECRET) steps.push('The server administrator configures the Connect webhook with the events payment_intent.succeeded and payment_intent.payment_failed.');
  }
  return {
    ready: !stripe || (publishableKey && chargesEnabled),
    mode: !stripe ? ('test_form' as const) : publishableKey ? ('stripe_element' as const) : ('hosted_fallback' as const),
    publishableKey, connected: state !== 'not_connected' && state !== 'unavailable', chargesEnabled,
    webhookEvents: ['payment_intent.succeeded', 'payment_intent.payment_failed'],
    steps,
  };
}

async function paymentsStatusCore(deps: Deps, ws: string) {
  const key = deps.config.STRIPE_SECRET_KEY ?? '';
  const mode = key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : null;
  const settings = await paymentSettings(deps, ws);
  const base = {
    provider: deps.config.PAYMENTS_PROVIDER, mode, settings, testCards: mode === 'live' ? [] : TEST_CARDS,
    webhooks: { platform: !!deps.config.STRIPE_WEBHOOK_SECRET, connect: !!deps.config.STRIPE_CONNECT_WEBHOOK_SECRET },
    applicationFeeNote: 'Funnels takes an application fee per plan on each payment (see Billing).',
  };
  if (!deps.stripe) return { ...base, state: 'unavailable' as ConnectState, connect: null, account: null, stale: false };
  const row = await accountOf(deps, ws);
  if (!row) return { ...base, state: 'not_connected' as ConnectState, connect: null, account: null, stale: false };
  let a: StripeAccount | null = null;
  let stale = false;
  try {
    a = await deps.stripe.call<StripeAccount>('GET', `/v1/accounts/${row.stripe_account_id}`);
    await applyAccount(deps, row.stripe_account_id, a);
  } catch (e) {
    if (!(e instanceof StripeApiError)) throw e;
    stale = true;
  }
  let taxAvailable = false;
  if (a?.charges_enabled) {
    try {
      taxAvailable = (await deps.stripe.call<{ status?: string }>('GET', '/v1/tax/settings', {}, { account: row.stripe_account_id })).status === 'active';
    } catch {
      taxAvailable = false; // Stripe Tax is not set up (or the call is not allowed): the toggle stays off
    }
  }
  const fresh = (await accountOf(deps, ws))!;
  const due = a?.requirements?.currently_due ?? (JSON.parse((await deps.db.get<{ requirements_json: string }>('SELECT requirements_json FROM stripe_accounts WHERE workspace_id = ?', ws))?.requirements_json ?? '[]') as string[]);
  const state: ConnectState = fresh.charges_enabled ? 'connected' : !fresh.details_submitted || due.length ? 'onboarding_incomplete' : 'restricted';
  const methods = Object.entries(a?.capabilities ?? {}).filter(([, v]) => v === 'active').map(([k]) => k.replace(/_payments$/, '').replace(/_/g, ' '));
  return {
    ...base, state, stale,
    connect: { accountId: fresh.stripe_account_id, chargesEnabled: fresh.charges_enabled === 1, payoutsEnabled: fresh.payouts_enabled === 1, detailsSubmitted: fresh.details_submitted === 1, requirementsDue: due, disabledReason: a?.requirements?.disabled_reason ?? null },
    account: a ? { country: a.country ?? null, currency: a.default_currency?.toUpperCase() ?? null, paymentMethods: methods, statementDescriptor: a.settings?.payments?.statement_descriptor ?? null, displayName: a.settings?.dashboard?.display_name ?? null, taxAvailable } : null,
  };
}
