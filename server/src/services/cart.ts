import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { inTx } from '../db/scope.js';
import { AppError, badRequest, conflict } from '../errors.js';
import type { FunnelRow } from '../repos/types.js';
import { newId } from '../util/ids.js';
import { formatMinor, fromMinor } from '../util/money.js';
import { currentPrice, type PriceRow, type ProductRow } from './catalog.js';
import type { CommerceBlock } from '../pagemodel/shared/clean.js';
import { enqueueConversions } from './conversions.js';
import { isBot } from './events.js';
import { insertEvents } from './rollups.js';
import { resolveCommerceBlock, resolvePublicFunnel, sanitizeUtms, stepDoc } from './publicblocks.js';
import { catalogItem } from './catalogview.js';
import { priceOfItem } from '../pagemodel/shared/markup.js';
import { resolveOffer } from './catalogcheckout.js';

/**
 * Server-side carts (docs/PRODUCTS.md#cart). One open cart per visitor and funnel, holding catalog prices and quantities only (no email, no name: nothing personal).
 * The browser keeps a signed token (`crt_<id>.<hmac>`) in a first-party cookie of the page's own host and sends it in the body, so the same calls work on the built-in
 * address, customer domains and Cloudflare Pages hosts (cross-origin, CORS like the other public endpoints). Without a token (a sandboxed page cannot read cookies)
 * the open cart of the visitor id is used. Every change carries a client operation id: a retry or a double click changes the cart once.
 * Prices are never stored as amounts: each view and each checkout re-reads the catalog (a replaced price follows `replaced_by`).
 */
const opId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid operation id');
const base = {
  token: z.string().max(200).optional(),
  visitorId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  preview: z.boolean().optional(),
  /** The Cart block asking (its checkout step's order bumps are part of the answer). */
  cartBlock: z.object({ stepId: z.string().max(64), blockId: z.string().max(64) }).optional(),
};
export const CartViewInput = z.object({ ...base, funnelId: z.string().max(64).optional() });
export const CartAddInput = z.object({
  ...base, funnelId: z.string().max(64).optional(), opId, quantity: z.number().int().min(1).max(999).optional(), url: z.string().max(500).optional(), utms: z.unknown().optional(),
  /** Product catalog blocks only: which of its products (the server checks it against the block and reads its price from the catalog). */
  productId: z.string().regex(/^prd_[A-Za-z0-9_-]{6,60}$/, 'Invalid product id').optional(),
});
export const CartUpdateInput = z
  .object({
    ...base,
    funnelId: z.string().max(64).optional(),
    opId,
    itemId: z.string().regex(/^cti_[A-Za-z0-9_-]{6,60}$/).optional(),
    /** New quantity of the line; 0 removes it. */
    quantity: z.number().int().min(0).max(999).optional(),
    bump: z.object({ stepId: z.string().max(64), blockId: z.string().max(64), selected: z.boolean() }).optional(),
  })
  .refine((v) => (v.itemId !== undefined && v.quantity !== undefined) || v.bump !== undefined, 'Send itemId and quantity, or bump');

export interface CartRow {
  id: string;
  workspace_id: string;
  funnel_id: string;
  visitor_id: string | null;
  currency: string | null;
  status: 'open' | 'checked_out';
  bumps_json: string;
  preview: number;
  version: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface ItemRow {
  id: string;
  cart_id: string;
  product_id: string;
  price_id: string;
  quantity: number;
  created_at: string;
}

export interface CartBump { stepId: string; blockId: string }

// ---- token ------------------------------------------------------------------------------------------------------------------------------------------

const mac = (deps: Deps, id: string) => createHmac('sha256', deps.config.JWT_SECRET).update(`cart:${id}`).digest('base64url').slice(0, 32);
export const cartToken = (deps: Deps, id: string): string => `${id}.${mac(deps, id)}`;
export function cartIdOf(deps: Deps, token: string | undefined): string | null {
  if (!token) return null;
  const m = /^(crt_[A-Za-z0-9_-]{6,60})\.([A-Za-z0-9_-]{32})$/.exec(token);
  if (!m) return null;
  const want = Buffer.from(mac(deps, m[1]!));
  const got = Buffer.from(m[2]!);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1]! : null;
}

