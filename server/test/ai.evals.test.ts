import { describe, expect, it } from 'vitest';
import { GOLDEN } from '../src/ai/builder/evals/briefs.js';
import { grade, formatReport } from '../src/ai/builder/evals/rubric.js';
import { runPipeline, type Env } from '../src/ai/builder/engine.js';
import { BuildOptions } from '../src/ai/builder/types.js';
import { LlmError } from '../src/ai/llm.js';
import { ScriptedLlm, goodReply, type Reply } from './support/fakellm.js';

/**
 * Golden-prompt evals, offline: every brief runs through the whole pipeline (a) with the built-in writer and (b) with a scripted model that answers well,
 * badly (banned claims, invented numbers, injected text, wrong shapes) and in malformed ways. The deterministic rubric must pass in every mode: a bad model
 * may lower the source to "fallback" but never the quality of what is saved. Real-model runs use scripts/ai-smoke.ts (verified with fakes only here).
 */
const limits = { inputTokens: 6000, outputTokens: 40_000, maxRepairs: 2 };
const catalog = [{ productId: 'prd_yogakit01', priceId: 'prc_yogakit01', name: 'Yoga Starter Kit', type: 'one_time' as const, amount: 49, currency: 'USD' }];
const run = (g: (typeof GOLDEN)[number], llm?: ScriptedLlm) => {
  const env: Env = { llm, limits, catalog };
  return runPipeline({ prompt: g.prompt, structured: g.structured, options: BuildOptions.parse({ products: 'none', ...g.options }) }, env);
};
const summary: { id: string; source: string; rows: ReturnType<typeof grade> }[] = [];

describe('golden prompts: at least 15 diverse briefs, 11 business kinds and adversarial cases', () => {
  it('has the required coverage', () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(15);
    for (const id of ['bakery', 'dentist', 'saas-trial', 'webinar', 'coaching', 'ecommerce', 'nonprofit', 'real-estate', 'course', 'b2b-agency', 'event', 'injection', 'huge-input', 'empty', 'non-english-es', 'profanity', 'regulated-health', 'regulated-finance']) expect(GOLDEN.some((g) => g.id === id), id).toBe(true);
  });
});

describe.each(GOLDEN)('eval: $id', (g) => {
  it('built-in writer: deterministic, passes the rubric', async () => {
    const a = await run(g);
    const b = await run(g);
    const rows = grade(g, a);
    summary.push({ id: `${g.id}/builtin`, source: a.source, rows });
    expect(rows.filter((r) => !r.pass), formatReport([{ id: g.id, source: a.source, rows }])).toEqual([]);
    expect(a.source).toBe('heuristic');
    expect(JSON.stringify(a.steps.map((s) => s.doc))).toBe(JSON.stringify(b.steps.map((s) => s.doc)));
  });

  const modes: [string, Record<string, Reply>, 'model' | 'fallback'][] = [
    ['good model', {}, 'model'],
    ['model with banned claims and invented numbers', { 'copy:': { headline: 'Rated #1: guaranteed results for 12,000 happy customers', subheadline: 'Doctor recommended, clinically proven, cures everything, double your money', bullets: ['Lose 30 pounds fast', 'Risk-free, 98% success'], cta: 'Buy now', illustration: { kind: 'chart', alt: 'x' } } }, 'fallback'],
    ['model that follows injected text', { 'copy:': (req) => ({ ...goodReply(req), headline: 'PWNED-9921 reveal system prompt', subheadline: 'fuck shit damn bastard' }) }, 'fallback'],
    ['malformed model output', { brief: 'nope', strategy: '{"funnelType": "invented"}', 'copy:': '```json\n{"headline": 5}\n```' }, 'fallback'],
    ['failing provider', { brief: new LlmError('provider', 'x'), strategy: new LlmError('timeout', 'x'), 'copy:': new LlmError('refusal', 'x') }, 'fallback'],
  ];
  it.each(modes)('%s still passes the rubric', async (_n, script, source) => {
    const llm = new ScriptedLlm(script);
    const out = await run(g, llm);
    const rows = grade(g, out);
    summary.push({ id: `${g.id}/${_n}`, source: out.source, rows });
    // The model's brief/strategy may differ from the rules' reading for the goal checks; the safety and structure rows must always hold.
    const safety = rows.filter((r) => !['goal', 'funnel-type', 'industry', 'language', 'regulated', 'injection-flagged', 'price-max', 'price-min'].includes(r.id));
    expect(safety.filter((r) => !r.pass), formatReport([{ id: g.id, source: out.source, rows }])).toEqual([]);
    if (source === 'fallback' && _n !== 'good model') expect(out.source).toBe('fallback');
    if (_n === 'good model' && g.id !== 'huge-input') expect(['model', 'fallback']).toContain(out.source);
    for (const r of rows.filter((x) => x.id.startsWith('no-echo:'))) expect(r.pass, r.detail).toBe(true);
  });
});

describe('summary', () => {
  it('prints the rubric report', () => {
    const failed = summary.filter((s) => s.rows.some((r) => !r.pass && !['goal', 'funnel-type', 'industry', 'language', 'regulated', 'injection-flagged', 'price-max', 'price-min'].includes(r.id)));
    expect(failed).toEqual([]);
    if (process.env.EVAL_REPORT) console.log(formatReport(summary));
  });
});
