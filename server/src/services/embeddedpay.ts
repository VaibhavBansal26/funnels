import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PLAN_DEFS } from '../billing/plans.js';
import type { CheckoutBlock } from '../blocks/index.js';
import type { Deps } from '../deps.js';
import { inTx } from '../db/scope.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import type { CommerceBlock } from '../pagemodel/shared/clean.js';
import { StripeApiError } from '../payments/stripe.js';
import type { Plan } from '../ratelimit/types.js';
import type { FunnelRow, StepRow } from '../repos/types.js';
import { newId } from '../util/ids.js';
import { formatMinor, fromMinor, stripeAmount } from '../util/money.js';
import { cartLines, closeCart, findCart, selectedBumps, setCartBumps, type CartRow } from './cart.js';
import { checkQuantity, resolveOffer, type Offer } from './catalogcheckout.js';
import { enqueueConversions } from './conversions.js';
import { isBot } from './events.js';
import { serializeLine, type OrderRow } from './orders.js';
import { paymentSettings } from './paymentsettings.js';
import { EMAIL_RE, resolveCommerceBlock, sanitizeUtms } from './publicblocks.js';
import { insertEvents } from './rollups.js';
import { accountOf, funnelWantsUpsell, ordersFromItems, persistPurchase, requireStripe, returnUrls, startHostedCheckout, type Item } from './stripepay.js';

/**
 * The Payment form (docs/STRIPE.md#embedded-payment-form): the order summary and the card fields on the funnel's own page.
 *
 * With Stripe, the server creates ONE PaymentIntent per attempt on the workspace's connected account (direct charge, `Stripe-Account`, application fee by plan,
 * idempotency key per attempt and quote version). The amount is computed here from the catalog (the cart lines or the chosen price, plus the selected order bumps)
 * and NEVER read from the browser; the browser only receives the client secret, mounts Stripe's Payment Element (card data stays in Stripe's iframe: PCI SAQ A) and
 * confirms with Stripe.js, which also runs 3-D Secure. Orders are created exactly once by whichever arrives first: the Connect webhook `payment_intent.succeeded`
 * or the browser's completion call (or the return URL after a 3-D Secure redirect). All three re-read the PaymentIntent from Stripe and compare amount and currency
 * with the stored quote before inserting orders under a unique key per attempt and line.
 *
 * Without Stripe (`PAYMENTS_PROVIDER=mock`) the beacon renders a labelled TEST card form whose numbers never leave the browser: it maps the documented test cards to an
 * outcome (success, decline, authentication) and only that outcome is sent here.
 *
 * UNVERIFIED against the real Stripe API: tested against the in-process fake (test/support/fakestripe.ts).
 */
type PaymentBlock = Extract<CommerceBlock, { type: 'payment' }>;

const AddressInput = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(1).max(20),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'Use the 2-letter country code'),
  state: z.string().trim().max(100).optional(),
});

export const PayInput = z.object({
  token: z.string().max(200).optional(),
  visitorId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  attemptId: z.string().regex(/^pay_[A-Za-z0-9_-]{6,60}$/).optional(),
  /** Order bumps of this page the visitor ticked. Absent on the first call of a cart Payment form: the bumps chosen in the Cart are used. */
  bumpBlockIds: z.array(z.string().max(64)).max(10).optional(),
  quantity: z.number().int().min(1).max(99).optional(),
  /** Sent when the visitor presses Pay: validated here before any confirmation. */
  contact: z.object({ email: z.string().trim().max(254), name: z.string().trim().max(120).optional(), address: z.unknown().optional() }).optional(),
  /** Use Stripe's hosted Checkout (the block's mode, or the page cannot run Stripe.js). */
  hosted: z.boolean().optional(),
  _hp: z.string().max(200).optional(),
  utms: z.unknown().optional(),
  url: z.string().max(500).optional(),
  preview: z.boolean().optional(),
});

export const CompleteInput = z.object({
  attemptId: z.string().regex(/^pay_[A-Za-z0-9_-]{6,60}$/),
  /** TEST form only (no Stripe): the outcome of the test card, decided in the browser from the documented test numbers. Never a card number. */
  test: z.enum(['success', 'decline', 'authenticate']).optional(),
  /** TEST form only: the visitor completed (true) or failed (false) the simulated authentication. */
  authenticated: z.boolean().optional(),
  preview: z.boolean().optional(),
});

