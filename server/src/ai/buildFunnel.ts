import { createBuilder, documentOf, field, type Block, type PageDocument } from '../blocks/index.js';
import { slugPath } from '../services/paths.js';
import type { FunnelCopy } from './schemas.js';
import type { Goal, StepKind } from './types.js';

const BASE: Record<Goal, StepKind[]> = {
  leads: ['optin', 'thankyou'],
  webinar: ['registration', 'thankyou'],
  sales: ['sales', 'upsell', 'thankyou'],
  booking: ['booking', 'thankyou'],
};

/** Page kinds for a goal and step count. Always decided here so model output (or injected text) can never change the structure. */
export function planSteps(goal: Goal, count: number): StepKind[] {
  const n = Math.min(Math.max(Math.round(count), 1), 6);
  const base = BASE[goal];
  if (n <= base.length) return base.slice(0, n);
  return [base[0]!, ...Array<StepKind>(n - base.length).fill('story'), ...base.slice(1)];
}

const NAMES: Record<StepKind, string> = { optin: 'Opt-in page', registration: 'Registration page', story: 'Story page', sales: 'Sales page', upsell: 'One-click upsell', booking: 'Booking page', thankyou: 'Thank-you page' };

export interface BuiltStep {
  kind: StepKind;
  name: string;
  base_path: string;
  doc: PageDocument;
}

/** Turns plain copy into valid block documents. Copy is plain text; the renderer escapes it. */
export function buildSteps(kinds: StepKind[], copy: FunnelCopy): BuiltStep[] {
  const used = new Set<string>();
  return kinds.map((kind, i) => {
    const c = copy.steps[i] ?? copy.steps[copy.steps.length - 1]!;
    const b = createBuilder(`a${i + 1}-`);
    const head: Block[] = [b.heading(c.headline, { level: 1, align: 'center' })];
    if (c.subheadline) head.push(b.paragraph(c.subheadline, { align: 'center', color: '#4b5563' }));
    const bullets = c.bullets.length ? [b.list(c.bullets)] : [];
    let body: Block[];
    switch (kind) {
      case 'optin':
      case 'registration':
        body = [
          ...(kind === 'registration' ? [b.countdown({ mode: 'evergreen', minutes: 60 * 24, label: 'Seats are filling up' })] : []),
          ...bullets,
          b.form({ name: kind === 'optin' ? 'Opt-in' : 'Registration', fields: [field('name', 'name', 'First name', true), field('email', 'email', 'Email', true)], submitLabel: c.cta, consent: true }),
        ];
        break;
      case 'story':
        body = [...bullets, b.button(c.cta, { type: 'next_step' }, { size: 'lg', align: 'center' })];
        break;
      case 'sales':
        body = [
          ...bullets,
          b.checkout({ productName: 'Main offer', price: 97, description: 'Replace this with your product description.', buttonLabel: c.cta }),
          b.checkout({ productName: 'Bonus add-on', price: 19, orderBump: true, description: 'Add this bonus to your order.' }),
          b.faq([{ q: 'Is there a guarantee?', a: 'Describe your refund policy here.' }, { q: 'How do I get access?', a: 'Describe delivery here.' }]),
        ];
        break;
      case 'upsell':
        body = [...bullets, b.checkout({ productName: 'Special one-time offer', price: 47, oneClickUpsell: true, buttonLabel: c.cta })];
        break;
      case 'booking':
        body = [...bullets, b.form({ name: 'Booking request', fields: [field('name', 'name', 'Name', true), field('email', 'email', 'Email', true), field('phone', 'phone', 'Phone'), field('message', 'textarea', 'What would you like to talk about?')], submitLabel: c.cta, consent: true })];
        break;
      case 'thankyou':
        body = [];
        break;
    }
    let path = slugPath(kind === 'thankyou' ? 'thank-you' : NAMES[kind]);
    for (let n = 2; used.has(path); n++) path = `${slugPath(NAMES[kind])}-${n}`;
    used.add(path);
    return { kind, name: NAMES[kind], base_path: path, doc: documentOf([b.section([...head, ...body], { padding: 'lg', align: 'center', width: 'narrow' })]) };
  });
}
