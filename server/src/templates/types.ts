import type { ProjectDoc } from '../pagemodel/doc.js';

/**
 * What a template is. Built-in templates are authored in code (`templates/library/*.ts`) with the page builder DSL and stored in the database by the versioned
 * seed (`templates/seed.ts`); the same shape is the admin import/export format (`services/templateio.ts`), so a template can also be added without a deploy.
 */
export const TEMPLATE_GOALS = ['leads', 'webinar', 'sales', 'booking', 'events', 'donations', 'engagement'] as const;
export type TemplateGoal = (typeof TEMPLATE_GOALS)[number];

/** What a step is for. Used by the gallery and by the funnel wizard; it never changes how the step is served. */
export const STEP_KINDS = ['page', 'landing', 'optin', 'registration', 'replay', 'sales', 'checkout', 'upsell', 'downsell', 'booking', 'application', 'survey', 'thankyou'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export type ProductRole = 'main' | 'bump' | 'upsell' | 'downsell';

/**
 * A product placeholder. Checkout blocks of the template carry `slot: <key>`; when the template is used, each slot is bound to a product of the workspace
 * catalog (an existing price, or a new product created from these defaults). `amount` is in major units of `currency`.
 */
export interface TemplateProduct {
  key: string;
  role: ProductRole;
  name: string;
  description: string;
  type: 'one_time' | 'subscription';
  amount: number;
  currency: string;
  interval?: 'day' | 'week' | 'month' | 'year';
  intervalCount?: number;
  trialDays?: number;
}

export interface TemplateStepDef {
  name: string;
  path: string;
  kind: StepKind;
  doc: ProjectDoc;
}

export interface TemplateDef {
  /** Stable identifier (URL-safe). Funnels created from a template never refer back to it. */
  slug: string;
  /** Raise it when the content changes: databases holding an older version of an untouched built-in template are upgraded on boot. */
  version: number;
  name: string;
  description: string;
  /** Category slug (see CATEGORIES in seed.ts). */
  category: string;
  /** One industry slug the copy is written for ("general", "saas", "dentist", ...). */
  industry: string;
  /** The goal the funnel is recommended for. */
  goal: TemplateGoal;
  tags: string[];
  basePath: string;
  /** Brand colour of the design (used for the gallery card tint). */
  accent: string;
  steps: TemplateStepDef[];
  products: TemplateProduct[];
}
