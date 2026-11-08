import { normalizeDoc, type ProjectDoc } from '../pagemodel/doc.js';
import { walk, wrapperOf, type GjsNode } from '../pagemodel/shared/clean.js';
import type { CatalogProps, ProductProps } from '../pagemodel/shared/props.js';

/** Pure operations on the checkout components of a page document (no database): used by the catalog link, template binding, import and export. */
export interface ProductNode {
  node: GjsNode;
  /** Checkout props, or the props of an Add to cart / product Payment form: they carry the same catalog fields (productName, price, currency, productId, priceId, slot). */
  props: ProductProps;
  /** The component id (the public checkout endpoint addresses it). */
  id: string;
  /** Which prop holds the catalog link. */
  key: 'fnProduct' | 'fnCartAdd' | 'fnPayment';
}

/** Components that name ONE catalog price: checkouts, Add to cart buttons, and Payment forms that sell a chosen product (a cart Payment form names none). */
export function productNodes(doc: ProjectDoc): ProductNode[] {
  const out: ProductNode[] = [];
  walk(wrapperOf(doc.project), (n) => {
    const id = ((n.attributes as Record<string, string> | undefined) ?? {}).id ?? '';
    if (n.type === 'fn-checkout' && n.fnProduct) out.push({ node: n, props: n.fnProduct as ProductProps, id, key: 'fnProduct' });
    else if (n.type === 'fn-cart-add' && n.fnCartAdd) out.push({ node: n, props: n.fnCartAdd as ProductProps, id, key: 'fnCartAdd' });
    else if (n.type === 'fn-payment' && (n.fnPayment as { source?: string } | undefined)?.source === 'product') out.push({ node: n, props: n.fnPayment as ProductProps, id, key: 'fnPayment' });
  });
  return out;
}

/** Copies the document, lets `fn` rewrite the props of each checkout component (return the same object to leave it), and rebuilds the derived `products` list. */
export function mapProducts(doc: ProjectDoc, fn: (p: ProductProps, id: string) => ProductProps): ProjectDoc {
  const copy = structuredClone(doc);
  let changed = false;
  for (const { node, props, id, key } of productNodes(copy)) {
    const next = fn(props, id);
    if (next !== props) {
      node[key] = next;
      changed = true;
    }
  }
  if (!changed) return doc;
  const r = normalizeDoc({ version: 2, project: copy.project }, { scriptsOk: true });
  if (!r.ok) throw new Error(`catalog link produced an invalid document: ${JSON.stringify(r.issues)}`);
  return r.doc;
}

/** Product catalog blocks of a page (they name products by hand-picked id or template slot, never one price). */
export function catalogNodes(doc: ProjectDoc): { node: GjsNode; props: CatalogProps; id: string }[] {
  const out: { node: GjsNode; props: CatalogProps; id: string }[] = [];
  walk(wrapperOf(doc.project), (n) => {
    if (n.type === 'fn-catalog' && n.fnCatalog) out.push({ node: n, props: n.fnCatalog as CatalogProps, id: ((n.attributes as Record<string, string> | undefined) ?? {}).id ?? '' });
  });
  return out;
}

/** Like mapProducts, for the props of Product catalog blocks. */
export function mapCatalogs(doc: ProjectDoc, fn: (p: CatalogProps) => CatalogProps): ProjectDoc {
  const copy = structuredClone(doc);
  let changed = false;
  for (const { node, props } of catalogNodes(copy)) {
    const next = fn(props);
    if (next !== props) {
      node.fnCatalog = next;
      changed = true;
    }
  }
  if (!changed) return doc;
  const r = normalizeDoc({ version: 2, project: copy.project }, { scriptsOk: true });
  if (!r.ok) throw new Error(`catalog link produced an invalid document: ${JSON.stringify(r.issues)}`);
  return r.doc;
}

/**
 * Templates carry no workspace ids: catalog links are removed (the slot, if any, stays). A Product catalog keeps the picks that name a template slot; one left
 * with no pick lists all products instead.
 */
export function stripCatalogLinks(doc: ProjectDoc): ProjectDoc {
  const stripped = mapProducts(doc, (p) => {
    if (!p.productId && !p.priceId) return p;
    const { productId: _a, priceId: _b, ...rest } = p;
    return rest as ProductProps;
  });
  return mapCatalogs(stripped, (c) => {
    if (!c.picks.some((x) => x.productId || x.priceId)) return c;
    const picks = c.picks.filter((x) => x.slot).map((x) => ({ slot: x.slot }));
    return { ...c, picks, source: picks.length ? c.source : 'all' };
  });
}
