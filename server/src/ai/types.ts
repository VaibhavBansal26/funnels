export const TONES = ['persuasive', 'concise', 'friendly', 'formal'] as const;
export type Tone = (typeof TONES)[number];
export const GOALS = ['leads', 'webinar', 'sales', 'booking'] as const;
export type Goal = (typeof GOALS)[number];
export type StepKind = 'optin' | 'registration' | 'story' | 'sales' | 'upsell' | 'booking' | 'thankyou';

export interface GenerateFunnelInput {
  business: string;
  goal: Goal;
  tone: Tone;
  audience: string;
  /** The page kinds the funnel will have, in order. Structure is decided by the server, the model only writes copy for each. */
  stepKinds: StepKind[];
}

export interface RewriteInput {
  text: string;
  tone: Tone;
  length: 'shorter' | 'same' | 'longer';
  context?: string;
}

export interface HeadlineInput {
  topic: string;
  audience?: string;
  tone: Tone;
}

export interface StepMetrics {
  stepId: string;
  name: string;
  views: number;
  uniqueVisitors: number;
  optIns: number;
  orders: number;
  gross: number;
  /** Share of the previous step's unique visitors that did not reach this step, 0-100. Null for the first step or without data. */
  dropOffPercent: number | null;
}

/** All numbers here are computed by SQL. The model may only narrate them. */
export interface InsightInput {
  funnelName: string;
  range: { from: string; to: string };
  totals: { views: number; uniqueVisitors: number; optIns: number; optInRate: number; orders: number; gross: number; salesRate: number };
  steps: StepMetrics[];
  weakestStepId: string | null;
}

export interface AltTextInput {
  src: string;
  context?: string;
}

/**
 * Feature-level provider. Methods return *unvalidated* output; `ai/service.ts` validates every result
 * with zod and falls back to the heuristic implementation when it is malformed or the call throws.
 */
export interface AiProvider {
  readonly name: string;
  funnelCopy(input: GenerateFunnelInput): Promise<unknown>;
  rewrite(input: RewriteInput): Promise<unknown>;
  headlines(input: HeadlineInput): Promise<unknown>;
  insights(input: InsightInput): Promise<unknown>;
  altText(input: AltTextInput): Promise<unknown>;
}
