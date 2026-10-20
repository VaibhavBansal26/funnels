import { StripeClient } from '../../src/payments/stripe.js';

/**
 * An in-process fake of the Stripe API endpoints Funnels uses, modelled on Stripe's documentation. It keeps state (accounts, sessions, payment intents, refunds,
 * customers, subscriptions), honours idempotency keys and the Stripe-Account header, and has switches to make things fail. It is NOT Stripe: the tests prove this
 * code does what it intends against the documented contract; running it against Stripe's test mode is the remaining step (docs/STRIPE.md).
 */
export interface Call {
  method: string;
  path: string;
  params: Record<string, string>;
  account?: string;
  idempotencyKey?: string;
}

type Obj = Record<string, any>;

export class FakeStripe {
  calls: Call[] = [];
  accounts = new Map<string, Obj>();
  sessions = new Map<string, Obj>();
  intents = new Map<string, Obj>();
  refunds = new Map<string, Obj>();
  customers = new Map<string, Obj>();
  subscriptions = new Map<string, Obj>();
  private idem = new Map<string, Obj>();
  private n = 0;
  /** Next off-session PaymentIntent: 'decline' (card_error) or 'action' (requires_action). */
  nextIntent: 'ok' | 'decline' | 'action' = 'ok';
  failRefund: { status: number; code?: string } | null = null;
  down = false;

