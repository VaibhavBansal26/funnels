import type { Deps } from '../deps.js';
import { AppError } from '../errors.js';
import type { Plan } from '../ratelimit/types.js';
import { type Limited, PLAN_DEFS } from './plans.js';

const count = async (deps: Deps, sql: string, ...p: (string | number)[]) => Number((await deps.db.get<{ n: number }>(sql, ...p))!.n);

export async function usageOf(deps: Deps, ws: string): Promise<Record<Limited, number>> {
  const now = deps.now().toISOString();
  return {
    funnels: await count(deps, 'SELECT COUNT(*) AS n FROM funnels WHERE workspace_id = ? AND deleted_at IS NULL', ws),
    domains: await count(deps, 'SELECT COUNT(*) AS n FROM domains WHERE workspace_id = ?', ws),
    members: (await count(deps, 'SELECT COUNT(*) AS n FROM users WHERE workspace_id = ?', ws)) + (await count(deps, 'SELECT COUNT(*) AS n FROM invitations WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', ws, now)),
    apiKeys: await count(deps, 'SELECT COUNT(*) AS n FROM api_keys WHERE workspace_id = ? AND revoked_at IS NULL', ws),
    pagesProjects: await count(deps, "SELECT COUNT(*) AS n FROM funnel_publish WHERE workspace_id = ? AND owner = 'platform' AND target = 'cloudflare-pages'", ws),
  };
}

const LABEL: Record<Limited, string> = { funnels: 'funnels', domains: 'domains', members: 'members (including pending invitations)', apiKeys: 'API keys', pagesProjects: 'hosted Pages projects' };

/** Refuses (402 PLAN_LIMIT_REACHED) when creating `adding` more of `what` would exceed the workspace's plan. Does nothing unless BILLING_ENFORCE_LIMITS is on. */
export async function assertWithinLimit(deps: Deps, ws: string, what: Limited, adding = 1): Promise<void> {
  if (!deps.config.BILLING_ENFORCE_LIMITS) return;
  const plan = ((await deps.db.get<{ plan: Plan }>('SELECT plan FROM workspaces WHERE id = ?', ws))?.plan ?? 'free') as Plan;
  const limit = PLAN_DEFS[plan][what];
  const used = (await usageOf(deps, ws))[what];
  if (used + adding > limit) throw new AppError(402, 'PLAN_LIMIT_REACHED', `The ${PLAN_DEFS[plan].name} plan allows ${limit} ${LABEL[what]} and you have ${used}. Upgrade to add more.`, { resource: what, limit, used, plan });
}

