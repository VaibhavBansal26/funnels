import { z } from 'zod';
import { isUniqueViolation } from '../db/index.js';
import { inTx } from '../db/scope.js';
import type { Deps } from '../deps.js';
import { conflict, notFound } from '../errors.js';
import { like, placeholders } from '../repos/sql.js';
import type { TagRow } from '../repos/types.js';
import { newId } from '../util/ids.js';

export const TagInput = z.object({ name: z.string().trim().min(1).max(50) });

const serialize = (t: TagRow, count = 0) => ({ id: t.id, name: t.name, count, createdAt: t.created_at });

export async function listTags(deps: Deps, ws: string, search?: string) {
  const rows = await deps.db.all<TagRow & { n: number }>(
    `SELECT t.id, t.workspace_id, t.name, t.name_lower, t.created_at, COUNT(f.id) AS n FROM tags t
     LEFT JOIN funnel_tags ft ON ft.tag_id = t.id LEFT JOIN funnels f ON f.id = ft.funnel_id AND f.deleted_at IS NULL
     WHERE t.workspace_id = ? ${search ? `AND ${deps.db.dialect.ilike('t.name_lower')}` : ''}
     GROUP BY t.id, t.workspace_id, t.name, t.name_lower, t.created_at ORDER BY ${deps.db.dialect.orderCi('t.name_lower')}`,
    ...(search ? [ws, like(search.toLowerCase())] : [ws]),
  );
  return { data: rows.map((r) => serialize(r, r.n)) };
}

const taken = () => conflict('TAG_EXISTS', 'A tag with this name already exists');

/** Uniqueness is the (workspace_id, name_lower) unique index; `name_lower` is the case-folded name, so "Sale" and "sale" collide on both engines. */
export async function createTag(deps: Deps, ws: string, input: z.infer<typeof TagInput>) {
  const id = newId('tag');
  try {
    await deps.db.run('INSERT INTO tags (id, workspace_id, name, name_lower, created_at) VALUES (?, ?, ?, ?, ?)', id, ws, input.name, input.name.toLowerCase(), deps.now().toISOString());
  } catch (e) {
    if (isUniqueViolation(e)) throw taken();
    throw e;
  }
  return serialize((await deps.db.get<TagRow>('SELECT * FROM tags WHERE id = ?', id))!);
}

export async function renameTag(deps: Deps, ws: string, id: string, input: z.infer<typeof TagInput>) {
  const tag = await deps.db.get<TagRow>('SELECT * FROM tags WHERE workspace_id = ? AND id = ?', ws, id);
  if (!tag) throw notFound('Tag');
  try {
    await deps.db.run('UPDATE tags SET name = ?, name_lower = ? WHERE workspace_id = ? AND id = ?', input.name, input.name.toLowerCase(), ws, id);
  } catch (e) {
    if (isUniqueViolation(e)) throw taken();
    throw e;
  }
  return serialize({ ...tag, name: input.name, name_lower: input.name.toLowerCase() });
}

/** Deletes tags of this workspace and detaches them from this workspace's funnels only. Unknown ids are a 404 and change nothing. */
export async function deleteTags(deps: Deps, ws: string, ids: string[]): Promise<{ deleted: number }> {
  const unique = [...new Set(ids)].sort();
  return inTx(deps, async (d) => {
    const found = await d.db.all<{ id: string }>(`SELECT id FROM tags WHERE workspace_id = ? AND id IN (${placeholders(unique.length)})`, ws, ...unique);
    if (found.length !== unique.length) throw notFound('Tag');
    await d.db.run(`DELETE FROM funnel_tags WHERE tag_id IN (${placeholders(unique.length)}) AND funnel_id IN (SELECT id FROM funnels WHERE workspace_id = ?)`, ...unique, ws);
    await d.db.run(`DELETE FROM tags WHERE workspace_id = ? AND id IN (${placeholders(unique.length)})`, ws, ...unique);
    return { deleted: unique.length };
  });
}
