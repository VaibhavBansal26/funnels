import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import { inTx } from '../db/scope.js';
import type { Deps } from '../deps.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { loadDoc, type ProjectDoc } from '../pagemodel/doc.js';
import { createPageBuilder, type PageBuilder } from '../pagemodel/shared/build.js';
import type { GjsNode } from '../pagemodel/shared/clean.js';
import { wrapperOf } from '../pagemodel/shared/clean.js';
import type { ProductProps } from '../pagemodel/shared/props.js';
import { listSteps, lockFunnel, requireFunnel, requireStep } from '../repos/funnels.js';
import { footer, thanksSection } from '../templates/kit.js';
import { fromMinor, isCurrency } from '../util/money.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';
import { currentPrice, unavailable, type PriceRow, type ProductRow } from './catalog.js';
import { findOrCreateProduct } from './catalogcheckout.js';
import { syncProductSafely } from './catalogsync.js';
import { getFunnelDetail } from './funnels.js';
import { regenerateFunnel, savePage } from './pages.js';
import { slugPath } from './paths.js';
import { assertPathFree, insertStep } from './steps.js';

/**
 * "Add payments to this funnel": one call that picks (or creates) the products, builds the checkout blocks and the steps around them, and wires the flow:
 * offer -> checkout (with an order bump) -> one-click upsell -> downsell -> thank-you. Every step is a normal editable page afterwards. The prices come from the
 * catalog like everywhere else; the wizard only decides which blocks exist and where they send the buyer.
 */
const Ref = z.union([
  z.object({ priceId: z.string().min(1).max(64) }),
  z.object({
    create: z.object({
      name: z.string().trim().min(1).max(200),
      description: z.string().trim().max(500).optional(),
      amount: z.number().min(0.01).max(1_000_000),
      currency: z.string().trim().toUpperCase().refine(isCurrency, 'Unknown currency code'),
      type: z.enum(['one_time', 'subscription']).default('one_time'),
      interval: z.enum(['day', 'week', 'month', 'year']).optional(),
      trialDays: z.number().int().min(0).max(730).optional(),
    }),
  }),
]);

export const WizardInput = z.object({
  /** An existing step to put the checkout on (its page gets a new section at the end). Without it a new step is added. */
  stepId: z.string().max(64).optional(),
  /** one-step: product and payment form on one page. two-step: an offer page, then a checkout page. */
  layout: z.enum(['one-step', 'two-step']).default('one-step'),
  product: Ref,
  bump: Ref.optional(),
  upsell: Ref.optional(),
  downsell: Ref.optional(),
  thankYou: z.boolean().default(true),
  headline: z.string().trim().max(120).optional(),
});

interface Resolved {
  product: ProductRow;
  price: PriceRow;
}

async function resolveRef(d: Deps, auth: Auth, ref: z.infer<typeof Ref>, role: 'main' | 'bump' | 'upsell' | 'downsell', created: string[]): Promise<Resolved> {
  let r: Resolved | null;
  if ('priceId' in ref) {
    r = await currentPrice(d, auth.workspaceId, ref.priceId);
    if (!r) throw notFound('Price');
    if (r.product.status !== 'active' || r.price.active !== 1) throw unavailable();
  } else {
    const c = ref.create;
    if (c.type === 'subscription' && !c.interval) throw badRequest('INTERVAL_REQUIRED', 'A subscription needs an interval');
    r = await findOrCreateProduct(d, auth.workspaceId, auth.userId, { name: c.name, description: c.description, type: c.type, amount: c.amount, currency: c.currency, interval: c.interval, trialDays: c.trialDays });
    created.push(r.product.id);
  }
  if ((role === 'upsell' || role === 'downsell') && r.price.billing_interval) throw badRequest('SUBSCRIPTION_UPSELL_UNSUPPORTED', 'A one-click upsell or downsell must be a one-time product');
  return r;
}

const props = (x: Resolved, role: 'main' | 'bump' | 'upsell' | 'downsell', extra: Partial<ProductProps> = {}): Pick<ProductProps, 'productName' | 'price'> & Partial<ProductProps> => ({
  productName: x.product.name, description: x.product.description || undefined, price: fromMinor(x.price.unit_amount, x.price.currency), currency: x.price.currency, productId: x.product.id, priceId: x.price.id,
  ...(x.price.billing_interval ? { interval: x.price.billing_interval, trialDays: x.price.trial_days } : {}),
  ...(role === 'bump' ? { orderBump: true, buttonLabel: 'Add to order' } : role === 'upsell' ? { oneClickUpsell: true, buttonLabel: 'Yes, add it to my order' } : role === 'downsell' ? { oneClickUpsell: true, downsell: true, buttonLabel: 'Yes, add it to my order' } : { buttonLabel: x.price.billing_interval && x.price.trial_days ? 'Start free trial' : 'Buy now' }),
  ...extra,
});

