import type { Db } from '../db/db.js';
import { notFound } from '../errors.js';
import type { FunnelRow, StepRow, TagRow } from './types.js';
import { placeholders, updateScoped } from './sql.js';

export function findFunnel(db: Db, ws: string, id: string, includeDeleted = false): FunnelRow | undefined {
  return db.get<FunnelRow>(`SELECT * FROM funnels WHERE workspace_id = ? AND id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`, ws, id);
}

export function requireFunnel(db: Db, ws: string, id: string, includeDeleted = false): FunnelRow {
  const f = findFunnel(db, ws, id, includeDeleted);
  if (!f) throw notFound('Funnel');
  return f;
}

export function insertFunnel(db: Db, f: Omit<FunnelRow, 'deleted_at'>): void {
  db.run(
    `INSERT INTO funnels (id, workspace_id, name, base_path, domain_id, status, favicon, header_tracking_code, footer_tracking_code, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.id, f.workspace_id, f.name, f.base_path, f.domain_id, f.status, f.favicon, f.header_tracking_code, f.footer_tracking_code, f.created_by, f.created_at, f.updated_at,
  );
}

export const patchFunnel = (db: Db, ws: string, id: string, fields: Record<string, string | number | null>): number => updateScoped(db, 'funnels', ws, id, fields);

export const touchFunnel = (db: Db, ws: string, id: string, at: string): void => void patchFunnel(db, ws, id, { updated_at: at });

export const activeFunnelNames = (db: Db, ws: string): string[] =>
  db.all<{ name: string }>('SELECT name FROM funnels WHERE workspace_id = ? AND deleted_at IS NULL', ws).map((r) => r.name);

export function listSteps(db: Db, ws: string, funnelId: string): StepRow[] {
  return db.all<StepRow>('SELECT * FROM steps WHERE workspace_id = ? AND funnel_id = ? ORDER BY position, created_at', ws, funnelId);
}

export function findStep(db: Db, ws: string, funnelId: string, stepId: string): StepRow | undefined {
  return db.get<StepRow>('SELECT * FROM steps WHERE workspace_id = ? AND funnel_id = ? AND id = ?', ws, funnelId, stepId);
}

export function requireStep(db: Db, ws: string, funnelId: string, stepId: string): StepRow {
  const s = findStep(db, ws, funnelId, stepId);
  if (!s) throw notFound('Step');
  return s;
}

export function tagsByFunnel(db: Db, ws: string, funnelIds: string[]): Map<string, { id: string; name: string }[]> {
  const map = new Map<string, { id: string; name: string }[]>();
  if (funnelIds.length === 0) return map;
  const rows = db.all<{ funnel_id: string; id: string; name: string }>(
    `SELECT ft.funnel_id, t.id, t.name FROM funnel_tags ft JOIN tags t ON t.id = ft.tag_id
     WHERE t.workspace_id = ? AND ft.funnel_id IN (${placeholders(funnelIds.length)}) ORDER BY t.name_lower`,
    ws, ...funnelIds,
  );
  for (const r of rows) (map.get(r.funnel_id) ?? map.set(r.funnel_id, []).get(r.funnel_id)!).push({ id: r.id, name: r.name });
  return map;
}

/** Tags must belong to the workspace; anything else is treated as a missing resource. */
export function requireTags(db: Db, ws: string, tagIds: string[]): TagRow[] {
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) return [];
  const rows = db.all<TagRow>(`SELECT * FROM tags WHERE workspace_id = ? AND id IN (${placeholders(unique.length)})`, ws, ...unique);
  if (rows.length !== unique.length) throw notFound('Tag');
  return rows;
}

export function setFunnelTags(db: Db, ws: string, funnelId: string, tagIds: string[]): void {
  requireTags(db, ws, tagIds);
  db.run('DELETE FROM funnel_tags WHERE funnel_id = ?', funnelId);
  for (const t of new Set(tagIds)) db.run('INSERT INTO funnel_tags (funnel_id, tag_id) VALUES (?, ?)', funnelId, t);
}
