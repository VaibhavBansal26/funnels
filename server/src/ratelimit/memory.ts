import { gcra, slidingWindow, type WindowState } from './math.js';
import type { GcraArgs, LimitedRecord, PenaltyConfig, Store, StoreResult, WindowArgs } from './types.js';

interface Rec {
  exp: number;
  tat?: number;
  win?: WindowState;
  n?: number;
  until?: number;
  leases?: Map<string, number>;
}

const MAX_LIMITED = 1000;

/**
 * The single-process store: same operations and same arithmetic as the Redis scripts, with a bounded LRU map and
 * lazy expiry plus a periodic sweep. Used in development and tests, as the fallback tier, and by anything that runs without REDIS_URL.
 */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private map = new Map<string, Rec>();
  private limitedLog: LimitedRecord[] = [];
  private lists_ = new Map<string, { kind: 'allow' | 'deny'; subject: string; exp: number | null }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private now: () => number = () => Date.now(),
    private maxKeys = 100_000,
    sweepMs = 30_000,
  ) {
    if (sweepMs > 0) {
      this.timer = setInterval(() => this.sweep(), sweepMs);
      this.timer.unref();
    }
  }

  get size(): number {
    return this.map.size;
  }

  private get(key: string): Rec | undefined {
    const r = this.map.get(key);
    if (!r) return undefined;
    if (r.exp <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return r;
  }

  private set(key: string, rec: Rec): void {
    this.map.delete(key); // re-insert so Map order is recency order
    this.map.set(key, rec);
    if (this.map.size > this.maxKeys) this.map.delete(this.map.keys().next().value!);
  }

  sweep(): void {
    const t = this.now();
    for (const [k, r] of this.map) if (r.exp <= t) this.map.delete(k);
  }

  /** Penalty box size, for the gauge. */
  blockedCount(): number {
    const t = this.now();
    let n = 0;
    for (const [k, r] of this.map) if (k.endsWith('|pen') && (r.until ?? 0) > t && r.exp > t) n++;
    return n;
  }

  private guards(subject: string): StoreResult | null {
    const t = this.now();
    const deny = this.lists_.get(`deny|${subject}`);
    if (deny && (deny.exp === null || deny.exp > t)) return { verdict: 'denied', remaining: 0, resetMs: 0, retryAfterMs: deny.exp === null ? 86_400_000 : deny.exp - t };
    const allow = this.lists_.get(`allow|${subject}`);
    if (allow && (allow.exp === null || allow.exp > t)) return { verdict: 'bypassed', remaining: Number.MAX_SAFE_INTEGER, resetMs: 0, retryAfterMs: 0 };
    const pen = this.get(`${subject}|pen`);
    if (pen && (pen.until ?? 0) > t) return { verdict: 'blocked', remaining: 0, resetMs: pen.until! - t, retryAfterMs: pen.until! - t };
    return null;
  }

  /** Counts a violation; at the threshold the subject is blocked for the next escalation step. Returns the block length (0 = none). */
  private strike(subject: string, cfg: PenaltyConfig): number {
    const t = this.now();
    const sk = `${subject}|strk`;
    const cur = this.get(sk);
    const n = (cur?.n ?? 0) + 1;
    this.set(sk, { n, exp: cur ? cur.exp : t + cfg.strikeWindowMs });
    if (n < cfg.threshold) return 0;
    this.map.delete(sk);
    const lk = `${subject}|lvl`;
    const lvl = (this.get(lk)?.n ?? 0) + 1;
    const block = cfg.stepsMs[Math.min(lvl, cfg.stepsMs.length) - 1]!;
    this.set(lk, { n: lvl, exp: t + block + cfg.decayMs }); // the level is forgotten `decayMs` after the block ends
    this.set(`${subject}|pen`, { until: t + block, exp: t + block });
    return block;
  }

  private limitedResult(subject: string, penalty: PenaltyConfig | undefined, r: StoreResult): StoreResult {
    const block = penalty ? this.strike(subject, penalty) : 0;
    return block > 0 ? { verdict: 'blocked', remaining: 0, retryAfterMs: block, resetMs: block } : r;
  }

  async gcra(a: GcraArgs): Promise<StoreResult> {
    const g = this.guards(a.subject);
    if (g) return g;
    const t = this.now();
    const key = `${a.subject}|g:${a.policyId}`;
    const cur = this.get(key);
    const o = gcra(cur?.tat, t, a.emissionMs, a.capacity, a.cost);
    if (!o.allowed) return this.limitedResult(a.subject, a.penalty, { verdict: 'limited', remaining: o.remaining, resetMs: o.resetMs, retryAfterMs: o.retryAfterMs });
    this.set(key, { tat: o.newTat, exp: t + Math.ceil(o.newTat - t) + 1000 });
    return { verdict: 'allowed', remaining: o.remaining, resetMs: o.resetMs, retryAfterMs: 0 };
  }

  async window(a: WindowArgs): Promise<StoreResult> {
    const g = this.guards(a.subject);
    if (g) return g;
    const t = this.now();
    const key = `${a.subject}|w:${a.policyId}`;
    const cur = this.get(key);
    const o = slidingWindow(cur?.win, t, a.limit, a.windowMs, a.cost, a.mode);
    if (!o.allowed) return this.limitedResult(a.subject, a.mode === 'consume' ? a.penalty : undefined, { verdict: 'limited', remaining: o.remaining, resetMs: o.resetMs, retryAfterMs: o.retryAfterMs });
    if (a.mode === 'consume') this.set(key, { win: o.state, exp: t + 2 * a.windowMs });
    return { verdict: 'allowed', remaining: o.remaining, resetMs: o.resetMs, retryAfterMs: 0 };
  }

  async acquire(subject: string, policyId: string, max: number, ttlMs: number, leaseId: string): Promise<{ ok: boolean; count: number; retryAfterMs: number }> {
    const t = this.now();
    const key = `${subject}|c:${policyId}`;
    const rec = this.get(key) ?? { leases: new Map<string, number>(), exp: t + ttlMs };
    for (const [id, exp] of rec.leases!) if (exp <= t) rec.leases!.delete(id);
    if (rec.leases!.size >= max) {
      const soonest = Math.min(...rec.leases!.values());
      this.set(key, rec);
      return { ok: false, count: rec.leases!.size, retryAfterMs: Math.max(1, soonest - t) };
    }
    rec.leases!.set(leaseId, t + ttlMs);
    rec.exp = t + ttlMs;
    this.set(key, rec);
    return { ok: true, count: rec.leases!.size, retryAfterMs: 0 };
  }

  async release(subject: string, policyId: string, leaseId: string): Promise<void> {
    const rec = this.get(`${subject}|c:${policyId}`);
    rec?.leases?.delete(leaseId);
  }

  async once(subject: string, policyId: string, token: string, ttlMs: number): Promise<boolean> {
    const key = `${subject}|i:${policyId}:${token}`;
    if (this.get(key)) return false;
    this.set(key, { exp: this.now() + ttlMs });
    return true;
  }

  async setList(kind: 'allow' | 'deny', subject: string, ttlMs: number | null): Promise<void> {
    this.lists_.set(`${kind}|${subject}`, { kind, subject, exp: ttlMs === null ? null : this.now() + ttlMs });
  }

  async unsetList(kind: 'allow' | 'deny', subject: string): Promise<void> {
    this.lists_.delete(`${kind}|${subject}`);
  }

  async clearPenalty(subject: string): Promise<void> {
    for (const s of ['pen', 'strk', 'lvl']) this.map.delete(`${subject}|${s}`);
  }

  async recordLimited(policyId: string, subject: string): Promise<void> {
    this.limitedLog.push({ policyId, subject, at: this.now() });
    if (this.limitedLog.length > MAX_LIMITED) this.limitedLog.splice(0, this.limitedLog.length - MAX_LIMITED);
  }

  async limited(max: number): Promise<LimitedRecord[]> {
    return this.limitedLog.slice(-max).reverse();
  }

  async lists(): Promise<{ kind: 'allow' | 'deny'; subject: string; ttlMs: number | null }[]> {
    const t = this.now();
    return [...this.lists_.values()].filter((l) => l.exp === null || l.exp > t).map((l) => ({ kind: l.kind, subject: l.subject, ttlMs: l.exp === null ? null : l.exp - t }));
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
