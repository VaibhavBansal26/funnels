import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { inTx } from '../db/scope.js';
import { AppError, badRequest, conflict } from '../errors.js';
import { firstHeadingOfDoc, loadDoc, type ProjectDoc } from '../pagemodel/doc.js';
import { auditContrast, type ContrastIssue } from '../templates/contrast.js';
import { STEP_KINDS, TEMPLATE_GOALS, type TemplateProduct } from '../templates/types.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';
import { productNodes, stripCatalogLinks } from './catalogdoc.js';
import { validateDoc } from './pages.js';
import { isValidPath, pathKey } from './paths.js';
import { assertPlatformAdmin, requireTemplate } from './templates.js';

/**
 * Admin import and export of templates as JSON, so a template can be added (or fixed) without a deploy. The format is the shape of `TemplateDef`: the export of a
 * template is a valid import. Every step document goes through the same pipeline as a page saved from the builder (`validateDoc`: allow-list rebuild, CSS and
 * URL filters, derived forms and products), without script rights; catalog links are removed because a template carries no workspace ids.
 */
export const IMPORT_LIMITS = { steps: 12, bytes: 1_800_000, tags: 12, products: 8 } as const;

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'Use lowercase letters, digits and hyphens');
const label = (max: number) => z.string().trim().min(1).max(max);

const ProductSlot = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  role: z.enum(['main', 'bump', 'upsell', 'downsell']),
  name: label(200),
  description: z.string().trim().max(500).default(''),
  type: z.enum(['one_time', 'subscription']).default('one_time'),
  amount: z.number().min(0).max(1_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  interval: z.enum(['day', 'week', 'month', 'year']).optional(),
  intervalCount: z.number().int().min(1).max(12).optional(),
  trialDays: z.number().int().min(0).max(730).optional(),
}).refine((p) => p.type === 'one_time' || !!p.interval, { message: 'A subscription needs an interval', path: ['interval'] });

export const TemplateFile = z.object({
  format: z.literal('funnels-template'),
  formatVersion: z.literal(1),
  template: z.object({
    slug,
    version: z.number().int().min(1).max(100_000).default(1),
    name: label(120),
    description: z.string().trim().max(400).default(''),
    category: slug,
    categoryName: label(60).optional(),
    industry: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).default('general'),
    goal: z.enum(TEMPLATE_GOALS).default('leads'),
    tags: z.array(label(32)).max(IMPORT_LIMITS.tags).default([]),
    basePath: z.string().max(200),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2563eb'),
    products: z.array(ProductSlot).max(IMPORT_LIMITS.products).default([]),
    steps: z.array(z.object({ name: label(120), path: z.string().max(200), kind: z.enum(STEP_KINDS).default('page'), doc: z.unknown() })).min(1).max(IMPORT_LIMITS.steps),
  }),
});

export const TemplateImport = TemplateFile.extend({ onConflict: z.enum(['fail', 'replace']).default('fail') });

export async function exportTemplate(deps: Deps, auth: Auth, id: string) {
  await assertPlatformAdmin(deps, auth);
  const t = await requireTemplate(deps, id);
  const steps = await deps.db.all<{ name: string; base_path: string; kind: string; doc_json: string }>('SELECT name, base_path, kind, doc_json FROM template_steps WHERE template_id = ? ORDER BY position', t.id);
  const parse = <T>(s: string, d: T): T => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return d;
    }
  };
  return {
    format: 'funnels-template' as const,
    formatVersion: 1 as const,
    template: {
      slug: t.slug, version: t.version, name: t.name, description: t.description, category: t.category_slug ?? 'lead-generation', categoryName: t.category_name ?? undefined, industry: t.industry,
      goal: t.goal, tags: parse<string[]>(t.tags_json, []), basePath: t.base_path, accent: t.accent, products: parse<TemplateProduct[]>(t.products_json, []),
      steps: steps.map((s) => ({ name: s.name, path: s.base_path, kind: s.kind, doc: loadDoc(s.doc_json) })),
    },
  };
}