interface AttemptRow {
  id: string;
  workspace_id: string;
  funnel_id: string;
  step_id: string;
  block_id: string;
  cart_id: string | null;
  cart_version: number | null;
  provider: 'stripe' | 'mock';
  stripe_account: string | null;
  stripe_intent_id: string | null;
  stripe_customer: string | null;
  items_json: string;
  bumps_json: string;
  amount: number;
  currency: string;
  fee: number;
  email: string | null;
  name: string | null;
  address_json: string | null;
  visitor_id: string | null;
  utms_json: string | null;
  next_url: string | null;
  cancel_url: string | null;
  status: 'open' | 'succeeded' | 'failed' | 'canceled';
  last_error: string | null;
  version: number;
  created_at: string;
}

interface StripeIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  client_secret?: string;
  payment_method: string | { id: string } | null;
  customer: string | { id: string } | null;
  last_payment_error?: { code?: string; decline_code?: string; message?: string } | null;
  metadata?: Record<string, string>;
}

/** What the form shows: the lines the server priced, never anything the browser computed. */
export interface Summary {
  lines: { name: string; productId: string | null; quantity: number; amount: number; total: string; role: string; unitValue: number }[];
  currency: string;
  total: number;
  totalFormatted: string;
  /** The total in major units (for the browser pixels). */
  value: number;
}

export interface QuoteAnswer {
  ok: true;
  provider: 'stripe' | 'mock' | 'preview';
  mode: 'embedded' | 'hosted';
  attemptId: string | null;
  summary: Summary;
  bumpBlockIds: string[];
  stripe?: { publishableKey: string; account: string; clientSecret: string };
  /** Where Stripe.js sends the buyer after a 3-D Secure redirect (this API; it finishes the order and redirects to the next step). */
  returnUrl?: string;
  /** Shared with the browser pixel (fn:begin_checkout) for deduplication against the server-side InitiateCheckout. */
  eventId?: string;
  /** Hosted mode: send the visitor here. */
  redirect?: string;
  /** Mock hosted mode records the orders at once. */
  orderId?: string;
  orders?: ReturnType<typeof serializeLine>[];
  recorded?: boolean;
}

const lower = (c: string) => c.toLowerCase();
const plan = async (deps: Deps, ws: string) => ((await deps.db.get<{ plan: Plan }>('SELECT plan FROM workspaces WHERE id = ?', ws))?.plan ?? 'free') as Plan;
const idOf = (v: string | { id: string } | null | undefined): string | null => (typeof v === 'string' ? v : v?.id ?? null);

/** A Payment form presented to the checkout helpers that expect a checkout block (only these fields are read). */
const asCheckoutBlock = (b: PaymentBlock): CheckoutBlock => ({ id: b.id, type: 'checkout', productName: b.productName, description: b.description, price: b.price, currency: b.currency, buttonLabel: b.buttonLabel, orderBump: false, oneClickUpsell: false, success: b.success, productId: b.productId, priceId: b.priceId, quantity: b.quantity, interval: b.interval, trialDays: b.trialDays });

/** Prices what this Payment form would charge right now: the chosen product (or the cart, re-read from the catalog) plus the selected bumps of this page. */
async function priceBasket(deps: Deps, c: { ws: string; block: PaymentBlock; doc: { products: CheckoutBlock[] }; cart: CartRow | undefined; bumpIds: string[]; quantity?: number }): Promise<Offer[]> {
  const offers: Offer[] = [];
  if (c.block.source === 'product') {
    if (!c.block.priceId) throw new AppError(409, 'PRODUCT_UNAVAILABLE', 'This product is not set up yet: the page owner must choose a product and save the page');
    const o = await resolveOffer(deps, c.ws, asCheckoutBlock(c.block), checkQuantity(asCheckoutBlock(c.block), c.quantity));
    offers.push({ ...o, role: 'main', lineKey: 'main' });
  } else {
    if (!c.cart) throw conflict('CART_EMPTY', 'Your cart is empty');
    const lines = await cartLines(deps, c.cart);
    if (!lines.length) throw conflict('CART_EMPTY', 'Your cart is empty');
    for (const l of lines) {
      if (!l.available || !l.product || !l.price) throw conflict('PRODUCT_UNAVAILABLE', `${l.product?.name ?? 'A product in your cart'} is no longer available: remove it from your cart to continue`, { itemId: l.item.id });
      offers.push({
        blockId: c.block.id, lineKey: `ci_${l.item.id}`, role: 'cart', productId: l.product.id, priceId: l.price.id, stripeProductId: l.product.stripe_product_id, stripePriceId: l.price.stripe_price_id, stripeAccountId: l.price.stripe_account_id,
        name: l.product.name, description: l.product.description || undefined, unitAmount: l.price.unit_amount, currency: l.price.currency, quantity: l.item.quantity, recurring: null, taxCode: l.product.tax_code,
      });
    }
  }
  for (const id of new Set(c.bumpIds)) {
    const b = c.doc.products.find((p) => p.id === id);
    if (!b || !b.orderBump) throw badRequest('INVALID_BUMP', 'Unknown order bump');
    offers.push({ ...(await resolveOffer(deps, c.ws, b, 1)), lineKey: `bump_${b.id}` });
  }
  if (new Set(offers.map((o) => o.currency)).size > 1) throw badRequest('MIXED_CURRENCY', 'The order and its bumps must use the same currency');
  if (offers.some((o) => o.unitAmount * o.quantity <= 0)) throw badRequest('NOT_PURCHASABLE', 'A free offer cannot be paid for');
  return offers;
}

