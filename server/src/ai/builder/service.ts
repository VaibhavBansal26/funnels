import { z } from 'zod';
import { can, type Auth } from '../../auth/context.js';
import { inTx } from '../../db/scope.js';
import type { Deps } from '../../deps.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../errors.js';
import { loadDoc } from '../../pagemodel/doc.js';
import { audit } from '../../services/audit.js';
import { bindTemplateProducts } from '../../services/catalogbind.js';
import { createFunnelFromSteps, getFunnelDetail } from '../../services/funnels.js';
import { savePage } from '../../services/pages.js';
import { slugPath } from '../../services/paths.js';
import { newId } from '../../util/ids.js';
import { guard } from '../service.js';
import { llmMessage } from '../llm.js';
import { assembleAll, CanceledError, freshState, regenerateCopy, runPipeline, type Env, type PipelineOutput, type PipelineState, type Usage } from './engine.js';
import { prepareInput } from './brief.js';
import { bindingsOf, loadCatalog, slotsOf } from './products.js';
import { plainOut } from './redact.js';
import { BuildOptions, StructuredBrief, type StageRecord, type ValidationReport } from './types.js';
import { validateFunnel } from './validate.js';

export const BuildRequest = z.object({
  prompt: z.string().max(50_000).default(''),
  structured: StructuredBrief.optional(),
  options: BuildOptions.default({ products: 'none', redactPii: false }),
});
export const RegenerateRequest = z.object({ instruction: z.string().trim().max(400).optional() });

interface Row {
  id: string; workspace_id: string; user_id: string | null; kind: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'; provider: string; model: string | null; source: string | null;
  prompt: string; input_json: string; brief_json: string | null; assumptions_json: string; strategy_json: string | null; stages_json: string; state_json: string; report_json: string | null;
  tokens_in: number; tokens_out: number; llm_calls: number; funnel_id: string | null; error_code: string | null; error_message: string | null; created_at: string; updated_at: string; completed_at: string | null;
}

const parse = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function serialize(r: Row, opts: { detail?: boolean } = {}) {
  const report = parse<(ValidationReport & { degraded?: boolean; fallbacks?: { stage: string; reason: string }[]; products?: unknown[]; stepMap?: unknown[]; injectionSuspected?: boolean }) | null>(r.report_json, null);
  const base = {
    id: r.id, status: r.status, kind: r.kind, provider: r.provider, model: r.model, source: r.source, funnelId: r.funnel_id,
    stages: parse<StageRecord[]>(r.stages_json, []), assumptions: parse<string[]>(r.assumptions_json, []),
    usage: { inputTokens: r.tokens_in, outputTokens: r.tokens_out, calls: r.llm_calls },
    degraded: !!report?.degraded, error: r.error_code ? { code: r.error_code, message: r.error_message } : null,
    createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
  };
  if (!opts.detail) return base;
  return { ...base, prompt: r.prompt, input: parse(r.input_json, {}), brief: parse(r.brief_json, null), strategy: parse(r.strategy_json, null), report, steps: report?.stepMap ?? [], products: report?.products ?? [] };
}

const getRow = async (deps: Deps, ws: string, id: string): Promise<Row> => {
  const r = await deps.db.get<Row>('SELECT * FROM ai_generations WHERE id = ? AND workspace_id = ?', id, ws);
  if (!r) throw notFound('Generation');
  return r;
};

/** In-process abort controllers of running builds, so a cancel in the same process interrupts the model call; other replicas see the status at the next stage. */
const controllers = new Map<string, AbortController>();

export async function startBuild(deps: Deps, auth: Auth, req: z.infer<typeof BuildRequest>) {
  const ws = auth.workspaceId;
  if (req.options.products === 'create' && !can(auth, 'products:write')) throw forbidden('Creating draft products needs the products:write permission');
  if (!req.prompt.trim() && !req.structured?.business && !req.structured?.offer) throw badRequest('EMPTY_BRIEF', 'Describe your business in a sentence or two');
  const running = await deps.db.get<{ id: string }>("SELECT id FROM ai_generations WHERE workspace_id = ? AND kind = 'funnel' AND status IN ('queued', 'running') AND created_at > ?", ws, new Date(deps.now().getTime() - 15 * 60_000).toISOString());
  if (running) throw conflict('BUILD_IN_PROGRESS', 'A funnel is already being generated for this workspace', { id: running.id });
  await guard(deps, ws);
  // The stored prompt is what the model sees: truncated and, when asked, redacted. The unredacted original is never written down.
  const prepared = prepareInput(req.prompt, req.structured, req.options.redactPii);
  const id = newId('gen');
  const at = deps.now().toISOString();
  const llm = deps.ai.llm;
  await deps.db.run(
    `INSERT INTO ai_generations (id, workspace_id, user_id, kind, status, provider, model, prompt, input_json, assumptions_json, stages_json, state_json, created_at, updated_at) VALUES (?, ?, ?, 'funnel', 'queued', ?, ?, ?, ?, '[]', '[]', '{}', ?, ?)`,
    id, ws, auth.userId, llm ? deps.ai.name : 'heuristic', llm?.model ?? null, prepared.prompt, JSON.stringify({ structured: req.structured ?? null, options: req.options, redactions: prepared.redactions }), at, at,
  );
  await deps.jobs.enqueue('ai.build', { id }, { maxAttempts: 2, group: ws, dedupeKey: `ai.build:${id}` });
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'ai.build_started', target: id, detail: { provider: llm ? deps.ai.name : 'heuristic', products: req.options.products, redacted: req.options.redactPii } });
  return serialize((await getRow(deps, ws, id)));
}

