import type { Deps } from '../deps.js';
import { loadDoc } from '../pagemodel/doc.js';
import type { CatalogItem, CatalogPrice } from '../pagemodel/shared/markup.js';
import { fromMinor } from '../util/money.js';
import type { PriceRow, ProductRow } from './catalog.js';
import { catalogNodes } from './catalogdoc.js';

/**
 * What the Product catalog block lists (docs/PRODUCTS.md#product-catalog-block, ADR 0048): the workspace's ACTIVE ONE-TIME products that have an active one-time
 * price, read from the database when a page is rendered (save, publish, any catalog change, previews, Cloudflare bundles). Subscriptions, archived products and
 * archived prices are never listed. A replaced price is listed under the price that replaced it, so a page that picked the old price shows the new one.
 */
export const CATALOG_SNAPSHOT_MAX = 200;

/** The snapshot of the catalog a page is rendered with. `ids` adds products that a block hand-picked (even beyond the first CATALOG_SNAPSHOT_MAX). */
export async function loadCatalog(deps: Deps, ws: string, ids: string[] = [], opts: { only?: boolean } = {}): Promise<CatalogItem[]> {
  const base = "workspace_id = ? AND status = 'active' AND type = 'one_time'";
  const rows = opts.only ? [] : await deps.db.all<ProductRow>(`SELECT * FROM products WHERE ${base} ORDER BY created_at, id LIMIT ?`, ws, CATALOG_SNAPSHOT_MAX);
  const missing = [...new Set(ids)].filter((id) => !rows.some((r) => r.id === id)).slice(0, 50);
  if (missing.length) rows.push(...(await deps.db.all<ProductRow>(`SELECT * FROM products WHERE ${base} AND id IN (${missing.map(() => '?').join(',')})`, ws, ...missing)));
  if (!rows.length) return [];
  const prices = await deps.db.all<PriceRow>(`SELECT * FROM prices WHERE workspace_id = ? AND product_id IN (${rows.map(() => '?').join(',')}) ORDER BY created_at, id`, ws, ...rows.map((r) => r.id));
  const byId = new Map(prices.map((p) => [p.id, p]));
  /** Where a replaced price leads (at most 10 hops, like catalog.currentPrice). */
  const current = (p: PriceRow): PriceRow | null => {
    let cur: PriceRow | undefined = p;
    for (let hop = 0; cur && hop < 10; hop++) {
      if (cur.active === 1) return cur;
      cur = cur.replaced_by ? byId.get(cur.replaced_by) : undefined;
    }
    return null;
  };
  const replaces = new Map<string, string[]>();
  for (const p of prices) {
    if (p.active === 1 || !p.replaced_by) continue;
    const to = current(p);
    if (to) replaces.set(to.id, [...(replaces.get(to.id) ?? []), p.id]);
  }
  const items: CatalogItem[] = [];
  for (const r of rows) {
    const own: CatalogPrice[] = prices
      .filter((p) => p.product_id === r.id && p.active === 1 && !p.billing_interval)
      .map((p) => ({ id: p.id, amount: fromMinor(p.unit_amount, p.currency), currency: p.currency, ...(replaces.has(p.id) ? { replaces: replaces.get(p.id)!.slice(0, 20) } : {}) }));
    if (!own.length) continue;
    let images: unknown = [];
    try {
      images = JSON.parse(r.images_json);
    } catch {
      /* no image */
    }
    const image = Array.isArray(images) && typeof images[0] === 'string' ? images[0] : null;
    items.push({ id: r.id, name: r.name, description: r.description, image, imageAlt: r.image_alt ?? '', createdAt: r.created_at, defaultPriceId: r.default_price_id, prices: own });
  }
  return items;
}

export const hasCatalogBlock = (docJson: string): boolean => docJson.includes('"fn-catalog"');

/** The catalog snapshot for rendering one stored page, or undefined when the page has no Product catalog block (nothing is read). */
export async function catalogFor(deps: Deps, ws: string, docJson: string): Promise<CatalogItem[] | undefined> {
  if (!hasCatalogBlock(docJson)) return undefined;
  const picked = catalogNodes(loadDoc(docJson)).flatMap((n) => (n.props.source === 'picked' ? n.props.picks.map((x) => x.productId).filter((x): x is string => !!x) : []));
  return loadCatalog(deps, ws, picked);
}

/** One sellable product as the catalog block would show it (for the add-to-cart check), or null when it is not listed (archived, subscription, no active price). */
export async function catalogItem(deps: Deps, ws: string, productId: string): Promise<CatalogItem | null> {
  return (await loadCatalog(deps, ws, [productId], { only: true })).find((i) => i.id === productId) ?? null;
}
