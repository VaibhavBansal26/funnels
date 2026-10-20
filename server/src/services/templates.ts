import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import { isPlatformAdmin } from '../auth/platform.js';
import { firstHeadingOfDoc, loadDoc } from '../pagemodel/doc.js';
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
import { TEMPLATE_GOALS, type TemplateProduct } from '../templates/types.js';
import { bindTemplateProducts, BindingsInput } from './catalogbind.js';
import { stripCatalogLinks } from './catalogdoc.js';

interface TemplateRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  category_id: string | null;
  category_name: string | null;
  category_slug: string | null;
  base_path: string;
  version: number;
  source: string;
  industry: string;
  goal: string;
  tags_json: string;
  products_json: string;
  accent: string;
  heading: string | null;
  steps: number;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT t.*, c.name AS category_name, c.slug AS category_slug, (SELECT COUNT(*) FROM template_steps s WHERE s.template_id = t.id) AS steps
                FROM templates t LEFT JOIN template_categories c ON c.id = t.category_id`;

const parseJson = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const serialize = (t: TemplateRow) => {
  const products = parseJson<TemplateProduct[]>(t.products_json, []);
  return {
    id: t.id, slug: t.slug, name: t.name, description: t.description, categoryId: t.category_id, categoryName: t.category_name, categorySlug: t.category_slug,
    industry: t.industry, goal: t.goal, tags: parseJson<string[]>(t.tags_json, []), version: t.version, source: t.source, accent: t.accent,
    stepCount: t.steps, heading: t.heading, hasCheckout: products.length > 0, products,
    thumbnail: { step: 1, url: `/api/templates/${t.slug}/html?step=1`, accent: t.accent, heading: t.heading },
    createdAt: t.created_at, updatedAt: t.updated_at,
  };
};

export const TemplateQuery = z.object({
  category: z.string().max(64).optional(),
  industry: z.string().max(64).optional(),
  goal: z.enum(TEMPLATE_GOALS).optional(),
  tag: z.string().max(64).optional(),
  checkout: z.enum(['true', 'false']).optional(),
  search: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

/** The gallery: filters (category, industry, goal, tag, checkout), search over name, description, tags and industry, pages, and facet counts for the filter chips. */
export async function listTemplates(deps: Deps, q: z.infer<typeof TemplateQuery>) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.category) {
    where.push('(t.category_id = ? OR c.slug = ?)');
    params.push(q.category, q.category);
  }
  if (q.industry) (where.push('t.industry = ?'), params.push(q.industry));
  if (q.goal) (where.push('t.goal = ?'), params.push(q.goal));
  if (q.tag) (where.push(deps.db.dialect.ilike('t.tags_json')), params.push(like(JSON.stringify(q.tag))));
  if (q.checkout) where.push(q.checkout === 'true' ? "t.products_json <> '[]'" : "t.products_json = '[]'");
  if (q.search?.trim()) {
    const p = like(q.search.trim());
    where.push(`(${['t.name', 't.description', 't.tags_json', 't.industry'].map((c) => deps.db.dialect.ilike(c)).join(' OR ')})`);
    params.push(p, p, p, p);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await deps.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM templates t LEFT JOIN template_categories c ON c.id = t.category_id ${clause}`, ...params))!.n;
  const rows = await deps.db.all<TemplateRow>(`${SELECT} ${clause} ORDER BY COALESCE(c.position, 999), t.name, t.id LIMIT ? OFFSET ?`, ...params, q.limit, (q.page - 1) * q.limit);
  return { data: rows.map(serialize), pagination: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) }, facets: await facets(deps) };
}

async function facets(deps: Deps) {
  const rows = await deps.db.all<{ industry: string; goal: string; tags_json: string }>('SELECT industry, goal, tags_json FROM templates');
  const count = (m: Map<string, number>) => [...m].map(([value, n]) => ({ value, count: n })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  const industries = new Map<string, number>();
  const goals = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const r of rows) {
    industries.set(r.industry, (industries.get(r.industry) ?? 0) + 1);
    goals.set(r.goal, (goals.get(r.goal) ?? 0) + 1);
    for (const t of parseJson<string[]>(r.tags_json, [])) tags.set(t, (tags.get(t) ?? 0) + 1);
  }
  return { industries: count(industries), goals: count(goals), tags: count(tags).slice(0, 40) };
}

export async function listCategories(deps: Deps) {
  return {
    data: (await deps.db.all<{ id: string; name: string; slug: string; n: number }>(
      `SELECT c.id, c.name, c.slug, COUNT(t.id) AS n FROM template_categories c LEFT JOIN templates t ON t.category_id = c.id GROUP BY c.id, c.name, c.slug, c.position ORDER BY c.position, c.name`,
    )).map((c) => ({ id: c.id, name: c.name, slug: c.slug, templateCount: c.n })),
  };
}

export async function requireTemplate(deps: Deps, id: string): Promise<TemplateRow> {
  const t = await deps.db.get<TemplateRow>(`${SELECT} WHERE t.id = ? OR t.slug = ?`, id, id);
  if (!t) throw notFound('Template');
  return t;
}

