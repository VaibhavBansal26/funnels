import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import { isPlatformAdmin } from '../auth/platform.js';
import { headingOfJson, loadDoc } from '../pagemodel/doc.js';
import { renderProject } from '../pagemodel/render.js';
import { customBlockFromInput, customBlockToNode } from '../pagemodel/customblocks.js';
import type { Deps } from '../deps.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isUniqueViolation } from '../db/index.js';
import { inTx } from '../db/scope.js';
import { like } from '../repos/sql.js';
import { listSteps, requireFunnel } from '../repos/funnels.js';
import { newId } from '../util/ids.js';
import { createFunnelFromSteps } from './funnels.js';
import { slugPath } from './paths.js';
import { validateDoc } from './pages.js';

interface TemplateRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  category_id: string | null;
  category_name: string | null;
  base_path: string;
  steps: number;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT t.*, c.name AS category_name, (SELECT COUNT(*) FROM template_steps s WHERE s.template_id = t.id) AS steps
                FROM templates t LEFT JOIN template_categories c ON c.id = t.category_id`;

const serialize = async (deps: Deps, t: TemplateRow) => {
  const first = await deps.db.get<{ doc_json: string }>('SELECT doc_json FROM template_steps WHERE template_id = ? ORDER BY position LIMIT 1', t.id);
  return {
    id: t.id, slug: t.slug, name: t.name, description: t.description, categoryId: t.category_id, categoryName: t.category_name,
    stepCount: t.steps, heading: first ? headingOfJson(first.doc_json) : null, createdAt: t.created_at, updatedAt: t.updated_at,
  };
};

export const TemplateQuery = z.object({ category: z.string().max(64).optional(), search: z.string().max(100).optional() });

export async function listTemplates(deps: Deps, q: z.infer<typeof TemplateQuery>) {
  const where: string[] = [];
  const params: string[] = [];
  if (q.category) {
    where.push('(t.category_id = ? OR c.slug = ?)');
    params.push(q.category, q.category);
  }
  if (q.search?.trim()) {
    where.push(`(${deps.db.dialect.ilike('t.name')} OR ${deps.db.dialect.ilike('t.description')})`);
    params.push(like(q.search.trim()), like(q.search.trim()));
  }
  const rows = await deps.db.all<TemplateRow>(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.position, t.name, t.id`, ...params);
  const data = [];
  for (const r of rows) data.push(await serialize(deps, r));
  return { data };
}

export async function listCategories(deps: Deps) {
  return {
    data: (await deps.db.all<{ id: string; name: string; slug: string; n: number }>(
      `SELECT c.id, c.name, c.slug, COUNT(t.id) AS n FROM template_categories c LEFT JOIN templates t ON t.category_id = c.id GROUP BY c.id, c.name, c.slug, c.position ORDER BY c.position, c.name`,
    )).map((c) => ({ id: c.id, name: c.name, slug: c.slug, templateCount: c.n })),
  };
}

async function requireTemplate(deps: Deps, id: string): Promise<TemplateRow> {
  const t = await deps.db.get<TemplateRow>(`${SELECT} WHERE t.id = ? OR t.slug = ?`, id, id);
  if (!t) throw notFound('Template');
  return t;
}

export async function getTemplate(deps: Deps, id: string) {
  const t = await requireTemplate(deps, id);
  const steps = await deps.db.all<{ id: string; name: string; base_path: string; position: number; doc_json: string }>('SELECT * FROM template_steps WHERE template_id = ? ORDER BY position', t.id);
  return { ...(await serialize(deps, t)), steps: steps.map((s) => ({ id: s.id, name: s.name, path: s.base_path, position: s.position, doc: loadDoc(s.doc_json) })) };
}

export const TemplateHtmlQuery = z.object({ step: z.coerce.number().int().min(1).max(50).default(1) });

/** A template step rendered as a standalone page (inert: for previews, shown in a sandboxed iframe). */
export async function templateStepHtml(deps: Deps, id: string, step: number) {
  const t = await requireTemplate(deps, id);
  const row = await deps.db.get<{ id: string; name: string; doc_json: string }>('SELECT id, name, doc_json FROM template_steps WHERE template_id = ? AND position = ?', t.id, step);
  if (!row) throw notFound('Template step');
  const { html } = renderProject(loadDoc(row.doc_json).project, { funnelId: 'preview', stepId: row.id, stepName: row.name, mode: 'preview' });
  return { step, name: row.name, html };
}

/** Clones a template into the caller's workspace as a new test funnel. Names are uniquified ("Lead magnet", "Lead magnet 2", ...). */
export async function useTemplate(deps: Deps, auth: Auth, id: string) {
  const t = await getTemplate(deps, id);
  return createFunnelFromSteps(deps, auth, { name: t.name, basePath: t.steps[0]?.path ?? slugPath(t.name), steps: t.steps.map((s) => ({ name: s.name, base_path: s.path, doc: s.doc, refId: s.id })) });
}

// ----- platform admin (guarded by PLATFORM_ADMIN_EMAILS) -----

export async function assertPlatformAdmin(deps: Deps, auth: Auth): Promise<void> {
  if (!(await isPlatformAdmin(deps, auth))) throw forbidden('Only platform administrators can manage templates');
}

export const TemplateCreate = z.object({
  funnelId: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).default(''),
  categoryId: z.string().max(64).nullish(),
});
export const TemplatePatch = z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(400).optional(), categoryId: z.string().max(64).nullable().optional() });
export const CategoryInput = z.object({ name: z.string().trim().min(1).max(60) });

