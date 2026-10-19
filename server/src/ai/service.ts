import { z, type ZodType } from 'zod';
import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { AppError } from '../errors.js';
import { denyError } from '../ratelimit/response.js';
import { slugPath } from '../services/paths.js';
import { createFunnelFromSteps } from '../services/funnels.js';
import { AnalyticsQuery, funnelAnalytics } from '../services/analytics.js';
import { buildSteps, planSteps } from './buildFunnel.js';
import { heuristicAltText, heuristicFunnelCopy, heuristicHeadlines, heuristicInsights, heuristicRewrite } from './heuristic.js';
import { cleanText, LIMITS } from './prompts.js';
import { AltTextSchema, FunnelCopySchema, HeadlinesSchema, InsightsSchema, RewriteSchema, type Insights } from './schemas.js';
import { GOALS, TONES, type InsightInput, type StepMetrics } from './types.js';

export type Source = 'model' | 'heuristic' | 'fallback';

export const FunnelRequest = z.object({
  business: z.string().min(1).max(50_000),
  goal: z.enum(GOALS),
  tone: z.enum(TONES).default('persuasive'),
  audience: z.string().max(50_000).default(''),
  steps: z.number().int().min(1).max(6).optional(),
});
export const RewriteRequest = z.object({ text: z.string().min(1).max(50_000), tone: z.enum(TONES), length: z.enum(['shorter', 'same', 'longer']).default('same'), context: z.string().max(50_000).optional() });
export const HeadlineRequest = z.object({ topic: z.string().min(1).max(50_000), audience: z.string().max(50_000).optional(), tone: z.enum(TONES).default('persuasive') });
export const InsightRequest = AnalyticsQuery.extend({ funnelId: z.string().min(1).max(64) });
export const AltTextRequest = z.object({ src: z.string().min(1).max(5000), context: z.string().max(50_000).optional() });

const today = (deps: Deps) => deps.now().toISOString().slice(0, 10);

/** Per-workspace per-minute rate limit plus a daily cap (AI_DAILY_CAP, 0 disables AI). The request is counted before the call. */
async function guard(deps: Deps, ws: string): Promise<void> {
  const d = await deps.limiter.check('ai.minute', { ip: 'workspace', workspaceId: ws });
  if (!d.allowed) throw denyError(d);
  const cap = deps.config.AI_DAILY_CAP;
  // One atomic conditional upsert: the cap check and the increment cannot be split by a concurrent request.
  const day = today(deps);
  const exhausted = () => new AppError(429, 'AI_DAILY_CAP_REACHED', 'The daily AI request limit for this workspace has been reached', undefined, { 'Retry-After': '3600' });
  if (cap <= 0) throw exhausted();
  const { changes } = await deps.db.run(
    `INSERT INTO ai_usage (workspace_id, day, count) VALUES (?, ?, 1)${deps.db.dialect.upsert(['workspace_id', 'day'], 'count = ai_usage.count + 1')} WHERE ai_usage.count < ?`,
    ws, day, cap,
  );
  if (changes === 0) throw exhausted();
}

export async function usage(deps: Deps, ws: string) {
  const used = (await deps.db.get<{ count: number }>('SELECT count FROM ai_usage WHERE workspace_id = ? AND day = ?', ws, today(deps)))?.count ?? 0;
  return { provider: deps.ai.name, dailyCap: deps.config.AI_DAILY_CAP, usedToday: used };
}

/**
 * Calls the model, validates its output with zod (and an optional semantic check) and returns it.
 * Throwing, empty, malformed or schema-mismatching output all end in the deterministic heuristic result.
 */
async function validated<T>(deps: Deps, feature: string, call: () => Promise<unknown>, schema: ZodType<T>, heuristic: () => T, check?: (v: T) => boolean): Promise<{ value: T; source: Source }> {
  if (deps.ai.name === 'heuristic') return { value: heuristic(), source: 'heuristic' };
  try {
    const parsed = schema.safeParse(await call());
    if (parsed.success && (!check || check(parsed.data))) return { value: parsed.data, source: 'model' };
    deps.log.warn('ai output rejected', { feature, reason: parsed.success ? 'failed semantic check' : parsed.error.issues[0]?.message });
  } catch (e) {
    deps.log.warn('ai call failed', { feature, error: (e as Error).message });
  }
  return { value: heuristic(), source: 'fallback' };
}

export async function generateFunnel(deps: Deps, auth: Auth, req: z.infer<typeof FunnelRequest>) {
  await guard(deps, auth.workspaceId);
  const input = {
    business: cleanText(req.business, LIMITS.business),
    audience: cleanText(req.audience, LIMITS.audience),
    goal: req.goal,
    tone: req.tone,
    stepKinds: planSteps(req.goal, req.steps ?? (req.goal === 'sales' ? 3 : 2)),
  };
  const { value, source } = await validated(deps, 'funnel', () => deps.ai.funnelCopy(input), FunnelCopySchema, () => FunnelCopySchema.parse(heuristicFunnelCopy(input)));
  const name = cleanText(value.name, LIMITS.name) || 'AI generated funnel';
  const funnel = await createFunnelFromSteps(deps, auth, { name, basePath: slugPath(name), steps: buildSteps(input.stepKinds, value) });
  return { funnel, source };
}

