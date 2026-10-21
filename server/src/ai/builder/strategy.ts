import { z } from 'zod';
import { slugPath } from '../../services/paths.js';
import { childrenOf, wrapperOf, type GjsNode } from '../../pagemodel/shared/clean.js';
import { LIBRARY } from '../../templates/library/index.js';
import { HERO } from '../../templates/kit.js';
import type { TemplateDef } from '../../templates/types.js';
import { FUNNEL_TYPES, STEP_KINDS, type Brief, type FunnelType, type ProductMode, type StepPlan, type Strategy, type TemplatePick, type TemplateStepKind } from './types.js';

/**
 * Funnel taxonomy: the step sequence of every funnel type, in the vocabulary of the template library (`templates/types.ts`), so a plan can be compared with
 * the native templates and the closest one lends its look. The model may choose among these shapes; it cannot invent a step kind or reorder the thank-you page.
 */
export const SEQUENCES: Record<FunnelType, TemplateStepKind[]> = {
  lead_magnet: ['optin', 'thankyou'],
  waitlist: ['landing', 'thankyou'],
  webinar: ['registration', 'thankyou'],
  sales_page: ['sales', 'upsell', 'thankyou'],
  product_launch: ['landing', 'checkout', 'thankyou'],
  saas_trial: ['landing', 'checkout', 'thankyou'],
  booking: ['booking', 'thankyou'],
  application: ['landing', 'application', 'thankyou'],
  event: ['landing', 'checkout', 'thankyou'],
  donation: ['landing', 'thankyou'],
  local_lead: ['landing', 'thankyou'],
};

export const TYPE_LABEL: Record<FunnelType, string> = {
  lead_magnet: 'Lead magnet', waitlist: 'Waitlist', webinar: 'Webinar registration', sales_page: 'Sales page with bump and upsell', product_launch: 'Product launch', saas_trial: 'Software free trial',
  booking: 'Booking page', application: 'Application funnel', event: 'Event tickets', donation: 'Donation page', local_lead: 'Local business enquiry',
};

const NAMES: Record<TemplateStepKind, string> = {
  page: 'Page', landing: 'Landing page', optin: 'Opt-in page', registration: 'Registration page', replay: 'Replay page', sales: 'Sales page', checkout: 'Checkout page', upsell: 'One-click upsell',
  downsell: 'Downsell offer', booking: 'Booking page', application: 'Application page', survey: 'Survey', thankyou: 'Thank-you page',
};

const LOCAL = new Set(['food', 'dental', 'fitness', 'real-estate', 'home-services']);

export function chooseFunnelType(b: Brief, mode: ProductMode, text = ''): FunnelType {
  const t = `${b.business} ${b.offer} ${text}`.toLowerCase();
  switch (b.goal) {
    case 'webinar': return 'webinar';
    case 'events': return 'event';
    case 'donations': return 'donation';
    case 'booking': return /\b(apply|application)\b/.test(t) ? 'application' : b.industry === 'coaching' && /\bprogram|high[- ]ticket\b/.test(t) ? 'application' : 'booking';
    case 'sales':
      if (b.industry === 'saas') return 'saas_trial';
      if (/\blaunch\b/.test(t)) return 'product_launch';
      return 'sales_page';
    case 'leads':
      if (/\bwaitlist|coming soon|pre-?launch\b/.test(t)) return 'waitlist';
      return LOCAL.has(b.industry) ? 'local_lead' : 'lead_magnet';
    default:
      return 'lead_magnet';
  }
}

/** What the visitor is asked to do on each page. Decided here from the kind and its neighbours, never by the model. */
export function primaryFor(kind: TemplateStepKind, next: TemplateStepKind | undefined, mode: ProductMode): StepPlan['primary'] {
  switch (kind) {
    case 'thankyou': return 'none';
    case 'optin': case 'registration': case 'booking': case 'application': case 'survey': return 'form';
    case 'sales': return mode === 'none' ? 'form' : 'checkout';
    case 'checkout': case 'upsell': case 'downsell': return mode === 'none' ? 'form' : 'checkout';
    case 'landing': return next === 'thankyou' ? 'form' : 'button';
    default: return 'button';
  }
}

/** The pages of a funnel type. Without catalog products there is nothing to check out, so offer pages become enquiry forms and upsell steps are dropped. */
export function planSteps(type: FunnelType, mode: ProductMode, count?: number, kinds: TemplateStepKind[] = SEQUENCES[type]): StepPlan[] {
  let seq = [...kinds];
  if (mode === 'none') seq = seq.filter((k) => k !== 'upsell' && k !== 'downsell');
  if (mode === 'none' && seq.includes('checkout')) seq = seq.map((k) => (k === 'checkout' ? 'application' : k));
  if (mode === 'none' && type === 'donation') seq = ['landing', 'thankyou'];
  if (count && count < seq.length) seq = [...seq.slice(0, Math.max(1, count - 1)), 'thankyou'];
  const used = new Set<string>();
  return seq.map((kind, i) => {
    let path = slugPath(kind === 'thankyou' ? 'thank-you' : NAMES[kind]);
    for (let n = 2; used.has(path); n++) path = `${slugPath(NAMES[kind])}-${n}`;
    used.add(path);
    const main = (kind === 'sales' || kind === 'checkout' || kind === 'landing' && type === 'donation') && mode !== 'none';
    return {
      key: `s${i + 1}`, kind, name: NAMES[kind], path,
      primary: type === 'donation' && kind === 'landing' && mode !== 'none' ? 'checkout' : primaryFor(kind, seq[i + 1], mode),
      ...(main ? { role: 'main' as const } : kind === 'upsell' ? { role: 'upsell' as const } : kind === 'downsell' ? { role: 'downsell' as const } : {}),
    };
  });
}

