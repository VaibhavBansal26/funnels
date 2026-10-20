import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import { safeUrl } from '../blocks/safe.js';
import { inTx } from '../db/scope.js';
import type { Deps } from '../deps.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { like } from '../repos/sql.js';
import { currencyExponent, formatMinor, fromMinor, isCurrency, toMinor, validMinor } from '../util/money.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';
import { accountOf } from './stripepay.js';
import { syncProductSafely } from './catalogsync.js';

/**
 * The product catalog (docs/PRODUCTS.md). A product is something sold; a price is how much, in which currency and (for subscriptions) how often. Prices are
 * immutable like Stripe's: changing an amount creates a new price and archives the old one (`replaced_by`), so orders keep the price they were bought at and pages
 * that still name the old price follow the chain to the current one. Products are never deleted, only archived (orders refer to them). Everything is workspace-scoped.
 */
export interface ProductRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  images_json: string;
  status: 'active' | 'archived';
  type: 'one_time' | 'subscription';
  tax_code: string | null;
  metadata_json: string;
  default_price_id: string | null;
  stripe_product_id: string | null;
  stripe_account_id: string | null;
  sync_status: string;
  sync_error: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface PriceRow {
  id: string;
  workspace_id: string;
  product_id: string;
  currency: string;
  unit_amount: number;
  billing_interval: 'day' | 'week' | 'month' | 'year' | null;
  billing_interval_count: number;
  trial_days: number;
  nickname: string | null;
  active: number;
  replaced_by: string | null;
  stripe_price_id: string | null;
  stripe_account_id: string | null;
  sync_status: string;
  created_at: string;
  archived_at: string | null;
}

const imageUrl = z.string().max(2048).refine((u) => safeUrl(u, ['https']) !== null, 'Images must be https URLs or uploaded files (/uploads/...)');
const metadata = z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/), z.string().max(500)).refine((m) => Object.keys(m).length <= 20, 'At most 20 metadata keys');

export const PriceInput = z
  .object({
    currency: z.string().trim().toUpperCase().refine(isCurrency, 'Unknown currency code'),
    /** In minor units (cents; 1 for JPY; 1000 per unit for KWD). Send this or `amount`. */
    unitAmount: z.number().int().min(0).max(99_999_999).optional(),
    /** In major units (12.5 = 12.50). Converted with the currency exponent. */
    amount: z.number().min(0).max(1_000_000).optional(),
    interval: z.enum(['day', 'week', 'month', 'year']).optional(),
    intervalCount: z.number().int().min(1).max(12).default(1),
    trialDays: z.number().int().min(0).max(730).default(0),
    nickname: z.string().trim().max(120).optional(),
  })
  .refine((p) => (p.unitAmount === undefined) !== (p.amount === undefined), { message: 'Send exactly one of unitAmount and amount', path: ['amount'] });

const ProductFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  images: z.array(imageUrl.or(z.string().regex(/^\/uploads\/[A-Za-z0-9_-]+(\/[^\s/]+)?$/))).max(8).default([]),
  taxCode: z.string().regex(/^txcd_\d{8}$/, 'A Stripe tax code looks like txcd_10000000').nullish(),
  metadata: metadata.default({}),
};
export const ProductInput = z.object({ ...ProductFields, type: z.enum(['one_time', 'subscription']).default('one_time'), price: PriceInput.optional() });
export const ProductPatch = z.object({
  name: ProductFields.name.optional(),
  description: z.string().trim().max(2000).optional(),
  images: ProductFields.images.optional(),
  taxCode: ProductFields.taxCode,
  metadata: metadata.optional(),
  defaultPriceId: z.string().max(64).optional(),
});
export const ProductQuery = z.object({
  status: z.enum(['active', 'archived', 'all']).default('active'),
  search: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const PricePatch = z.object({ nickname: z.string().trim().max(120).nullable() });

const parse = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export const serializePrice = (p: PriceRow) => ({
  id: p.id, productId: p.product_id, currency: p.currency, unitAmount: p.unit_amount, exponent: currencyExponent(p.currency), amount: fromMinor(p.unit_amount, p.currency), formatted: formatMinor(p.unit_amount, p.currency),
  interval: p.billing_interval, intervalCount: p.billing_interval_count, trialDays: p.trial_days, nickname: p.nickname, active: p.active === 1, replacedBy: p.replaced_by,
  stripe: { priceId: p.stripe_price_id, status: p.sync_status }, createdAt: p.created_at, archivedAt: p.archived_at,
});

export interface Connection {
  connected: boolean;
  chargesEnabled: boolean;
  accountId: string | null;
}
export async function connectionOf(deps: Deps, ws: string): Promise<Connection> {
  const a = await accountOf(deps, ws);
  return { connected: !!a && !!deps.stripe, chargesEnabled: a?.charges_enabled === 1, accountId: a?.stripe_account_id ?? null };
}

/** 'not_connected' when there is nowhere to sync to; otherwise the stored status (local, pending, synced, error). */
const syncState = (stored: string, c: Connection): string => (c.connected ? stored : 'not_connected');

export function serializeProduct(p: ProductRow, prices: PriceRow[], c: Connection, orders = 0) {
  return {
    id: p.id, name: p.name, description: p.description, images: parse<string[]>(p.images_json, []), status: p.status, type: p.type, taxCode: p.tax_code, metadata: parse<Record<string, string>>(p.metadata_json, {}),
    defaultPriceId: p.default_price_id, prices: prices.map(serializePrice),
    stripe: { productId: p.stripe_product_id, syncState: syncState(p.sync_status, c), error: p.sync_error, syncedAt: p.synced_at }, orderCount: orders,
    createdAt: p.created_at, updatedAt: p.updated_at, archivedAt: p.archived_at,
  };
}

async function pricesOf(deps: Deps, ws: string, ids: string[]): Promise<Map<string, PriceRow[]>> {
  const map = new Map<string, PriceRow[]>();
  if (!ids.length) return map;
  const rows = await deps.db.all<PriceRow>(`SELECT * FROM prices WHERE workspace_id = ? AND product_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, id`, ws, ...ids);
  for (const r of rows) map.set(r.product_id, [...(map.get(r.product_id) ?? []), r]);
  return map;
}

async function orderCounts(deps: Deps, ws: string, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await deps.db.all<{ product_id: string; n: number }>(`SELECT product_id, COUNT(*) AS n FROM orders WHERE workspace_id = ? AND product_id IN (${ids.map(() => '?').join(',')}) GROUP BY product_id`, ws, ...ids);
  return new Map(rows.map((r) => [r.product_id, r.n]));
}

export async function listProducts(base: Deps, ws: string, q: z.infer<typeof ProductQuery>) {
  const deps: Deps = { ...base, db: base.db.read(ws) };
  const where = ['workspace_id = ?'];
  const params: (string | number)[] = [ws];
  if (q.status !== 'all') (where.push('status = ?'), params.push(q.status));
  if (q.search?.trim()) (where.push(deps.db.dialect.ilike('name')), params.push(like(q.search.trim())));
  const clause = where.join(' AND ');
  const total = (await deps.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM products WHERE ${clause}`, ...params))!.n;
  const rows = await deps.db.all<ProductRow>(`SELECT * FROM products WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, ...params, q.limit, (q.page - 1) * q.limit);
  const ids = rows.map((r) => r.id);
  const [prices, counts, conn] = await Promise.all([pricesOf(deps, ws, ids), orderCounts(deps, ws, ids), connectionOf(deps, ws)]);
  return { data: rows.map((p) => serializeProduct(p, prices.get(p.id) ?? [], conn, counts.get(p.id) ?? 0)), pagination: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) }, stripe: { connected: conn.connected, chargesEnabled: conn.chargesEnabled } };
}

export async function requireProductRow(deps: Deps, ws: string, id: string): Promise<ProductRow> {
  const p = await deps.db.get<ProductRow>('SELECT * FROM products WHERE workspace_id = ? AND id = ?', ws, id);
  if (!p) throw notFound('Product');
  return p;
}

