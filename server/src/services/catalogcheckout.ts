import type { CheckoutBlock } from '../blocks/index.js';
import { inTx } from '../db/scope.js';
import type { Deps } from '../deps.js';
import { badRequest } from '../errors.js';
import type { ProjectDoc } from '../pagemodel/doc.js';
import type { ProductProps } from '../pagemodel/shared/props.js';
import { fromMinor, toMinor } from '../util/money.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';
import { currentPrice, unavailable, type PriceRow, type ProductRow } from './catalog.js';
import { mapProducts, productNodes } from './catalogdoc.js';

export type OfferRole = 'main' | 'bump' | 'upsell' | 'downsell';

/** One thing in a basket, as the server prices it: from the catalog when the block is linked, from the block (legacy pages) otherwise. Never from the request. */
export interface Offer {
  blockId: string;
  role: OfferRole;
  productId: string | null;
  priceId: string | null;
  stripeProductId: string | null;
  stripePriceId: string | null;
  /** The Stripe account the ids above belong to: they are only used when it is the account connected now. */
  stripeAccountId: string | null;
  name: string;
  description?: string;
  unitAmount: number;
  currency: string;
  quantity: number;
  recurring: { interval: 'day' | 'week' | 'month' | 'year'; count: number; trialDays: number } | null;
  taxCode: string | null;
}

export const roleOf = (b: Pick<CheckoutBlock, 'orderBump' | 'oneClickUpsell' | 'downsell'>): OfferRole => (b.orderBump ? 'bump' : b.oneClickUpsell ? (b.downsell ? 'downsell' : 'upsell') : 'main');

/** The quantity the visitor asked for, checked against the block's own settings. Bumps and upsells are always one. */
export function checkQuantity(block: CheckoutBlock, requested: number | undefined): number {
  if (requested === undefined || requested === 1) return 1;
  const q = block.quantity;
  if (block.orderBump || block.oneClickUpsell || !q?.enabled) throw badRequest('INVALID_QUANTITY', 'This offer is sold one at a time');
  if (requested < q.min || requested > q.max) throw badRequest('INVALID_QUANTITY', `Choose between ${q.min} and ${q.max}`);
  return requested;
}

/**
 * Prices a block for checkout. A linked block follows its price to the current one (a replaced price points at its successor); an archived product, an archived
 * price with no successor, or a price that no longer exists answers 409 PRODUCT_UNAVAILABLE (the page itself still renders). An unlinked block (a page saved before
 * the catalog existed and not opened since) is priced from its own fields, converted with the currency exponent.
 */
export async function resolveOffer(deps: Deps, ws: string, block: CheckoutBlock, quantity = 1): Promise<Offer> {
  const role = roleOf(block);
  if (!block.priceId) {
    return { blockId: block.id, role, productId: null, priceId: null, stripeProductId: null, stripePriceId: null, stripeAccountId: null, name: block.productName, description: block.description, unitAmount: toMinor(block.price, block.currency), currency: block.currency, quantity, recurring: null, taxCode: null };
  }
  const found = await currentPrice(deps, ws, block.priceId);
  if (!found || found.product.status !== 'active' || found.price.active !== 1) throw unavailable();
  const { product, price } = found;
  return {
    blockId: block.id, role, productId: product.id, priceId: price.id, stripeProductId: product.stripe_product_id, stripePriceId: price.stripe_price_id, stripeAccountId: price.stripe_account_id, name: product.name, description: block.description || product.description || undefined,
    unitAmount: price.unit_amount, currency: price.currency, quantity,
    recurring: price.billing_interval ? { interval: price.billing_interval, count: price.billing_interval_count, trialDays: price.trial_days } : null, taxCode: product.tax_code,
  };
}

// ---- linking page blocks to the catalog -------------------------------------------------------------------------------------------------------------

export interface NewProduct {
  name: string;
  description?: string;
  type: 'one_time' | 'subscription';
  amount: number;
  currency: string;
  interval?: 'day' | 'week' | 'month' | 'year';
  intervalCount?: number;
  trialDays?: number;
}