// ---- lookup -----------------------------------------------------------------------------------------------------------------------------------------

/** The visitor's open, unexpired cart in this funnel: by token first, then by visitor id. Previews keep their own carts (never mixed with live ones). */
export async function findCart(deps: Deps, funnel: Pick<FunnelRow, 'id'>, input: { token?: string; visitorId?: string; preview?: boolean }): Promise<CartRow | undefined> {
  const now = deps.now().toISOString();
  const preview = input.preview ? 1 : 0;
  const id = cartIdOf(deps, input.token);
  if (id) {
    const row = await deps.db.get<CartRow>("SELECT * FROM carts WHERE id = ? AND funnel_id = ? AND status = 'open' AND expires_at > ? AND preview = ?", id, funnel.id, now, preview);
    if (row) return row;
  }
  if (!input.visitorId) return undefined;
  return deps.db.get<CartRow>("SELECT * FROM carts WHERE funnel_id = ? AND visitor_id = ? AND status = 'open' AND expires_at > ? AND preview = ? ORDER BY updated_at DESC, id DESC LIMIT 1", funnel.id, input.visitorId, now, preview);
}

const expiry = (deps: Deps) => new Date(deps.now().getTime() + deps.config.CART_TTL_DAYS * 86_400_000).toISOString();

async function createCart(d: Deps, funnel: FunnelRow, input: { visitorId?: string; preview?: boolean }): Promise<CartRow> {
  const at = d.now().toISOString();
  const id = newId('crt');
  await d.db.run('INSERT INTO carts (id, workspace_id, funnel_id, visitor_id, currency, status, bumps_json, preview, version, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, ?, ?, ?)', id, funnel.workspace_id, funnel.id, input.visitorId ?? null, 'open', '[]', input.preview ? 1 : 0, at, at, expiry(d));
  return (await d.db.get<CartRow>('SELECT * FROM carts WHERE id = ?', id))!;
}

/** Locks the cart row for the rest of the transaction (PostgreSQL; SQLite transactions are serialised anyway) and re-reads it. */
const lockCart = (d: Deps, id: string) => d.db.get<CartRow>(`SELECT * FROM carts WHERE id = ?${d.db.dialect.forUpdate()}`, id);

const touch = (d: Deps, id: string, extra = '') => d.db.run(`UPDATE carts SET version = version + 1, updated_at = ?, expires_at = ?${extra} WHERE id = ?`, d.now().toISOString(), expiry(d), id);

/** Claims a client operation id for the cart. False when it was applied before (the caller answers with the cart as it is). */
async function claimOp(d: Deps, cartId: string, op: string): Promise<boolean> {
  const r = await d.db.run(`INSERT INTO cart_ops (cart_id, op_id, created_at) VALUES (?, ?, ?)${d.db.dialect.onConflictDoNothing()}`, cartId, op, d.now().toISOString());
  return r.changes === 1;
}

// ---- pricing ----------------------------------------------------------------------------------------------------------------------------------------

export interface CartLine {
  item: ItemRow;
  product: ProductRow | null;
  price: PriceRow | null;
  /** The product is active and the price (or its successor) can still be bought. */
  available: boolean;
}

/** The cart's items with their CURRENT catalog price (a replaced price is followed to its successor). */
export async function cartLines(deps: Deps, cart: CartRow): Promise<CartLine[]> {
  const items = await deps.db.all<ItemRow>('SELECT * FROM cart_items WHERE cart_id = ? ORDER BY created_at, id', cart.id);
  const out: CartLine[] = [];
  for (const item of items) {
    const found = await currentPrice(deps, cart.workspace_id, item.price_id);
    const available = !!found && found.product.status === 'active' && found.price.active === 1 && !found.price.billing_interval;
    out.push({ item, product: found?.product ?? null, price: found?.price ?? null, available });
  }
  return out;
}

