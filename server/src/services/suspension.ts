import type { Deps } from '../deps.js';
import { AppError } from '../errors.js';

/**
 * Is this workspace suspended? Read on every public request (events, forms, checkout, API keys), so the answer is cached in-process for a few seconds. Suspending
 * clears the cache of the node that did it; other nodes follow within `TTL_MS`. Sign-in sessions are checked against the database directly (auth/context.ts).
 */
const TTL_MS = 5_000;
const cache = new Map<string, { suspended: boolean; until: number }>();

export function forgetSuspensions(): void {
  cache.clear();
}

export async function isSuspended(deps: Deps, ws: string): Promise<boolean> {
  const hit = cache.get(ws);
  const now = Date.now();
  if (hit && hit.until > now) return hit.suspended;
  const row = await deps.db.get<{ suspended_at: string | null }>('SELECT suspended_at FROM workspaces WHERE id = ?', ws);
  if (cache.size > 20_000) cache.clear();
  const suspended = !!row?.suspended_at;
  cache.set(ws, { suspended, until: now + TTL_MS });
  return suspended;
}

export async function assertNotSuspended(deps: Deps, ws: string): Promise<void> {
  if (await isSuspended(deps, ws)) throw new AppError(403, 'WORKSPACE_SUSPENDED', 'This account is suspended');
}