export async function importTemplate(deps: Deps, auth: Auth, input: z.infer<typeof TemplateImport>, ip?: string) {
  await assertPlatformAdmin(deps, auth);
  const t = input.template;
  const raw = JSON.stringify(t.steps.map((s) => s.doc));
  if (raw.length > IMPORT_LIMITS.bytes) throw new AppError(413, 'TEMPLATE_TOO_LARGE', `The step documents together may be at most ${IMPORT_LIMITS.bytes} bytes`);
  if (!isValidPath(t.basePath)) throw badRequest('INVALID_PATH', `"${t.basePath}" is not a valid path`);

  const seen = new Set<string>();
  const docs: ProjectDoc[] = [];
  const warnings: { step: string; issues: ContrastIssue[] }[] = [];
  for (const [i, s] of t.steps.entries()) {
    if (!isValidPath(s.path)) throw badRequest('INVALID_PATH', `Step ${i + 1}: "${s.path}" is not a valid path`);
    if (seen.has(pathKey(s.path))) throw badRequest('DUPLICATE_PATH', `Step ${i + 1}: the path "${s.path}" is used twice`);
    seen.add(pathKey(s.path));
    let doc: ProjectDoc;
    try {
      doc = stripCatalogLinks(validateDoc(s.doc, { scriptsOk: false }));
    } catch (e) {
      if (e instanceof AppError) throw badRequest(e.code, `Step ${i + 1} ("${s.name}"): ${e.message}`, e.details);
      throw e;
    }
    docs.push(doc);
    const issues = auditContrast(doc.project);
    if (issues.length) warnings.push({ step: s.name, issues: issues.slice(0, 20) });
  }
  const slots = new Set(t.products.map((p) => p.key));
  if (slots.size !== t.products.length) throw badRequest('DUPLICATE_SLOT', 'Product slot keys must be unique');
  for (const [i, d] of docs.entries()) {
    for (const p of productNodes(d)) if (p.props.slot && !slots.has(p.props.slot)) throw badRequest('UNKNOWN_SLOT', `Step ${i + 1}: the checkout refers to the product slot "${p.props.slot}", which the template does not declare`);
  }
  // A template with a checkout block must declare a slot for it: otherwise the funnel wizard cannot ask which product to sell.
  for (const [i, d] of docs.entries()) {
    if (t.products.length === 0 && productNodes(d).length) throw badRequest('MISSING_SLOTS', `Step ${i + 1} has a checkout but the template declares no products`);
  }

  const result = await inTx(deps, async (d) => {
    const at = d.now().toISOString();
    let category = await d.db.get<{ id: string }>('SELECT id FROM template_categories WHERE slug = ?', t.category);
    if (!category) {
      const id = newId('cat');
      await d.db.run('INSERT INTO template_categories (id, name, slug, position) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM template_categories))', id, t.categoryName ?? t.category.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), t.category);
      category = { id };
    }
    const existing = await d.db.get<{ id: string; version: number }>('SELECT id, version FROM templates WHERE slug = ?', t.slug);
    if (existing && input.onConflict === 'fail') throw conflict('TEMPLATE_EXISTS', `A template with the slug "${t.slug}" already exists (send onConflict: "replace" to replace it)`);
    const id = existing?.id ?? newId('tpl');
    const version = existing ? Math.max(t.version, existing.version + 1) : t.version;
    const heading = firstHeadingOfDoc(docs[0]!);
    if (existing) {
      await d.db.run(
        "UPDATE templates SET name = ?, description = ?, category_id = ?, base_path = ?, version = ?, source = 'imported', industry = ?, goal = ?, tags_json = ?, products_json = ?, accent = ?, heading = ?, customized = 1, updated_at = ? WHERE id = ?",
        t.name, t.description, category.id, t.basePath, version, t.industry, t.goal, JSON.stringify(t.tags), JSON.stringify(t.products), t.accent, heading, at, id,
      );
      await d.db.run('DELETE FROM template_steps WHERE template_id = ?', id);
    } else {
      await d.db.run(
        "INSERT INTO templates (id, slug, name, description, category_id, base_path, version, source, industry, goal, tags_json, products_json, accent, heading, customized, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'imported', ?, ?, ?, ?, ?, ?, 1, ?, ?)",
        id, t.slug, t.name, t.description, category.id, t.basePath, version, t.industry, t.goal, JSON.stringify(t.tags), JSON.stringify(t.products), t.accent, heading, at, at,
      );
    }
    for (const [i, s] of t.steps.entries()) {
      await d.db.run('INSERT INTO template_steps (id, template_id, name, base_path, position, doc_json, kind) VALUES (?, ?, ?, ?, ?, ?, ?)', newId('tps'), id, s.name, s.path, i + 1, JSON.stringify(docs[i]), s.kind);
    }
    await audit(d, { workspaceId: null, actorId: auth.userId, action: existing ? 'admin.template.replaced' : 'admin.template.imported', target: t.slug, ip, detail: { version, steps: t.steps.length } });
    return { id, replaced: !!existing, version };
  });
  return { ...result, slug: t.slug, warnings };
}