/** First dark section's gradient in a template: the "hero look" the generated pages borrow. */
function heroOf(t: TemplateDef): string {
  for (const step of t.steps) {
    const styles = new Map<string, Record<string, string>>();
    for (const r of step.doc.project.styles) {
      const sel = r.selectors?.[0];
      if (typeof sel === 'string' && sel.startsWith('#') && !r.mediaText && !r.state) styles.set(sel.slice(1), { ...(styles.get(sel.slice(1)) ?? {}), ...r.style });
    }
    let found = '';
    const visit = (n: GjsNode) => {
      if (found) return;
      const id = (n.attributes as Record<string, string> | undefined)?.id;
      const own = (n.style as Record<string, string> | undefined)?.background;
      const bg = id ? (styles.get(id)?.background ?? own) : own;
      if (((n.classes as string[] | undefined) ?? []).includes('fn-dark') && bg && /gradient/.test(bg)) found = bg;
      for (const c of childrenOf(n)) visit(c);
    };
    visit(wrapperOf(step.doc.project));
    if (found) return found;
  }
  return HERO.blue as string;
}

/** Template ranking: step-kind overlap with the plan, the same goal, the same industry. Pure and deterministic. */
export function pickTemplates(b: Brief, kinds: TemplateStepKind[], library: TemplateDef[] = LIBRARY): TemplatePick[] {
  const set = new Set(kinds);
  return library
    .map((t) => {
      const tk = new Set<string>(t.steps.map((s) => s.kind));
      const inter = [...set].filter((k) => tk.has(k)).length;
      const union = new Set([...set, ...tk]).size;
      const overlap = inter / union;
      const goal = t.goal === b.goal ? 3 : 0;
      const industry = t.industry === b.industry ? 3 : t.industry === 'general' ? 0.5 : 0;
      const score = Math.round((overlap * 4 + goal + industry) * 100) / 100;
      const why = [`${Math.round(overlap * 100)}% of the same page types`, goal ? `same goal (${t.goal})` : '', industry >= 3 ? `same industry (${t.industry})` : ''].filter(Boolean).join(', ');
      return { slug: t.slug, name: t.name, score, reason: why };
    })
    .sort((a, c) => c.score - a.score || (a.slug < c.slug ? -1 : 1))
    .slice(0, 3);
}

export function strategyFor(b: Brief, mode: ProductMode, steps?: number, forced?: { funnelType: FunnelType; kinds: TemplateStepKind[]; rationale: string }): Strategy {
  const funnelType = forced?.funnelType ?? chooseFunnelType(b, mode);
  const plan = planSteps(funnelType, mode, steps, forced?.kinds);
  const templates = pickTemplates(b, plan.map((p) => p.kind));
  const top = LIBRARY.find((t) => t.slug === templates[0]?.slug) ?? LIBRARY[0]!;
  const noCheckout = mode === 'none' && ['sales_page', 'product_launch', 'saas_trial', 'event', 'donation'].includes(funnelType);
  return {
    funnelType,
    rationale: forced?.rationale || `${TYPE_LABEL[funnelType]}: ${plan.map((p) => p.name).join(' then ')}.${noCheckout ? ' No catalog products were requested, so the offer page collects enquiries instead of taking payment.' : ''}`,
    steps: plan,
    templates,
    base: { slug: top.slug, accent: top.accent, hero: heroOf(top) },
  };
}

/** What the model returns for the strategy stage. */
export const StrategyModelSchema = z.object({
  funnelType: z.enum(FUNNEL_TYPES),
  rationale: z.string().trim().min(1).max(400),
  steps: z.array(z.object({ kind: z.enum(STEP_KINDS) })).min(1).max(6),
});

/** Semantic check of a model strategy. Returns the reasons it is unusable (fed back to the model on a repair retry). */
export function strategyProblems(m: z.infer<typeof StrategyModelSchema>, mode: ProductMode): string[] {
  const out: string[] = [];
  const kinds = m.steps.map((s) => s.kind);
  if (kinds[kinds.length - 1] !== 'thankyou') out.push('the last step must be "thankyou"');
  if (kinds.slice(0, -1).includes('thankyou')) out.push('"thankyou" may only be the last step');
  if (kinds.length > 1 && kinds[0] === 'thankyou') out.push('the first step cannot be the thank-you page');
  if (mode === 'none' && kinds.some((k) => k === 'checkout' || k === 'upsell' || k === 'downsell')) out.push('no catalog products were requested: do not use checkout, upsell or downsell steps');
  if (new Set(kinds).size !== kinds.length && kinds.some((k, i) => kinds.indexOf(k) !== i && k !== 'page' && k !== 'landing')) out.push('do not repeat a step kind');
  if (mode !== 'none' && (kinds.includes('upsell') || kinds.includes('downsell')) && !kinds.includes('sales') && !kinds.includes('checkout')) out.push('an upsell needs a sales or checkout step before it');
  return out;
}

export { NAMES as STEP_NAMES };