/** An active product with this name and an active price of exactly this amount, currency and billing; created when none exists. Returns the ids. */
export async function findOrCreateProduct(d: Deps, ws: string, actorId: string, n: NewProduct): Promise<{ product: ProductRow; price: PriceRow }> {
  const unit = toMinor(n.amount, n.currency);
  const hit = await d.db.get<{ product_id: string; price_id: string }>(
    `SELECT p.id AS product_id, pr.id AS price_id FROM products p JOIN prices pr ON pr.product_id = p.id
     WHERE p.workspace_id = ? AND p.status = 'active' AND p.type = ? AND lower(p.name) = lower(?) AND pr.active = 1 AND pr.currency = ? AND pr.unit_amount = ?
       AND COALESCE(pr.billing_interval, '') = ? AND pr.billing_interval_count = ? AND pr.trial_days = ?
     ORDER BY p.created_at, p.id LIMIT 1`,
    ws, n.type, n.name, n.currency, unit, n.interval ?? '', n.intervalCount ?? 1, n.trialDays ?? 0,
  );
  if (hit) return { product: (await d.db.get<ProductRow>('SELECT * FROM products WHERE id = ?', hit.product_id))!, price: (await d.db.get<PriceRow>('SELECT * FROM prices WHERE id = ?', hit.price_id))! };
  const at = d.now().toISOString();
  const pid = newId('prd');
  const prid = newId('prc');
  await d.db.run('INSERT INTO products (id, workspace_id, name, description, images_json, status, type, metadata_json, default_price_id, sync_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', pid, ws, n.name.slice(0, 200), (n.description ?? '').slice(0, 2000), '[]', 'active', n.type, '{}', prid, 'local', at, at);
  await d.db.run('INSERT INTO prices (id, workspace_id, product_id, currency, unit_amount, billing_interval, billing_interval_count, trial_days, active, sync_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)', prid, ws, pid, n.currency, unit, n.type === 'subscription' ? (n.interval ?? 'month') : null, n.type === 'subscription' ? (n.intervalCount ?? 1) : 1, n.type === 'subscription' ? (n.trialDays ?? 0) : 0, 'local', at);
  await audit(d, { workspaceId: ws, actorId, action: 'product.created', target: pid, detail: { name: n.name, source: 'page' } });
  return { product: (await d.db.get<ProductRow>('SELECT * FROM products WHERE id = ?', pid))!, price: (await d.db.get<PriceRow>('SELECT * FROM prices WHERE id = ?', prid))! };
}

const snapshot = (p: ProductProps, product: ProductRow, price: PriceRow): ProductProps => ({
  ...p, productId: product.id, priceId: price.id, price: fromMinor(price.unit_amount, price.currency), currency: price.currency,
  ...(price.billing_interval ? { interval: price.billing_interval, trialDays: price.trial_days } : { interval: undefined, trialDays: undefined }),
});

/**
 * Called on every page save (inside its transaction): the catalog is the authority for what a checkout block costs. A block that names a price of THIS workspace
 * gets its display fields (amount, currency, billing) refreshed from it (a replaced price is followed to its successor; an archived product keeps its last snapshot so
 * the page still renders). A block that names nothing, or something that is not this workspace's, is matched to an equal product or gets a new one, so every
 * checkout ends up linked. The link ids in the request are never trusted: they are looked up with the workspace id.
 */
export async function linkCatalog(d: Deps, ws: string, doc: ProjectDoc, actorId: string): Promise<ProjectDoc> {
  const nodes = productNodes(doc);
  if (!nodes.length) return doc;
  const next = new Map<string, ProductProps>();
  for (const { props, id } of nodes) {
    const found = props.priceId ? await currentPrice(d, ws, props.priceId) : null;
    if (found) {
      if (found.product.status === 'active' && found.price.active === 1) next.set(id, snapshot(props, found.product, found.price));
      continue; // archived: leave the page as it was, checkout refuses
    }
    const { productId: _p, priceId: _r, ...rest } = props;
    const made = await findOrCreateProduct(d, ws, actorId, { name: props.productName, description: props.description, type: 'one_time', amount: props.price, currency: props.currency });
    next.set(id, snapshot(rest as ProductProps, made.product, made.price));
  }
  return mapProducts(doc, (p, id) => next.get(id) ?? p);
}

/**
 * At upgrade: every workspace is scanned once and the checkout blocks of its pages (and the product names of its orders) are linked to catalog products, so
 * nothing derived from block props is left behind. Idempotent (a marker row per workspace) and safe to run on every boot.
 */
export async function backfillCatalog(deps: Deps): Promise<{ workspaces: number; pages: number; orders: number }> {
  const todo = await deps.db.all<{ id: string }>('SELECT id FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM catalog_backfill b WHERE b.workspace_id = w.id) ORDER BY id');
  let pages = 0;
  let orders = 0;
  for (const w of todo) {
    await inTx(deps, async (d) => {
      const rows = await d.db.all<{ step_id: string; doc_json: string }>("SELECT step_id, doc_json FROM step_pages WHERE workspace_id = ? AND doc_json LIKE '%\"fn-checkout\"%'", w.id);
      for (const r of rows) {
        let doc: ProjectDoc;
        try {
          doc = JSON.parse(r.doc_json) as ProjectDoc;
        } catch {
          continue;
        }
        if (doc.version !== 2) continue;
        const linked = await linkCatalog(d, w.id, doc, 'system');
        if (linked !== doc) {
          await d.db.run('UPDATE step_pages SET doc_json = ? WHERE step_id = ?', JSON.stringify(linked), r.step_id);
          pages++;
        }
      }
      // Orders: same product name and currency as a catalog product of the workspace.
      const res = await d.db.run(
        `UPDATE orders SET product_id = (SELECT p.id FROM products p WHERE p.workspace_id = orders.workspace_id AND lower(p.name) = lower(orders.product_name) ORDER BY p.created_at LIMIT 1),
                           role = CASE WHEN is_bump = 1 THEN 'bump' WHEN is_upsell = 1 THEN 'upsell' ELSE 'main' END
         WHERE workspace_id = ? AND product_id IS NULL`, w.id,
      );
      orders += res.changes;
      await d.db.run(`INSERT INTO catalog_backfill (workspace_id, done_at) VALUES (?, ?)${d.db.dialect.onConflictDoNothing()}`, w.id, d.now().toISOString());
    });
  }
  return { workspaces: todo.length, pages, orders };
}