export interface CartView {
  count: number;
  currency: string | null;
  lines: { id: string; productId: string; priceId: string; name: string; quantity: number; max: number; unitAmount: number; unit: string; lineAmount: number; total: string; available: boolean }[];
  subtotal: number;
  subtotalFormatted: string;
  bumps: { stepId: string; blockId: string; name: string; description: string | null; amount: number; formatted: string; selected: boolean }[];
  total: number;
  totalFormatted: string;
  expiresAt: string | null;
}

const fmt = (minor: number, currency: string | null) => (currency ? formatMinor(minor, currency) : '');

/** What the Cart block, the Cart count badge and a cart Payment form show. Bumps are those of the checkout step of the asking Cart block (when it shows them). */
export async function viewOf(deps: Deps, cart: CartRow | undefined, opts: { cartBlock?: { stepId: string; blockId: string }; funnelId: string }): Promise<CartView> {
  const empty: CartView = { count: 0, currency: null, lines: [], subtotal: 0, subtotalFormatted: '', bumps: [], total: 0, totalFormatted: '', expiresAt: null };
  const lines = cart ? await cartLines(deps, cart) : [];
  const currency = cart?.currency ?? null;
  const view: CartView = cart ? { ...empty, currency, expiresAt: cart.expires_at } : empty;
  for (const l of lines) {
    const unit = l.price?.unit_amount ?? 0;
    const name = l.product?.name ?? 'Product';
    view.lines.push({ id: l.item.id, productId: l.item.product_id, priceId: l.price?.id ?? l.item.price_id, name, quantity: l.item.quantity, max: deps.config.CART_MAX_QUANTITY, unitAmount: unit, unit: fmt(unit, currency), lineAmount: unit * l.item.quantity, total: fmt(unit * l.item.quantity, currency), available: l.available });
    if (l.available) {
      view.subtotal += unit * l.item.quantity;
      view.count += l.item.quantity;
    }
  }
  view.total = view.subtotal;
  if (cart && opts.cartBlock && view.lines.length) {
    const doc = await stepDoc(deps, opts.funnelId, opts.cartBlock.stepId);
    const block = doc?.commerce?.find((b) => b.id === opts.cartBlock!.blockId && b.type === 'cart');
    if (block?.type === 'cart' && block.showBumps) {
      const target = block.checkoutStepId ?? (await nextStepId(deps, opts.funnelId, opts.cartBlock.stepId));
      const bdoc = target ? await stepDoc(deps, opts.funnelId, target) : null;
      const selected = selectedBumps(cart);
      for (const b of bdoc?.products.filter((p) => p.orderBump) ?? []) {
        try {
          const o = await resolveOffer(deps, cart.workspace_id, b, 1);
          if (o.recurring || (currency && o.currency !== currency)) continue;
          const on = selected.some((s) => s.stepId === target && s.blockId === b.id);
          view.bumps.push({ stepId: target!, blockId: b.id, name: o.name, description: b.description ?? null, amount: o.unitAmount, formatted: formatMinor(o.unitAmount, o.currency), selected: on });
          if (on) view.total += o.unitAmount;
        } catch {
          /* an unavailable bump is not offered */
        }
      }
    }
  }
  view.subtotalFormatted = fmt(view.subtotal, currency);
  view.totalFormatted = fmt(view.total, currency);
  return view;
}

export const selectedBumps = (cart: Pick<CartRow, 'bumps_json'>): CartBump[] => {
  try {
    const v = JSON.parse(cart.bumps_json) as CartBump[];
    return Array.isArray(v) ? v.filter((b) => typeof b?.stepId === 'string' && typeof b?.blockId === 'string').slice(0, 20) : [];
  } catch {
    return [];
  }
};

async function nextStepId(deps: Deps, funnelId: string, stepId: string): Promise<string | null> {
  const cur = await deps.db.get<{ position: number }>('SELECT position FROM steps WHERE id = ? AND funnel_id = ?', stepId, funnelId);
  if (!cur) return null;
  return (await deps.db.get<{ id: string }>('SELECT id FROM steps WHERE funnel_id = ? AND position > ? ORDER BY position LIMIT 1', funnelId, cur.position))?.id ?? null;
}