const slugOf = (name: string) => slugPath(name).slice(1);

async function requireCategory(deps: Deps, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  if (!(await deps.db.get('SELECT 1 FROM template_categories WHERE id = ?', id))) throw notFound('Category');
  return id;
}

/** Publishes one of the caller's funnels as a global template (copies its step documents). */
export async function createTemplate(deps: Deps, auth: Auth, input: z.infer<typeof TemplateCreate>) {
  await assertPlatformAdmin(deps, auth);
  const id = await inTx(deps, async (d) => {
    const funnel = await requireFunnel(d.db, auth.workspaceId, input.funnelId);
    const steps = await listSteps(d.db, auth.workspaceId, funnel.id);
    const category = await requireCategory(d, input.categoryId);
    let slug = slugOf(input.name);
    for (let n = 2; await d.db.get('SELECT 1 FROM templates WHERE slug = ?', slug); n++) slug = `${slugOf(input.name)}-${n}`;
    const tid = newId('tpl');
    const at = d.now().toISOString();
    await d.db.run('INSERT INTO templates (id, slug, name, description, category_id, base_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', tid, slug, input.name, input.description, category, funnel.base_path, at, at);
    for (const s of steps) {
      const page = await d.db.get<{ doc_json: string }>('SELECT doc_json FROM step_pages WHERE step_id = ?', s.id);
      await d.db.run('INSERT INTO template_steps (id, template_id, name, base_path, position, doc_json) VALUES (?, ?, ?, ?, ?, ?)', newId('tps'), tid, s.name, s.base_path, s.position, page!.doc_json);
    }
    return tid;
  }).catch((e) => {
    if (isUniqueViolation(e)) throw conflict('TEMPLATE_EXISTS', 'A template with this name already exists');
    throw e;
  });
  return getTemplate(deps, id);
}

export async function updateTemplate(deps: Deps, auth: Auth, id: string, patch: z.infer<typeof TemplatePatch>) {
  await assertPlatformAdmin(deps, auth);
  const t = await requireTemplate(deps, id);
  const category = patch.categoryId === undefined ? t.category_id : await requireCategory(deps, patch.categoryId);
  await deps.db.run('UPDATE templates SET name = ?, description = ?, category_id = ?, updated_at = ? WHERE id = ?', patch.name ?? t.name, patch.description ?? t.description, category, deps.now().toISOString(), t.id);
  return getTemplate(deps, t.id);
}

export async function deleteTemplate(deps: Deps, auth: Auth, id: string): Promise<void> {
  await assertPlatformAdmin(deps, auth);
  await deps.db.run('DELETE FROM templates WHERE id = ?', (await requireTemplate(deps, id)).id);
}

export async function createCategory(deps: Deps, auth: Auth, input: z.infer<typeof CategoryInput>) {
  await assertPlatformAdmin(deps, auth);
  const slug = slugOf(input.name);
  if (await deps.db.get('SELECT 1 FROM template_categories WHERE slug = ?', slug)) throw conflict('CATEGORY_EXISTS', 'A category with this name already exists');
  const id = newId('cat');
  try {
    await deps.db.run('INSERT INTO template_categories (id, name, slug, position) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM template_categories))', id, input.name, slug);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('CATEGORY_EXISTS', 'A category with this name already exists');
    throw e;
  }
  return { id, name: input.name, slug, templateCount: 0 };
}

export async function deleteCategory(deps: Deps, auth: Auth, id: string): Promise<void> {
  await assertPlatformAdmin(deps, auth);
  await requireCategory(deps, id);
  await deps.db.run('DELETE FROM template_categories WHERE id = ?', id);
}

// ----- saved custom blocks (per workspace) -----

export const CustomBlockInput = z.object({ name: z.string().trim().min(1).max(80), block: z.unknown() });
const MAX_CUSTOM_BLOCKS = 200;

export async function listCustomBlocks(deps: Deps, ws: string) {
  return {
    data: (await deps.db.all<{ id: string; name: string; block_json: string; created_at: string }>('SELECT * FROM custom_blocks WHERE workspace_id = ? ORDER BY created_at DESC, id DESC', ws))
      .map((b) => ({ id: b.id, name: b.name, block: customBlockToNode(b.block_json), createdAt: b.created_at })),
  };
}

/** Saved blocks are component subtrees of the page builder. They are cleaned like page content, so a saved block can never carry anything a page could not. */
export async function saveCustomBlock(deps: Deps, ws: string, input: z.infer<typeof CustomBlockInput>) {
  const node = customBlockFromInput(input.block);
  if (!node.ok) throw badRequest('INVALID_BLOCK', 'The block is not valid', node.issues);
  if ((await deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM custom_blocks WHERE workspace_id = ?', ws))!.n >= MAX_CUSTOM_BLOCKS) throw conflict('LIMIT_REACHED', `A workspace can save at most ${MAX_CUSTOM_BLOCKS} custom blocks`);
  const id = newId('blk');
  const at = deps.now().toISOString();
  await deps.db.run('INSERT INTO custom_blocks (id, workspace_id, name, block_json, created_at) VALUES (?, ?, ?, ?, ?)', id, ws, input.name, JSON.stringify(node.node), at);
  return { id, name: input.name, block: node.node, createdAt: at };
}

export async function deleteCustomBlock(deps: Deps, ws: string, id: string): Promise<void> {
  if ((await deps.db.run('DELETE FROM custom_blocks WHERE workspace_id = ? AND id = ?', ws, id)).changes === 0) throw notFound('Block');
}