export async function getProduct(deps: Deps, ws: string, id: string) {
  const p = await requireProductRow(deps, ws, id);
  const [prices, counts, conn] = await Promise.all([pricesOf(deps, ws, [p.id]), orderCounts(deps, ws, [p.id]), connectionOf(deps, ws)]);
  return serializeProduct(p, prices.get(p.id) ?? [], conn, counts.get(p.id) ?? 0);
}

/** Validates a price against its product and returns the integer minor amount. */
function priceValues(type: ProductRow['type'], i: z.infer<typeof PriceInput>) {
  const unit = i.unitAmount ?? toMinor(i.amount!, i.currency);
  if (!validMinor(unit, i.currency)) throw badRequest('INVALID_AMOUNT', currencyExponent(i.currency) === 3 ? 'Amounts in this currency must be multiples of 0.01 (Stripe rounds the last digit)' : 'The amount is not valid');
  if (type === 'subscription' && !i.interval) throw badRequest('INTERVAL_REQUIRED', 'A subscription price needs an interval (day, week, month or year)');
  if (type === 'one_time' && (i.interval || i.trialDays)) throw badRequest('INTERVAL_NOT_ALLOWED', 'A one-time product cannot have an interval or a trial');
  return { unit, interval: type === 'subscription' ? i.interval! : null, count: type === 'subscription' ? i.intervalCount : 1, trial: type === 'subscription' ? i.trialDays : 0 };
}

async function insertPrice(d: Deps, ws: string, product: ProductRow, i: z.infer<typeof PriceInput>): Promise<PriceRow> {
  const v = priceValues(product.type, i);
  const existing = await d.db.all<{ currency: string }>('SELECT DISTINCT currency FROM prices WHERE workspace_id = ? AND product_id = ? AND active = 1', ws, product.id);
  if (existing.some((e) => e.currency !== i.currency) && product.type === 'subscription') throw conflict('CURRENCY_MISMATCH', 'Active prices of one subscription product must share a currency');
  const id = newId('prc');
  const at = d.now().toISOString();
  await d.db.run(
    'INSERT INTO prices (id, workspace_id, product_id, currency, unit_amount, billing_interval, billing_interval_count, trial_days, nickname, active, sync_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
    id, ws, product.id, i.currency, v.unit, v.interval, v.count, v.trial, i.nickname ?? null, 'local', at,
  );
  if (!product.default_price_id) await d.db.run('UPDATE products SET default_price_id = ?, sync_status = ? WHERE id = ?', id, 'pending', product.id);
  return (await d.db.get<PriceRow>('SELECT * FROM prices WHERE id = ?', id))!;
}

export async function createProduct(deps: Deps, auth: Auth, input: z.infer<typeof ProductInput>, ip?: string) {
  const ws = auth.workspaceId;
  const id = await inTx(deps, async (d) => {
    const pid = newId('prd');
    const at = d.now().toISOString();
    await d.db.run(
      'INSERT INTO products (id, workspace_id, name, description, images_json, status, type, tax_code, metadata_json, sync_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      pid, ws, input.name, input.description, JSON.stringify(input.images), 'active', input.type, input.taxCode ?? null, JSON.stringify(input.metadata), 'local', at, at,
    );
    const product = (await d.db.get<ProductRow>('SELECT * FROM products WHERE id = ?', pid))!;
    if (input.price) await insertPrice(d, ws, product, input.price);
    await audit(d, { workspaceId: ws, actorId: auth.userId, action: 'product.created', target: pid, ip, detail: { name: input.name, type: input.type } });
    return pid;
  });
  await syncProductSafely(deps, ws, id);
  return getProduct(deps, ws, id);
}