export interface CartAnswer {
  ok: true;
  /** Store it (first-party cookie) and send it back; absent when there is no cart yet. */
  token: string | null;
  cart: CartView;
  duplicate?: boolean;
  /** Shared with the browser pixel (fn:add_to_cart) for deduplication against the server-side AddToCart. */
  eventId?: string;
  added?: { name: string; productId: string; priceId: string; quantity: number; unitAmount: number; currency: string; value: number };
  /** The quantity was capped at the cart's limit. */
  limited?: boolean;
}

const answer = async (deps: Deps, funnelId: string, cart: CartRow | undefined, input: { cartBlock?: { stepId: string; blockId: string } }, extra: Partial<CartAnswer> = {}): Promise<CartAnswer> => ({
  ok: true, token: cart ? cartToken(deps, cart.id) : null, cart: await viewOf(deps, cart, { funnelId, cartBlock: input.cartBlock }), ...extra,
});

// ---- operations -------------------------------------------------------------------------------------------------------------------------------------

export async function viewCart(deps: Deps, funnelId: string, input: z.infer<typeof CartViewInput>): Promise<CartAnswer> {
  const funnel = await resolvePublicFunnel(deps, funnelId);
  return answer(deps, funnel.id, await findCart(deps, funnel, input), input);
}

/**
 * "Add to cart": the price comes from the stored block (its catalog price, re-read now), the quantity is checked against the block. A cart holds one currency: adding a
 * product priced in another one is refused with a message that says what to do. Subscriptions are not sold through carts (use a Checkout or a product Payment form).
 */
export async function addToCart(deps: Deps, p: { funnelId: string; stepId: string; blockId: string; input: z.infer<typeof CartAddInput>; userAgent?: string }): Promise<CartAnswer> {
  const { funnel, step, block } = await resolveCommerceBlock(deps, p.funnelId, p.stepId, p.blockId, ['cart-add', 'catalog']);
  const input = p.input;
  const q = block.quantity?.enabled ? block.quantity : null;
  const quantity = input.quantity ?? (q ? Math.min(Math.max(q.default, q.min), q.max) : 1);
  if (q ? quantity < q.min || quantity > q.max : quantity !== 1) throw badRequest('INVALID_QUANTITY', q ? `Choose between ${q.min} and ${q.max}` : 'This product is added one at a time');
  const found = block.type === 'catalog' ? await catalogPrice(deps, funnel.workspace_id, block, input.productId) : await blockPrice(deps, funnel.workspace_id, block.priceId);
  const { product, price } = found;
  const max = deps.config.CART_MAX_QUANTITY;

  const result = await inTx(deps, async (d) => {
    let cart = await findCart(d, funnel, input);
    cart = cart ? (await lockCart(d, cart.id))! : await createCart(d, funnel, input);
    if (!(await claimOp(d, cart.id, input.opId))) return { cart, duplicate: true as const };
    const items = await d.db.all<ItemRow>('SELECT * FROM cart_items WHERE cart_id = ?', cart.id);
    if (items.length && cart.currency && cart.currency !== price.currency) {
      throw conflict('CART_CURRENCY_MISMATCH', `Your cart is in ${cart.currency} and ${product.name} is priced in ${price.currency}. Check out your cart first, or remove its items, to buy it.`, { cartCurrency: cart.currency, currency: price.currency });
    }
    const same = items.find((i) => i.price_id === price.id);
    if (!same && items.length >= d.config.CART_MAX_LINES) throw conflict('CART_FULL', `A cart can hold at most ${d.config.CART_MAX_LINES} different products`);
    const at = d.now().toISOString();
    const next = Math.min(max, (same?.quantity ?? 0) + quantity);
    if (same) await d.db.run('UPDATE cart_items SET quantity = ?, updated_at = ? WHERE id = ?', next, at, same.id);
    else await d.db.run('INSERT INTO cart_items (id, cart_id, workspace_id, product_id, price_id, quantity, added_step_id, added_block_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', newId('cti'), cart.id, funnel.workspace_id, product.id, price.id, next, step.id, block.id, at, at);
    await touch(d, cart.id);
    await d.db.run('UPDATE carts SET currency = ? WHERE id = ?', price.currency, cart.id);
    const added = next - (same?.quantity ?? 0);
    const eventId = `atc_${input.opId}`;
    if (!input.preview && !isBot(p.userAgent) && added > 0) {
      await insertEvents(d.db, [{
        id: newId('evt'), workspace_id: funnel.workspace_id, funnel_id: funnel.id, step_id: step.id, type: 'add_to_cart', visitor_id: input.visitorId ?? null, unique_visit: 0, lead_id: null, order_id: null,
        external_id: `atc:${cart.id}:${input.opId}`, amount_cents: 0, currency: null, utm_json: JSON.stringify(sanitizeUtms(input.utms)), url: input.url ?? null, created_at: at,
      }]);
      await enqueueConversions(d, {
        ws: funnel.workspace_id, funnelId: funnel.id, stepId: step.id, kind: 'AddToCart', eventId, visitorId: input.visitorId, currency: price.currency, value: fromMinor(price.unit_amount * added, price.currency),
        items: [{ id: product.id, name: product.name, quantity: added, price: fromMinor(price.unit_amount, price.currency) }], user: { email: '' },
      });
    }
    return { cart: (await d.db.get<CartRow>('SELECT * FROM carts WHERE id = ?', cart.id))!, duplicate: false as const, eventId, added, limited: next < (same?.quantity ?? 0) + quantity };
  });
  if (result.duplicate) return answer(deps, funnel.id, result.cart, input, { duplicate: true });
  return answer(deps, funnel.id, result.cart, input, {
    eventId: result.eventId, limited: result.limited || undefined,
    added: { name: product.name, productId: product.id, priceId: price.id, quantity: result.added, unitAmount: price.unit_amount, currency: price.currency, value: fromMinor(price.unit_amount * result.added, price.currency) },
  });
}

