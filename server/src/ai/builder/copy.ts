import { z } from 'zod';
import { findViolations, ungroundedNumbers, usedAvoided } from './claims.js';
import { rng } from './brief.js';
import { plainOut } from './redact.js';
import { ILLUSTRATIONS, type Brief, type FormPlan, type IllustrationKind, type StepCopy, type StepPlan, type TemplateStepKind, type Voice } from './types.js';

const FIELD_TYPES = ['name', 'email', 'phone', 'text', 'textarea', 'select', 'checkbox'] as const;
/** Fields a funnel must not ask for: they are sensitive, rarely needed to follow up, and a liability to store. */
const SENSITIVE_LABEL = /\b(ssn|social security|passport|card number|credit card|cvv|password|date of birth|dob|salary|income|diagnos\w*|medical (history|condition)|religion|ethnic\w*|bank account|iban)\b/i;

export const CopyModelSchema = z.object({
  eyebrow: z.string().trim().max(40).default(''),
  headline: z.string().trim().min(1).max(100),
  subheadline: z.string().trim().max(240).default(''),
  bullets: z.array(z.string().trim().min(1).max(120)).max(5).default([]),
  cta: z.string().trim().min(1).max(40).default('Continue'),
  faq: z.array(z.object({ q: z.string().trim().min(1).max(120), a: z.string().trim().min(1).max(320) })).max(5).default([]),
  proofPrompts: z.array(z.string().trim().min(1).max(110)).max(3).default([]),
  form: z
    .object({
      fields: z.array(z.object({ label: z.string().trim().min(1).max(60), type: z.enum(FIELD_TYPES), required: z.boolean().default(false), options: z.array(z.string().trim().min(1).max(60)).max(8).optional() })).min(1).max(6),
      submitLabel: z.string().trim().min(1).max(40).default('Submit'),
    })
    .nullable()
    .default(null),
  illustration: z.object({ kind: z.enum(ILLUSTRATIONS).default('browser'), alt: z.string().trim().max(140).default('') }).default({ kind: 'browser', alt: '' }),
});
export type CopyModel = z.infer<typeof CopyModelSchema>;

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'field';

/** Builds the validated form definition: ids come from labels (never from the model), an email field always exists, sensitive fields are refused. */
export function normalizeForm(raw: CopyModel['form'], fallback: FormPlan): { form: FormPlan; problems: string[] } {
  if (!raw) return { form: fallback, problems: [] };
  const problems: string[] = [];
  const used = new Set<string>();
  const fields: FormPlan['fields'] = [];
  for (const f of raw.fields) {
    const label = plainOut(f.label, 60);
    if (!label) continue;
    if (SENSITIVE_LABEL.test(label)) {
      problems.push(`the field "${label}" asks for sensitive data; remove it`);
      continue;
    }
    let id = f.type === 'email' ? 'email' : f.type === 'name' ? 'name' : slug(label);
    if (!/^[a-z]/.test(id)) id = `f_${id}`;
    for (let n = 2; used.has(id); n++) id = `${id.replace(/_\d+$/, '')}_${n}`;
    used.add(id);
    const options = f.type === 'select' ? (f.options ?? []).map((o) => plainOut(o, 60)).filter(Boolean) : undefined;
    if (f.type === 'select' && !options?.length) {
      problems.push(`the select field "${label}" needs options`);
      continue;
    }
    fields.push({ id, type: f.type, label, required: f.type === 'email' ? true : f.required, ...(options ? { options } : {}) });
  }
  if (!fields.some((f) => f.type === 'email')) {
    fields.push({ id: 'email', type: 'email', label: 'Email', required: true });
    problems.push('a form needs an email field (added)');
  }
  return { form: { fields, submitLabel: plainOut(raw.submitLabel, 40) || fallback.submitLabel }, problems: problems.filter((p) => !p.includes('(added)')) };
}

// ---- deterministic writer ------------------------------------------------------------------------------------------------------------------------------