  readonly fetch = (async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const params: Record<string, string> = {};
    const raw = method === 'GET' ? u.searchParams : new URLSearchParams(String(init.body ?? ''));
    for (const [k, v] of raw) params[k] = v;
    const account = init.headers['stripe-account'];
    const idempotencyKey = init.headers['idempotency-key'];
    this.calls.push({ method, path: u.pathname, params, account, idempotencyKey });
    if (this.down) return this.err(500, 'api_error', undefined, 'Stripe is down');
    const key = idempotencyKey ? `${method} ${u.pathname} ${idempotencyKey}` : null;
    if (key && this.idem.has(key)) return this.ok(this.idem.get(key)!);
    const res = this.route(method, u.pathname, params, account);
    if (res instanceof Response) return res;
    if (key) this.idem.set(key, res);
    return this.ok(res);
  }) as unknown as typeof fetch;

  readonly client = new StripeClient({ secretKey: 'sk_test_fake', base: 'https://stripe.test', fetch: this.fetch });

  private ok = (o: Obj) => new Response(JSON.stringify(o), { status: 200 });
  private err = (status: number, type: string, code: string | undefined, message: string, decline?: string) =>
    new Response(JSON.stringify({ error: { type, code, message, decline_code: decline } }), { status });
  private id = (p: string) => `${p}_${String(++this.n).padStart(6, '0')}`;

  private route(method: string, path: string, p: Record<string, string>, account?: string): Obj | Response {
    let m: RegExpMatchArray | null;
    if (method === 'POST' && path === '/v1/accounts') {
      const id = this.id('acct_test');
      this.accounts.set(id, { id, charges_enabled: false, payouts_enabled: false, details_submitted: false, requirements: { currently_due: ['external_account'] }, metadata: { workspace_id: p['metadata[workspace_id]'] } });
      return this.accounts.get(id)!;
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/accounts\/(\w+)$/))) return this.accounts.get(m[1]!) ?? this.err(404, 'invalid_request_error', 'resource_missing', 'No such account');
    if (method === 'POST' && path === '/v1/account_links') return { url: `https://connect.stripe.test/setup/${p.account}`, object: 'account_link' };
    if (method === 'POST' && path === '/v1/customers') {
      const id = this.id('cus');
      this.customers.set(id, { id, email: p.email, metadata: { workspace_id: p['metadata[workspace_id]'] } });
      return this.customers.get(id)!;
    }
    if (method === 'POST' && path === '/v1/billing_portal/sessions') return { url: `https://billing.stripe.test/portal/${p.customer}` };
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      const id = this.id('cs_test');
      let total = 0;
      for (let i = 0; p[`line_items[${i}][quantity]`] !== undefined; i++) total += Number(p[`line_items[${i}][quantity]`]) * Number(p[`line_items[${i}][price_data][unit_amount]`] ?? 0);
      const s: Obj = { id, url: `https://checkout.stripe.test/c/${id}`, mode: p.mode, status: 'open', payment_status: 'unpaid', amount_total: total, currency: p['line_items[0][price_data][currency]'] ?? 'usd', customer: p.customer ?? null, payment_intent: null, metadata: { checkout_id: p['metadata[checkout_id]'], workspace_id: p['metadata[workspace_id]'] }, params: p, account };
      this.sessions.set(id, s);
      return s;
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/checkout\/sessions\/(\w+)$/))) {
      const s = this.sessions.get(m[1]!);
      if (!s) return this.err(404, 'invalid_request_error', 'resource_missing', 'No such session');
      if (account && s.account !== account) return this.err(404, 'invalid_request_error', 'resource_missing', 'No such session for this account');
      return { ...s, payment_intent: p['expand[0]'] === 'payment_intent' && s.payment_intent ? this.intents.get(s.payment_intent) : s.payment_intent };
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/subscriptions\/(\w+)$/))) return this.subscriptions.get(m[1]!) ?? this.err(404, 'invalid_request_error', 'resource_missing', 'No such subscription');
    if (method === 'POST' && path === '/v1/payment_intents') {
      if (this.nextIntent === 'decline') {
        this.nextIntent = 'ok';
        return this.err(402, 'card_error', 'card_declined', 'Your card was declined.', 'insufficient_funds');
      }
      const id = this.id('pi');
      const action = this.nextIntent === 'action';
      this.nextIntent = 'ok';
      this.intents.set(id, { id, amount: Number(p.amount), currency: p.currency, status: action ? 'requires_action' : 'succeeded', payment_method: p.payment_method, customer: p.customer, refunded: 0, account, params: p });
      return this.intents.get(id)!;
    }
    if (method === 'POST' && (m = path.match(/^\/v1\/payment_intents\/(\w+)\/cancel$/))) {
      const pi = this.intents.get(m[1]!);
      if (pi) pi.status = 'canceled';
      return pi ?? this.err(404, 'invalid_request_error', 'resource_missing', 'No such payment intent');
    }
    if (method === 'POST' && path === '/v1/refunds') {
      if (this.failRefund) {
        const f = this.failRefund;
        return this.err(f.status, 'invalid_request_error', f.code, 'Refund refused by the fake');
      }
      const pi = this.intents.get(p.payment_intent!);
      if (!pi) return this.err(404, 'invalid_request_error', 'resource_missing', 'No such payment intent');
      const amount = Number(p.amount ?? pi.amount - pi.refunded);
      if (pi.refunded >= pi.amount) return this.err(400, 'invalid_request_error', 'charge_already_refunded', 'Charge already refunded');
      if (pi.refunded + amount > pi.amount) return this.err(400, 'invalid_request_error', 'amount_too_large', 'Refund amount is greater than the charge');
      pi.refunded += amount;
      const id = this.id('re');
      this.refunds.set(id, { id, amount, payment_intent: pi.id, reason: p.reason ?? null });
      return this.refunds.get(id)!;
    }
    return this.err(404, 'invalid_request_error', 'resource_missing', `Unknown endpoint ${method} ${path}`);
  }

  // ---- scenario helpers ----------------------------------------------------------------------------------------------------------------------------

  /** Account finished onboarding. */
  enable(accountId: string): void {
    Object.assign(this.accounts.get(accountId)!, { charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: { currently_due: [] } });
  }

  /** The visitor paid: the session is complete and has a PaymentIntent and customer. */
  pay(sessionId: string): Obj {
    const s = this.sessions.get(sessionId)!;
    const pi = this.id('pi');
    this.intents.set(pi, { id: pi, amount: s.amount_total, currency: s.currency, status: 'succeeded', payment_method: this.id('pm'), customer: s.customer ?? this.id('cus'), refunded: 0, account: s.account });
    Object.assign(s, { status: 'complete', payment_status: 'paid', payment_intent: pi, customer: this.intents.get(pi)!.customer });
    return s;
  }

  subscription(o: { id?: string; status?: string; price: string; customer: string; workspace: string; periodEnd?: number }): Obj {
    const id = o.id ?? this.id('sub');
    const sub = { id, status: o.status ?? 'active', customer: o.customer, current_period_end: o.periodEnd ?? 1_800_000_000, items: { data: [{ price: { id: o.price } }] }, metadata: { workspace_id: o.workspace } };
    this.subscriptions.set(id, sub);
    return sub;
  }

  called(method: string, path: RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && path.test(c.path));
  }
}
