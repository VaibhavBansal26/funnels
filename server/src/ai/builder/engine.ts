import type { ZodType } from 'zod';
import { parseJsonLoose } from '../anthropic.js';
import { estimateTokens, LlmError, llmMessage, type LlmClient } from '../llm.js';
import { assembleStep, type AssembledStep } from './assemble.js';
import { BriefModelSchema, briefProblems, heuristicBrief, mergeBrief, prepareInput, seedOf, type PreparedInput } from './brief.js';
import { cleanCopy, CopyModelSchema, copyProblems, defaultForm, defaultIllustration, heuristicCopy, normalizeForm, type CopyModel } from './copy.js';
import { BUILDER_SYSTEM, briefPrompt, copyPrompt, repairSuffix, strategyPrompt } from './prompts.js';
import { planProducts, type CatalogItem } from './products.js';
import { plainOut } from './redact.js';
import { StrategyModelSchema, strategyFor, strategyProblems } from './strategy.js';
import { validateFunnel, repairWiring } from './validate.js';
import type { Brief, BuildOptionsInput, ProductMode, ProductPlan, StageRecord, StepCopy, StepPlan, Strategy, StructuredBriefInput, ValidationReport } from './types.js';

export class CanceledError extends Error {
  constructor() {
    super('canceled');
  }
}

export interface Usage { inputTokens: number; outputTokens: number; calls: number; model: string | null }

export interface PipelineState {
  prepared?: PreparedInput;
  brief?: Brief;
  mode?: ProductMode;
  strategy?: Strategy;
  plans?: ProductPlan[];
  copies: Record<string, StepCopy>;
  copySource: Record<string, 'model' | 'heuristic' | 'fallback'>;
  fallbacks: { stage: string; reason: string }[];
  assumptions: string[];
  done: string[];
}

export const freshState = (): PipelineState => ({ copies: {}, copySource: {}, fallbacks: [], assumptions: [], done: [] });

export interface Env {
  llm?: LlmClient;
  limits: { inputTokens: number; outputTokens: number; maxRepairs: number };
  signal?: AbortSignal;
  catalog: CatalogItem[];
  checkCancel?(): Promise<void>;
  checkpoint?(state: PipelineState, stages: StageRecord[], usage: Usage): Promise<void>;
}

export interface PipelineInput { prompt: string; structured?: StructuredBriefInput; options: BuildOptionsInput }

export interface PipelineOutput {
  state: PipelineState;
  steps: AssembledStep[];
  report: ValidationReport;
  source: 'model' | 'heuristic' | 'fallback';
  usage: Usage;
  stages: StageRecord[];
}

const LABELS = { understanding: 'Understanding your brief', strategy: 'Choosing the funnel', products: 'Suggesting products', assembly: 'Building the pages', validation: 'Checking the result', saving: 'Saving the funnel' } as const;

