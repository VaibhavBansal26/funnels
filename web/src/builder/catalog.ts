import type { Product } from '../api/types';
import type { CatalogItem } from './pagemodel-bridge';

/**
 * The builder's view of what a Product catalog block lists: the same rule as the server's snapshot (services/catalogview.ts): active one-time products with an
 * active one-time price; a replaced price is listed under its successor. The published page is always rendered from the server's catalog, not from this.
 */
export function catalogItemsOf(products: Product[]): CatalogItem[] {
  const out: CatalogItem[] = [];
  for (const p of products) {
    if (p.status !== 'active' || p.type !== 'one_time') continue;
    const byId = new Map(p.prices.map((x) => [x.id, x]));
    const prices = p.prices.filter((x) => x.active && !x.interval).map((x) => {
      const replaces = p.prices.filter((o) => {
        let cur = o;
        for (let hop = 0; hop < 10 && !cur.active && cur.replacedBy; hop++) cur = byId.get(cur.replacedBy) ?? cur;
        return o.id !== x.id && !o.active && cur.id === x.id;
      }).map((o) => o.id);
      return { id: x.id, amount: x.amount, currency: x.currency, ...(replaces.length ? { replaces } : {}) };
    });
    if (!prices.length) continue;
    out.push({ id: p.id, name: p.name, description: p.description, image: p.images[0] ?? null, imageAlt: p.imageAlt ?? '', createdAt: p.createdAt, defaultPriceId: p.defaultPriceId, prices });
  }
  return out;
}