const CTA: Record<Voice, Record<'form' | 'checkout' | 'button' | 'book' | 'join', string>> = {
  persuasive: { form: 'Send me the details', checkout: 'Get instant access', button: 'Show me how', book: 'Book my call', join: 'Save my seat' },
  concise: { form: 'Get started', checkout: 'Buy now', button: 'Continue', book: 'Book a call', join: 'Register' },
  friendly: { form: 'Count me in', checkout: 'Yes, I want this', button: "Let's go", book: 'Book a chat', join: 'Save my spot' },
  formal: { form: 'Request information', checkout: 'Purchase', button: 'Continue', book: 'Request an appointment', join: 'Register now' },
  playful: { form: "I'm in!", checkout: 'Take my money (nicely)', button: 'Show me', book: 'Pick a time', join: 'Save me a seat' },
  authoritative: { form: 'Request access', checkout: 'Secure your order', button: 'Learn more', book: 'Schedule a consultation', join: 'Reserve your place' },
};

const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
const lower = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') : s);

export function defaultForm(kind: TemplateStepKind, b: Brief): FormPlan {
  const name = { id: 'name', type: 'name' as const, label: 'First name', required: true };
  const email = { id: 'email', type: 'email' as const, label: 'Email address', required: true };
  const phone = { id: 'phone', type: 'phone' as const, label: 'Phone (optional)', required: false };
  const sel = (id: string, label: string, options: string[]) => ({ id, type: 'select' as const, label, required: false, options });
  switch (kind) {
    case 'booking': case 'application': case 'landing': {
      const extra = b.industry === 'dental' ? [sel('preferred_time', 'Preferred time', ['Morning', 'Afternoon', 'Evening'])]
        : b.industry === 'real-estate' ? [sel('looking_to', 'I am looking to', ['Buy', 'Sell', 'Rent'])]
        : b.industry === 'home-services' ? [{ id: 'job', type: 'textarea' as const, label: 'What do you need done?', required: false }]
        : [{ id: 'message', type: 'textarea' as const, label: kind === 'application' ? 'Tell us about your goals' : 'How can we help?', required: false }];
      return { fields: [{ ...name, label: 'Name' }, email, phone, ...extra], submitLabel: '' };
    }
    case 'survey': return { fields: [sel('interest', 'What are you most interested in?', ['Learning more', 'Pricing', 'A demo', 'Something else']), email], submitLabel: '' };
    default: return { fields: [name, email], submitLabel: '' };
  }
}

export function defaultIllustration(b: Brief, kind: TemplateStepKind): { kind: IllustrationKind; alt: string } {
  const k: IllustrationKind = b.industry === 'saas' ? 'browser' : b.industry === 'food' || b.industry === 'nonprofit' || b.industry === 'events' ? 'discs'
    : b.industry === 'education' || b.industry === 'coaching' || b.industry === 'fitness' ? 'ring' : b.industry === 'agency' || b.regulated === 'finance' ? 'chart'
    : b.industry === 'media' || b.industry === 'ecommerce' && kind === 'upsell' ? 'phone' : 'browser';
  const alt = { browser: 'Decorative illustration of a web page with a headline and a button', phone: 'Decorative illustration of a phone showing a list of items', chart: 'Decorative illustration of a rising bar chart', ring: 'Decorative illustration of a progress ring', discs: 'Decorative illustration of overlapping coloured circles' }[k];
  return { kind: k, alt };
}

