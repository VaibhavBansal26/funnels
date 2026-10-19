import { randomBytes } from 'node:crypto';
import { type BreakerState, StoreUnavailable } from './guarded.js';
import type { TierResolver } from './tiers.js';
import { PENALTY } from './policies.js';
import { subjectFor } from './subject.js';
import type { Decision, Outcome, Plan, Policy, Principal, Store, StoreResult } from './types.js';

/** Observers, filled in later (metrics are created after the limiter). */
export interface LimiterHooks {
  store?(seconds: number, ok: boolean): void;
  breaker?(s: BreakerState): void;
  decision?(policyId: string, outcome: Outcome): void;
  lease?(policyId: string, result: 'hit' | 'refill' | 'direct'): void;
  logLimited?(info: { policyId: string; outcome: Outcome; sample: number }): void;
}

export interface LimiterOptions {
  store: Store;
  policies: Policy[];
  now?: () => number;
  hooks: LimiterHooks;
  /** Resolves a workspace's plan and per-workspace multiplier. */
  tiers?: TierResolver;
  /** Fraction of a GCRA bucket leased to this process at a time (policies with `lease`). 0 disables the local tier. */
  leaseFraction?: number;
  /** False turns every decision into "allowed" (RATELIMIT_ENABLED=false), for emergencies and benchmarks. */
  enabled?: boolean;
  /** Log one in N limited decisions. */
  logSample?: number;
}

interface Lease {
  tokens: number;
  exp: number;
}

export interface ConcurrencyHandle {
  decision: Decision;
  release(): Promise<void>;
}

const NOOP_RELEASE = async () => undefined;

/**
 * Evaluates policies against a store. Cheap to call: with Redis, one atomic script per layer, and for `lease` policies mostly zero,
 * because tokens are pre-paid from Redis in small batches and spent locally.
 *
 * Lease tier error bound: tokens are charged to Redis when leased, so the cluster NEVER admits more than limit + burst in any window.
 * The cost is the other direction: a process that leases and then goes idle strands up to `leaseFraction * burst` tokens until the lease
 * expires (`batch * emission`, at most 5 s), so with N processes a key can be refused up to N * leaseFraction * burst tokens early.
 */
export class RateLimiter {
  private byId = new Map<string, Policy>();
  private leases = new Map<string, Lease>();
  private denials = new Map<string, { until: number; result: StoreResult }>();
  private recorded = new Map<string, number>();
  private refills = new Map<string, { promise: Promise<void> }>();
  private seq = 0;
  readonly store: Store;
  readonly hooks: LimiterHooks;
  readonly tiers?: TierResolver;
  private now: () => number;

  constructor(private o: LimiterOptions) {
    this.store = o.store;
    this.hooks = o.hooks;
    this.tiers = o.tiers;
    this.now = o.now ?? (() => Date.now());
    for (const p of o.policies) this.byId.set(p.id, p);
  }

  policy(id: string): Policy {
    const p = this.byId.get(id);
    if (!p) throw new Error(`Unknown rate limit policy "${id}"`);
    return p;
  }

  get policies(): Policy[] {
    return [...this.byId.values()];
  }

  private async scaled(p: Policy, principal: Principal): Promise<{ limit: number; burst: number }> {
    let mult = 1;
    const ws = principal.workspaceId;
    if (ws && this.tiers && (p.tiers || p.layer === 'workspace')) {
      const t = await this.tiers.resolve(ws);
      mult = (p.tiers?.[t.plan] ?? 1) * t.multiplier;
    } else if (principal.plan && p.tiers) mult = p.tiers[principal.plan] ?? 1;
    const limit = Math.max(1, Math.floor(p.limit * mult));
    return { limit, burst: Math.max(1, Math.floor((p.burst ?? p.limit) * mult)) };
  }

  private finish(p: Policy, outcome: Outcome, allowed: boolean, d: Partial<Decision> & { limit: number }): Decision {
    this.hooks.decision?.(p.id, outcome);
    return {
      policyId: p.id, outcome, allowed, windowMs: p.windowMs, capacity: d.limit, remaining: 0, resetMs: 0, retryAfterMs: 0,
      status: p.algo === 'concurrency' ? 503 : 429, ...d,
    };
  }

  private fromStore(p: Policy, r: StoreResult, limit: number, capacity = limit): Decision {
    const outcome: Outcome = r.verdict === 'allowed' ? 'allowed' : r.verdict;
    const allowed = r.verdict === 'allowed' || r.verdict === 'bypassed';
    return this.finish(p, outcome, allowed, { limit, capacity, remaining: r.remaining, resetMs: r.resetMs, retryAfterMs: r.retryAfterMs });
  }

