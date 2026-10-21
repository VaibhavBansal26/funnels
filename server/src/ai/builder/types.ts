import { z } from 'zod';
import { TEMPLATE_GOALS, STEP_KINDS, type ProductRole, type TemplateGoal } from '../../templates/types.js';

export { TEMPLATE_GOALS, STEP_KINDS };
export type { TemplateGoal, ProductRole };
export type TemplateStepKind = (typeof STEP_KINDS)[number];

export const VOICES = ['persuasive', 'concise', 'friendly', 'formal', 'playful', 'authoritative'] as const;
export type Voice = (typeof VOICES)[number];

export const FUNNEL_TYPES = ['lead_magnet', 'webinar', 'sales_page', 'product_launch', 'saas_trial', 'booking', 'application', 'event', 'donation', 'local_lead', 'waitlist'] as const;
export type FunnelType = (typeof FUNNEL_TYPES)[number];

export const REGULATED = ['none', 'health', 'finance', 'legal'] as const;
export type Regulated = (typeof REGULATED)[number];

export const PRODUCT_MODES = ['none', 'create', 'existing'] as const;
export type ProductMode = (typeof PRODUCT_MODES)[number];

/** Optional structured fields next to the free-text prompt. Anything given here wins over what is read from the prompt. */
export const StructuredBrief = z.object({
  business: z.string().max(2000).optional(),
  offer: z.string().max(2000).optional(),
  audience: z.string().max(1000).optional(),
  tone: z.enum(VOICES).optional(),
  goal: z.enum(TEMPLATE_GOALS).optional(),
  priceMin: z.number().min(0).max(1_000_000).optional(),
  priceMax: z.number().min(0).max(1_000_000).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  constraints: z.array(z.string().max(300)).max(10).optional(),
  avoid: z.array(z.string().max(60)).max(20).optional(),
  mustInclude: z.array(z.string().max(120)).max(10).optional(),
  language: z.string().max(40).optional(),
});
export type StructuredBriefInput = z.infer<typeof StructuredBrief>;

export const BuildOptions = z.object({
  products: z.enum(PRODUCT_MODES).default('none'),
  /** Existing catalog products (by id) the funnel may sell; used when products = 'existing'. */
  productIds: z.array(z.string().max(64)).max(5).optional(),
  redactPii: z.boolean().default(false),
  steps: z.number().int().min(1).max(6).optional(),
});
export type BuildOptionsInput = z.infer<typeof BuildOptions>;

export interface Brief {
  business: string;
  offer: string;
  audience: string;
  tone: Voice;
  goal: TemplateGoal;
  industry: string;
  currency: string;
  priceMin: number | null;
  priceMax: number | null;
  constraints: string[];
  avoid: string[];
  mustInclude: string[];
  language: string;
  regulated: Regulated;
  assumptions: string[];
  /** The prompt tried to give the model instructions (see redact.ts). The text is still used as subject matter only. */
  injectionSuspected: boolean;
}

export interface StepPlan {
  /** Stable key within the generation ("s1", "s2"...), used by "regenerate step". */
  key: string;
  kind: TemplateStepKind;
  name: string;
  path: string;
  /** What the visitor is asked to do on this page. */
  primary: 'form' | 'checkout' | 'button' | 'none';
  role?: ProductRole;
}

export interface TemplatePick { slug: string; name: string; score: number; reason: string }

export interface Strategy {
  funnelType: FunnelType;
  rationale: string;
  steps: StepPlan[];
  templates: TemplatePick[];
  base: { slug: string; accent: string; hero: string };
}

export const ILLUSTRATIONS = ['browser', 'phone', 'chart', 'ring', 'discs'] as const;
export type IllustrationKind = (typeof ILLUSTRATIONS)[number];

export interface FormPlan {
  fields: { id: string; type: 'name' | 'email' | 'phone' | 'text' | 'textarea' | 'select' | 'checkbox'; label: string; required: boolean; options?: string[] }[];
  submitLabel: string;
}

export interface StepCopy {
  eyebrow: string;
  headline: string;
  subheadline: string;
  bullets: string[];
  cta: string;
  faq: { q: string; a: string }[];
  /** What a real customer could be asked to say. Rendered as a clearly labelled placeholder card, never as a quote. */
  proofPrompts: string[];
  form: FormPlan | null;
  illustration: { kind: IllustrationKind; alt: string };
}

export interface ProductPlan {
  slot: string;
  role: ProductRole;
  name: string;
  description: string;
  type: 'one_time' | 'subscription';
  amount: number;
  currency: string;
  interval?: 'month' | 'year';
  /** `catalog`: an existing workspace product (productId/priceId set); `new`: created as a draft catalog product on save. */
  source: 'catalog' | 'new';
  productId?: string;
  priceId?: string;
}

export type CheckStatus = 'pass' | 'fail' | 'warn';
export interface Check { id: string; status: CheckStatus; step?: string; detail: string }

export interface ValidationReport {
  ok: boolean;
  checks: Check[];
  repairs: string[];
}

export const STAGE_IDS = ['understanding', 'strategy', 'copy', 'products', 'assembly', 'validation', 'saving'] as const;
export interface StageRecord {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'fallback' | 'failed' | 'skipped';
  startedAt?: string;
  endedAt?: string;
  detail?: string;
  attempts?: number;
}