export async function rewriteCopy(deps: Deps, auth: Auth, req: z.infer<typeof RewriteRequest>) {
  await guard(deps, auth.workspaceId);
  const input = { ...req, text: cleanText(req.text, LIMITS.text), context: req.context ? cleanText(req.context, LIMITS.context) : undefined };
  const { value, source } = await validated(deps, 'rewrite', () => deps.ai.rewrite(input), RewriteSchema, () => ({ text: heuristicRewrite(input) }));
  return { text: value.text, source };
}

export async function headlineVariants(deps: Deps, auth: Auth, req: z.infer<typeof HeadlineRequest>) {
  await guard(deps, auth.workspaceId);
  const input = { topic: cleanText(req.topic, LIMITS.topic), audience: req.audience ? cleanText(req.audience, LIMITS.audience) : undefined, tone: req.tone };
  const fallback = heuristicHeadlines(input);
  const { value, source } = await validated(deps, 'headlines', () => deps.ai.headlines(input), HeadlinesSchema, () => ({ headlines: fallback }));
  // Always exactly five distinct options: model output first, topped up from the heuristic list.
  const seen = new Set<string>();
  const headlines = [...value.headlines, ...fallback].filter((h) => !seen.has(h.toLowerCase()) && seen.add(h.toLowerCase())).slice(0, 5);
  return { headlines, source };
}

export async function altText(deps: Deps, auth: Auth, req: z.infer<typeof AltTextRequest>) {
  await guard(deps, auth.workspaceId);
  const input = { src: cleanText(req.src, 500), context: req.context ? cleanText(req.context, LIMITS.context) : undefined };
  const { value, source } = await validated(deps, 'alt', () => deps.ai.altText(input), AltTextSchema, () => ({ alt: heuristicAltText(input) }));
  return { alt: value.alt, source };
}

/** Every number the model is allowed to mention. */
function allowedNumbers(input: InsightInput): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'number') out.push(v, Math.round(v), Number(v.toFixed(2)));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => (k === 'range' ? undefined : walk(x)));
  };
  walk(input);
  return out;
}

/** True when every number in the narrative is one we computed (plus tiny ordinals such as "3 actions"). */
export function narrativeUsesOnlyKnownNumbers(texts: string[], input: InsightInput): boolean {
  const allowed = allowedNumbers(input);
  const dates = new Set([input.range.from, input.range.to].flatMap((d) => d.split('-').map(Number)));
  for (const text of texts) {
    const withoutDates = text.replace(/\d{4}-\d{2}-\d{2}/g, '');
    for (const m of withoutDates.matchAll(/\d+(?:\.\d+)?/g)) {
      const n = Number(m[0]);
      if (n <= 10 || dates.has(n) || allowed.some((a) => Math.abs(a - n) < 0.005)) continue;
      return false;
    }
  }
  return true;
}

/** Weakest step: the largest drop-off from the previous step; with a single step, the lowest opt-in rate. */
export function weakestStep(steps: StepMetrics[]): string | null {
  const withDrop = steps.filter((s) => s.dropOffPercent !== null);
  if (withDrop.length) return withDrop.reduce((a, b) => (b.dropOffPercent! > a.dropOffPercent! ? b : a)).stepId;
  const traffic = steps.filter((s) => s.uniqueVisitors > 0);
  if (!traffic.length) return null;
  return traffic.reduce((a, b) => (b.optIns / b.uniqueVisitors < a.optIns / a.uniqueVisitors ? b : a)).stepId;
}

export async function analyticsInsights(deps: Deps, auth: Auth, req: z.infer<typeof InsightRequest>) {
  const ws = auth.workspaceId;
  const data = await funnelAnalytics(deps, ws, req.funnelId, req);
  await guard(deps, ws);
  const funnelName = (await deps.db.get<{ name: string }>('SELECT name FROM funnels WHERE id = ?', req.funnelId))!.name;
  const steps: StepMetrics[] = data.steps.map((s, i) => {
    const prev = data.steps[i - 1];
    const dropOff = prev && prev.pageViews.unique > 0 ? Math.max(0, Math.round((1 - s.pageViews.unique / prev.pageViews.unique) * 10000) / 100) : null;
    return { stepId: s.stepId, name: s.name, views: s.pageViews.all, uniqueVisitors: s.pageViews.unique, optIns: s.optIns.all, orders: s.sales.orders, gross: s.sales.gross, dropOffPercent: dropOff };
  });
  const input: InsightInput = {
    funnelName: cleanText(funnelName, 120),
    range: { from: data.range.from, to: data.range.to },
    totals: { views: data.summary.pageViews.all, uniqueVisitors: data.summary.pageViews.unique, optIns: data.summary.optIns.all, optInRate: data.summary.optIns.conversionRate, orders: data.summary.sales.orders, gross: data.summary.sales.gross, salesRate: data.summary.sales.conversionRate },
    steps,
    weakestStepId: weakestStep(steps),
  };
  const { value, source } = await validated<Insights>(
    deps, 'insights', () => deps.ai.insights(input), InsightsSchema, () => heuristicInsights(input),
    (v) => narrativeUsesOnlyKnownNumbers([v.summary, ...v.actions.flatMap((a) => [a.title, a.detail])], input),
  );
  // Metrics and the weakest step always come from the database, never from the model.
  return { metrics: data, weakestStepId: input.weakestStepId, summary: value.summary, actions: value.actions, source };
}