const itemsOf = (offers: Offer[]): Item[] => offers.map((o) => ({ blockId: o.blockId, lineKey: o.lineKey, productName: o.name, description: o.description, amountCents: o.unitAmount * o.quantity, unitAmount: o.unitAmount, quantity: o.quantity, currency: o.currency, bump: o.role === 'bump', role: o.role, productId: o.productId, priceId: o.priceId, recurring: o.recurring }));

function summaryOf(items: Item[]): Summary {
  const currency = items[0]?.currency ?? 'USD';
  const total = items.reduce((a, i) => a + i.amountCents, 0);
  return {
    lines: items.map((i) => ({ name: i.productName, productId: i.productId ?? null, quantity: i.quantity ?? 1, amount: i.amountCents, total: formatMinor(i.amountCents, i.currency), role: i.role ?? 'main', unitValue: fromMinor(i.unitAmount ?? i.amountCents, i.currency) })),
    currency, total, totalFormatted: formatMinor(total, currency), value: fromMinor(total, currency),
  };
}

function checkContact(block: PaymentBlock, contact: NonNullable<z.infer<typeof PayInput>['contact']>) {
  const fields: Record<string, string> = {};
  const email = contact.email.trim();
  if (!EMAIL_RE.test(email)) fields.email = 'Enter a valid email address';
  let address: z.infer<typeof AddressInput> | null = null;
  if (block.collectAddress) {
    const r = AddressInput.safeParse(contact.address);
    if (r.success) address = { ...r.data, country: r.data.country.toUpperCase() };
    else for (const i of r.error.issues) fields[String(i.path[0] ?? 'address')] = i.path[0] === 'country' ? 'Use the 2-letter country code (for example US)' : 'Required';
  }
  if (Object.keys(fields).length) throw new AppError(422, 'VALIDATION_ERROR', Object.values(fields)[0]!, { fields });
  return { email: email.toLowerCase(), name: contact.name?.trim() || null, address };
}

/**
 * Creates or re-quotes the attempt of a Payment form. Called when the form appears (to mount the card fields), when an order bump is ticked (the amount of the
 * PaymentIntent is updated to the new server-side quote) and when the visitor presses Pay (with the contact details, validated here). Hosted mode answers a redirect.
 */
