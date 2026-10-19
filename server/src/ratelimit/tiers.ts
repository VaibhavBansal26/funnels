import type { Db } from '../db/index.js';
import { type Plan, PLANS } from './types.js';

export interface TierInfo {
  plan: Plan;
  multiplier: number;
}

/** Reads a workspace's plan and per-workspace override (workspaces.plan, workspaces.rate_override), cached briefly so the hot path adds no query. */
export class TierResolver {
  private cache = new Map<string, TierInfo & { exp: number }>();

  constructor(
    private db: Db,
    private ttlMs = 30_000,
    private now: () => number = () => Date.now(),
  ) {}

  async resolve(workspaceId: string): Promise<TierInfo> {
    const hit = this.cache.get(workspaceId);
    if (hit && hit.exp > this.now()) return hit;
    const row = await this.db.get<{ plan: string; rate_override: string | null }>('SELECT plan, rate_override FROM workspaces WHERE id = ?', workspaceId);
    const plan = PLANS.includes(row?.plan as Plan) ? (row!.plan as Plan) : 'free';
    let multiplier = 1;
    if (row?.rate_override) {
      try {
        const m = Number((JSON.parse(row.rate_override) as { multiplier?: number }).multiplier);
        if (Number.isFinite(m) && m > 0 && m <= 1000) multiplier = m;
      } catch {
        /* a malformed override is ignored, never fatal */
      }
    }
    const info = { plan, multiplier };
    this.cache.set(workspaceId, { ...info, exp: this.now() + this.ttlMs });
    if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value!);
    return info;
  }

  invalidate(workspaceId?: string): void {
    if (workspaceId) this.cache.delete(workspaceId);
    else this.cache.clear();
  }
}