export async function updateProduct(deps: Deps, auth: Auth, id: string, patch: z.infer<typeof ProductPatch>, ip?: string) {
  const ws = auth.workspaceId;
  await inTx(deps, async (d) => {
    const p = await requireProductRow(d, ws, id);
    if (patch.defaultPriceId) {
      const price = await d.db.get<PriceRow>('SELECT * FROM prices WHERE workspace_id = ? AND product_id = ? AND id = ? AND active = 1', ws, id, patch.defaultPriceId);
      if (!price) throw badRequest('INVALID_DEFAULT_PRICE', 'The default price must be an active price of this product');
    }
    await d.db.run(
      'UPDATE products SET name = ?, description = ?, images_json = ?, tax_code = ?, metadata_json = ?, default_price_id = ?, sync_status = ?, updated_at = ? WHERE id = ?',
      patch.name ?? p.name, patch.description ?? p.description, patch.images ? JSON.stringify(patch.images) : p.images_json, patch.taxCode === undefined ? p.tax_code : patch.taxCode, patch.metadata ? JSON.stringify(patch.metadata) : p.metadata_json,
      patch.defaultPriceId ?? p.default_price_id, p.stripe_product_id ? 'pending' : p.sync_status, d.now().toISOString(), id,
    );
    await audit(d, { workspaceId: ws, actorId: auth.userId, action: 'product.updated', target: id, ip, detail: { fields: Object.keys(patch) } });
  });
  await syncProductSafely(deps, ws, id);
  return getProduct(deps, ws, id);
}

/** Soft archive: the product leaves lists and pickers, checkouts naming it are refused with a friendly message, pages keep rendering, orders keep their link. */
export async function setProductStatus(deps: Deps, auth: Auth, id: string, status: 'active' | 'archived', ip?: string) {
  const ws = auth.workspaceId;
  await inTx(deps, async (d) => {
    const p = await requireProductRow(d, ws, id);
    if (p.status === status) return;
    const at = d.now().toISOString();
    await d.db.run('UPDATE products SET status = ?, archived_at = ?, sync_status = ?, updated_at = ? WHERE id = ?', status, status === 'archived' ? at : null, p.stripe_product_id ? 'pending' : p.sync_status, at, id);
    await audit(d, { workspaceId: ws, actorId: auth.userId, action: status === 'archived' ? 'product.archived' : 'product.restored', target: id, ip });
  });
  await syncProductSafely(deps, ws, id);
  return getProduct(deps, ws, id);
}

export async function addPrice(deps: Deps, auth: Auth, productId: string, input: z.infer<typeof PriceInput>, ip?: string) {
  const ws = auth.workspaceId;
  const price = await inTx(deps, async (d) => {
    const p = await requireProductRow(d, ws, productId);
    if (p.status === 'archived') throw conflict('PRODUCT_ARCHIVED', 'Restore the product before adding prices');
    const row = await insertPrice(d, ws, p, input);
    await d.db.run('UPDATE products SET sync_status = CASE WHEN stripe_product_id IS NULL THEN sync_status ELSE ? END, updated_at = ? WHERE id = ?', 'pending', d.now().toISOString(), p.id);
    await audit(d, { workspaceId: ws, actorId: auth.userId, action: 'price.created', target: row.id, ip, detail: { productId, currency: row.currency, unitAmount: row.unit_amount } });
    return row;
  });
  await syncProductSafely(deps, ws, productId);
  return serializePrice((await deps.db.get<PriceRow>('SELECT * FROM prices WHERE id = ?', price.id))!);
}

/** "Change the price": creates the replacement, archives the old price and points it at the new one. Pages and checkouts that name the old price now use the new one. */
export async function replacePrice(deps: Deps, auth: Auth, productId: string, priceId: string, input: z.infer<typeof PriceInput>, ip?: string) {
  const ws = auth.workspaceId;
  const next = await inTx(deps, async (d) => {
    const p = await requireProductRow(d, ws, productId);
    const old = await d.db.get<PriceRow>('SELECT * FROM prices WHERE workspace_id = ? AND product_id = ? AND id = ?', ws, productId, priceId);
    if (!old) throw notFound('Price');
    if (!old.active) throw conflict('PRICE_ARCHIVED', 'This price is already archived');
    const row = await insertPrice(d, ws, p, input);
    const at = d.now().toISOString();
    await d.db.run('UPDATE prices SET active = 0, replaced_by = ?, archived_at = ?, sync_status = ? WHERE id = ?', row.id, at, old.stripe_price_id ? 'pending' : old.sync_status, old.id);
    await d.db.run('UPDATE products SET default_price_id = CASE WHEN default_price_id = ? THEN ? ELSE default_price_id END, sync_status = CASE WHEN stripe_product_id IS NULL THEN sync_status ELSE ? END, updated_at = ? WHERE id = ?', old.id, row.id, 'pending', at, p.id);
    await audit(d, { workspaceId: ws, actorId: auth.userId, action: 'price.replaced', target: row.id, ip, detail: { productId, replaced: old.id, from: old.unit_amount, to: row.unit_amount, currency: row.currency } });
    return row;
  });
  await syncProductSafely(deps, ws, productId);
  return serializePrice((await deps.db.get<PriceRow>('SELECT * FROM prices WHERE id = ?', next.id))!);
}