export async function quotePayment(deps: Deps, p: { funnelId: string; stepId: string; blockId: string; input: z.infer<typeof PayInput>; userAgent?: string }): Promise<QuoteAnswer> {
  const { funnel, step, block, workspaceId: ws, doc } = await resolveCommerceBlock(deps, p.funnelId, p.stepId, p.blockId, 'payment');
  const input = p.input;
  const cart = block.source === 'cart' ? await findCart(deps, funnel, input) : undefined;
  const cartBumps = cart ? selectedBumps(cart).filter((b) => b.stepId === step.id).map((b) => b.blockId).filter((id) => doc.products.some((x) => x.id === id && x.orderBump)) : [];
  const bumpIds = [...new Set(input.bumpBlockIds ?? cartBumps)];
  if (input._hp) return { ok: true, provider: 'preview', mode: block.mode, attemptId: null, summary: { lines: [], currency: 'USD', total: 0, totalFormatted: '', value: 0 }, bumpBlockIds: [] };
  const offers = await priceBasket(deps, { ws, block, doc, cart, bumpIds, quantity: input.quantity });
  const items = itemsOf(offers);
  const summary = summaryOf(items);
  if (input.preview) return { ok: true, provider: 'preview', mode: block.mode, attemptId: null, summary, bumpBlockIds: bumpIds };
  if (cart && input.bumpBlockIds) await setCartBumps(deps, cart.id, step.id, bumpIds);
  const contact = input.contact ? checkContact(block, input.contact) : null;
  const stripeMode = deps.config.PAYMENTS_PROVIDER === 'stripe';
  // Without a publishable key the browser cannot run the Payment Element: the form uses hosted Checkout instead (documented fallback).
  const hosted = block.mode === 'hosted' || input.hosted === true || (stripeMode && !deps.config.STRIPE_PUBLISHABLE_KEY) || offers.some((o) => o.recurring);
  if (offers.some((o) => o.recurring) && !stripeMode) throw conflict('SUBSCRIPTION_NEEDS_STRIPE', 'Subscriptions need Stripe payments');

  if (hosted) {
    if (!contact) return { ok: true, provider: stripeMode ? 'stripe' : 'mock', mode: 'hosted', attemptId: null, summary, bumpBlockIds: bumpIds };
    if (stripeMode) {
      const r = await startHostedCheckout(deps, { ws, funnel, step, block: { id: block.id, productName: block.title || block.productName, success: block.success }, offers, email: contact.email, name: contact.name, visitorId: input.visitorId, utms: input.utms, cartId: cart?.id ?? null });
      return { ok: true, provider: 'stripe', mode: 'hosted', attemptId: null, summary, bumpBlockIds: bumpIds, redirect: r.redirect };
    }
    // Test payments: the order is recorded at once, as with a Checkout block.
    const attempt = await createAttempt(deps, { ws, funnel, step, block, cart, items, summary, bumpIds, provider: 'mock', input, fee: 0 });
    await saveContact(deps, attempt.id, contact);
    const done = await completeMock(deps, (await getAttempt(deps, attempt.id))!, { test: 'success' });
    return { ok: true, provider: 'mock', mode: 'hosted', attemptId: attempt.id, summary, bumpBlockIds: bumpIds, recorded: true, orderId: done.orderId, orders: done.orders };
  }

  const fee = stripeMode ? Math.floor((summary.total * PLAN_DEFS[await plan(deps, ws)].feeBps) / 10_000) : 0;
  let attempt = input.attemptId ? await getAttempt(deps, input.attemptId) : undefined;
  if (attempt && (attempt.funnel_id !== funnel.id || attempt.block_id !== block.id || attempt.status !== 'open' || (attempt.visitor_id && input.visitorId && attempt.visitor_id !== input.visitorId) || Date.parse(attempt.created_at) < deps.now().getTime() - 24 * 3_600_000)) attempt = undefined;
  if (attempt?.status === 'open' && (await ordersOf(deps, attempt)).length) attempt = undefined;
  if (attempt && attempt.provider !== (stripeMode ? 'stripe' : 'mock')) attempt = undefined;
  if (attempt && stripeMode && !attempt.stripe_intent_id) attempt = undefined; // its PaymentIntent was never created (Stripe failed): start again
  let created = false;
  if (!stripeMode) {
    if (!attempt) {
      attempt = await createAttempt(deps, { ws, funnel, step, block, cart, items, summary, bumpIds, provider: 'mock', input, fee: 0 });
      created = true;
    } else await requote(deps, attempt, { items, summary, bumpIds, cart, fee: 0 });
    if (contact) await saveContact(deps, attempt.id, contact);
    if (created) await beginCheckout(deps, { ws, funnel, step, attempt, summary, items, input, userAgent: p.userAgent });
    return { ok: true, provider: 'mock', mode: 'embedded', attemptId: attempt.id, summary, bumpBlockIds: bumpIds, eventId: `ic_${attempt.id}` };
  }

  const stripe = requireStripe(deps);
  const account = await accountOf(deps, ws);
  if (!account || !account.charges_enabled) throw conflict('STRIPE_NOT_CONNECTED', 'This store cannot take payments yet: the owner has not finished connecting Stripe');
  const urls = await returnUrls(deps, { ws, funnel, step, block: { id: block.id, productName: block.productName, success: block.success } });
  const settings = await paymentSettings(deps, ws);
  let intent!: StripeIntent;
  try {
    if (!attempt) {
      attempt = await createAttempt(deps, { ws, funnel, step, block, cart, items, summary, bumpIds, provider: 'stripe', input, fee, account: account.stripe_account_id, urls });
      created = true;
      intent = await stripe.call<StripeIntent>('POST', '/v1/payment_intents', {
        amount: stripeAmount(summary.total, summary.currency), currency: lower(summary.currency), automatic_payment_methods: { enabled: true },
        description: `${block.title || block.productName} (${funnel.name})`, ...(fee > 0 ? { application_fee_amount: fee } : {}),
        ...((await funnelWantsUpsell(deps, funnel.id)) ? { setup_future_usage: 'off_session' } : {}),
        ...(settings.statementDescriptor ? { statement_descriptor_suffix: settings.statementDescriptor.slice(0, 22) } : {}),
        metadata: { attempt_id: attempt.id, workspace_id: ws, funnel_id: funnel.id },
      }, { account: account.stripe_account_id, idempotencyKey: `pay:${attempt.id}:0` });
      await deps.db.run('UPDATE payment_attempts SET stripe_intent_id = ?, updated_at = ? WHERE id = ?', intent.id, deps.now().toISOString(), attempt.id);
      attempt = (await getAttempt(deps, attempt.id))!;
    }
    if (!created || contact) {
      const changed = attempt.amount !== summary.total || attempt.currency !== summary.currency;
      if (!created) await requote(deps, attempt, { items, summary, bumpIds, cart, fee });
      const update: Record<string, unknown> = {};
      if (changed && !created) Object.assign(update, { amount: stripeAmount(summary.total, summary.currency), currency: lower(summary.currency), ...(fee > 0 ? { application_fee_amount: fee } : {}) }); // the fee follows the amount; a 0 % plan never sets one
      if (contact) {
        const customer = attempt.stripe_customer ?? (await stripe.call<{ id: string }>('POST', '/v1/customers', { email: contact.email, ...(contact.name ? { name: contact.name } : {}), metadata: { funnels_attempt: attempt.id } }, { account: account.stripe_account_id, idempotencyKey: `cus:${attempt.id}` })).id;
        if (customer !== attempt.stripe_customer) {
          update.customer = customer;
          await deps.db.run('UPDATE payment_attempts SET stripe_customer = ? WHERE id = ?', customer, attempt.id);
        }
        if (settings.receiptEmails) update.receipt_email = contact.email;
      }
      const version = (await getAttempt(deps, attempt.id))!.version;
      if (Object.keys(update).length || !created) intent = Object.keys(update).length
        ? await stripe.call<StripeIntent>('POST', `/v1/payment_intents/${attempt.stripe_intent_id}`, update, { account: account.stripe_account_id, idempotencyKey: `pay:${attempt.id}:${version}:${createHash('sha256').update(JSON.stringify(update)).digest('hex').slice(0, 12)}` })
        : await stripe.call<StripeIntent>('GET', `/v1/payment_intents/${attempt.stripe_intent_id}`, {}, { account: account.stripe_account_id });
    }
  } catch (e) {
    if (created && attempt) await deps.db.run("UPDATE payment_attempts SET status = 'failed', last_error = ? WHERE id = ? AND stripe_intent_id IS NULL", 'provider_error', attempt.id);
    if (e instanceof StripeApiError && e.code === 'payment_intent_unexpected_state') throw conflict('ALREADY_PAID', 'This payment was already completed', { attemptId: attempt?.id });
    if (e instanceof StripeApiError) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider could not prepare the payment, try again shortly', { code: e.code });
    throw e;
  }
  if (contact) await saveContact(deps, attempt.id, contact);
  if (created) await beginCheckout(deps, { ws, funnel, step, attempt, summary, items, input, userAgent: p.userAgent });
  return {
    ok: true, provider: 'stripe', mode: 'embedded', attemptId: attempt.id, summary, bumpBlockIds: bumpIds, eventId: `ic_${attempt.id}`,
    stripe: { publishableKey: deps.config.STRIPE_PUBLISHABLE_KEY!, account: account.stripe_account_id, clientSecret: intent.client_secret ?? '' },
    returnUrl: `${deps.config.APP_PUBLIC_URL.replace(/\/$/, '')}/api/public/pay/return?attempt=${attempt.id}`,
  };
}