/** Deterministic copy for one step. The same brief and step always give the same words; nothing here states a fact the author did not give. */
export function heuristicCopy(b: Brief, step: StepPlan, seed: number): StepCopy {
  const r = rng(seed ^ (step.key.charCodeAt(1) * 7919));
  const what = short(b.offer || b.business, 70);
  const who = b.audience ? short(b.audience, 60) : 'people like you';
  const c = CTA[b.tone];
  const form = defaultForm(step.kind, b);
  const faq = (items: [string, string][]) => items.map(([q, a]) => ({ q, a }));
  const bullets = (xs: string[]) => xs.map((x) => short(x, 110));
  const proof = [`Ask a customer what changed after ${short(lower(b.offer || 'working with you'), 50)}.`, 'Ask a customer what nearly stopped them, and what they would tell a friend.'];
  const base = { eyebrow: '', proofPrompts: proof, form: step.primary === 'form' ? { ...form, submitLabel: '' } : null, illustration: defaultIllustration(b, step.kind) };
  const legal = b.regulated !== 'none';
  const gen = (x: Omit<StepCopy, 'eyebrow' | 'proofPrompts' | 'form' | 'illustration'> & Partial<StepCopy>): StepCopy => {
    const out: StepCopy = { ...base, ...x };
    if (out.form && !out.form.submitLabel) out.form = { ...out.form, submitLabel: out.cta };
    return out;
  };
  switch (step.kind) {
    case 'optin':
      return gen({
        eyebrow: 'Free guide',
        headline: pick(r, [`Get the free guide to ${lower(what)}`, `A simple starting point for ${lower(what)}`, `Your free guide: ${what}`]),
        subheadline: `Made for ${who}. Enter your email and we will send it straight away.`,
        bullets: bullets(['Clear, practical steps you can use today', 'Written for beginners, no jargon', `Focused on what matters to ${who}`]),
        cta: c.form,
        faq: faq([['What happens after I sign up?', 'You will see a confirmation and receive the guide at the email address you enter.'], ['Can I unsubscribe?', 'Yes. Every email includes an unsubscribe link.']]),
      });
    case 'registration':
      return gen({
        eyebrow: 'Free live session',
        headline: pick(r, [`Join the live session: ${what}`, `Learn ${lower(what)} in one live session`, `Live walkthrough: ${what}`]),
        subheadline: `A practical session for ${who}. Save your seat and we will email the details.`,
        bullets: bullets(['See the approach step by step', 'Ask your questions live', 'Leave with a clear next step']),
        cta: c.join,
        faq: faq([['Will there be a replay?', '[Add your replay policy here.]'], ['How do I join?', 'After you register you will receive the joining details by email.']]),
      });
    case 'landing':
      return gen({
        eyebrow: step.primary === 'form' ? (b.industry === 'dental' || b.industry === 'real-estate' ? 'Get in touch' : 'Welcome') : 'Introducing',
        headline: pick(r, [`${what}, made simple`, `${what} for ${who}`, `Meet ${lower(what)}`]),
        subheadline: step.primary === 'form' ? `Tell us a little about what you need and we will get back to you.` : `Everything ${who} need to get started, on one page.`,
        bullets: bullets(['Clear next steps from the first minute', `Designed around ${who}`, 'Straightforward and friendly to work with']),
        cta: step.primary === 'form' ? c.form : c.button,
        faq: faq([['How quickly will you reply?', '[Add your usual reply time here.]'], ['What does it cost?', b.priceMin !== null ? `Prices start from ${b.priceMin} ${b.currency}.` : '[Add your pricing information here.]']]),
      });
    case 'sales': case 'checkout':
      return gen({
        eyebrow: step.primary === 'checkout' ? 'The offer' : 'Learn more',
        headline: pick(r, [`${what}: everything in one place`, `Get ${lower(what)}`, `${what} for ${who}`]),
        subheadline: `Built for ${who}. Review what is included and continue when you are ready.`,
        bullets: bullets(['Everything you need to get started', 'Simple to use from day one', `Focused on ${who}`, 'Help when you need it']),
        cta: step.primary === 'checkout' ? c.checkout : c.form,
        faq: faq([['What is included?', '[Describe exactly what the buyer gets.]'], ['What is your refund policy?', '[Add your refund policy here.]'], ['How do I get access?', '[Describe how and when access is delivered.]']]),
      });
    case 'upsell': case 'downsell':
      return gen({
        eyebrow: 'One-time offer',
        headline: step.kind === 'upsell' ? 'Add this to your order' : 'Prefer a smaller option?',
        subheadline: step.kind === 'upsell' ? `A one-time offer for ${who}: add it with one click, no need to re-enter your details.` : 'A lighter option, available on this page only.',
        bullets: bullets(['Added to the order you just placed', 'One click, nothing to re-enter']),
        cta: step.kind === 'upsell' ? 'Yes, add it to my order' : 'Yes, I want this option',
        faq: [],
      });
    case 'booking': case 'application':
      return gen({
        eyebrow: step.kind === 'application' ? 'Apply' : 'Book',
        headline: pick(r, [step.kind === 'application' ? `Apply to work with us on ${lower(what)}` : `Book a time to talk about ${lower(what)}`, `Let's talk about ${lower(what)}`]),
        subheadline: `Tell us a little about you and we will reply to arrange a time.`,
        bullets: bullets(['A short, no-pressure conversation', 'Answers to your questions', 'A clear recommendation for your next step']),
        cta: step.kind === 'application' ? 'Send my application' : c.book,
        faq: faq([['What happens next?', 'We will contact you at the email or phone number you give to arrange a time.'], ['Is there any obligation?', '[Add what a first conversation involves.]']]),
      });
    case 'survey':
      return gen({ eyebrow: 'Quick question', headline: 'Help us point you in the right direction', subheadline: 'One question, then we will share what fits.', bullets: [], cta: 'Continue', faq: [] });
    case 'replay':
      return gen({ eyebrow: 'Replay', headline: `Watch the session: ${what}`, subheadline: 'The replay is available here.', bullets: [], cta: c.button, faq: [] });
    default:
      return gen({
        eyebrow: 'All done',
        headline: pick(r, ['Thank you, you are all set', 'Thanks! We have got it']),
        subheadline: step.kind === 'thankyou' ? `Check your inbox for what happens next.${legal ? '' : ' We are glad to have you.'}` : '',
        bullets: bullets(['Check your email for the confirmation', 'Add our address to your contacts so nothing lands in spam']),
        cta: 'Back to the homepage',
        faq: [],
      });
  }
}