export async function getBuild(deps: Deps, ws: string, id: string) {
  return serialize(await getRow(deps, ws, id), { detail: true });
}

export async function listBuilds(deps: Deps, ws: string, limit = 20) {
  const rows = await deps.db.all<Row>('SELECT * FROM ai_generations WHERE workspace_id = ? ORDER BY created_at DESC, id LIMIT ?', ws, Math.min(Math.max(limit, 1), 50));
  return { data: rows.map((r) => serialize(r)) };
}

export async function cancelBuild(deps: Deps, auth: Auth, id: string) {
  const r = await getRow(deps, auth.workspaceId, id);
  if (r.status !== 'queued' && r.status !== 'running') throw conflict('NOT_CANCELLABLE', `This generation already ${r.status === 'succeeded' ? 'finished' : r.status}`);
  const at = deps.now().toISOString();
  await deps.db.run("UPDATE ai_generations SET status = 'canceled', completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')", at, at, id);
  controllers.get(id)?.abort();
  deps.bus.publish(auth.workspaceId, { type: 'ai.build', data: { id, status: 'canceled' } });
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'ai.build_canceled', target: id });
  return serialize(await getRow(deps, auth.workspaceId, id));
}

const jobAuth = (r: Row): Auth => ({ userId: r.user_id ?? '', workspaceId: r.workspace_id, role: 'member', roleId: 'member', roleName: 'Member', permissions: new Set(), sessionId: 'job', email: '', name: '' });

function envFor(deps: Deps, r: Row, catalog: Awaited<ReturnType<typeof loadCatalog>>, signal: AbortSignal): Env {
  const cfg = deps.config;
  const publish = (status: string, stages: StageRecord[]) => deps.bus.publish(r.workspace_id, { type: 'ai.build', data: { id: r.id, status, stages } });
  return {
    llm: deps.ai.llm, signal, catalog,
    limits: { inputTokens: cfg.AI_BUILD_INPUT_TOKENS, outputTokens: cfg.AI_BUILD_OUTPUT_TOKENS, maxRepairs: cfg.AI_BUILD_MAX_REPAIRS },
    async checkCancel() {
      if (signal.aborted) throw new CanceledError();
      const cur = await deps.db.get<{ status: string }>('SELECT status FROM ai_generations WHERE id = ?', r.id);
      if (!cur || cur.status === 'canceled') throw new CanceledError();
    },
    async checkpoint(state: PipelineState, stages: StageRecord[], usage: Usage) {
      await deps.db.run(
        "UPDATE ai_generations SET state_json = ?, stages_json = ?, brief_json = ?, strategy_json = ?, assumptions_json = ?, tokens_in = ?, tokens_out = ?, llm_calls = ?, model = COALESCE(?, model), updated_at = ? WHERE id = ? AND status = 'running'",
        JSON.stringify(state), JSON.stringify(stages), JSON.stringify(state.brief ?? null), JSON.stringify(state.strategy ?? null), JSON.stringify([...new Set(state.assumptions.length ? state.assumptions : state.brief?.assumptions ?? [])]),
        usage.inputTokens, usage.outputTokens, usage.calls, usage.model, deps.now().toISOString(), r.id,
      );
      publish('running', stages);
    },
  };
}

async function fail(deps: Deps, r: Row, code: string, message: string, stages?: StageRecord[]) {
  const at = deps.now().toISOString();
  await deps.db.run("UPDATE ai_generations SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')", code, message.slice(0, 400), at, at, r.id);
  deps.bus.publish(r.workspace_id, { type: 'ai.build', data: { id: r.id, status: 'failed', stages: stages ?? parse(r.stages_json, []), error: { code, message } } });
}