  private limitedSideEffects(p: Policy, d: Decision, subject: string): void {
    if (this.o.logSample && ++this.seq % this.o.logSample === 0) this.hooks.logLimited?.({ policyId: p.id, outcome: d.outcome, sample: this.o.logSample });
    if (subject) {
      // The admin view needs "who is being limited", not every refusal: at most one record per subject and policy per second.
      const k = `${p.id}|${subject}`;
      const t = this.now();
      if ((this.recorded.get(k) ?? 0) + 1000 <= t) {
        this.recorded.set(k, t);
        if (this.recorded.size > 10_000) this.recorded.delete(this.recorded.keys().next().value!);
        void this.store.recordLimited(p.id, subject).catch(() => undefined);
      }
    }
  }

  private failure(p: Policy, e: unknown, limit: number): Decision {
    const reason = e instanceof StoreUnavailable ? e.reason : 'error';
    void reason;
    if (p.onFail === 'open') return this.finish(p, 'fail_open', true, { limit, remaining: limit });
    return this.finish(p, 'error', false, { limit, retryAfterMs: 5000, status: 503 });
  }

  /** One decision for one policy. `cost` defaults to the policy's; `mode: 'check'` (window policies) only asks whether the budget is spent. */
  async check(id: string, principal: Principal, opts: { cost?: number; mode?: 'consume' | 'check'; idempotencyKey?: string } = {}): Promise<Decision> {
    const p = this.policy(id);
    if (p.algo === 'concurrency') throw new Error(`Policy "${id}" is a concurrency policy: use acquire()`);
    if (this.o.enabled === false || (principal.bypassIp && (p.keyBy === 'ip' || (p.keyBy === 'composite' && p.composite?.includes('ip'))))) return this.finish(p, 'bypassed', true, { limit: p.limit, remaining: p.limit });
    const { limit, burst } = await this.scaled(p, principal);
    const subject = subjectFor(p, principal);
    const cost = opts.cost ?? p.cost;
    try {
      if (p.idempotent && opts.idempotencyKey && !(await this.store.once(subject, p.id, opts.idempotencyKey, Math.max(p.windowMs, 60_000)))) {
        return this.finish(p, 'replayed', true, { limit, remaining: limit });
      }
      const penalty = p.penalty ? PENALTY : undefined;
      if (p.algo === 'window') {
        const r = await this.store.window({ subject, policyId: p.id, limit, windowMs: p.windowMs, cost, mode: opts.mode ?? 'consume', penalty });
        const d = this.fromStore(p, r, limit);
        if (!d.allowed) this.limitedSideEffects(p, d, subject);
        return d;
      }
      const emissionMs = p.windowMs / limit;
      const leased = await this.leaseTake(p, subject, emissionMs, burst, cost);
      if (leased?.ok) return this.finish(p, 'allowed', true, { limit, capacity: burst, remaining: leased.remaining, resetMs: leased.resetMs });
      if (leased) {
        const d = this.fromStore(p, leased.result, limit, burst);
        this.limitedSideEffects(p, d, subject);
        return d;
      }
      const r = await this.store.gcra({ subject, policyId: p.id, emissionMs, capacity: burst, cost, penalty });
      const d = this.fromStore(p, r, limit, burst);
      if (!d.allowed) this.limitedSideEffects(p, d, subject);
      return d;
    } catch (e) {
      return this.failure(p, e, limit);
    }
  }