/** Plain, length-capped, link-free copy from any source (model or writer). */
export function cleanCopy(c: StepCopy): StepCopy {
  return {
    eyebrow: plainOut(c.eyebrow, 40),
    headline: plainOut(c.headline, 100),
    subheadline: plainOut(c.subheadline, 240),
    bullets: c.bullets.map((x) => plainOut(x, 120)).filter(Boolean).slice(0, 5),
    cta: plainOut(c.cta, 40) || 'Continue',
    faq: c.faq.map((f) => ({ q: plainOut(f.q, 120), a: plainOut(f.a, 320) })).filter((f) => f.q && f.a).slice(0, 5),
    proofPrompts: c.proofPrompts.map((x) => plainOut(x, 110)).filter(Boolean).slice(0, 3),
    form: c.form,
    illustration: { kind: c.illustration.kind, alt: plainOut(c.illustration.alt, 140) },
  };
}

export const allText = (c: StepCopy): string => [c.eyebrow, c.headline, c.subheadline, c.cta, ...c.bullets, ...c.faq.flatMap((f) => [f.q, f.a]), ...c.proofPrompts, ...(c.form?.fields.map((f) => f.label) ?? [])].join('\n');

/** Everything the model may quote numbers from: the author's own words and prices. */
export const groundingText = (b: Brief): string => [b.business, b.offer, b.audience, ...b.constraints, ...b.mustInclude, b.priceMin ?? '', b.priceMax ?? ''].join('\n');

/** Problems with a step's copy, as sentences the repair prompt can quote back to the model. */
export function copyProblems(c: StepCopy, b: Brief, kind: TemplateStepKind, extraGround = ''): string[] {
  const out: string[] = [];
  const text = allText(c);
  for (const v of findViolations(text, b.regulated)) out.push(`remove the ${v.rule} ("${v.excerpt}")`);
  const nums = ungroundedNumbers(text, `${groundingText(b)}\n${extraGround}`);
  if (nums.length) out.push(`do not invent statistics or counts (${[...new Set(nums)].slice(0, 4).join(', ')}); use only numbers from the brief`);
  const avoided = usedAvoided(text, b.avoid);
  if (avoided.length) out.push(`do not use these words: ${avoided.join(', ')}`);
  if (kind !== 'thankyou' && !c.headline) out.push('the headline is empty');
  if (c.cta.split(/\s+/).length > 6) out.push('the button text must be at most 6 words');
  if (/\b(testimonial|review)s?\b.*["“”]/i.test(c.proofPrompts.join(' ')) && /["“”]/.test(c.proofPrompts.join(' '))) out.push('proofPrompts are instructions for the author, not quotes');
  return out;
}
