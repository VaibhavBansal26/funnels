import type { Deps } from '../deps.js';
import { badRequest, notFound } from '../errors.js';
import { newId } from '../util/ids.js';
import { subjectFor } from './subject.js';
import { type LimitedRecord, type Plan, PLANS } from './types.js';

export type SubjectInput = { kind: 'ip' | 'workspace' | 'user'; value: string };

const subjectOf = ({ kind, value }: SubjectInput): string => {
  if (!value || value.length > 120) throw badRequest('INVALID_SUBJECT', 'Provide a value of at most 120 characters');
  if (kind === 'ip') return subjectFor({ keyBy: 'ip' }, { ip: value });
  return subjectFor({ keyBy: kind }, { ip: '', [kind === 'workspace' ? 'workspaceId' : 'userId']: value });
};

/**
 * Operator controls for the limiter, written as plain methods because the admin panel does not exist yet; the routes under
 * /api/admin/rate-limits are thin wrappers. Every change is audited (audit_log row + structured log line).
 */
export class RateLimitAdmin {
  constructor(private deps: Deps) {}

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    const { db, log } = this.deps;
    await db.run('INSERT INTO audit_log (id, workspace_id, actor_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId('aud'), (detail.workspaceId as string | undefined) ?? null, actor, action, JSON.stringify(detail), this.deps.now().toISOString());
    log.info('ratelimit.admin', { actor, action, ...detail });
  }

  /** Recently limited subjects (bounded log, newest first). Identifiers other than IPs are hashes. */
  async limited(max = 100): Promise<LimitedRecord[]> {
    return this.deps.limiter.store.limited(Math.min(max, 500));
  }

  async lists() {
    return this.deps.limiter.store.lists();
  }

  async block(actor: string, who: SubjectInput, ttlSeconds: number | null): Promise<{ subject: string }> {
    const subject = subjectOf(who);
    await this.deps.limiter.store.setList('deny', subject, ttlSeconds === null ? null : ttlSeconds * 1000);
    await this.audit(actor, 'block', { subject, ttlSeconds });
    return { subject };
  }

  async unblock(actor: string, who: SubjectInput): Promise<void> {
    const subject = subjectOf(who);
    await this.deps.limiter.store.unsetList('deny', subject);
    await this.deps.limiter.store.clearPenalty(subject);
    await this.audit(actor, 'unblock', { subject });
  }

  async allow(actor: string, who: SubjectInput, ttlSeconds: number | null): Promise<{ subject: string }> {
    const subject = subjectOf(who);
    await this.deps.limiter.store.setList('allow', subject, ttlSeconds === null ? null : ttlSeconds * 1000);
    await this.audit(actor, 'allow', { subject, ttlSeconds });
    return { subject };
  }

  async unallow(actor: string, who: SubjectInput): Promise<void> {
    const subject = subjectOf(who);
    await this.deps.limiter.store.unsetList('allow', subject);
    await this.audit(actor, 'unallow', { subject });
  }

  /** Override a workspace's plan and/or multiplier. Takes effect within the tier cache TTL (30 s) on every node. */
  async setTier(actor: string, workspaceId: string, change: { plan?: Plan; multiplier?: number | null }): Promise<{ plan: Plan; multiplier: number }> {
    const { db, limiter } = this.deps;
    const ws = await db.get<{ plan: string; rate_override: string | null }>('SELECT plan, rate_override FROM workspaces WHERE id = ?', workspaceId);
    if (!ws) throw notFound('Workspace');
    if (change.plan !== undefined && !PLANS.includes(change.plan)) throw badRequest('INVALID_PLAN', `Plan must be one of ${PLANS.join(', ')}`);
    if (change.multiplier != null && !(change.multiplier > 0 && change.multiplier <= 1000)) throw badRequest('INVALID_MULTIPLIER', 'Multiplier must be between 0 and 1000');
    const plan = change.plan ?? (ws.plan as Plan);
    const override = change.multiplier === undefined ? ws.rate_override : change.multiplier === null ? null : JSON.stringify({ multiplier: change.multiplier });
    await db.run('UPDATE workspaces SET plan = ?, rate_override = ? WHERE id = ?', plan, override, workspaceId);
    limiter.tiers?.invalidate(workspaceId);
    await this.audit(actor, 'set_tier', { workspaceId, plan, multiplier: change.multiplier });
    return limiter.tiers ? limiter.tiers.resolve(workspaceId) : { plan, multiplier: 1 };
  }
}
