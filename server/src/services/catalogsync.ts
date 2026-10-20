import type { Deps } from '../deps.js';
import { StripeApiError } from '../payments/stripe.js';
import { audit } from './audit.js';
import type { PriceRow, ProductRow } from './catalog.js';
import { accountOf } from './stripepay.js';

/**
 * Mirrors the catalog to the workspace's connected Stripe account (Product and Price objects, `Stripe-Account` header, an idempotency key per object so a retry
 * never creates a duplicate). Prices are immutable in Stripe as here: a replaced price is archived (`active=false`), never edited. Archiving and restoring a product
 * propagates `active`. UNVERIFIED against the real Stripe API: tested against an in-process fake (docs/STRIPE.md).
 *
 * Sync is best effort and never blocks a catalog change: the local catalog is the source of truth for what the server charges, so a failing or missing Stripe only
 * leaves the product `pending` or `error` (visible in the UI) and a later `POST /api/products/:id/sync` pushes it. Without a connected account nothing is attempted.
 */
export type SyncResult = 'not_connected' | 'synced' | 'error';

const absolute = (deps: Deps, u: string) => (u.startsWith('/') ? `${deps.config.APP_PUBLIC_URL.replace(/\/$/, '')}${u}` : u);

export async function syncProduct(deps: Deps, ws: string, productId: string): Promise<SyncResult> {
  const stripe = deps.stripe;
  const account = await accountOf(deps, ws);
  if (!stripe || !account) return 'not_connected';
  const acct = account.stripe_account_id;
  const p = await deps.db.get<ProductRow>('SELECT * FROM products WHERE workspace_id = ? AND id = ?', ws, productId);
  if (!p) return 'synced';
  let stripeProductId = p.stripe_product_id;
  if (p.stripe_account_id && p.stripe_account_id !== acct) {
    // The workspace connected another Stripe account since: the old ids mean nothing there.
    stripeProductId = null;
    await deps.db.run("UPDATE products SET stripe_product_id = NULL, stripe_account_id = NULL, sync_status = 'pending' WHERE id = ?", p.id);
    await deps.db.run("UPDATE prices SET stripe_price_id = NULL, stripe_account_id = NULL, sync_status = 'pending' WHERE product_id = ?", p.id);
  }
  const at = deps.now().toISOString();
  try {
    const meta = { ...(JSON.parse(p.metadata_json) as Record<string, string>), funnels_workspace_id: ws, funnels_product_id: p.id };
    const body: Record<string, unknown> = {
      name: p.name, description: p.description, active: p.status === 'active', metadata: meta,
      ...(p.tax_code ? { tax_code: p.tax_code } : {}), ...((JSON.parse(p.images_json) as string[]).length ? { images: (JSON.parse(p.images_json) as string[]).map((u) => absolute(deps, u)) } : {}),
    };
    if (!stripeProductId) {
      if (!p.description) delete body.description; // Stripe refuses an empty description on create
      stripeProductId = (await stripe.call<{ id: string }>('POST', '/v1/products', body, { account: acct, idempotencyKey: `prd:${p.id}:${acct}` })).id;
    } else {
      await stripe.call('POST', `/v1/products/${stripeProductId}`, body, { account: acct });
    }
    await deps.db.run('UPDATE products SET stripe_product_id = ?, stripe_account_id = ? WHERE id = ?', stripeProductId, acct, p.id);

    const prices = await deps.db.all<PriceRow>('SELECT * FROM prices WHERE product_id = ? ORDER BY created_at, id', p.id);
    for (const pr of prices) {
      if (!pr.stripe_price_id && pr.active === 1) {
        const created = await stripe.call<{ id: string }>('POST', '/v1/prices', {
          product: stripeProductId, currency: pr.currency.toLowerCase(), unit_amount: pr.unit_amount, ...(pr.nickname ? { nickname: pr.nickname } : {}), metadata: { funnels_price_id: pr.id },
          ...(pr.billing_interval ? { recurring: { interval: pr.billing_interval, interval_count: pr.billing_interval_count, ...(pr.trial_days ? { trial_period_days: pr.trial_days } : {}) } } : {}),
        }, { account: acct, idempotencyKey: `prc:${pr.id}:${acct}` });
        await deps.db.run("UPDATE prices SET stripe_price_id = ?, stripe_account_id = ?, sync_status = 'synced' WHERE id = ?", created.id, acct, pr.id);
      } else if (pr.stripe_price_id && pr.sync_status !== 'synced') {
        await stripe.call('POST', `/v1/prices/${pr.stripe_price_id}`, { active: pr.active === 1, nickname: pr.nickname ?? '' }, { account: acct });
        await deps.db.run("UPDATE prices SET sync_status = 'synced' WHERE id = ?", pr.id);
      }
    }
    const def = p.default_price_id ? (await deps.db.get<{ stripe_price_id: string | null; active: number }>('SELECT stripe_price_id, active FROM prices WHERE id = ?', p.default_price_id)) : undefined;
    if (def?.stripe_price_id && def.active === 1) await stripe.call('POST', `/v1/products/${stripeProductId}`, { default_price: def.stripe_price_id }, { account: acct });
    await deps.db.run("UPDATE products SET sync_status = 'synced', sync_error = NULL, synced_at = ? WHERE id = ?", at, p.id);
    return 'synced';
  } catch (e) {
    const message = e instanceof StripeApiError ? e.message : (e as Error).message;
    await deps.db.run("UPDATE products SET sync_status = 'error', sync_error = ? WHERE id = ?", message.slice(0, 300), p.id);
    deps.log.warn('stripe catalog sync failed', { workspace: ws, product: p.id, error: message });
    return 'error';
  }
}