async function createAttempt(deps: Deps, c: { ws: string; funnel: FunnelRow; step: StepRow; block: PaymentBlock; cart: CartRow | undefined; items: Item[]; summary: Summary; bumpIds: string[]; provider: 'stripe' | 'mock'; input: z.infer<typeof PayInput>; fee: number; account?: string; urls?: { nextUrl: string; cancelUrl: string } }): Promise<AttemptRow> {
  const id = newId('pay');
  const at = deps.now().toISOString();
  await deps.db.run(
    `INSERT INTO payment_attempts (id, workspace_id, funnel_id, step_id, block_id, cart_id, cart_version, provider, stripe_account, items_json, bumps_json, amount, currency, fee, visitor_id, utms_json, next_url, cancel_url, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)`,
    id, c.ws, c.funnel.id, c.step.id, c.block.id, c.cart?.id ?? null, c.cart?.version ?? null, c.provider, c.account ?? null, JSON.stringify(c.items), JSON.stringify(c.bumpIds), c.summary.total, c.summary.currency, c.fee,
    c.input.visitorId ?? null, c.input.utms ? JSON.stringify(sanitizeUtms(c.input.utms)) : null, c.urls?.nextUrl ?? null, c.urls?.cancelUrl ?? null, at, at,
  );
  return (await getAttempt(deps, id))!;
}