const section = (pm: PageBuilder, children: GjsNode[], name: string) => pm.section(children, { padding: 'lg', width: 'small', align: 'center', name });
const withRules = (doc: ProjectDoc, pm: PageBuilder, sections: GjsNode[], atTop = false): ProjectDoc => {
  const copy = structuredClone(doc);
  const wrapper = wrapperOf(copy.project);
  wrapper.components = atTop ? [...sections, ...((wrapper.components as GjsNode[]) ?? [])] : [...((wrapper.components as GjsNode[]) ?? []), ...sections];
  copy.project.styles.push(...pm.rules);
  return copy;
};

function pageDoc(pm: PageBuilder, sections: GjsNode[], brand: string): ProjectDoc {
  return { version: 2, project: pm.project([...sections, footer(pm, brand)]), forms: [], products: [] };
}

export async function addPayments(deps: Deps, auth: Auth, funnelId: string, input: z.infer<typeof WizardInput>, ip?: string) {
  const ws = auth.workspaceId;
  const created: string[] = [];
  const result = await inTx(deps, async (d) => {
    const funnel = await lockFunnel(d.db, ws, funnelId);
    if (input.downsell && !input.upsell) throw badRequest('DOWNSELL_NEEDS_UPSELL', 'A downsell is shown when the upsell is declined: add an upsell first');
    const target = input.stepId ? await requireStep(d.db, ws, funnelId, input.stepId, true) : null;
    const main = await resolveRef(d, auth, input.product, 'main', created);
    const bump = input.bump ? await resolveRef(d, auth, input.bump, 'bump', created) : null;
    const upsell = input.upsell ? await resolveRef(d, auth, input.upsell, 'upsell', created) : null;
    const downsell = input.downsell ? await resolveRef(d, auth, input.downsell, 'downsell', created) : null;
    const currencies = new Set([main, bump].filter(Boolean).map((x) => x!.price.currency));
    if (currencies.size > 1) throw conflict('MIXED_CURRENCY', 'The product and its order bump must use the same currency');
    if (bump && main.price.billing_interval && bump.price.billing_interval && (bump.price.billing_interval !== main.price.billing_interval || bump.price.billing_interval_count !== main.price.billing_interval_count)) throw conflict('MIXED_INTERVAL', 'Subscriptions in one order must bill on the same interval');

    const base = slugPath(funnel.base_path.replace(/\/+$/, '') || funnel.name);
    const free = async (suffix: string) => {
      for (let n = 1; n < 50; n++) {
        const path = `${base}-${suffix}${n > 1 ? `-${n}` : ''}`;
        try {
          await assertPathFree(d, ws, funnel, path);
          return path;
        } catch (e) {
          if (n === 49) throw e;
        }
      }
      throw conflict('PATH_CONFLICT', 'No free path');
    };
    const pfx = `wz${randomBytes(3).toString('hex')}`;
    const ids = { offer: newId('stp'), checkout: newId('stp'), upsell: newId('stp'), downsell: newId('stp'), thanks: newId('stp') };
    const added: { id: string; name: string; path: string; kind: string }[] = [];
    const order = (await listSteps(d.db, ws, funnelId)).map((s) => s.id);
    const afterId = target?.id ?? order.at(-1) ?? null;
    const newOrder: string[] = [];
    const step = async (id: string, name: string, suffix: string, doc: ProjectDoc, kind: string) => {
      const path = await free(suffix);
      await insertStep(d, ws, funnel, { name, base_path: path, doc, scriptsOk: false }, id);
      added.push({ id, name, path, kind });
      newOrder.push(id);
    };
    const brand = funnel.name;
    const hasThanks = input.thankYou;
    const checkoutSuccess = hasThanks || input.upsell ? { type: 'next_step' as const } : { type: 'message' as const, message: 'Thank you! Your order is confirmed and a receipt is on its way.' };

    // ---- the checkout (and, for two steps, the offer before it) ----
    const pmC = createPageBuilder(pfx);
    const checkoutBlocks = [
      pmC.checkout(`${pfx}-main`, props(main, 'main', { success: checkoutSuccess, allowPromotionCodes: false }), { name: 'Checkout' }),
      ...(bump ? [pmC.checkout(`${pfx}-bump`, props(bump, 'bump'), { name: 'Order bump' })] : []),
    ];
    const checkoutSection = section(pmC, [pmC.stack([pmC.heading(input.headline ?? 'Complete your order', { level: target ? 2 : 1, align: 'center' }), ...(main.product.description ? [pmC.text(main.product.description, { align: 'center', muted: true })] : []), ...checkoutBlocks])], 'Checkout');
    let checkoutStepId: string;
    if (input.layout === 'one-step') {
      if (target) {
        const page = loadDoc((await d.db.get<{ doc_json: string }>('SELECT doc_json FROM step_pages WHERE step_id = ?', target.id))!.doc_json);
        await savePage(d, auth, funnelId, target.id, withRules(page, pmC, [checkoutSection]));
        checkoutStepId = target.id;
      } else {
        await step(ids.checkout, 'Checkout', 'checkout', pageDoc(pmC, [checkoutSection], brand), 'checkout');
        checkoutStepId = ids.checkout;
      }
    } else {
      const pmO = createPageBuilder(`${pfx}o`);
      const offer = section(pmO, [pmO.stack([
        pmO.eyebrow('Your offer', { align: 'center' }), pmO.heading(main.product.name, { level: target ? 2 : 1, align: 'center' }),
        ...(main.product.description ? [pmO.text(main.product.description, { align: 'center', muted: true })] : []),
        pmO.text(`**${fromMinor(main.price.unit_amount, main.price.currency).toLocaleString('en-US', { style: 'currency', currency: main.price.currency })}**${main.price.billing_interval ? ` / ${main.price.billing_interval}` : ''}`, { align: 'center', size: '1.6rem' }),
        pmO.button('Continue to checkout', { type: 'next_step' }, { size: 'lg', align: 'center' }),
      ])], 'Offer');
      if (target) {
        const page = loadDoc((await d.db.get<{ doc_json: string }>('SELECT doc_json FROM step_pages WHERE step_id = ?', target.id))!.doc_json);
        await savePage(d, auth, funnelId, target.id, withRules(page, pmO, [offer]));
      } else await step(ids.offer, 'Offer', 'offer', pageDoc(pmO, [offer], brand), 'sales');
      await step(ids.checkout, 'Checkout', 'checkout', pageDoc(pmC, [checkoutSection], brand), 'checkout');
      checkoutStepId = ids.checkout;
    }

    // ---- one-click offers and the thank-you ----
    if (upsell) {
      const pm = createPageBuilder(`${pfx}u`);
      const block = pm.checkout(`${pfx}-upsell`, props(upsell, 'upsell', { ...(downsell ? { declineStepId: ids.downsell } : {}), ...(hasThanks && downsell ? { acceptStepId: ids.thanks } : {}) }), { name: 'One-click upsell' });
      await step(ids.upsell, 'Special offer', 'special-offer', pageDoc(pm, [section(pm, [pm.stack([pm.badgeText('Wait! Your order is not complete yet'), pm.heading(`Add ${upsell.product.name} to your order`, { level: 1, align: 'center' }), ...(upsell.product.description ? [pm.text(upsell.product.description, { align: 'center', muted: true })] : []), block])], 'Special offer')], brand), 'upsell');
    }
    if (downsell) {
      const pm = createPageBuilder(`${pfx}d`);
      const block = pm.checkout(`${pfx}-downsell`, props(downsell, 'downsell'), { name: 'One-click downsell' });
      await step(ids.downsell, 'Last chance', 'last-chance', pageDoc(pm, [section(pm, [pm.stack([pm.badgeText('One more option'), pm.heading(`How about ${downsell.product.name}?`, { level: 1, align: 'center' }), ...(downsell.product.description ? [pm.text(downsell.product.description, { align: 'center', muted: true })] : []), block])], 'Last chance')], brand), 'downsell');
    }
    if (hasThanks) {
      const pm = createPageBuilder(`${pfx}t`);
      await step(ids.thanks, 'Thank you', 'thank-you', pageDoc(pm, [thanksSection(pm, { eyebrow: 'Order confirmed', title: 'Thank you for your order!', text: 'A receipt is on its way to your inbox.', bullets: ['Check your email for the receipt', 'Keep it for your records', 'Reply to that email if you need anything'] })], brand), 'thankyou');
    }

    // New steps go right after the step the checkout lives on (the flow order matters: each step's next step is the one below it).
    if (newOrder.length) {
      const final = afterId ? [...order.slice(0, order.indexOf(afterId) + 1), ...newOrder, ...order.slice(order.indexOf(afterId) + 1)] : [...order, ...newOrder];
      const unique = [...new Set(final)];
      for (const [id, position] of unique.map((id, i) => [id, i + 1] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1))) await d.db.run('UPDATE steps SET position = ? WHERE id = ?', position, id);
      await d.db.run('UPDATE funnels SET updated_at = ? WHERE id = ?', d.now().toISOString(), funnelId);
    }
    await regenerateFunnel(d, ws, funnelId);
    await audit(d, { workspaceId: ws, actorId: auth.userId, action: 'funnel.payments_added', target: funnelId, ip, detail: { layout: input.layout, steps: added.length, bump: !!bump, upsell: !!upsell, downsell: !!downsell } });
    return { checkoutStepId, added };
  });
  for (const id of new Set(created)) await syncProductSafely(deps, ws, id);
  await requireFunnel(deps.db, ws, funnelId);
  return { ...result, funnel: await getFunnelDetail(deps, ws, funnelId) };
}
