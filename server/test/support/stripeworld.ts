import { expect } from 'vitest';
import { signStripePayload } from '../../src/payments/stripe.js';
import { activeDomain, checkoutTarget, makeHarness } from '../helpers.js';
import { FakeStripe } from './fakestripe.js';

export const PLATFORM = 'whsec_platform_secret';
export const CONNECT = 'whsec_connect_secret';
export const DESKTOP = { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' };
let evn = 0;

export async function world(over: Record<string, string> = {}) {
  const stripe = new FakeStripe();
  const env = Object.fromEntries(Object.entries(over).filter(([, v]) => v !== 'unset'));
  const unset = Object.keys(over).filter((k) => over[k] === 'unset');
  const base: Record<string, string> = { PAYMENTS_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: PLATFORM, STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT, STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_BUSINESS: 'price_business', API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', ...env };
  for (const k of unset) delete base[k];
  const h = await makeHarness({
    env: base,
    deps: { stripe: stripe.client },
  });
  const owner = await h.register();
  const hook = (source: 'platform' | 'connect', type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}, opts: { id?: string; secret?: string; t?: number } = {}) => {
    const body = JSON.stringify({ id: opts.id ?? `evt_${++evn}`, type, data: { object }, ...extra });
    const t = opts.t ?? Math.floor(h.clock.now().getTime() / 1000);
    return h.app.request(source === 'platform' ? '/api/stripe/webhook' : '/api/stripe/connect-webhook', { method: 'POST', body, headers: { 'stripe-signature': signStripePayload(opts.secret ?? (source === 'platform' ? PLATFORM : CONNECT), body, t), 'content-type': 'application/json' } });
  };
  return { h, owner, stripe, hook };
}

/** Connected, charges enabled, live funnel with the sales page (offer + bump) and the upsell step. */
export async function store(env: Record<string, string> = {}) {
  const w = await world(env);
  const { h, owner, stripe } = w;
  await h.call('POST', '/api/billing/connect/start', { token: owner.token });
  const [acct] = [...stripe.accounts.keys()];
  stripe.enable(acct!);
  await h.call('GET', '/api/billing/connect', { token: owner.token }); // refresh from Stripe
  const t = await checkoutTarget(h, owner.token);
  const d = await activeDomain(h, owner.token, 'shop.example.com');
  const live = await h.call('PATCH', `/api/funnels/${t.funnelId}`, { token: owner.token, body: { status: 'live', domain_id: d } });
  expect(live.status).toBe(200);
  const buy = (email = 'buyer@example.com', extra: object = {}) => h.call('POST', t.mainPath, { body: { email, name: 'Bea Buyer', bumpBlockIds: [t.bumpId], ...extra }, headers: DESKTOP });
  const pay = async (email?: string) => {
    const r = await buy(email);
    expect(r.status, r.text).toBe(200);
    const sid = [...stripe.sessions.keys()].at(-1)!;
    stripe.pay(sid);
    return { sid, redirect: r.json.redirect as string };
  };
  const orders = async () => h.deps.db.all<{ id: string; is_bump: number; is_upsell: number; provider: string; provider_ref: string; status: string; refunded_cents: number; disputed_lost_cents: number; amount_cents: number; payment_method_ref: string | null; provider_customer: string | null }>('SELECT * FROM orders ORDER BY created_at, id');
  return { ...w, t, acct: acct!, buy, pay, orders };
}