export async function runPipeline(input: PipelineInput, env: Env, resume?: { state?: PipelineState; stages?: StageRecord[]; usage?: Usage }): Promise<PipelineOutput> {
  const state: PipelineState = resume?.state ?? freshState();
  const stages: StageRecord[] = resume?.stages ?? [];
  const usage: Usage = resume?.usage ?? { inputTokens: 0, outputTokens: 0, calls: 0, model: env.llm?.model ?? null };
  const iso = () => new Date().toISOString();
  const useModel = !!env.llm;

  const stage = async <T>(id: string, label: string, fn: (rec: StageRecord) => Promise<T>, skipWhenDone = true): Promise<T | undefined> => {
    let rec = stages.find((s) => s.id === id);
    if (!rec) stages.push((rec = { id, label, status: 'pending' }));
    if (skipWhenDone && state.done.includes(id)) return undefined;
    await env.checkCancel?.();
    rec.status = 'running';
    rec.startedAt = iso();
    await env.checkpoint?.(state, stages, usage);
    try {
      const out = await fn(rec);
      if (rec.status === 'running') rec.status = 'done';
      rec.endedAt = iso();
      state.done.push(id);
      await env.checkpoint?.(state, stages, usage);
      return out;
    } catch (e) {
      rec.status = e instanceof CanceledError ? 'pending' : 'failed';
      rec.endedAt = iso();
      if (!(e instanceof CanceledError)) rec.detail = (e as Error).message.slice(0, 200);
      await env.checkpoint?.(state, stages, usage).catch(() => undefined);
      throw e;
    }
  };

  /** One model stage: ask, parse, validate, re-ask with the reasons up to maxRepairs times, then give up (the caller uses the built-in writer). */
  const ask = async <T>(rec: StageRecord, req: { stage: string; user: string; maxTokens: number }, schema: ZodType<T>, semantic: (v: T) => string[]): Promise<{ value: T } | { reason: string }> => {
    let problems: string[] = [];
    let reason = 'the model output failed validation';
    for (let attempt = 1; attempt <= 1 + env.limits.maxRepairs; attempt++) {
      await env.checkCancel?.();
      const user = attempt === 1 ? req.user : req.user + repairSuffix(problems);
      if (estimateTokens(BUILDER_SYSTEM + user) > env.limits.inputTokens) return { reason: llmMessage('budget') };
      const remaining = env.limits.outputTokens - usage.outputTokens;
      if (remaining < 200) return { reason: 'the output token budget for this build was used up' };
      rec.attempts = attempt;
      try {
        const res = await env.llm!.complete({ stage: req.stage, system: BUILDER_SYSTEM, user, maxTokens: Math.min(req.maxTokens, remaining), attempt }, env.signal);
        usage.inputTokens += res.usage.inputTokens;
        usage.outputTokens += res.usage.outputTokens;
        usage.calls += 1;
        usage.model = res.model;
        if (res.stopReason === 'max_tokens') {
          problems = ['the answer was cut off; make it shorter'];
          reason = 'the model answer was cut off';
          continue;
        }
        let json: unknown;
        try {
          json = parseJsonLoose(res.text);
        } catch {
          problems = ['the answer was not valid JSON'];
          reason = llmMessage('malformed');
          continue;
        }
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          problems = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`);
          reason = llmMessage('malformed');
          continue;
        }
        const sem = semantic(parsed.data);
        if (sem.length) {
          problems = sem;
          reason = `the model output failed checks: ${sem[0]}`;
          continue;
        }
        return { value: parsed.data };
      } catch (e) {
        if (e instanceof CanceledError) throw e;
        if (e instanceof LlmError) {
          if (e.kind === 'aborted') throw new CanceledError();
          reason = llmMessage(e.kind);
          if (!e.retryable) return { reason };
          problems = ['the answer was empty'];
          continue;
        }
        return { reason: llmMessage('provider') };
      }
    }
    return { reason };
  };
  const fallback = (rec: StageRecord, stageId: string, reason: string) => {
    rec.status = 'fallback';
    rec.detail = reason;
    state.fallbacks.push({ stage: stageId, reason });
  };

  // 1. understanding ------------------------------------------------------------------------------------------------------------------------------------
  await stage('understanding', LABELS.understanding, async (rec) => {
    const prepared = prepareInput(input.prompt, input.structured, input.options.redactPii);
    state.prepared = prepared;
    const base = heuristicBrief(prepared.prompt, input.structured, prepared.injectionSuspected);
    state.brief = base;
    if (!useModel) {
      rec.detail = 'Read with the built-in rules (no AI model configured).';
      return;
    }
    const source = `${prepared.prompt}\n${JSON.stringify(input.structured ?? {})}`;
    const r = await ask(rec, { stage: 'brief', user: briefPrompt(prepared.prompt, input.structured ?? {}), maxTokens: 900 }, BriefModelSchema, (m) => briefProblems(m, source));
    if ('value' in r) state.brief = mergeBrief(r.value, base, input.structured);
    else fallback(rec, 'understanding', r.reason);
  });
  const brief = state.brief!;
  state.assumptions = [...brief.assumptions];

  // 2. strategy -----------------------------------------------------------------------------------------------------------------------------------------
  await stage('strategy', LABELS.strategy, async (rec) => {
    let mode: ProductMode = input.options.products;
    if (mode === 'existing') {
      const text = `${brief.business} ${brief.offer} ${state.prepared?.prompt ?? ''}`.toLowerCase();
      const pool = input.options.productIds?.some((id) => env.catalog.some((c) => c.productId === id)) || env.catalog.some((c) => c.name.length > 2 && text.includes(c.name.toLowerCase()));
      if (!pool) {
        mode = 'none';
        state.assumptions.push('You asked to sell existing products but none was selected or named in your description, so the funnel collects enquiries instead of taking payment.');
      }
    }
    state.mode = mode;
    let strategy = strategyFor(brief, mode, input.options.steps);
    if (useModel) {
      const r = await ask(rec, { stage: 'strategy', user: strategyPrompt(brief, mode), maxTokens: 500 }, StrategyModelSchema, (m) => strategyProblems(m, mode));
      if ('value' in r) strategy = strategyFor(brief, mode, input.options.steps, { funnelType: r.value.funnelType, kinds: r.value.steps.map((s) => s.kind), rationale: plainOut(r.value.rationale, 400) });
      else fallback(rec, 'strategy', r.reason);
    }
    state.strategy = strategy;
  });

  // 3. products (also prunes steps that have no product in "existing" mode) --------------------------------------------------------------------------
  await stage('products', LABELS.products, async (rec) => {
    const s = state.strategy!;
    const mode = state.mode!;
    if (mode === 'none') {
      rec.status = 'skipped';
      rec.detail = 'No products requested.';
      state.plans = [];
      return;
    }
    const r = planProducts(brief, s, mode, env.catalog, input.options.productIds, state.prepared?.prompt ?? '');
    state.plans = r.plans;
    state.assumptions.push(...r.assumptions);
    if (mode === 'existing') {
      const roles = new Set(r.plans.map((p) => p.role));
      const keep = s.steps.filter((st) => !st.role || roles.has(st.role));
      if (!roles.has('main') || keep.length !== s.steps.length) {
        const dropped = s.steps.filter((st) => !keep.includes(st)).map((st) => st.name);
        state.strategy = { ...s, steps: keep.map((st) => (st.role === 'main' && !roles.has('main') ? { ...st, primary: 'form' as const, role: undefined } : st)) };
        if (dropped.length) state.assumptions.push(`Dropped ${dropped.join(', ')}: no existing product was available for it.`);
      }
    }
  });

  // 4. copy, one stage per page ---------------------------------------------------------------------------------------------------------------------
  const seed = seedOf(`${state.prepared?.prompt}|${JSON.stringify(input.structured ?? {})}`);
  const writeCopy = async (step: StepPlan, instruction?: string): Promise<void> => {
    await stage(`copy:${step.key}`, `Writing "${step.name}"`, async (rec) => {
      const strategy = state.strategy!;
      const heur = cleanCopy(heuristicCopy(brief, step, seed));
      let chosen: StepCopy = heur;
      let how: 'model' | 'heuristic' | 'fallback' = 'heuristic';
      if (useModel) {
        let formProblems: string[] = [];
        const r = await ask(rec, { stage: `copy:${step.kind}`, user: copyPrompt(brief, strategy, step, { instruction }), maxTokens: 1400 }, CopyModelSchema, (m) => {
          const c = fromModel(m, step, heur, brief);
          formProblems = c.formProblems;
          return [...c.formProblems, ...copyProblems(c.copy, brief, step.kind, (state.plans ?? []).map((p) => p.amount).join(' '))];
        });
        if ('value' in r) {
          chosen = fromModel(r.value, step, heur, brief).copy;
          how = 'model';
        } else {
          fallback(rec, `copy:${step.key}`, r.reason);
          how = 'fallback';
        }
        void formProblems;
      }
      state.copies[step.key] = chosen;
      state.copySource[step.key] = how;
    }, instruction === undefined);
  };
  for (const step of state.strategy!.steps) await writeCopy(step);
  return finishPipeline(state, stages, usage, env, input);
}

/** Maps validated model output onto the StepCopy the assembler uses. The form's ids and the page's primary action are decided by code, never by the model. */
export function fromModel(m: CopyModel, step: StepPlan, heur: StepCopy, brief: Brief): { copy: StepCopy; formProblems: string[] } {
  const formBase = heur.form ?? { ...defaultForm(step.kind, brief), submitLabel: heur.cta };
  const nf = step.primary === 'form' ? normalizeForm(m.form, formBase) : { form: null, problems: [] as string[] };
  const cta = plainOut(m.cta, 40) || heur.cta;
  const copy = cleanCopy({
    eyebrow: m.eyebrow, headline: m.headline, subheadline: m.subheadline, bullets: step.kind === 'thankyou' && !m.bullets.length ? heur.bullets : m.bullets, cta,
    faq: step.kind === 'thankyou' ? [] : m.faq, proofPrompts: step.kind === 'thankyou' || step.kind === 'upsell' ? [] : m.proofPrompts,
    form: nf.form ? { ...nf.form, submitLabel: nf.form.submitLabel || cta } : null,
    illustration: m.illustration.alt ? m.illustration : defaultIllustration(brief, step.kind),
  });
  if (copy.form) copy.form = { ...copy.form, submitLabel: plainOut(copy.form.submitLabel, 40) || cta };
  return { copy, formProblems: nf.problems };
}

function assembleAll(state: PipelineState): AssembledStep[] {
  const { brief, strategy } = state;
  const raw = strategy!.steps.map((step, index) => assembleStep({ brief: brief!, strategy: strategy!, products: state.plans ?? [], copy: state.copies[step.key]!, step, index }));
  return repairWiring(raw).steps;
}

async function finishPipeline(state: PipelineState, stages: StageRecord[], usage: Usage, env: Env, input: PipelineInput): Promise<PipelineOutput> {
  const brief = state.brief!;
  const strategy = state.strategy!;
  const rec = (id: string, label: string) => stages.find((s) => s.id === id) ?? (stages.push({ id, label, status: 'pending' }), stages[stages.length - 1]!);
  const run = async <T>(id: string, label: string, fn: (r: StageRecord) => Promise<T> | T): Promise<T> => {
    await env.checkCancel?.();
    const r = rec(id, label);
    r.status = 'running';
    r.startedAt = new Date().toISOString();
    await env.checkpoint?.(state, stages, usage);
    const out = await fn(r);
    if (r.status === 'running') r.status = 'done';
    r.endedAt = new Date().toISOString();
    if (!state.done.includes(id)) state.done.push(id);
    await env.checkpoint?.(state, stages, usage);
    return out;
  };
  let steps = await run('assembly', LABELS.assembly, () => assembleAll(state));
  let repairs: string[] = [];
  const report = await run('validation', LABELS.validation, (r) => {
    const check = (st: AssembledStep[]) => validateFunnel({ brief, strategy, steps: st, copies: strategy.steps.map((s) => state.copies[s.key]!), plans: state.plans ?? [], productMode: state.mode! });
    let rep = check(steps);
    if (!rep.ok) {
      // Copy that fails the claims or length checks is replaced by the built-in writer's version for that page, once; the pages are rebuilt and checked again.
      const bad = new Set(rep.checks.filter((c) => c.status === 'fail' && ['claims', 'lengths', 'fake-proof'].includes(c.id) && c.step).map((c) => c.step!));
      if (bad.size) {
        const seed = seedOf(`${state.prepared?.prompt}|${JSON.stringify(input.structured ?? {})}`);
        for (const key of bad) {
          const step = strategy.steps.find((s) => s.key === key)!;
          state.copies[key] = cleanCopy(heuristicCopy(brief, step, seed));
          state.copySource[key] = 'fallback';
          state.fallbacks.push({ stage: `copy:${key}`, reason: 'the page failed the rubric checks' });
          repairs.push(`Rewrote "${step.name}" with the built-in writer after it failed: ${rep.checks.filter((c) => c.step === key && c.status === 'fail').map((c) => c.id).join(', ')}`);
        }
        steps = assembleAll(state);
        rep = check(steps);
        r.status = 'fallback';
        r.detail = repairs.join('; ');
      }
    }
    return { ...rep, repairs };
  });
  const model = !!env.llm;
  const source: PipelineOutput['source'] = !model ? 'heuristic' : state.fallbacks.length ? 'fallback' : 'model';
  return { state, steps, report, source, usage, stages };
}

/** Rewrites one page's copy (used by "regenerate step"). The state must hold the brief, strategy and plans of the original build. */
export async function regenerateCopy(state: PipelineState, stepKey: string, instruction: string | undefined, env: Env): Promise<{ copy: StepCopy; how: 'model' | 'heuristic' | 'fallback'; usage: Usage; reason?: string }> {
  const brief = state.brief!;
  const strategy = state.strategy!;
  const step = strategy.steps.find((s) => s.key === stepKey)!;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, calls: 0, model: env.llm?.model ?? null };
  const heur = cleanCopy(heuristicCopy(brief, step, seedOf(`${state.prepared?.prompt}|regen|${Date.now() >> 14}`)));
  if (!env.llm) return { copy: heur, how: 'heuristic', usage };
  const rec: StageRecord = { id: `copy:${stepKey}`, label: 'regenerate', status: 'running' };
  const stub: PipelineState = { ...state, done: [] };
  void stub;
  // Reuse the same ask() through a one-stage pipeline run is overkill; a direct loop with the same rules keeps this path small.
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 1 + env.limits.maxRepairs; attempt++) {
    await env.checkCancel?.();
    const user = copyPrompt(brief, strategy, step, { instruction: instruction ? plainOut(instruction, 400) : undefined }) + (attempt > 1 ? repairSuffix(problems) : '');
    if (estimateTokens(BUILDER_SYSTEM + user) > env.limits.inputTokens) return { copy: heur, how: 'fallback', usage, reason: llmMessage('budget') };
    try {
      const res = await env.llm.complete({ stage: `copy:${step.kind}`, system: BUILDER_SYSTEM, user, maxTokens: Math.min(1400, env.limits.outputTokens), attempt }, env.signal);
      usage.inputTokens += res.usage.inputTokens; usage.outputTokens += res.usage.outputTokens; usage.calls++; usage.model = res.model;
      const parsed = CopyModelSchema.safeParse(parseJsonLoose(res.text));
      if (!parsed.success) { problems = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.')}: ${i.message}`); continue; }
      const c = fromModel(parsed.data, step, heur, brief);
      problems = [...c.formProblems, ...copyProblems(c.copy, brief, step.kind, (state.plans ?? []).map((p) => p.amount).join(' '))];
      if (!problems.length) return { copy: c.copy, how: 'model', usage };
    } catch (e) {
      if (e instanceof LlmError && e.retryable) { problems = ['the answer was empty or not JSON']; continue; }
      if (e instanceof LlmError && e.kind === 'aborted') throw new CanceledError();
      if (e instanceof SyntaxError || (e instanceof Error && e.message.includes('JSON'))) { problems = ['the answer was not valid JSON']; continue; }
      return { copy: heur, how: 'fallback', usage, reason: e instanceof LlmError ? llmMessage(e.kind) : llmMessage('provider') };
    }
  }
  void rec;
  return { copy: heur, how: 'fallback', usage, reason: problems[0] ?? llmMessage('malformed') };
}

export { assembleAll };