/** Fire-and-record: used after catalog changes so the request that made them never fails because Stripe did. */
export async function syncProductSafely(deps: Deps, ws: string, productId: string): Promise<void> {
  try {
    await syncProduct(deps, ws, productId);
  } catch (e) {
    deps.log.warn('catalog sync crashed', { workspace: ws, product: productId, error: (e as Error).message });
  }
}

/** Pushes every product that is not in sync (never pushed, changed since, or failed last time). */
export async function syncAll(deps: Deps, ws: string, actorId: string) {
  const account = await accountOf(deps, ws);
  if (!deps.stripe || !account) return { connected: false, synced: 0, failed: 0 };
  const rows = await deps.db.all<{ id: string }>("SELECT id FROM products WHERE workspace_id = ? AND sync_status <> 'synced' ORDER BY created_at LIMIT 200", ws);
  let synced = 0;
  let failed = 0;
  for (const r of rows) (await syncProduct(deps, ws, r.id)) === 'synced' ? synced++ : failed++;
  await audit(deps, { workspaceId: ws, actorId, action: 'catalog.synced', detail: { synced, failed } });
  return { connected: true, synced, failed };
}

// ---- webhook reconciliation -------------------------------------------------------------------------------------------------------------------------

interface StripeProductObject {
  id: string;
  name?: string;
  description?: string | null;
  active?: boolean;
}
interface StripePriceObject {
  id: string;
  active?: boolean;
  nickname?: string | null;
}

/** `product.updated`: a change made in the Stripe dashboard is applied here (name, description, active), a no-op for the echo of our own push. */
export async function reconcileStripeProduct(deps: Deps, account: string | undefined, o: StripeProductObject): Promise<boolean> {
  if (!account) return false;
  const p = await deps.db.get<ProductRow>('SELECT * FROM products WHERE stripe_account_id = ? AND stripe_product_id = ?', account, o.id);
  if (!p) return false;
  const status = o.active === false ? 'archived' : o.active === true ? 'active' : p.status;
  const name = o.name?.trim() ? o.name.trim().slice(0, 200) : p.name;
  const description = o.description === undefined ? p.description : (o.description ?? '').slice(0, 2000);
  if (status === p.status && name === p.name && description === p.description) return true;
  const at = deps.now().toISOString();
  await deps.db.run('UPDATE products SET name = ?, description = ?, status = ?, archived_at = ?, updated_at = ?, synced_at = ? WHERE id = ?', name, description, status, status === 'archived' ? (p.archived_at ?? at) : null, at, at, p.id);
  await audit(deps, { workspaceId: p.workspace_id, actorId: 'stripe', action: 'product.reconciled', target: p.id, detail: { status, changedName: name !== p.name } });
  return true;
}

/** `product.deleted`: the Stripe object is gone; the local product is archived (orders keep referring to it) and forgets the Stripe ids. */
export async function reconcileStripeProductDeleted(deps: Deps, account: string | undefined, o: { id: string }): Promise<boolean> {
  if (!account) return false;
  const p = await deps.db.get<ProductRow>('SELECT * FROM products WHERE stripe_account_id = ? AND stripe_product_id = ?', account, o.id);
  if (!p) return false;
  const at = deps.now().toISOString();
  await deps.db.run("UPDATE products SET status = 'archived', archived_at = COALESCE(archived_at, ?), stripe_product_id = NULL, stripe_account_id = NULL, sync_status = 'local', updated_at = ? WHERE id = ?", at, at, p.id);
  await deps.db.run("UPDATE prices SET stripe_price_id = NULL, stripe_account_id = NULL, sync_status = 'local' WHERE product_id = ?", p.id);
  await audit(deps, { workspaceId: p.workspace_id, actorId: 'stripe', action: 'product.reconciled', target: p.id, detail: { deletedInStripe: true } });
  return true;
}

/** `price.updated`: Stripe prices can only be archived or renamed, so that is all that is applied. A price archived in Stripe stops being sold here. */
export async function reconcileStripePrice(deps: Deps, account: string | undefined, o: StripePriceObject): Promise<boolean> {
  if (!account) return false;
  const pr = await deps.db.get<PriceRow>('SELECT * FROM prices WHERE stripe_account_id = ? AND stripe_price_id = ?', account, o.id);
  if (!pr) return false;
  const active = o.active === undefined ? pr.active : o.active ? 1 : 0;
  const nickname = o.nickname === undefined ? pr.nickname : o.nickname;
  if (active === pr.active && nickname === pr.nickname) return true;
  await deps.db.run('UPDATE prices SET active = ?, nickname = ?, archived_at = ? WHERE id = ?', active, nickname, active ? null : (pr.archived_at ?? deps.now().toISOString()), pr.id);
  await audit(deps, { workspaceId: pr.workspace_id, actorId: 'stripe', action: 'price.reconciled', target: pr.id, detail: { active: active === 1 } });
  return true;
}