  /**
   * Local tier: spend pre-paid tokens; when empty, pre-pay a batch from the store (or the exact cost if a whole batch no longer fits).
   * A refusal from the store is remembered until its Retry-After: the GCRA state only moves later, so nothing can be admitted sooner, and a
   * hammering client costs one store call per Retry-After instead of one per request.
   */
  private async leaseTake(p: Policy, subject: string, emissionMs: number, burst: number, cost: number): Promise<{ ok: true; remaining: number; resetMs: number } | { ok: false; result: StoreResult } | null> {
    const frac = this.o.leaseFraction ?? 0;
    if (!p.lease || p.penalty || this.store.kind !== 'redis' || frac <= 0) return null;
    const batch = Math.max(Math.ceil(burst * frac), cost);
    if (batch <= cost) return null; // too small to be worth leasing
    const key = `${p.id}|${subject}`;
    for (let round = 0; round < 4; round++) {
      const t = this.now();
      const denied = this.denials.get(key);
      if (denied && denied.until > t) {
        this.hooks.lease?.(p.id, 'hit');
        return { ok: false, result: { ...denied.result, retryAfterMs: denied.until - t } };
      }
      const lease = this.leases.get(key);
      if (lease && lease.exp > t && lease.tokens >= cost) {
        lease.tokens -= cost;
        this.hooks.lease?.(p.id, 'hit');
        return { ok: true, remaining: Math.floor(lease.tokens), resetMs: Math.max(0, lease.exp - t) };
      }
      // Single flight: concurrent requests for one key share one refill. Without this each would pre-pay its own batch and all but the
      // last would be stranded (measured: 3 processes x 13 concurrent requests admitted a third of the burst).
      const inflight = this.refills.get(key);
      if (inflight) {
        await inflight.promise;
        continue;
      }
      let direct: { ok: true; remaining: number; resetMs: number } | { ok: false; result: StoreResult } | null = null;
      const promise = (async () => {
        const r = await this.store.gcra({ subject, policyId: p.id, emissionMs, capacity: burst, cost: batch });
        if (r.verdict === 'allowed') {
          this.leases.set(key, { tokens: batch - cost, exp: t + Math.min(5000, Math.max(100, batch * emissionMs)) });
          if (this.leases.size > 50_000) this.leases.delete(this.leases.keys().next().value!);
          this.hooks.lease?.(p.id, 'refill');
          direct = { ok: true, remaining: batch - cost, resetMs: r.resetMs };
          return;
        }
        if (r.verdict === 'blocked' || r.verdict === 'denied') return; // the exact path reports it
        this.leases.delete(key);
        this.hooks.lease?.(p.id, 'direct');
        const exact = await this.store.gcra({ subject, policyId: p.id, emissionMs, capacity: burst, cost });
        if (exact.verdict === 'limited') {
          this.denials.set(key, { until: t + exact.retryAfterMs, result: exact });
          if (this.denials.size > 50_000) this.denials.delete(this.denials.keys().next().value!);
          direct = { ok: false, result: exact };
        } else if (exact.verdict === 'allowed') direct = { ok: true, remaining: exact.remaining, resetMs: exact.resetMs };
      })();
      this.refills.set(key, { promise: promise.catch(() => undefined) });
      try {
        await promise;
      } finally {
        this.refills.delete(key);
      }
      return direct;
    }
    return null;
  }

  /** Cheapest-first layers; the first denial short-circuits. Returns every decision made so the caller can report the tightest one. */
  async evaluate(ids: string[], principal: Principal, opts: { cost?: number; idempotencyKey?: string } = {}): Promise<{ decisions: Decision[]; denied: Decision | null }> {
    const order = { ip: 0, class: 1, principal: 2, workspace: 3, concurrency: 4 } as const;
    const sorted = [...ids].sort((a, b) => order[this.policy(a).layer] - order[this.policy(b).layer]);
    const decisions: Decision[] = [];
    for (const id of sorted) {
      if (this.policy(id).algo === 'concurrency') continue;
      const d = await this.check(id, principal, { cost: id === 'api.workspace' ? opts.cost : undefined, idempotencyKey: opts.idempotencyKey });
      decisions.push(d);
      if (this.policy(id).layer === 'ip' && d.outcome === 'bypassed') principal.bypassIp = true;
      if (!d.allowed) return { decisions, denied: d };
    }
    return { decisions, denied: null };
  }

  /** In-flight cap. The returned `release` must be called in `finally` (or when a stream ends); an unreleased slot frees itself after `leaseTtlMs`. */
  async acquire(id: string, principal: Principal): Promise<ConcurrencyHandle> {
    const p = this.policy(id);
    if (this.o.enabled === false) return { decision: this.finish(p, 'bypassed', true, { limit: p.limit, remaining: p.limit }), release: NOOP_RELEASE };
    const { limit } = await this.scaled(p, principal);
    const subject = subjectFor(p, principal);
    const leaseId = randomBytes(9).toString('base64url');
    try {
      const r = await this.store.acquire(subject, p.id, limit, p.leaseTtlMs ?? 60_000, leaseId);
      if (!r.ok) {
        const d = this.finish(p, 'shed', false, { limit, remaining: 0, retryAfterMs: r.retryAfterMs, status: 503 });
        this.limitedSideEffects(p, d, subject);
        return { decision: d, release: NOOP_RELEASE };
      }
      let released = false;
      return {
        decision: this.finish(p, 'allowed', true, { limit, remaining: Math.max(0, limit - r.count) }),
        release: async () => {
          if (released) return;
          released = true;
          await this.store.release(subject, p.id, leaseId).catch(() => undefined);
        },
      };
    } catch (e) {
      return { decision: this.failure(p, e, limit), release: NOOP_RELEASE };
    }
  }

  /** Runs `fn` while holding a concurrency slot; releases on return or throw. `onDenied` receives the 503 decision. */
  async withConcurrency<T>(id: string, principal: Principal, fn: () => Promise<T>, onDenied: (d: Decision) => never): Promise<T> {
    const h = await this.acquire(id, principal);
    if (!h.decision.allowed) onDenied(h.decision);
    try {
      return await fn();
    } finally {
      await h.release();
    }
  }
}