/** The catalog price an Add to cart block names (a replaced price is followed); refused when the product is gone or is a subscription. */
async function blockPrice(deps: Deps, ws: string, priceId: string | undefined): Promise<{ product: ProductRow; price: PriceRow }> {
  if (!priceId) throw new AppError(409, 'PRODUCT_UNAVAILABLE', 'This product is not set up yet: the page owner must save the page again');
  const found = await currentPrice(deps, ws, priceId);
  if (!found || found.product.status !== 'active' || found.price.active !== 1) throw new AppError(409, 'PRODUCT_UNAVAILABLE', 'This product is no longer available');
  if (found.price.billing_interval) throw conflict('SUBSCRIPTION_NOT_IN_CART', 'Subscriptions cannot be added to a cart');
  return found;
}

/**
 * The price a Product catalog card adds: the product must be one the block lists NOW (hand-picked, or any active one-time product for "all products") and the
 * price is read from the catalog like the block shows it (a picked price, its replacement, else the default price). The page's prices are never used.
 */
async function catalogPrice(deps: Deps, ws: string, block: Extract<CommerceBlock, { type: 'catalog' }>, productId: string | undefined): Promise<{ product: ProductRow; price: PriceRow }> {
  if (!productId) throw badRequest('PRODUCT_REQUIRED', 'Choose a product to add');
  const pick = block.source === 'picked' ? block.picks.find((x) => x.productId === productId) : undefined;
  if (block.source === 'picked' && !pick) throw new AppError(409, 'PRODUCT_UNAVAILABLE', 'This product is no longer available');
  const item = await catalogItem(deps, ws, productId);
  if (!item) {
    const row = await deps.db.get<{ type: string; status: string }>('SELECT type, status FROM products WHERE workspace_id = ? AND id = ?', ws, productId);
    if (row?.type === 'subscription' && row.status === 'active') throw conflict('SUBSCRIPTION_NOT_IN_CART', 'Subscriptions cannot be added to a cart');
    throw new AppError(409, 'PRODUCT_UNAVAILABLE', 'This product is no longer available');
  }
  const chosen = priceOfItem(item, pick?.priceId);
  const price = chosen ? await deps.db.get<PriceRow>('SELECT * FROM prices WHERE workspace_id = ? AND id = ? AND active = 1', ws, chosen.id) : undefined;
  const product = await deps.db.get<ProductRow>('SELECT * FROM products WHERE workspace_id = ? AND id = ?', ws, productId);
  if (!price || !product || price.billing_interval) throw new AppError(409, 'PRODUCT_UNAVAILABLE', 'This product is no longer available');
  return { product, price };
}

