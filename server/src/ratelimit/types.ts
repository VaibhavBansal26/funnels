/** Who a limit is counted against. `composite` combines several principal fields (e.g. ip + funnel). */
export type KeyBy = 'ip' | 'user' | 'workspace' | 'apiKey' | 'visitor' | 'socket' | 'composite';
export type Algo = 'gcra' | 'window' | 'concurrency';
export type Plan = 'free' | 'pro' | 'business';
export const PLANS: readonly Plan[] = ['free', 'pro', 'business'];

export interface Principal {
  ip: string;
  userId?: string;
  workspaceId?: string;
  apiKey?: string;
  visitorId?: string;
  socketId?: string;
  /** Free-form extra dimension for composite keys (funnel id, email hash, ...). */
  scope?: string;
  plan?: Plan;
  /** Set by the limiter when the client's IP is allow-listed: every IP-keyed policy then admits without counting. */
  bypassIp?: boolean;
}

export interface PenaltyConfig {
  /** Limited decisions within `strikeWindowMs` that trigger a block. */
  threshold: number;
  strikeWindowMs: number;
  /** Block durations by escalation level; the last one is the cap. */
  stepsMs: number[];
  /** A level is forgotten after this long without a new escalation. */
  decayMs: number;
}

export const DEFAULT_PENALTY: PenaltyConfig = { threshold: 5, strikeWindowMs: 10 * 60_000, stepsMs: [60_000, 5 * 60_000, 30 * 60_000, 24 * 3_600_000], decayMs: 24 * 3_600_000 };

export type FailMode = 'open' | 'closed';

export interface Policy {
  id: string;
  description: string;
  layer: 'ip' | 'class' | 'principal' | 'workspace' | 'concurrency';
  keyBy: KeyBy;
  /** Which Principal fields make up a composite key, in order. */
  composite?: (keyof Principal)[];
  algo: Algo;
  /** Requests (or cost units) allowed per `windowMs`. For concurrency: max in-flight. */
  limit: number;
  windowMs: number;
  /** GCRA bucket size in cost units (default = limit). */
  burst?: number;
  /** Default cost of one call. */
  cost: number;
  onFail: FailMode;
  /** Per-plan multiplier on `limit` (and `burst`). Missing plans use 1. */
  tiers?: Partial<Record<Plan, number>>;
  /** Spend tokens from a process-local lease instead of asking Redis every time. Never combined with `penalty`. */
  lease?: boolean;
  penalty?: boolean;
  /** A repeated Idempotency-Key does not count twice. */
  idempotent?: boolean;
  /** Concurrency lease lifetime, so a crashed holder frees its slot. */
  leaseTtlMs?: number;
}

export type Outcome = 'allowed' | 'limited' | 'blocked' | 'denied' | 'bypassed' | 'shed' | 'error' | 'fail_open' | 'replayed';

export interface Decision {
  policyId: string;
  outcome: Outcome;
  allowed: boolean;
  limit: number;
  /** Bucket size (burst) in cost units; what `remaining` counts down from. Equals `limit` for windows. */
  capacity: number;
  windowMs: number;
  remaining: number;
  /** Time until the bucket is full again / the window ends. */
  resetMs: number;
  retryAfterMs: number;
  /** HTTP status to answer with when not allowed. */
  status: 429 | 503;
}

export type Verdict = 'allowed' | 'limited' | 'blocked' | 'denied' | 'bypassed';

export interface StoreResult {
  verdict: Verdict;
  remaining: number;
  resetMs: number;
  retryAfterMs: number;
}

export interface GcraArgs {
  subject: string;
  policyId: string;
  emissionMs: number;
  capacity: number;
  cost: number;
  penalty?: PenaltyConfig;
}

export interface WindowArgs {
  subject: string;
  policyId: string;
  limit: number;
  windowMs: number;
  cost: number;
  /** `check` only reads (is the budget already spent?), `consume` charges. */
  mode: 'consume' | 'check';
  penalty?: PenaltyConfig;
}

export interface LimitedRecord {
  policyId: string;
  subject: string;
  at: number;
}

/** Every operation is atomic in the store: for Redis one Lua script call, in memory one synchronous step. */
export interface Store {
  readonly kind: 'memory' | 'redis';
  gcra(a: GcraArgs): Promise<StoreResult>;
  window(a: WindowArgs): Promise<StoreResult>;
  acquire(subject: string, policyId: string, max: number, ttlMs: number, leaseId: string): Promise<{ ok: boolean; count: number; retryAfterMs: number }>;
  release(subject: string, policyId: string, leaseId: string): Promise<void>;
  /** True the first time `token` is seen within `ttlMs` (idempotency marker). */
  once(subject: string, policyId: string, token: string, ttlMs: number): Promise<boolean>;
  setList(kind: 'allow' | 'deny', subject: string, ttlMs: number | null): Promise<void>;
  unsetList(kind: 'allow' | 'deny', subject: string): Promise<void>;
  clearPenalty(subject: string): Promise<void>;
  recordLimited(policyId: string, subject: string): Promise<void>;
  limited(max: number): Promise<LimitedRecord[]>;
  lists(): Promise<{ kind: 'allow' | 'deny'; subject: string; ttlMs: number | null }[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export const SUBJECT_MAX = 200;
