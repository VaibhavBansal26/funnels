import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import { can } from '../auth/context.js';
import { defaultStepDoc, loadDoc } from '../pagemodel/doc.js';
import type { Deps } from '../deps.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { inTx } from '../db/scope.js';
import { isUniqueViolation } from '../db/index.js';
import { listSteps, lockFunnel, requireFunnel, requireStep } from '../repos/funnels.js';
import type { FunnelRow, StepRow } from '../repos/types.js';
import { newId } from '../util/ids.js';
import { copyName, copyPath, isValidPath, pathKey, slugPath, suggestPaths } from './paths.js';
import { domainPathIndex, funnelPathKeys } from './pathconflicts.js';
import { insertPage, regenerateFunnel, scriptsAllowedFor, validateDoc } from './pages.js';
import { updateScoped } from '../repos/sql.js';
import { liveUrlsForFunnel, schedulePurge } from '../edge/purger.js';
import { onFunnelChanged } from './publishing.js';

export function serializeStep(s: StepRow, extras: { isHome?: boolean; is404?: boolean } = {}) {
  return {
    id: s.id,
    funnelId: s.funnel_id,
    name: s.name,
    path: s.base_path,
    position: s.position,
    title: s.title,
    seoDescription: s.seo_description,
    customCss: s.custom_css,
    headerTrackingCode: s.header_tracking_code,
    footerTrackingCode: s.footer_tracking_code,
    version: s.version,
    isDomainHome: extras.isHome ?? false,
    isDomain404: extras.is404 ?? false,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

const iso = (deps: Deps) => deps.now().toISOString();

export function assertValidPath(path: string): void {
  if (!isValidPath(path)) throw badRequest('INVALID_PATH', 'Path must start with "/" and contain only letters, digits, "-" or %XX escapes (no nested segments or dots)');
}

/** Throws 409 with `/path-NNNN` suggestions when the path is used by another step of this funnel or on its domain. */
export async function assertPathFree(deps: Deps, ws: string, funnel: FunnelRow, path: string, excludeStepId?: string): Promise<void> {
  const key = pathKey(path);
  const own = await funnelPathKeys(deps.db, ws, funnel.id, excludeStepId);
  const domain = funnel.domain_id ? await domainPathIndex(deps.db, ws, funnel.domain_id, funnel.id) : new Map();
  if (own.has(key) || domain.has(key)) {
    const taken = new Set([...own, ...domain.keys()]);
    const owner = domain.get(key);
    throw conflict(own.has(key) ? 'STEP_PATH_EXISTS' : 'PATH_CONFLICT', own.has(key) ? 'Another step in this funnel already uses this path' : `The path is already used on this domain by "${owner?.funnelName}"`, {
      uniquePaths: suggestPaths(path, taken),
    });
  }
}

export interface NewStep {
  name: string;
  base_path: string;
  doc: unknown;
  scriptsOk?: boolean;
}

/** Inserts a step plus its page. Caller owns the transaction and path checks. */
export async function insertStep(deps: Deps, ws: string, funnel: FunnelRow, s: NewStep, id = newId('stp')): Promise<StepRow> {
  const at = iso(deps);
  const position = ((await deps.db.get<{ m: number | null }>('SELECT MAX(position) AS m FROM steps WHERE funnel_id = ?', funnel.id))?.m ?? 0) + 1;
  await deps.db.run(
    `INSERT INTO steps (id, workspace_id, funnel_id, name, base_path, path_key, position, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ws, funnel.id, s.name, s.base_path, pathKey(s.base_path), position, deps.now().getTime(), at, at,
  );
  const step = await requireStep(deps.db, ws, funnel.id, id);
  await insertPage(deps, ws, funnel, step, s.doc, s.scriptsOk ?? false);
  return step;
}

export const StepInput = z.object({
  name: z.string().trim().min(1).max(120),
  base_path: z.string().max(200).optional(),
  doc: z.unknown().optional(),
});

const pathTaken = (e: unknown) => {
  if (isUniqueViolation(e)) throw conflict('STEP_PATH_EXISTS', 'Another step in this funnel already uses this path');
  throw e;
};

export async function createStep(deps: Deps, auth: Auth, funnelId: string, input: z.infer<typeof StepInput>) {
  const ws = auth.workspaceId;
  const step = await inTx(deps, async (d) => {
    const funnel = await lockFunnel(d.db, ws, funnelId);
    const path = input.base_path ?? slugPath(input.name);
    assertValidPath(path);
    await assertPathFree(d, ws, funnel, path);
    const doc = input.doc === undefined ? defaultStepDoc(input.name) : validateDoc(input.doc);
    const created = await insertStep(d, ws, funnel, { name: input.name, base_path: path, doc, scriptsOk: await scriptsAllowedFor(d, auth) });
    await d.db.run('UPDATE funnels SET updated_at = ? WHERE id = ?', iso(d), funnelId);
    await regenerateFunnel(d, ws, funnelId);
    return created;
  }).catch(pathTaken);
  return serializeStep(step);
}

export const StepPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  base_path: z.string().max(200).optional(),
  title: z.string().max(200).nullable().optional(),
  seo_description: z.string().max(400).nullable().optional(),
  custom_css: z.string().max(20_000).nullable().optional(),
  header_tracking_code: z.string().max(20_000).nullable().optional(),
  footer_tracking_code: z.string().max(20_000).nullable().optional(),
});

export async function updateStep(deps: Deps, auth: Auth, funnelId: string, stepId: string, patch: z.infer<typeof StepPatch>) {
  const ws = auth.workspaceId;
  if ((patch.header_tracking_code !== undefined || patch.footer_tracking_code !== undefined) && !can(auth, 'funnels:tracking')) {
    throw forbidden('Editing tracking code requires the "funnels:tracking" permission');
  }
  const step = await inTx(deps, async (d) => {
    const funnel = await lockFunnel(d.db, ws, funnelId);
    const current = await requireStep(d.db, ws, funnelId, stepId, true);
    const urlsBefore = await liveUrlsForFunnel(d, funnelId); // a renamed path must be purged at the CDN under its OLD url too
    const fields: Record<string, string | number | null> = {};
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.base_path !== undefined && pathKey(patch.base_path) !== current.path_key) {
      assertValidPath(patch.base_path);
      await assertPathFree(d, ws, funnel, patch.base_path, stepId);
      fields.base_path = patch.base_path;
      fields.path_key = pathKey(patch.base_path);
    } else if (patch.base_path !== undefined && patch.base_path !== current.base_path) {
      assertValidPath(patch.base_path);
      fields.base_path = patch.base_path;
    }
    for (const k of ['title', 'seo_description', 'custom_css', 'header_tracking_code', 'footer_tracking_code'] as const) {
      if (patch[k] !== undefined) fields[k] = patch[k] || null;
    }
    fields.updated_at = iso(d);
    await updateScoped(d.db, 'steps', ws, stepId, fields);
    await d.db.run('UPDATE funnels SET updated_at = ? WHERE id = ?', iso(d), funnelId);
    await regenerateFunnel(d, ws, funnelId);
    await schedulePurge(d, urlsBefore);
    await onFunnelChanged(d, funnelId);
    return requireStep(d.db, ws, funnelId, stepId);
  }).catch(pathTaken);
  return serializeStep(step);
}

async function renumber(deps: Deps, ws: string, funnelId: string): Promise<void> {
  const steps = await listSteps(deps.db, ws, funnelId);
  for (const [i, s] of steps.entries()) if (s.position !== i + 1) await deps.db.run('UPDATE steps SET position = ? WHERE id = ?', i + 1, s.id);
}

export async function deleteStep(deps: Deps, auth: Auth, funnelId: string, stepId: string): Promise<void> {
  const ws = auth.workspaceId;
  await inTx(deps, async (d) => {
    await lockFunnel(d.db, ws, funnelId);
    await requireStep(d.db, ws, funnelId, stepId, true);
    if ((await listSteps(d.db, ws, funnelId)).length <= 1) throw conflict('LAST_STEP', 'A funnel needs at least one step');
    await d.db.run('DELETE FROM steps WHERE workspace_id = ? AND id = ?', ws, stepId);
    await d.db.run('UPDATE domains SET default_home_step_id = NULL WHERE workspace_id = ? AND default_home_step_id = ?', ws, stepId);
    await d.db.run('UPDATE domains SET default_404_step_id = NULL WHERE workspace_id = ? AND default_404_step_id = ?', ws, stepId);
    await renumber(d, ws, funnelId);
    await d.db.run('UPDATE funnels SET updated_at = ? WHERE id = ?', iso(d), funnelId);
    await regenerateFunnel(d, ws, funnelId);
    d.pageCache.invalidate([stepId]);
  });
}

export async function duplicateStep(deps: Deps, auth: Auth, funnelId: string, stepId: string) {
  const ws = auth.workspaceId;
  const copyId = await inTx(deps, async (d) => {
    const funnel = await lockFunnel(d.db, ws, funnelId);
    const source = await requireStep(d.db, ws, funnelId, stepId);
    const page = await d.db.get<{ doc_json: string; scripts_ok: number }>('SELECT doc_json, scripts_ok FROM step_pages WHERE step_id = ?', stepId);
    if (!page) throw notFound('Page');
    const steps = await listSteps(d.db, ws, funnelId);
    const taken = new Set([...(await funnelPathKeys(d.db, ws, funnelId)), ...(funnel.domain_id ? (await domainPathIndex(d.db, ws, funnel.domain_id, funnelId)).keys() : [])]);
    const copy = await insertStep(d, ws, funnel, {
      name: copyName(source.name, steps.map((s) => s.name)),
      base_path: copyPath(source.base_path, taken),
      doc: loadDoc(page.doc_json),
      scriptsOk: page.scripts_ok === 1 && (await scriptsAllowedFor(d, auth)),
    });
    await d.db.run('UPDATE steps SET title = ?, seo_description = ?, custom_css = ? WHERE id = ?', source.title, source.seo_description, source.custom_css, copy.id);
    await d.db.run('UPDATE funnels SET updated_at = ? WHERE id = ?', iso(d), funnelId);
    await regenerateFunnel(d, ws, funnelId);
    return copy.id;
  }).catch(pathTaken);
  return serializeStep(await requireStep(deps.db, ws, funnelId, copyId));
}

export const ReorderInput = z.object({
  orders: z.array(z.object({ stepId: z.string().min(1).max(64), order: z.number().int().min(1).max(10_000) })).min(1).max(500),
});

/**
 * Reorder validation (legacy accepted partial and non-contiguous sets):
 * every step of the funnel exactly once, no duplicate ids, no duplicate order values, no foreign ids.
 * Gaps in the supplied numbers are fine; the stored positions are always normalised to 1..n.
 */
export async function reorderSteps(deps: Deps, auth: Auth, funnelId: string, input: z.infer<typeof ReorderInput>) {
  const ws = auth.workspaceId;
  await inTx(deps, async (d) => {
    await lockFunnel(d.db, ws, funnelId);
    const steps = await listSteps(d.db, ws, funnelId);
    const known = new Set(steps.map((s) => s.id));
    const ids = input.orders.map((o) => o.stepId);
    if (new Set(ids).size !== ids.length) throw badRequest('DUPLICATE_STEP', 'A step appears more than once');
    if (new Set(input.orders.map((o) => o.order)).size !== ids.length) throw badRequest('DUPLICATE_ORDER', 'Two steps share the same order value');
    if (ids.some((id) => !known.has(id))) throw badRequest('INVALID_STEP_REFERENCE', 'The list references a step that is not part of this funnel');
    if (ids.length !== steps.length) throw badRequest('INCOMPLETE_ORDER', 'The list must include every step of the funnel');
    const position = new Map([...input.orders].sort((a, b) => a.order - b.order).map((o, i) => [o.stepId, i + 1]));
    // Step rows are updated in id order (after the funnel lock), the fixed lock order that keeps writers deadlock-free.
    for (const id of [...ids].sort()) await d.db.run('UPDATE steps SET position = ? WHERE id = ?', position.get(id)!, id);
    await d.db.run('UPDATE funnels SET updated_at = ? WHERE id = ?', iso(d), funnelId);
    await regenerateFunnel(d, ws, funnelId);
  });
  return (await listSteps(deps.db, ws, funnelId)).map((s) => serializeStep(s));
}

export const ValidatePathInput = z.object({
  path: z.string().max(300),
  domainId: z.string().max(64).nullish(),
  funnelId: z.string().max(64).nullish(),
  stepId: z.string().max(64).nullish(),
});

/** Backs POST /validate-path: format, intra-funnel and cross-funnel (domain) uniqueness, with suggestions. */
export async function validatePath(deps: Deps, ws: string, input: z.infer<typeof ValidatePathInput>) {
  if (!isValidPath(input.path)) return { success: false as const, reason: 'INVALID_PATH', uniquePaths: [] as string[], conflicts: [] };
  const key = pathKey(input.path);
  const own = input.funnelId ? await funnelPathKeys(deps.db, ws, (await requireFunnel(deps.db, ws, input.funnelId)).id, input.stepId ?? undefined) : new Set<string>();
  let domainOwners = new Map<string, Awaited<ReturnType<typeof domainPathIndex>> extends Map<string, infer V> ? V : never>();
  if (input.domainId) {
    const dom = await deps.db.get('SELECT id FROM domains WHERE workspace_id = ? AND id = ?', ws, input.domainId);
    if (!dom) throw notFound('Domain');
    domainOwners = await domainPathIndex(deps.db, ws, input.domainId, input.funnelId ?? undefined);
  }
  const conflicts = [];
  if (own.has(key)) conflicts.push({ path: input.path, scope: 'funnel' as const });
  const owner = domainOwners.get(key);
  if (owner) conflicts.push({ path: input.path, scope: 'domain' as const, funnelId: owner.funnelId, funnelName: owner.funnelName, stepId: owner.stepId });
  if (conflicts.length === 0) return { success: true as const };
  return { success: false as const, reason: 'PATH_CONFLICT', uniquePaths: suggestPaths(input.path, new Set([...own, ...domainOwners.keys()])), conflicts };
}
