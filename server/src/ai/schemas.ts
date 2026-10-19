import { z } from 'zod';

const clean = (max: number) => z.string().trim().min(1).max(max);

export const FunnelCopySchema = z.object({
  name: clean(80),
  steps: z
    .array(
      z.object({
        headline: clean(140),
        subheadline: z.string().trim().max(300).default(''),
        bullets: z.array(clean(160)).max(6).default([]),
        cta: clean(40).default('Continue'),
      }),
    )
    .min(1)
    .max(12),
});
export type FunnelCopy = z.infer<typeof FunnelCopySchema>;

export const RewriteSchema = z.object({ text: clean(4000) });
export const HeadlinesSchema = z.object({ headlines: z.array(clean(140)).min(1).max(12) });
export const AltTextSchema = z.object({ alt: clean(200) });
export const InsightsSchema = z.object({
  summary: clean(900),
  actions: z.array(z.object({ title: clean(100), detail: clean(400) })).length(3),
});
export type Insights = z.infer<typeof InsightsSchema>;