interface StepRow {
  id: string;
  name: string;
  base_path: string;
  position: number;
  kind: string;
  doc_json: string;
}

export const TemplateDetailQuery = z.object({ docs: z.enum(['true', 'false']).default('false') });

/** One template: summary, its steps (with the page documents on request), and the first step rendered as an inert preview page. */
export async function getTemplate(deps: Deps, id: string, opts: { docs?: boolean; preview?: boolean } = {}) {
  const t = await requireTemplate(deps, id);
  const steps = await deps.db.all<StepRow>('SELECT * FROM template_steps WHERE template_id = ? ORDER BY position', t.id);
  const out = {
    ...serialize(t),
    steps: steps.map((s) => ({ id: s.id, name: s.name, path: s.base_path, position: s.position, kind: s.kind, ...(opts.docs ? { doc: loadDoc(s.doc_json) } : {}) })),
  };
  if (!opts.preview) return out;
  const first = steps[0];
  return { ...out, preview: first ? { step: 1, name: first.name, html: renderStep(t, steps, first).html } : null };
}

export const TemplateHtmlQuery = z.object({ step: z.coerce.number().int().min(1).max(50).default(1) });

const htmlCache = new Map<string, string>();
function renderStep(t: TemplateRow, steps: StepRow[], row: StepRow): { html: string } {
  const key = `${t.id}:${t.version}:${t.updated_at}:${row.position}`;
  let html = htmlCache.get(key);
  if (html === undefined) {
    html = renderProject(loadDoc(row.doc_json).project, { funnelId: 'preview', stepId: row.id, stepName: row.name, mode: 'preview', steps: steps.map((s) => ({ id: s.id, href: s.base_path })) }).html;
    if (htmlCache.size > 200) htmlCache.delete(htmlCache.keys().next().value!);
    htmlCache.set(key, html);
  }
  return { html };
}

/** A template step rendered as a standalone page (inert: for previews, shown in a sandboxed iframe). */
export async function templateStepHtml(deps: Deps, id: string, step: number) {
  const t = await requireTemplate(deps, id);
  const steps = await deps.db.all<StepRow>('SELECT * FROM template_steps WHERE template_id = ? ORDER BY position', t.id);
  const row = steps.find((s) => s.position === step);
  if (!row) throw notFound('Template step');
  return { step, name: row.name, html: renderStep(t, steps, row).html };
}

export const UseTemplateInput = z.object({
  /** Name of the new funnel (defaults to the template name; made unique within the workspace). */
  name: z.string().trim().min(1).max(120).optional(),
  /** Catalog binding per product slot of the template: an existing price, or created from the template defaults (the default). */
  bindings: BindingsInput.optional(),
});

/** Clones a template into the caller's workspace as a new test funnel, binding its product slots to the workspace catalog. */
export async function useTemplate(deps: Deps, auth: Auth, id: string, input: z.infer<typeof UseTemplateInput> = {}) {
  const t = await requireTemplate(deps, id);
  const rows = await deps.db.all<StepRow>('SELECT * FROM template_steps WHERE template_id = ? ORDER BY position', t.id);
  return inTx(deps, async (d) => {
    const bound = await bindTemplateProducts(d, auth, parseJson<TemplateProduct[]>(t.products_json, []), rows.map((s) => loadDoc(s.doc_json)), input.bindings ?? {});
    return createFunnelFromSteps(d, auth, { name: input.name ?? t.name, basePath: rows[0]?.base_path ?? slugPath(t.name), steps: rows.map((s, i) => ({ name: s.name, base_path: s.base_path, doc: bound[i], refId: s.id })) });
  });
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

/** Publishes one of the caller's funnels as a global template (copies its step documents; catalog links are removed, a template carries no workspace ids). */
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
    const docs: { s: (typeof steps)[number]; json: string }[] = [];
    for (const s of steps) {
      const page = await d.db.get<{ doc_json: string }>('SELECT doc_json FROM step_pages WHERE step_id = ?', s.id);
      docs.push({ s, json: page!.doc_json });
    }
    const stripped = docs.map((x) => stripCatalogLinks(loadDoc(x.json)));
    const heading = stripped[0] ? firstHeadingOfDoc(stripped[0]) : null;
    await d.db.run("INSERT INTO templates (id, slug, name, description, category_id, base_path, source, heading, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?, ?)", tid, slug, input.name, input.description, category, funnel.base_path, heading, at, at);
    for (const [i, x] of docs.entries()) {
      await d.db.run('INSERT INTO template_steps (id, template_id, name, base_path, position, doc_json) VALUES (?, ?, ?, ?, ?, ?)', newId('tps'), tid, x.s.name, x.s.base_path, x.s.position, JSON.stringify(stripped[i]));
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
  // `customized`: the built-in seed no longer replaces a template an administrator edited.
  await deps.db.run('UPDATE templates SET name = ?, description = ?, category_id = ?, customized = 1, updated_at = ? WHERE id = ?', patch.name ?? t.name, patch.description ?? t.description, category, deps.now().toISOString(), t.id);
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
