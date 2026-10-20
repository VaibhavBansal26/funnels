import { headingOfJson } from '../pagemodel/doc.js';
import type { Db } from '../db/index.js';
import { LIBRARY } from './library/index.js';
import type { TemplateDef } from './types.js';

export type SeedTemplate = TemplateDef;
export const SEED_TEMPLATES: SeedTemplate[] = LIBRARY;

export const CATEGORIES = [
  { slug: 'lead-generation', name: 'Lead generation' },
  { slug: 'events', name: 'Events' },
  { slug: 'sales', name: 'Sales' },
  { slug: 'follow-up', name: 'Follow-up' },
  { slug: 'booking', name: 'Booking' },
  { slug: 'ecommerce', name: 'Ecommerce' },
  { slug: 'saas', name: 'Software and apps' },
  { slug: 'local-services', name: 'Local services' },
  { slug: 'education', name: 'Courses and membership' },
  { slug: 'nonprofit', name: 'Nonprofit' },
  { slug: 'agency', name: 'Agencies' },
];

/** The database ids of a built-in template and its steps are derived from the slug, so every replica computes the same ones. */
export const templateId = (slug: string): string => `tpl_${slug}`;
export const templateStepId = (slug: string, position: number): string => `${templateId(slug)}_${position}`;

/**
 * Idempotent and versioned. Inserts missing categories and templates by slug; a built-in template whose stored `version` is lower than the code's is
 * replaced (metadata and steps) unless an administrator edited it (`customized`) or it was imported or published by a user (`source` is not `builtin`), so
 * nothing anyone changed on purpose is clobbered. Funnels created from a template are copies and never change. Ids are deterministic and every insert is
 * `ON CONFLICT DO NOTHING`, so several replicas booting at once cannot collide.
 */
export async function seedTemplates(db: Db, now = new Date(), library: TemplateDef[] = SEED_TEMPLATES): Promise<{ inserted: number; upgraded: number }> {
  const at = now.toISOString();
  const skip = db.dialect.onConflictDoNothing();
  return db.transaction(async (tx) => {
    let inserted = 0;
    let upgraded = 0;
    for (const [i, c] of CATEGORIES.entries()) {
      await tx.run(`INSERT INTO template_categories (id, name, slug, position) VALUES (?, ?, ?, ?)${skip}`, `cat_${c.slug}`, c.name, c.slug, i);
    }
    for (const t of library) {
      const id = templateId(t.slug);
      const meta = [t.name, t.description, `cat_${t.category}`, t.basePath, t.version, t.industry, t.goal, JSON.stringify(t.tags), JSON.stringify(t.products), t.accent, headingOfJson(JSON.stringify(t.steps[0]!.doc))] as const;
      const row = await tx.get<{ id: string; version: number; source: string; customized: number }>('SELECT id, version, source, customized FROM templates WHERE slug = ?', t.slug);
      if (row) {
        if (row.source !== 'builtin' || row.customized === 1 || row.version >= t.version) continue;
        await tx.run('UPDATE templates SET name = ?, description = ?, category_id = ?, base_path = ?, version = ?, industry = ?, goal = ?, tags_json = ?, products_json = ?, accent = ?, heading = ?, updated_at = ? WHERE id = ?', ...meta.slice(0, 10), meta[10], at, row.id);
        await tx.run('DELETE FROM template_steps WHERE template_id = ?', row.id);
        await insertSteps(tx, row.id, t);
        upgraded++;
        continue;
      }
      const r = await tx.run(
        `INSERT INTO templates (id, slug, name, description, category_id, base_path, version, industry, goal, tags_json, products_json, accent, heading, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'builtin', ?, ?)${skip}`,
        id, t.slug, ...meta, at, at,
      );
      if (r.changes === 0) continue;
      await insertSteps(tx, id, t);
      inserted++;
    }
    return { inserted, upgraded };
  });
}

async function insertSteps(tx: Db, templateRowId: string, t: TemplateDef): Promise<void> {
  const skip = tx.dialect.onConflictDoNothing();
  for (const [i, s] of t.steps.entries()) {
    await tx.run(`INSERT INTO template_steps (id, template_id, name, base_path, position, doc_json, kind) VALUES (?, ?, ?, ?, ?, ?, ?)${skip}`, templateStepId(t.slug, i + 1), templateRowId, s.name, s.path, i + 1, JSON.stringify(s.doc), s.kind);
  }
}
