import { z } from 'zod';
import { isPlatformAdmin, type Auth } from '../auth/context.js';
import { BlockSchema, firstHeading, type PageDocument } from '../blocks/index.js';
import type { Deps } from '../deps.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
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

const serialize = (deps: Deps, t: TemplateRow) => {
  const first = deps.db.get<{ doc_json: string }>('SELECT doc_json FROM template_steps WHERE template_id = ? ORDER BY position LIMIT 1', t.id);
  return {
    id: t.id, slug: t.slug, name: t.name, description: t.description, categoryId: t.category_id, categoryName: t.category_name,
    stepCount: t.steps, heading: first ? firstHeading(JSON.parse(first.doc_json) as PageDocument) : null, createdAt: t.created_at, updatedAt: t.updated_at,
  };
};

export const TemplateQuery = z.object({ category: z.string().max(64).optional(), search: z.string().max(100).optional() });

export function listTemplates(deps: Deps, q: z.infer<typeof TemplateQuery>) {
  const where: string[] = [];
  const params: string[] = [];
  if (q.category) {
    where.push('(t.category_id = ? OR c.slug = ?)');
    params.push(q.category, q.category);
  }
  if (q.search?.trim()) {
    where.push(`(t.name LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')`);
    params.push(like(q.search.trim()), like(q.search.trim()));
  }
  const rows = deps.db.all<TemplateRow>(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.position, t.name`, ...params);
  return { data: rows.map((r) => serialize(deps, r)) };
}

export function listCategories(deps: Deps) {
  return {
    data: deps.db.all<{ id: string; name: string; slug: string; n: number }>(
      `SELECT c.id, c.name, c.slug, COUNT(t.id) AS n FROM template_categories c LEFT JOIN templates t ON t.category_id = c.id GROUP BY c.id ORDER BY c.position, c.name`,
    ).map((c) => ({ id: c.id, name: c.name, slug: c.slug, templateCount: c.n })),
  };
}

function requireTemplate(deps: Deps, id: string): TemplateRow {
  const t = deps.db.get<TemplateRow>(`${SELECT} WHERE t.id = ? OR t.slug = ?`, id, id);
  if (!t) throw notFound('Template');
  return t;
}

export function getTemplate(deps: Deps, id: string) {
  const t = requireTemplate(deps, id);
  const steps = deps.db.all<{ id: string; name: string; base_path: string; position: number; doc_json: string }>('SELECT * FROM template_steps WHERE template_id = ? ORDER BY position', t.id);
  return { ...serialize(deps, t), steps: steps.map((s) => ({ id: s.id, name: s.name, path: s.base_path, position: s.position, doc: JSON.parse(s.doc_json) as PageDocument })) };
}

/** Clones a template into the caller's workspace as a new test funnel. Names are uniquified ("Lead magnet", "Lead magnet 2", ...). */
export function useTemplate(deps: Deps, auth: Auth, id: string) {
  const t = getTemplate(deps, id);
  return createFunnelFromSteps(deps, auth, { name: t.name, basePath: t.steps[0]?.path ?? slugPath(t.name), steps: t.steps.map((s) => ({ name: s.name, base_path: s.path, doc: s.doc, refId: s.id })) });
}

// ----- platform admin (guarded by PLATFORM_ADMIN_EMAILS) -----

export function assertPlatformAdmin(deps: Deps, auth: Auth): void {
  if (!isPlatformAdmin(deps, auth)) throw forbidden('Only platform administrators can manage templates');
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

function requireCategory(deps: Deps, id: string | null | undefined): string | null {
  if (!id) return null;
  if (!deps.db.get('SELECT 1 FROM template_categories WHERE id = ?', id)) throw notFound('Category');
  return id;
}

/** Publishes one of the caller's funnels as a global template (copies its step documents). */
export function createTemplate(deps: Deps, auth: Auth, input: z.infer<typeof TemplateCreate>) {
  assertPlatformAdmin(deps, auth);
  return deps.db.tx(() => {
    const funnel = requireFunnel(deps.db, auth.workspaceId, input.funnelId);
    const steps = listSteps(deps.db, auth.workspaceId, funnel.id);
    const category = requireCategory(deps, input.categoryId);
    let slug = slugOf(input.name);
    for (let n = 2; deps.db.get('SELECT 1 FROM templates WHERE slug = ?', slug); n++) slug = `${slugOf(input.name)}-${n}`;
    const id = newId('tpl');
    const at = deps.now().toISOString();
    deps.db.run('INSERT INTO templates (id, slug, name, description, category_id, base_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, slug, input.name, input.description, category, funnel.base_path, at, at);
    for (const s of steps) {
      const page = deps.db.get<{ doc_json: string }>('SELECT doc_json FROM step_pages WHERE step_id = ?', s.id);
      deps.db.run('INSERT INTO template_steps (id, template_id, name, base_path, position, doc_json) VALUES (?, ?, ?, ?, ?, ?)', newId('tps'), id, s.name, s.base_path, s.position, page!.doc_json);
    }
    return getTemplate(deps, id);
  });
}

export function updateTemplate(deps: Deps, auth: Auth, id: string, patch: z.infer<typeof TemplatePatch>) {
  assertPlatformAdmin(deps, auth);
  const t = requireTemplate(deps, id);
  const category = patch.categoryId === undefined ? t.category_id : requireCategory(deps, patch.categoryId);
  deps.db.run('UPDATE templates SET name = ?, description = ?, category_id = ?, updated_at = ? WHERE id = ?', patch.name ?? t.name, patch.description ?? t.description, category, deps.now().toISOString(), t.id);
  return getTemplate(deps, t.id);
}

export function deleteTemplate(deps: Deps, auth: Auth, id: string): void {
  assertPlatformAdmin(deps, auth);
  deps.db.run('DELETE FROM templates WHERE id = ?', requireTemplate(deps, id).id);
}

export function createCategory(deps: Deps, auth: Auth, input: z.infer<typeof CategoryInput>) {
  assertPlatformAdmin(deps, auth);
  const slug = slugOf(input.name);
  if (deps.db.get('SELECT 1 FROM template_categories WHERE slug = ?', slug)) throw conflict('CATEGORY_EXISTS', 'A category with this name already exists');
  const id = newId('cat');
  deps.db.run('INSERT INTO template_categories (id, name, slug, position) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM template_categories))', id, input.name, slug);
  return { id, name: input.name, slug, templateCount: 0 };
}

export function deleteCategory(deps: Deps, auth: Auth, id: string): void {
  assertPlatformAdmin(deps, auth);
  requireCategory(deps, id);
  deps.db.run('DELETE FROM template_categories WHERE id = ?', id);
}

// ----- saved custom blocks (per workspace) -----

export const CustomBlockInput = z.object({ name: z.string().trim().min(1).max(80), block: z.unknown() });
const MAX_CUSTOM_BLOCKS = 200;

export function listCustomBlocks(deps: Deps, ws: string) {
  return {
    data: deps.db.all<{ id: string; name: string; block_json: string; created_at: string }>('SELECT * FROM custom_blocks WHERE workspace_id = ? ORDER BY created_at DESC', ws)
      .map((b) => ({ id: b.id, name: b.name, block: JSON.parse(b.block_json) as unknown, createdAt: b.created_at })),
  };
}

export function saveCustomBlock(deps: Deps, ws: string, input: z.infer<typeof CustomBlockInput>) {
  const parsed = BlockSchema.safeParse(input.block);
  if (!parsed.success) throw badRequest('INVALID_BLOCK', 'The block is not valid', parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })));
  // Wrap in a document so size/depth/id rules are enforced exactly as for pages.
  validateDoc({ version: 1, blocks: [parsed.data] });
  if (deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM custom_blocks WHERE workspace_id = ?', ws)!.n >= MAX_CUSTOM_BLOCKS) throw conflict('LIMIT_REACHED', `A workspace can save at most ${MAX_CUSTOM_BLOCKS} custom blocks`);
  const id = newId('blk');
  const at = deps.now().toISOString();
  deps.db.run('INSERT INTO custom_blocks (id, workspace_id, name, block_json, created_at) VALUES (?, ?, ?, ?, ?)', id, ws, input.name, JSON.stringify(parsed.data), at);
  return { id, name: input.name, block: parsed.data, createdAt: at };
}

export function deleteCustomBlock(deps: Deps, ws: string, id: string): void {
  if (deps.db.run('DELETE FROM custom_blocks WHERE workspace_id = ? AND id = ?', ws, id).changes === 0) throw notFound('Block');
}