export async function archivePrice(deps: Deps, auth: Auth, productId: string, priceId: string, ip?: string) {
  const ws = auth.workspaceId;
  await inTx(deps, async (d) => {
    const old = await d.db.get<PriceRow>('SELECT * FROM prices WHERE workspace_id = ? AND product_id = ? AND id = ?', ws, productId, priceId);
    if (!old) throw notFound('Price');
    if (!old.active) return;
    const others = (await d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM prices WHERE workspace_id = ? AND product_id = ? AND active = 1 AND id <> ?', ws, productId, priceId))!.n;
    if (others === 0) throw conflict('LAST_PRICE', 'A product keeps at least one active price: add another one or archive the product');
    const at = d.now().toISOString();
    await d.db.run('UPDATE prices SET active = 0, archived_at = ?, sync_status = ? WHERE id = ?', at, old.stripe_price_id ? 'pending' : old.sync_status, priceId);
    const fallback = await d.db.get<{ id: string }>('SELECT id FROM prices WHERE workspace_id = ? AND product_id = ? AND active = 1 ORDER BY created_at LIMIT 1', ws, productId);
    await d.db.run('UPDATE products SET default_price_id = CASE WHEN default_price_id = ? THEN ? ELSE default_price_id END, sync_status = CASE WHEN stripe_product_id IS NULL THEN sync_status ELSE ? END, updated_at = ? WHERE id = ?', priceId, fallback?.id ?? null, 'pending', at, productId);
    await audit(d, { workspaceId: ws, actorId: auth.userId, action: 'price.archived', target: priceId, ip, detail: { productId } });
  });
  await syncProductSafely(deps, ws, productId);
  return getProduct(deps, ws, productId);
}

export async function patchPrice(deps: Deps, ws: string, productId: string, priceId: string, patch: z.infer<typeof PricePatch>) {
  const r = await deps.db.run('UPDATE prices SET nickname = ?, sync_status = CASE WHEN stripe_price_id IS NULL THEN sync_status ELSE ? END WHERE workspace_id = ? AND product_id = ? AND id = ?', patch.nickname, 'pending', ws, productId, priceId);
  if (r.changes === 0) throw notFound('Price');
  return serializePrice((await deps.db.get<PriceRow>('SELECT * FROM prices WHERE id = ?', priceId))!);
}

// ---- resolving what is for sale ---------------------------------------------------------------------------------------------------------------------

export interface PriceWithProduct {
  product: ProductRow;
  price: PriceRow;
}

/** Follows `replaced_by` to the current price (at most 10 hops: a chain that long is a bug). Null when the price does not exist in the workspace. */
export async function currentPrice(deps: Deps, ws: string, priceId: string): Promise<PriceWithProduct | null> {
  let id = priceId;
  for (let hop = 0; hop < 10; hop++) {
    const price = await deps.db.get<PriceRow>('SELECT * FROM prices WHERE workspace_id = ? AND id = ?', ws, id);
    if (!price) return null;
    if (price.active === 1 || !price.replaced_by) {
      const product = await deps.db.get<ProductRow>('SELECT * FROM products WHERE workspace_id = ? AND id = ?', ws, price.product_id);
      return product ? { product, price } : null;
    }
    id = price.replaced_by;
  }
  return null;
}

export const unavailable = (): AppError => new AppError(409, 'PRODUCT_UNAVAILABLE', 'This product is no longer available');