/** Job `ai.build`: runs the pipeline with checkpoints (a restarted job resumes after the last finished stage), then saves the funnel as a normal test-status funnel. */
export async function runBuildJob(deps: Deps, payload: unknown): Promise<void> {
  const id = (payload as { id?: string })?.id;
  const r0 = id ? await deps.db.get<Row>('SELECT * FROM ai_generations WHERE id = ?', id) : undefined;
  if (!r0 || (r0.status !== 'queued' && r0.status !== 'running')) return;
  const at0 = deps.now().toISOString();
  await deps.db.run("UPDATE ai_generations SET status = 'running', updated_at = ? WHERE id = ? AND status IN ('queued', 'running')", at0, r0.id);
  const r = { ...r0, status: 'running' as const };
  const ac = new AbortController();
  controllers.set(r.id, ac);
  const input = parse<{ structured?: z.infer<typeof StructuredBrief> | null; options: z.infer<typeof BuildOptions>; redactions?: number }>(r.input_json, { options: BuildOptions.parse({}) });
  try {
    const catalog = input.options.products === 'existing' ? await loadCatalog(deps, r.workspace_id) : [];
    const saved = parse<PipelineState | null>(r.state_json === '{}' ? null : r.state_json, null);
    const out = await runPipeline({ prompt: r.prompt, structured: input.structured ?? undefined, options: input.options }, envFor(deps, r, catalog, ac.signal), saved ? { state: saved, stages: parse<StageRecord[]>(r.stages_json, []), usage: { inputTokens: r.tokens_in, outputTokens: r.tokens_out, calls: r.llm_calls, model: r.model } } : undefined);
    if (!out.report.ok) {
      await fail(deps, r, 'VALIDATION_FAILED', `The generated funnel did not pass its checks: ${out.report.checks.filter((c) => c.status === 'fail').map((c) => c.detail).slice(0, 2).join('; ')}`, out.stages);
      return;
    }
    await saveFunnel(deps, r, out);
  } catch (e) {
    if (e instanceof CanceledError) return;
    if (e instanceof AppError) await fail(deps, r, e.code, e.message);
    else {
      deps.log.error('ai build failed', { id: r.id, error: (e as Error).message });
      await fail(deps, r, 'BUILD_FAILED', 'Something went wrong while building the funnel. Try again, or build it from a template.');
    }
  } finally {
    controllers.delete(r.id);
  }
}

async function saveFunnel(deps: Deps, r: Row, out: PipelineOutput) {
  const auth = jobAuth(r);
  const rec = out.stages.find((s) => s.id === 'saving') ?? (out.stages.push({ id: 'saving', label: 'Saving the funnel', status: 'pending' }), out.stages[out.stages.length - 1]!);
  rec.status = 'running';
  rec.startedAt = deps.now().toISOString();
  deps.bus.publish(r.workspace_id, { type: 'ai.build', data: { id: r.id, status: 'running', stages: out.stages } });
  const cur = await deps.db.get<{ status: string }>('SELECT status FROM ai_generations WHERE id = ?', r.id);
  if (cur?.status === 'canceled') return;
  const { state, steps } = out;
  const plans = state.plans ?? [];
  const name = plainOut(`${state.brief!.business} funnel`, 80) || 'AI generated funnel';
  const funnel = await inTx(deps, async (d) => {
    const docs = plans.length ? await bindTemplateProducts(d, auth, slotsOf(plans), steps.map((s) => s.doc), bindingsOf(plans)) : steps.map((s) => s.doc);
    return createFunnelFromSteps(d, auth, { name, basePath: slugPath(state.brief!.business.slice(0, 40)), steps: steps.map((s, i) => ({ name: s.name, base_path: s.base_path, doc: docs[i] })) });
  });
  // Remember which catalog product each slot became, so "regenerate step" reuses it instead of creating a second one.
  const stepMap: { key: string; stepId: string; name: string; kind: string }[] = [];
  const resolved = new Map<string, { productId: string; priceId: string }>();
  for (const [i, s] of steps.entries()) {
    const stepId = funnel.steps[i]!.id;
    stepMap.push({ key: s.key, stepId, name: s.name, kind: s.kind });
    const row = await deps.db.get<{ doc_json: string }>('SELECT doc_json FROM step_pages WHERE step_id = ?', stepId);
    if (row) for (const p of loadDoc(row.doc_json).products) if (p.slot && p.productId && p.priceId) resolved.set(p.slot, { productId: p.productId, priceId: p.priceId });
  }
  state.plans = plans.map((p) => ({ ...p, ...(resolved.get(p.slot) ?? {}), ...(resolved.has(p.slot) ? { source: 'catalog' as const } : {}) }));
  const created = plans.filter((p) => p.source === 'new').map((p) => ({ slot: p.slot, name: p.name, amount: p.amount, currency: p.currency, ...(resolved.get(p.slot) ?? {}) }));
  rec.status = 'done';
  rec.endedAt = deps.now().toISOString();
  const at = deps.now().toISOString();
  const report = { ...out.report, degraded: out.source === 'fallback', fallbacks: state.fallbacks, products: created, stepMap, injectionSuspected: state.brief!.injectionSuspected, copySource: state.copySource, templates: state.strategy!.templates };
  const res = await deps.db.run(
    "UPDATE ai_generations SET status = 'succeeded', source = ?, funnel_id = ?, report_json = ?, state_json = ?, stages_json = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
    out.source, funnel.id, JSON.stringify(report), JSON.stringify(state), JSON.stringify(out.stages), at, at, r.id,
  );
  if (res.changes === 1) {
    await audit(deps, { workspaceId: r.workspace_id, actorId: r.user_id ?? '', action: 'ai.build_succeeded', target: r.id, detail: { funnelId: funnel.id, source: out.source, tokens: out.usage.inputTokens + out.usage.outputTokens } });
    deps.bus.publish(r.workspace_id, { type: 'ai.build', data: { id: r.id, status: 'succeeded', stages: out.stages, funnelId: funnel.id } });
  }
}