async function requote(deps: Deps, a: AttemptRow, q: { items: Item[]; summary: Summary; bumpIds: string[]; cart: CartRow | undefined; fee: number }) {
  await deps.db.run(
    "UPDATE payment_attempts SET items_json = ?, bumps_json = ?, amount = ?, currency = ?, fee = ?, cart_version = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'open'",
    JSON.stringify(q.items), JSON.stringify(q.bumpIds), q.summary.total, q.summary.currency, q.fee, q.cart?.version ?? null, deps.now().toISOString(), a.id,
  );
}

const saveContact = (deps: Deps, id: string, c: { email: string; name: string | null; address: unknown }) =>
  deps.db.run('UPDATE payment_attempts SET email = ?, name = ?, address_json = ?, updated_at = ? WHERE id = ?', c.email, c.name, c.address ? JSON.stringify(c.address) : null, deps.now().toISOString(), id);

const getAttempt = (deps: Deps, id: string) => deps.db.get<AttemptRow>('SELECT * FROM payment_attempts WHERE id = ?', id);
const ordersOf = (deps: Deps, a: Pick<AttemptRow, 'workspace_id' | 'id'>) => deps.db.all<OrderRow>('SELECT * FROM orders WHERE workspace_id = ? AND idem_key LIKE ? ORDER BY created_at, id', a.workspace_id, `pi:${a.id}:%`);

/** begin_checkout: one funnel event (rollup counter) and one server-side InitiateCheckout per attempt. Previews and bots record nothing. */
async function beginCheckout(deps: Deps, c: { ws: string; funnel: FunnelRow; step: StepRow; attempt: AttemptRow; summary: Summary; items: Item[]; input: z.infer<typeof PayInput>; userAgent?: string }) {
  if (c.input.preview || isBot(c.userAgent)) return;
  await inTx(deps, async (d) => {
    await insertEvents(d.db, [{
      id: newId('evt'), workspace_id: c.ws, funnel_id: c.funnel.id, step_id: c.step.id, type: 'begin_checkout', visitor_id: c.input.visitorId ?? null, unique_visit: 0, lead_id: null, order_id: null,
      external_id: `checkout:${c.attempt.id}`, amount_cents: 0, currency: null, utm_json: JSON.stringify(sanitizeUtms(c.input.utms)), url: c.input.url ?? null, created_at: d.now().toISOString(),
    }]);
    await enqueueConversions(d, {
      ws: c.ws, funnelId: c.funnel.id, stepId: c.step.id, kind: 'InitiateCheckout', eventId: `ic_${c.attempt.id}`, visitorId: c.input.visitorId, currency: c.summary.currency, value: fromMinor(c.summary.total, c.summary.currency),
      items: c.items.map((i) => ({ id: i.productId ?? i.blockId, name: i.productName, quantity: i.quantity ?? 1, price: fromMinor(i.unitAmount ?? i.amountCents, i.currency) })), user: { email: '' },
    });
  });
}

export interface CompleteAnswer {
  ok: true;
  /** The card needs (simulated) authentication: show the test dialog, then call again with `authenticated`. */
  requiresAction?: boolean;
  /** Stripe is still processing the payment: ask again shortly. */
  pending?: boolean;
  orderId?: string;
  orders?: ReturnType<typeof serializeLine>[];
  recorded?: boolean;
}

const failed = (reason: string, message?: string) => new AppError(402, 'PAYMENT_FAILED', message ?? (reason === 'authentication_failed' || reason === 'authentication_required' ? 'The card could not be authenticated. Please try again or use another card.' : 'Your card was declined. Please try another card.'), { reason });

