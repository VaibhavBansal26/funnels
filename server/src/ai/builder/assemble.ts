import { normalizeDoc, type ProjectDoc } from '../../pagemodel/doc.js';
import type { FormProps, ProductProps } from '../../pagemodel/shared/props.js';
import type { GjsNode } from '../../pagemodel/shared/clean.js';
import { browserMock, chartMock, discs, faqSection, feature, phoneMock, PASTEL, ringMock, thanksSection, createPageBuilder, type PageBuilder } from '../../templates/kit.js';
import { plainOut } from './redact.js';
import type { Brief, IllustrationKind, ProductPlan, StepCopy, StepPlan, Strategy } from './types.js';

export interface AssembleCtx { brief: Brief; strategy: Strategy; products: ProductPlan[]; copy: StepCopy; step: StepPlan; index: number }
export interface AssembledStep { key: string; kind: StepPlan['kind']; name: string; base_path: string; doc: ProjectDoc }

function illustration(pm: PageBuilder, kind: IllustrationKind, alt: string, accent: string): GjsNode {
  const art =
    kind === 'phone' ? phoneMock(pm, accent) : kind === 'chart' ? chartMock(pm, [30, 45, 40, 62, 78, 95], accent) : kind === 'ring' ? ringMock(pm, 72, '✓', accent) : kind === 'discs' ? discs(pm) : browserMock(pm, accent);
  const wrap = pm.box([art], { name: 'Illustration', style: { display: 'flex', 'justify-content': 'center', 'align-items': 'center', width: '100%' } });
  wrap.attributes = { ...(wrap.attributes as Record<string, string>), role: 'img', 'aria-label': alt || 'Decorative illustration' };
  return wrap;
}

const consentFor = (kind: StepPlan['kind']) => (kind === 'booking' || kind === 'application' || kind === 'landing' ? 'I agree to be contacted about my request.' : 'I agree to receive emails about this and can unsubscribe at any time.');

function formNode(pm: PageBuilder, c: AssembleCtx): GjsNode {
  const f = c.copy.form!;
  const props: Partial<FormProps> & Pick<FormProps, 'fields'> = {
    name: c.step.name,
    fields: f.fields.map((x) => ({ id: x.id, type: x.type, label: x.label, required: x.required, ...(x.options ? { options: x.options } : {}) })),
    submitLabel: f.submitLabel || c.copy.cta,
    consent: { enabled: true, text: consentFor(c.step.kind) },
    success: c.index === c.strategy.steps.length - 1 ? { type: 'message', message: 'Thank you. We have received your details.' } : { type: 'next_step' },
  };
  return pm.form(`${c.step.key}-form`, props, { name: c.step.name });
}

function checkoutNode(pm: PageBuilder, p: ProductPlan, c: AssembleCtx, o: { id: string; label?: string; bump?: boolean; upsell?: boolean }): GjsNode {
  const props: Partial<ProductProps> & Pick<ProductProps, 'productName' | 'price'> = {
    productName: p.name.slice(0, 200), price: p.amount, currency: p.currency, description: p.description ? plainOut(p.description, 500) : undefined,
    buttonLabel: (o.label ?? c.copy.cta).slice(0, 80), orderBump: !!o.bump, oneClickUpsell: !!o.upsell, slot: p.slot, ...(p.interval ? { interval: p.interval } : {}),
    ...(p.source === 'catalog' ? { productId: p.productId, priceId: p.priceId } : {}),
  };
  return pm.checkout(o.id, props, { name: o.bump ? 'Order bump' : o.upsell ? 'One-click upsell' : 'Checkout' });
}

function proofSection(pm: PageBuilder, c: AssembleCtx): GjsNode | null {
  if (!c.copy.proofPrompts.length) return null;
  return pm.section([
    pm.stack([pm.heading('What customers say', { align: 'center', level: 2 }), pm.text('These are placeholders. Replace each with a real quote from a real customer, or delete this section.', { align: 'center', muted: true, size: '.95rem' })]),
    pm.cols(c.copy.proofPrompts.slice(0, 3).map((prompt) => [pm.card([
      pm.badgeText('Placeholder testimonial'),
      pm.text(`[Quote to collect: ${prompt}]`, { name: 'Placeholder quote' }),
      pm.text('Customer name and role go here', { muted: true, size: '.9rem' }),
    ], { name: 'Testimonial placeholder' })])),
  ], { padding: 'lg', width: 'wide', name: 'Customer quotes (placeholders)' });
}

