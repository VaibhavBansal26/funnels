import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { badRequest, notFound } from '../errors.js';
import type { ProjectDoc } from '../pagemodel/doc.js';
import type { ProductProps } from '../pagemodel/shared/props.js';
import { fromMinor } from '../util/money.js';
import type { TemplateProduct } from '../templates/types.js';
import { currentPrice, unavailable } from './catalog.js';
import { findOrCreateProduct } from './catalogcheckout.js';
import { mapProducts } from './catalogdoc.js';

/** How the product slots of a template are filled when it is used: an existing catalog price, or (the default) a product created from the template's defaults. */
export const BindingsInput = z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), z.union([z.object({ priceId: z.string().max(64) }), z.object({ create: z.literal(true) })]));

export async function bindTemplateProducts(d: Deps, auth: Auth, slots: TemplateProduct[], docs: ProjectDoc[], bindings: z.infer<typeof BindingsInput>): Promise<ProjectDoc[]> {
  const ws = auth.workspaceId;
  for (const key of Object.keys(bindings)) if (!slots.some((s) => s.key === key)) throw badRequest('UNKNOWN_SLOT', `The template has no product slot "${key}"`);
  const resolved = new Map<string, { productId: string; priceId: string; name: string; amount: number; currency: string; interval?: ProductProps['interval']; trialDays?: number }>();
  for (const slot of slots) {
    const b = bindings[slot.key];
    if (b && 'priceId' in b) {
      const found = await currentPrice(d, ws, b.priceId);
      if (!found) throw notFound('Price');
      if (found.product.status !== 'active' || found.price.active !== 1) throw unavailable();
      if (found.price.billing_interval && (slot.role === 'upsell' || slot.role === 'downsell')) throw badRequest('SUBSCRIPTION_UPSELL_UNSUPPORTED', 'A one-click upsell or downsell must be a one-time product');
      resolved.set(slot.key, { productId: found.product.id, priceId: found.price.id, name: found.product.name, amount: fromMinor(found.price.unit_amount, found.price.currency), currency: found.price.currency, interval: found.price.billing_interval ?? undefined, trialDays: found.price.billing_interval ? found.price.trial_days : undefined });
    } else {
      const made = await findOrCreateProduct(d, ws, auth.userId, { name: slot.name, description: slot.description, type: slot.type, amount: slot.amount, currency: slot.currency, interval: slot.interval, intervalCount: slot.intervalCount, trialDays: slot.trialDays });
      resolved.set(slot.key, { productId: made.product.id, priceId: made.price.id, name: made.product.name, amount: fromMinor(made.price.unit_amount, made.price.currency), currency: made.price.currency, interval: made.price.billing_interval ?? undefined, trialDays: made.price.billing_interval ? made.price.trial_days : undefined });
    }
  }
  return docs.map((doc) =>
    mapProducts(doc, (p) => {
      const r = p.slot ? resolved.get(p.slot) : undefined;
      return r ? { ...p, productId: r.productId, priceId: r.priceId, productName: r.name, price: r.amount, currency: r.currency, interval: r.interval, trialDays: r.trialDays } : p;
    }),
  );
}