/** The browser reports that the payment went through (Stripe.js confirmed it, or the TEST form's outcome). Idempotent: a second call returns the same orders. */
export async function completePayment(deps: Deps, input: z.infer<typeof CompleteInput>): Promise<CompleteAnswer> {
  const a = await getAttempt(deps, input.attemptId);
  if (!a) throw notFound('Payment');
  const have = await ordersOf(deps, a);
  if (have.length) return { ok: true, recorded: false, orderId: have[0]!.id, orders: have.map(serializeLine) };
  if (a.status === 'canceled') throw conflict('CART_ALREADY_PAID', 'This cart was already paid in another tab or window');
  if (a.provider === 'mock') return completeMock(deps, a, input);
  const r = await finalizeAttempt(deps, a.stripe_intent_id ?? '', a.stripe_account ?? undefined);
  if (!r) throw notFound('Payment');
  if (r.status === 'paid') return { ok: true, recorded: true, orderId: r.orders[0]?.id, orders: r.orders.map(serializeLine) };
  if (r.status === 'processing') return { ok: true, pending: true };
  throw failed(r.reason ?? r.status);
}

async function completeMock(deps: Deps, a: AttemptRow, input: Pick<z.infer<typeof CompleteInput>, 'test' | 'authenticated'>): Promise<CompleteAnswer> {
  if (!a.email) throw new AppError(422, 'VALIDATION_ERROR', 'Enter your email address', { fields: { email: 'Enter a valid email address' } });
  const note = (error: string) => deps.db.run('UPDATE payment_attempts SET last_error = ?, updated_at = ? WHERE id = ?', error, deps.now().toISOString(), a.id);
  if (input.test === 'decline') {
    await note('card_declined');
    throw failed('card_declined');
  }
  if (input.test === 'authenticate' && input.authenticated === undefined) return { ok: true, requiresAction: true };
  if (input.test === 'authenticate' && !input.authenticated) {
    await note('authentication_failed');
    throw failed('authentication_failed');
  }
  if (!input.test) throw badRequest('TEST_OUTCOME_REQUIRED', 'Use one of the test cards');
  const charge = await deps.payments.charge({ amountCents: a.amount, currency: a.currency, description: `Order ${a.id}`, customer: { email: a.email, name: a.name ?? undefined }, idempotencyKey: a.id });
  if (charge.status === 'failed') {
    await note(charge.reason);
    throw failed(charge.reason);
  }
  const orders = await recordOrders(deps, a, { provider: deps.payments.name, ref: charge.providerRef, paymentMethod: charge.paymentMethodRef, customer: null, account: null });
  return { ok: true, recorded: true, orderId: orders[0]?.id, orders: orders.map(serializeLine) };
}

async function recordOrders(deps: Deps, a: AttemptRow, pay: { provider: string; ref: string; paymentMethod: string | null; customer: string | null; account: string | null }): Promise<OrderRow[]> {
  const items = JSON.parse(a.items_json) as Item[];
  const at = deps.now().toISOString();
  const created = ordersFromItems(deps, { ws: a.workspace_id, funnelId: a.funnel_id, stepId: a.step_id, email: a.email ?? '', name: a.name, idemPrefix: `pi:${a.id}`, at }, items, items.map(() => 0), pay);
  const orders = await persistPurchase(deps, { ws: a.workspace_id, funnelId: a.funnel_id, stepId: a.step_id, email: a.email ?? '', name: a.name, visitorId: a.visitor_id, utmsJson: a.utms_json }, created, () => ordersOf(deps, a));
  if (orders === created) {
    await deps.db.run("UPDATE payment_attempts SET status = 'succeeded', completed_at = ?, last_error = NULL, updated_at = ? WHERE id = ?", at, at, a.id);
    if (a.cart_id) {
      await closeCart(deps, a.cart_id);
      await cancelSiblings(deps, a);
    }
  }
  return orders;
}

/** Another tab may hold an unconfirmed PaymentIntent for the same cart: it is cancelled so the cart cannot be paid twice by accident. Best effort. */
async function cancelSiblings(deps: Deps, a: AttemptRow): Promise<void> {
  const others = await deps.db.all<AttemptRow>("SELECT * FROM payment_attempts WHERE cart_id = ? AND id <> ? AND status = 'open'", a.cart_id, a.id);
  for (const o of others) {
    await deps.db.run("UPDATE payment_attempts SET status = 'canceled', updated_at = ? WHERE id = ? AND status = 'open'", deps.now().toISOString(), o.id);
    if (o.provider === 'stripe' && o.stripe_intent_id && deps.stripe) await deps.stripe.call('POST', `/v1/payment_intents/${o.stripe_intent_id}/cancel`, {}, { account: o.stripe_account ?? undefined }).catch(() => undefined);
  }
}

