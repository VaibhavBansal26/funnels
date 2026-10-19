import type { GcraArgs, LimitedRecord, Store, StoreResult, WindowArgs } from './types.js';

export class StoreUnavailable extends Error {
  constructor(
    message: string,
    public readonly reason: 'timeout' | 'error' | 'circuit_open',
  ) {
    super(message);
  }
}

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface GuardOptions {
  /** Budget for one store call. Past it the call is abandoned (and counted as a failure) so a slow Redis never stalls requests. */
  timeoutMs: number;
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** While open, calls fail immediately (no added latency); after this one probe is let through. */
  openMs: number;
  now?: () => number;
  onState?: (s: BreakerState) => void;
  onLatency?: (seconds: number, ok: boolean) => void;
}

/** Wraps a remote store with a timeout budget and a circuit breaker. */
export class GuardedStore implements Store {
  private failures = 0;
  private state: BreakerState = 'closed';
  private openedAt = 0;
  private probing = false;
  private now: () => number;

  constructor(
    private inner: Store,
    private o: GuardOptions,
  ) {
    this.now = o.now ?? (() => Date.now());
  }

  get kind() {
    return this.inner.kind;
  }

  get breaker(): BreakerState {
    return this.state;
  }

  private set(s: BreakerState): void {
    if (s !== this.state) {
      this.state = s;
      this.o.onState?.(s);
    }
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.o.openMs || this.probing) throw new StoreUnavailable('rate limit store circuit open', 'circuit_open');
      this.set('half_open');
      this.probing = true;
    }
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StoreUnavailable(`rate limit store did not answer within ${this.o.timeoutMs} ms`, 'timeout')), this.o.timeoutMs);
        }),
      ]);
      this.failures = 0;
      this.probing = false;
      this.set('closed');
      this.o.onLatency?.((performance.now() - started) / 1000, true);
      return result;
    } catch (e) {
      this.o.onLatency?.((performance.now() - started) / 1000, false);
      this.probing = false;
      if (++this.failures >= this.o.failureThreshold || this.state === 'half_open') {
        this.openedAt = this.now();
        this.set('open');
      }
      if (e instanceof StoreUnavailable) throw e;
      throw new StoreUnavailable((e as Error).message, 'error');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  gcra(a: GcraArgs): Promise<StoreResult> { return this.call(() => this.inner.gcra(a)); }
  window(a: WindowArgs): Promise<StoreResult> { return this.call(() => this.inner.window(a)); }
  acquire(s: string, p: string, max: number, ttl: number, id: string) { return this.call(() => this.inner.acquire(s, p, max, ttl, id)); }
  release(s: string, p: string, id: string) { return this.call(() => this.inner.release(s, p, id)); }
  once(s: string, p: string, t: string, ttl: number) { return this.call(() => this.inner.once(s, p, t, ttl)); }
  setList(k: 'allow' | 'deny', s: string, ttl: number | null) { return this.call(() => this.inner.setList(k, s, ttl)); }
  unsetList(k: 'allow' | 'deny', s: string) { return this.call(() => this.inner.unsetList(k, s)); }
  clearPenalty(s: string) { return this.call(() => this.inner.clearPenalty(s)); }
  recordLimited(p: string, s: string) { return this.call(() => this.inner.recordLimited(p, s)); }
  limited(max: number): Promise<LimitedRecord[]> { return this.call(() => this.inner.limited(max)); }
  lists() { return this.call(() => this.inner.lists()); }
  ping() { return this.call(() => this.inner.ping()); }
  close() { return this.inner.close(); }
}
