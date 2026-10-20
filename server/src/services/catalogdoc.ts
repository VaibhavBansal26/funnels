import { normalizeDoc, type ProjectDoc } from '../pagemodel/doc.js';
import { walk, wrapperOf, type GjsNode } from '../pagemodel/shared/clean.js';
import type { ProductProps } from '../pagemodel/shared/props.js';

/** Pure operations on the checkout components of a page document (no database): used by the catalog link, template binding, import and export. */
export interface ProductNode {
  node: GjsNode;
  props: ProductProps;
  /** The component id (the public checkout endpoint addresses it). */
  id: string;
}

export function productNodes(doc: ProjectDoc): ProductNode[] {
  const out: ProductNode[] = [];
  walk(wrapperOf(doc.project), (n) => {
    if (n.type === 'fn-checkout' && n.fnProduct) out.push({ node: n, props: n.fnProduct as ProductProps, id: ((n.attributes as Record<string, string> | undefined) ?? {}).id ?? '' });
  });
  return out;
}

/** Copies the document, lets `fn` rewrite the props of each checkout component (return the same object to leave it), and rebuilds the derived `products` list. */
export function mapProducts(doc: ProjectDoc, fn: (p: ProductProps, id: string) => ProductProps): ProjectDoc {
  const copy = structuredClone(doc);
  let changed = false;
  for (const { node, props, id } of productNodes(copy)) {
    const next = fn(props, id);
    if (next !== props) {
      node.fnProduct = next;
      changed = true;
    }
  }
  if (!changed) return doc;
  const r = normalizeDoc({ version: 2, project: copy.project }, { scriptsOk: true });
  if (!r.ok) throw new Error(`catalog link produced an invalid document: ${JSON.stringify(r.issues)}`);
  return r.doc;
}

/** Templates carry no workspace ids: catalog links are removed (the slot, if any, stays). */
export function stripCatalogLinks(doc: ProjectDoc): ProjectDoc {
  return mapProducts(doc, (p) => {
    if (!p.productId && !p.priceId) return p;
    const { productId: _a, priceId: _b, ...rest } = p;
    return rest as ProductProps;
  });
}