/** Changes the quantity of a line (0 removes it), or selects / clears an order bump of the checkout step. */
export async function updateCart(deps: Deps, funnelId: string, input: z.infer<typeof CartUpdateInput>): Promise<CartAnswer> {
  const funnel = await resolvePublicFunnel(deps, funnelId);
  const found = await findCart(deps, funnel, input);
  if (!found) throw new AppError(404, 'CART_NOT_FOUND', 'Your cart has expired. Add the products again.');
  if (input.bump) {
    const doc = await stepDoc(deps, funnel.id, input.bump.stepId);
    if (!doc?.products.some((b) => b.id === input.bump!.blockId && b.orderBump)) throw badRequest('INVALID_BUMP', 'Unknown order bump');
  }
  const result = await inTx(deps, async (d) => {
    const cart = (await lockCart(d, found.id))!;
    if (cart.status !== 'open') throw new AppError(404, 'CART_NOT_FOUND', 'This cart was already checked out');
    if (!(await claimOp(d, cart.id, input.opId))) return { cart, duplicate: true };
    if (input.itemId !== undefined && input.quantity !== undefined) {
      const item = await d.db.get<ItemRow>('SELECT * FROM cart_items WHERE id = ? AND cart_id = ?', input.itemId, cart.id);
      if (!item) throw new AppError(404, 'CART_ITEM_NOT_FOUND', 'This item is no longer in your cart');
      if (input.quantity === 0) await d.db.run('DELETE FROM cart_items WHERE id = ?', item.id);
      else await d.db.run('UPDATE cart_items SET quantity = ?, updated_at = ? WHERE id = ?', Math.min(d.config.CART_MAX_QUANTITY, input.quantity), d.now().toISOString(), item.id);
      const left = await d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cart_items WHERE cart_id = ?', cart.id);
      if (!Number(left?.n)) await d.db.run("UPDATE carts SET currency = NULL, bumps_json = '[]' WHERE id = ?", cart.id); // an empty cart takes any currency again
    }
    if (input.bump) {
      const rest = selectedBumps(cart).filter((b) => !(b.stepId === input.bump!.stepId && b.blockId === input.bump!.blockId));
      const next = input.bump.selected ? [...rest, { stepId: input.bump.stepId, blockId: input.bump.blockId }] : rest;
      await d.db.run('UPDATE carts SET bumps_json = ? WHERE id = ?', JSON.stringify(next), cart.id);
    }
    await touch(d, cart.id);
    return { cart: (await d.db.get<CartRow>('SELECT * FROM carts WHERE id = ?', cart.id))!, duplicate: false };
  });
  return answer(deps, funnel.id, result.cart, input, result.duplicate ? { duplicate: true } : {});
}

/** Sets the order-bump selection of a cart for one step (the Payment form's checkboxes are the truth once the visitor is there). */
export async function setCartBumps(d: Deps, cartId: string, stepId: string, blockIds: string[]): Promise<void> {
  const cart = await d.db.get<CartRow>('SELECT * FROM carts WHERE id = ?', cartId);
  if (!cart) return;
  const next = [...selectedBumps(cart).filter((b) => b.stepId !== stepId), ...blockIds.map((blockId) => ({ stepId, blockId }))];
  await d.db.run('UPDATE carts SET bumps_json = ? WHERE id = ?', JSON.stringify(next), cartId);
}

/** After a paid checkout: the cart is closed, so the badge shows 0 and the next add starts a new cart. */
export async function closeCart(d: Deps, cartId: string): Promise<void> {
  await d.db.run("UPDATE carts SET status = 'checked_out', checked_out_at = ?, updated_at = ? WHERE id = ? AND status = 'open'", d.now().toISOString(), d.now().toISOString(), cartId);
}

/** Maintenance: expired carts (and their items and operation ids) are deleted. */
export async function sweepCarts(deps: Deps): Promise<number> {
  const r = await deps.db.run('DELETE FROM carts WHERE expires_at < ?', deps.now().toISOString());
  return r.changes;
}