export function assembleStep(c: AssembleCtx): AssembledStep {
  const { brief, strategy, copy, step } = c;
  const pm = createPageBuilder(step.key);
  const accent = strategy.base.accent;
  const main = c.products.find((p) => p.role === step.role);
  const bump = step.kind === 'sales' ? c.products.find((p) => p.role === 'bump') : undefined;
  const sections: GjsNode[] = [];
  const brand = plainOut(brief.business, 60) || 'Your business';
  const heading = (t: string) => pm.heading(t, { level: 1 });

  if (step.kind === 'thankyou') {
    sections.push(thanksSection(pm, { eyebrow: copy.eyebrow || undefined, title: copy.headline, text: copy.subheadline, bullets: copy.bullets.length ? copy.bullets : undefined }));
  } else if (step.kind === 'upsell' || step.kind === 'downsell') {
    sections.push(pm.section([pm.stack([
      pm.eyebrow(copy.eyebrow || 'One-time offer', { align: 'center' }), heading(copy.headline), pm.text(copy.subheadline, { muted: true }),
      pm.list(copy.bullets),
      ...(main ? [checkoutNode(pm, main, c, { id: `${step.key}-offer`, upsell: true })] : []),
      pm.button('No thanks, skip this offer', { type: 'next_step' }, { variant: 'outline', align: 'center' }),
    ])], { padding: 'xl', width: 'small', align: 'center', name: 'Offer' }));
  } else {
    const action: GjsNode[] = [];
    if (step.primary === 'form' && copy.form) action.push(formNode(pm, c));
    else if (step.primary === 'button') action.push(pm.button(copy.cta, { type: 'next_step' }, { size: 'lg' }));
    const left = [
      ...(copy.eyebrow ? [pm.eyebrow(copy.eyebrow)] : []),
      heading(copy.headline), pm.text(copy.subheadline, { size: '1.15rem' }),
      ...(step.primary === 'checkout' ? [pm.button(copy.cta, { type: 'anchor', anchor: 'offer' }, { size: 'lg' })] : action),
    ];
    sections.push(pm.section([pm.row([
      pm.col(left, { grow: 1 }),
      pm.col([illustration(pm, copy.illustration.kind, copy.illustration.alt, accent)], { grow: 1 }),
    ], { valign: 'center', gap: 'lg' })], { theme: 'dark', background: strategy.base.hero, padding: 'xl', width: 'wide', anchor: step.primary === 'checkout' ? undefined : 'top', name: 'Hero' }));
    if (step.primary === 'checkout' && main) {
      sections.push(pm.section([pm.stack([
        pm.heading('Your order', { level: 2, align: 'center' }),
        checkoutNode(pm, main, c, { id: `${step.key}-main` }),
        ...(bump ? [checkoutNode(pm, bump, c, { id: `${step.key}-bump`, bump: true })] : []),
      ])], { padding: 'lg', width: 'small', anchor: 'offer', name: 'Offer' }));
    }
    if (copy.bullets.length) {
      const cards = copy.bullets.slice(0, 3).map((b, i) => [feature(pm, String(i + 1), plainOut(b.split(/[:,.]/)[0]!, 40) || `Point ${i + 1}`, b)]);
      sections.push(pm.section([pm.stack([pm.heading('What to expect', { align: 'center', level: 2 })]), pm.cols(cards), ...(copy.bullets.length > 3 ? [pm.list(copy.bullets.slice(3))] : [])], { theme: 'soft', padding: 'lg', width: 'wide', name: 'Benefits' }));
    }
    const proof = proofSection(pm, c);
    if (proof) sections.push(proof);
    if (copy.faq.length) sections.push(faqSection(pm, 'Questions', copy.faq));
    if (step.primary !== 'none') {
      const target = step.primary === 'checkout' ? 'offer' : 'top';
      sections.push(pm.section([pm.stack([pm.heading(copy.headline, { align: 'center', level: 2 }), pm.button(copy.cta, { type: 'anchor', anchor: target }, { variant: 'secondary', size: 'lg', align: 'center' })])], { theme: 'accent', padding: 'lg', width: 'medium', align: 'center', name: 'Call to action' }));
    }
  }
  sections.push(pm.footer(`© ${brand}`));
  const r = normalizeDoc({ version: 2, project: pm.project(sections, { accent }) }, { scriptsOk: false });
  if (!r.ok) throw new Error(`assembled page is invalid: ${JSON.stringify(r.issues.slice(0, 3))}`);
  return { key: step.key, kind: step.kind, name: step.name, base_path: step.path, doc: r.doc };
}

export { PASTEL };
