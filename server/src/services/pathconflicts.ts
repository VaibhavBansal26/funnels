import type { Db } from '../db/db.js';
import { pathKey, suggestPaths } from './paths.js';

export interface PathOwner {
  stepId: string;
  stepName: string;
  funnelId: string;
  funnelName: string;
  path: string;
}

/** Path key -> owner for every step of every live (non-trashed) funnel attached to the domain. */
export function domainPathIndex(db: Db, ws: string, domainId: string, excludeFunnelId?: string): Map<string, PathOwner> {
  const rows = db.all<{ step_id: string; step_name: string; funnel_id: string; funnel_name: string; base_path: string; path_key: string }>(
    `SELECT s.id AS step_id, s.name AS step_name, f.id AS funnel_id, f.name AS funnel_name, s.base_path, s.path_key
     FROM steps s JOIN funnels f ON f.id = s.funnel_id
     WHERE f.workspace_id = ? AND f.domain_id = ? AND f.deleted_at IS NULL AND f.id != ?`,
    ws, domainId, excludeFunnelId ?? '',
  );
  const map = new Map<string, PathOwner>();
  for (const r of rows) map.set(r.path_key, { stepId: r.step_id, stepName: r.step_name, funnelId: r.funnel_id, funnelName: r.funnel_name, path: r.base_path });
  return map;
}

export interface PathConflict {
  path: string;
  stepId: string;
  conflictsWith: PathOwner;
  resolved_path: string;
}

/**
 * Conflicts between a funnel's step paths and the paths already used on `domainId` by other funnels.
 * Each conflict carries a suggested free replacement; suggestions never collide with each other.
 */
export function funnelDomainConflicts(db: Db, ws: string, funnelId: string, domainId: string): PathConflict[] {
  const taken = domainPathIndex(db, ws, domainId, funnelId);
  const own = db.all<{ id: string; base_path: string; path_key: string }>('SELECT id, base_path, path_key FROM steps WHERE workspace_id = ? AND funnel_id = ? ORDER BY position', ws, funnelId);
  const reserved = new Set([...taken.keys(), ...own.map((s) => s.path_key)]);
  const out: PathConflict[] = [];
  for (const s of own) {
    const owner = taken.get(s.path_key);
    if (!owner) continue;
    const [resolved] = suggestPaths(s.base_path, reserved, 1);
    reserved.add(pathKey(resolved!));
    out.push({ path: s.base_path, stepId: s.id, conflictsWith: owner, resolved_path: resolved! });
  }
  return out;
}

/** Path keys used by the other steps of the same funnel. */
export function funnelPathKeys(db: Db, ws: string, funnelId: string, excludeStepId?: string): Set<string> {
  return new Set(
    db.all<{ path_key: string }>('SELECT path_key FROM steps WHERE workspace_id = ? AND funnel_id = ? AND id != ?', ws, funnelId, excludeStepId ?? '').map((r) => r.path_key),
  );
}