/** Rewrites the copy of one page of a finished generation and saves it into the funnel's step (previous version goes to the page history). */
export async function regenerateStep(deps: Deps, auth: Auth, id: string, stepKey: string, req: z.infer<typeof RegenerateRequest>) {
  const r = await getRow(deps, auth.workspaceId, id);
  if (r.status !== 'succeeded' || !r.funnel_id) throw conflict('NOT_FINISHED', 'Only a finished generation can regenerate a page');
  const state = parse<PipelineState>(r.state_json, freshState());
  const report = parse<{ stepMap?: { key: string; stepId: string }[] } & ValidationReport>(r.report_json, {} as never);
  const target = report.stepMap?.find((s) => s.key === stepKey);
  if (!target || !state.strategy?.steps.some((s) => s.key === stepKey)) throw notFound('Step');
  const exists = await deps.db.get('SELECT 1 FROM steps WHERE id = ? AND funnel_id = ?', target.stepId, r.funnel_id);
  if (!exists) throw conflict('STEP_DELETED', 'That page was deleted from the funnel');
  await guard(deps, auth.workspaceId);
  const ac = new AbortController();
  const env: Env = { llm: deps.ai.llm, signal: ac.signal, catalog: [], limits: { inputTokens: deps.config.AI_BUILD_INPUT_TOKENS, outputTokens: Math.min(deps.config.AI_BUILD_OUTPUT_TOKENS, 4000), maxRepairs: deps.config.AI_BUILD_MAX_REPAIRS } };
  const res = await regenerateCopy(state, stepKey, req.instruction, env);
  state.copies[stepKey] = res.copy;
  state.copySource[stepKey] = res.how;
  const steps = assembleAll(state);
  const val = validateFunnel({ brief: state.brief!, strategy: state.strategy!, steps, copies: state.strategy!.steps.map((s) => state.copies[s.key]!), plans: state.plans ?? [], productMode: state.mode! });
  const doc = steps.find((s) => s.key === stepKey)!.doc;
  const stepChecks = val.checks.filter((c) => c.step === stepKey && c.status === 'fail');
  if (stepChecks.length) throw new AppError(422, 'VALIDATION_FAILED', `The new version did not pass its checks: ${stepChecks[0]!.detail}`);
  const saved = await savePage(deps, auth, r.funnel_id, target.stepId, doc, { backup: true });
  const at = deps.now().toISOString();
  await deps.db.run('UPDATE ai_generations SET state_json = ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, llm_calls = llm_calls + ?, updated_at = ? WHERE id = ?', JSON.stringify(state), res.usage.inputTokens, res.usage.outputTokens, res.usage.calls, at, r.id);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'ai.step_regenerated', target: r.id, detail: { stepKey, source: res.how } });
  return { stepId: target.stepId, version: saved.version, source: res.how, ...(res.reason ? { message: res.reason } : {}), copy: { headline: res.copy.headline } };
}

export async function purgeGenerations(deps: Deps, days: number): Promise<number> {
  const cutoff = new Date(deps.now().getTime() - days * 86_400_000).toISOString();
  const r = await deps.db.run("DELETE FROM ai_generations WHERE created_at < ? AND status NOT IN ('queued', 'running')", cutoff);
  return r.changes;
}

export { llmMessage, getFunnelDetail };
