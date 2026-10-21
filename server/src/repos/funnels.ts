import type { Db } from '../db/index.js';
import { notFound } from '../errors.js';
import type { FunnelRow, StepRow, TagRow } from './types.js';
import { placeholders, updateScoped } from './sql.js';

export function findFunnel(db: Db, ws: string, id: string, includeDeleted = false, lock = false): Promise<FunnelRow | undefined> {
  return db.get<FunnelRow>(`SELECT * FROM funnels WHERE workspace_id = ? AND id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}${lock ? db.dialect.forUpdate() : ''}`, ws, id);
}

export async function requireFunnel(db: Db, ws: string, id: string, includeDeleted = false): Promise<FunnelRow> {
  const f = await findFunnel(db, ws, id, includeDeleted);
  if (!f) throw notFound('Funnel');
  return f;
}

export async function insertFunnel(db: Db, f: Omit<FunnelRow, 'deleted_at' | 'public_slug' | 'allow_indexing'>): Promise<void> {
  await db.run(
    `INSERT INTO funnels (id, workspace_id, name, base_path, domain_id, status, favicon, header_tracking_code, footer_tracking_code, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.id, f.workspace_id, f.name, f.base_path, f.domain_id, f.status, f.favicon, f.header_tracking_code, f.footer_tracking_code, f.created_by, f.created_at, f.updated_at,
  );
}

export const patchFunnel = (db: Db, ws: string, id: string, fields: Record<string, string | number | null>): Promise<number> => updateScoped(db, 'funnels', ws, id, fields);

export const activeFunnelNames = async (db: Db, ws: string): Promise<string[]> =>
  (await db.all<{ name: string }>('SELECT name FROM funnels WHERE workspace_id = ? AND deleted_at IS NULL', ws)).map((r) => r.name);

export function listSteps(db: Db, ws: string, funnelId: string): Promise<StepRow[]> {
  return db.all<StepRow>('SELECT * FROM steps WHERE workspace_id = ? AND funnel_id = ? ORDER BY position, created_at, id', ws, funnelId);
}

export function findStep(db: Db, ws: string, funnelId: string, stepId: string, lock = false): Promise<StepRow | undefined> {
  return db.get<StepRow>(`SELECT * FROM steps WHERE workspace_id = ? AND funnel_id = ? AND id = ?${lock ? db.dialect.forUpdate() : ''}`, ws, funnelId, stepId);
}

export async function requireStep(db: Db, ws: string, funnelId: string, stepId: string, lock = false): Promise<StepRow> {
  const s = await findStep(db, ws, funnelId, stepId, lock);
  if (!s) throw notFound('Step');
  return s;
}

export async function tagsByFunnel(db: Db, ws: string, funnelIds: string[]): Promise<Map<string, { id: string; name: string }[]>> {
  const map = new Map<string, { id: string; name: string }[]>();
  if (funnelIds.length === 0) return map;
  const rows = await db.all<{ funnel_id: string; id: string; name: string }>(
    `SELECT ft.funnel_id, t.id, t.name FROM funnel_tags ft JOIN tags t ON t.id = ft.tag_id
     WHERE t.workspace_id = ? AND ft.funnel_id IN (${placeholders(funnelIds.length)}) ORDER BY t.name_lower`,
    ws, ...funnelIds,
  );
  for (const r of rows) (map.get(r.funnel_id) ?? map.set(r.funnel_id, []).get(r.funnel_id)!).push({ id: r.id, name: r.name });
  return map;
}

/** Tags must belong to the workspace; anything else is treated as a missing resource. */
export async function requireTags(db: Db, ws: string, tagIds: string[]): Promise<TagRow[]> {
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) return [];
  const rows = await db.all<TagRow>(`SELECT * FROM tags WHERE workspace_id = ? AND id IN (${placeholders(unique.length)})`, ws, ...unique);
  if (rows.length !== unique.length) throw notFound('Tag');
  return rows;
}

export async function setFunnelTags(db: Db, ws: string, funnelId: string, tagIds: string[]): Promise<void> {
  await requireTags(db, ws, tagIds);
  await db.run('DELETE FROM funnel_tags WHERE funnel_id = ?', funnelId);
  for (const t of new Set(tagIds)) await db.run(`INSERT INTO funnel_tags (funnel_id, tag_id) VALUES (?, ?)${db.dialect.onConflictDoNothing()}`, funnelId, t);
}

/**
 * Locks a funnel for a structural change. Lock order across the codebase is: workspace, then domain, then funnel, then its steps
 * (by id), then everything else. A funnel attached to a domain therefore takes the domain row first; the funnel is
 * re-read afterwards in case the attachment changed while we waited. No-op locks on SQLite (single writer).
 */
export async function lockFunnel(db: Db, ws: string, id: string, includeDeleted = false): Promise<FunnelRow> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const peek = await requireFunnel(db, ws, id, includeDeleted);
    if (peek.domain_id) await db.get(`SELECT id FROM domains WHERE id = ?${db.dialect.forUpdate()}`, peek.domain_id);
    const f = await findFunnel(db, ws, id, includeDeleted, true);
    if (!f) throw notFound('Funnel');
    if (f.domain_id === peek.domain_id) return f;
  }
  throw new Error('Funnel domain kept changing while locking');
}

/** Locks a domain row (first in the lock order); used before any path-uniqueness check across funnels of that domain. */
export async function lockDomain(db: Db, ws: string, id: string): Promise<void> {
  const row = await db.get(`SELECT id FROM domains WHERE workspace_id = ? AND id = ?${db.dialect.forUpdate()}`, ws, id);
  if (!row) throw notFound('Domain');
}

/**
 * Serialises operations that derive a unique name from the workspace's existing names ("Copy of ...", template names).
 * NO KEY UPDATE conflicts with itself but not with the foreign-key share locks that ordinary inserts take, so
 * ingestion and page saves of the workspace keep running. First in the lock order.
 */
export async function lockWorkspace(db: Db, ws: string): Promise<void> {
  await db.get(`SELECT id FROM workspaces WHERE id = ?${db.dialect.forNoKeyUpdate()}`, ws);
}