export type Finalize = { status: 'paid'; orders: OrderRow[]; attempt: AttemptRow } | { status: 'processing' | 'requires_payment_method' | 'requires_action' | 'requires_confirmation' | 'canceled'; reason?: string; attempt: AttemptRow };

/**
 * Turns a succeeded PaymentIntent into orders, exactly once. Called by the Connect webhook (`payment_intent.succeeded`), the browser's completion call and the
 * 3-D Secure return URL, in any order and concurrently: the intent is re-read from Stripe (nothing in the request is trusted), its amount and currency must equal
 * the stored quote (otherwise 409 and the webhook is retried), and the orders carry a unique key per attempt and line.
 */
export async function finalizeAttempt(deps: Deps, intentId: string, account?: string): Promise<Finalize | null> {
  const a = await deps.db.get<AttemptRow>('SELECT * FROM payment_attempts WHERE stripe_intent_id = ?', intentId);
  if (!a || !intentId) return null;
  if (account && a.stripe_account && account !== a.stripe_account) return null; // an event of another connected account never finishes this attempt
  const have = await ordersOf(deps, a);
  if (have.length) return { status: 'paid', orders: have, attempt: a };
  const pi = await requireStripe(deps).call<StripeIntent>('GET', `/v1/payment_intents/${intentId}`, {}, { account: a.stripe_account ?? account });
  if (pi.status !== 'succeeded') {
    const reason = pi.last_payment_error?.decline_code ?? pi.last_payment_error?.code ?? (pi.status === 'requires_action' ? 'authentication_required' : undefined);
    if (reason) await deps.db.run('UPDATE payment_attempts SET last_error = ?, updated_at = ? WHERE id = ?', reason, deps.now().toISOString(), a.id);
    return { status: pi.status as never, reason, attempt: a };
  }
  if (pi.amount !== stripeAmount(a.amount, a.currency) || lower(pi.currency) !== lower(a.currency)) {
    deps.log.error('payment intent amount does not match the stored quote', { attempt: a.id, stripe: pi.amount, stored: a.amount, currency: pi.currency });
    throw new AppError(409, 'CHECKOUT_MISMATCH', 'The paid amount does not match the order');
  }
  const orders = await recordOrders(deps, a, { provider: 'stripe', ref: pi.id, paymentMethod: idOf(pi.payment_method), customer: idOf(pi.customer) ?? a.stripe_customer, account: a.stripe_account });
  return { status: 'paid', orders, attempt: a };
}

/** Webhook `payment_intent.payment_failed`: remembered on the attempt (the form shows its own error; the buyer can retry with another card). */
export async function notePaymentFailed(deps: Deps, intent: { id: string; last_payment_error?: { code?: string; decline_code?: string } | null }, account?: string): Promise<boolean> {
  const a = await deps.db.get<AttemptRow>('SELECT * FROM payment_attempts WHERE stripe_intent_id = ?', intent.id);
  if (!a || (account && a.stripe_account && a.stripe_account !== account)) return false;
  await deps.db.run('UPDATE payment_attempts SET last_error = ?, updated_at = ? WHERE id = ?', intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code ?? 'payment_failed', deps.now().toISOString(), a.id);
  return true;
}

/** The 3-D Secure return URL: finishes the order (idempotent) and sends the buyer on, with the order id for a one-click upsell. */
export async function paymentReturn(deps: Deps, attemptId: string): Promise<{ location: string } | null> {
  const a = /^pay_[A-Za-z0-9_-]{6,60}$/.test(attemptId) ? await getAttempt(deps, attemptId) : undefined;
  if (!a || a.provider !== 'stripe' || !a.stripe_intent_id) return null;
  const r = await finalizeAttempt(deps, a.stripe_intent_id, a.stripe_account ?? undefined);
  const join = (url: string, q: string) => `${url}${url.includes('?') ? '&' : '?'}${q}`;
  if (r?.status === 'paid' && a.next_url) return { location: join(a.next_url, `fn_order=${encodeURIComponent(r.orders[0]?.id ?? '')}`) };
  if (!a.cancel_url) return null;
  return { location: join(a.cancel_url.replace(/[?&]purchase=cancelled/, ''), `payment=${r?.status === 'processing' ? 'processing' : 'failed'}`) };
}
