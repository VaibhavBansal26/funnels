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
  products = new Map<string, Obj>();
  prices = new Map<string, Obj>();
  /** Stripe Tax set up on the connected account. */
  taxActive = false;
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
      this.accounts.set(id, { id, country: 'US', default_currency: 'usd', capabilities: {}, settings: { payments: { statement_descriptor: 'EXAMPLE' }, dashboard: { display_name: 'Example Store' } }, charges_enabled: false, payouts_enabled: false, details_submitted: false, requirements: { currently_due: ['external_account'] }, metadata: { workspace_id: p['metadata[workspace_id]'] } });
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
    if (method === 'POST' && path === '/v1/products') {
      if (!p.name) return this.err(400, 'invalid_request_error', 'parameter_missing', 'Missing required param: name.');
      const id = this.id('prod');
      this.products.set(id, { id, name: p.name, description: p.description ?? null, active: p.active !== 'false', default_price: null, images: [], account, params: p, metadata: Object.fromEntries(Object.entries(p).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v])) });
      return this.products.get(id)!;
    }
    if ((m = path.match(/^\/v1\/products\/(\w+)$/))) {
      const prod = this.products.get(m[1]!);
      if (!prod || prod.account !== account) return this.err(404, 'invalid_request_error', 'resource_missing', 'No such product');
      if (method === 'GET') return prod;
      if (p.name !== undefined) prod.name = p.name;
      if (p.description !== undefined) prod.description = p.description || null;
      if (p.active !== undefined) prod.active = p.active === 'true';
      if (p.default_price) {
        const dp = this.prices.get(p.default_price);
        if (!dp || dp.product !== prod.id) return this.err(400, 'invalid_request_error', 'resource_missing', 'default_price must be a price of this product');
        prod.default_price = dp.id;
      }
      prod.updates = (prod.updates ?? 0) + 1;
      return prod;
    }
    if (method === 'POST' && path === '/v1/prices') {
      const prod = this.products.get(p.product ?? '');
      if (!prod || prod.account !== account) return this.err(400, 'invalid_request_error', 'resource_missing', 'No such product');
      const id = this.id('price');
      this.prices.set(id, { id, product: prod.id, currency: p.currency, unit_amount: Number(p.unit_amount), active: true, nickname: p.nickname ?? null, recurring: p['recurring[interval]'] ? { interval: p['recurring[interval]'], interval_count: Number(p['recurring[interval_count]'] ?? 1), trial_period_days: p['recurring[trial_period_days]'] ? Number(p['recurring[trial_period_days]']) : null } : null, account });
      return this.prices.get(id)!;
    }
    if (method === 'POST' && (m = path.match(/^\/v1\/prices\/(\w+)$/))) {
      const pr = this.prices.get(m[1]!);
      if (!pr || pr.account !== account) return this.err(404, 'invalid_request_error', 'resource_missing', 'No such price');
      if (p.unit_amount !== undefined || p.currency !== undefined) return this.err(400, 'invalid_request_error', 'parameter_unknown', 'Prices are immutable: unit_amount and currency cannot be changed');
      if (p.active !== undefined) pr.active = p.active === 'true';
      if (p.nickname !== undefined) pr.nickname = p.nickname || null;
      return pr;
    }
    if (method === 'GET' && path === '/v1/tax/settings') return { status: this.taxActive ? 'active' : 'pending' };
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      const id = this.id('cs_test');
      let total = 0;
      let recurring = false;
      let currency = p['line_items[0][price_data][currency]'];
      for (let i = 0; p[`line_items[${i}][quantity]`] !== undefined; i++) {
        const qty = Number(p[`line_items[${i}][quantity]`]);
        const pid = p[`line_items[${i}][price]`];
        if (pid) {
          const pr = this.prices.get(pid);
          if (!pr && !account) { recurring ||= p.mode === 'subscription'; continue; } // a platform plan price (the platform's own catalog is not modelled)
          if (!pr || pr.account !== account || !pr.active) return this.err(400, 'invalid_request_error', 'resource_missing', `No such price: ${pid}`);
          total += qty * pr.unit_amount;
          currency ??= pr.currency;
          recurring ||= !!pr.recurring;
        } else {
          total += qty * Number(p[`line_items[${i}][price_data][unit_amount]`] ?? 0);
          recurring ||= !!p[`line_items[${i}][price_data][recurring][interval]`];
        }
      }
      if (p.mode === 'payment' && recurring) return this.err(400, 'invalid_request_error', 'parameter_invalid_empty', 'You specified `payment` mode but passed a recurring price.');
      if (p.mode === 'subscription' && !recurring) return this.err(400, 'invalid_request_error', 'parameter_invalid_empty', 'You specified `subscription` mode but passed only one-time prices.');
      const s: Obj = { id, url: `https://checkout.stripe.test/c/${id}`, mode: p.mode, status: 'open', payment_status: 'unpaid', amount_total: total, amount_subtotal: total, total_details: { amount_discount: 0, amount_tax: 0 }, currency: currency ?? 'usd', customer: p.customer ?? null, payment_intent: null, subscription: null, invoice: null, allow_promotion_codes: p.allow_promotion_codes === 'true', automatic_tax: p['automatic_tax[enabled]'] === 'true', metadata: { checkout_id: p['metadata[checkout_id]'], workspace_id: p['metadata[workspace_id]'] }, params: p, account };
      this.sessions.set(id, s);
      return s;
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/checkout\/sessions\/(\w+)$/))) {
      const s = this.sessions.get(m[1]!);
      if (!s) return this.err(404, 'invalid_request_error', 'resource_missing', 'No such session');
      if (account && s.account !== account) return this.err(404, 'invalid_request_error', 'resource_missing', 'No such session for this account');
      const expanded = Object.values(p).includes('payment_intent');
      const invoice = s.invoice ? { ...s.invoice, payment_intent: Object.values(p).includes('invoice.payment_intent') && s.invoice.payment_intent ? this.intents.get(s.invoice.payment_intent) : s.invoice.payment_intent } : null;
      return { ...s, invoice, payment_intent: expanded && s.payment_intent ? this.intents.get(s.payment_intent) : s.payment_intent };
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
    Object.assign(this.accounts.get(accountId)!, { capabilities: { card_payments: 'active', transfers: 'active', link_payments: 'active' }, charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: { currently_due: [] } });
  }

  /** The visitor paid: the session is complete and has a PaymentIntent and customer. */
  pay(sessionId: string, o: { discount?: number; tax?: number } = {}): Obj {
    const s = this.sessions.get(sessionId)!;
    const sub = s.mode === 'subscription';
    const trial = sub && Number(s.params['subscription_data[trial_period_days]'] ?? 0) > 0;
    const discount = o.discount ?? 0;
    const tax = o.tax ?? 0;
    s.total_details = { amount_discount: discount, amount_tax: tax };
    s.amount_total = trial ? 0 : s.amount_subtotal - discount + tax;
    const customer = s.customer ?? this.id('cus');
    if (sub) {
      const subId = this.id('sub');
      this.subscriptions.set(subId, { id: subId, status: trial ? 'trialing' : 'active', customer, items: { data: [] } });
      Object.assign(s, { subscription: subId });
    }
    if (!trial) {
      const pi = this.id('pi');
      this.intents.set(pi, { id: pi, amount: s.amount_total, currency: s.currency, status: 'succeeded', payment_method: this.id('pm'), customer, refunded: 0, account: s.account });
      if (sub) s.invoice = { id: this.id('in'), payment_intent: pi };
      else s.payment_intent = pi;
    }
    Object.assign(s, { status: 'complete', payment_status: trial ? 'no_payment_required' : 'paid', customer });
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
