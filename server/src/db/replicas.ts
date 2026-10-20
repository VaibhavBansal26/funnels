import type { Pool } from 'pg';

export interface ReplicaOptions {
  /** A replica further behind than this is skipped (the read goes to the primary). */
  maxLagMs: number;
  /** After a write for a key (workspace), reads for that key go to the primary for this long: read-your-writes without tracking WAL positions. */
  stickyMs: number;
  /** How often replica lag is measured. 0 disables the background poll (tests drive `refresh()`). */
  pollMs: number;
  now?: () => number;
  onChange?: (info: { healthy: number; total: number }) => void;
}

export interface ReplicaTarget<T> {
  handle: T;
  pool: Pick<Pool, 'query' | 'end'>;
}

/**
 * Health and routing of read replicas. Lag is measured on each replica (`now() - pg_last_xact_replay_timestamp()`); a replica that errors or is
 * more than `maxLagMs` behind is out of rotation until it recovers; a `NULL` timestamp (an idle replica that has replayed nothing, or a server that is
 * not a replica) counts as caught up. Healthy replicas are used round-robin. A key that wrote less than `stickyMs` ago reads from the primary.
 */
export class ReplicaSet<T> {
  private healthy: boolean[];
  private lag: number[];
  private next = 0;
  private lastWrite = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private now: () => number;

  constructor(
    private replicas: ReplicaTarget<T>[],
    private o: ReplicaOptions,
  ) {
    this.now = o.now ?? (() => Date.now());
    this.healthy = replicas.map(() => true);
    this.lag = replicas.map(() => 0);
    if (o.pollMs > 0) {
      this.timer = setInterval(() => void this.refresh(), o.pollMs);
      this.timer.unref();
    }
  }

  get size(): number {
    return this.replicas.length;
  }

  status(): { healthy: boolean; lagMs: number }[] {
    return this.replicas.map((_, i) => ({ healthy: this.healthy[i]!, lagMs: this.lag[i]! }));
  }

  noteWrite(key: string): void {
    this.lastWrite.set(key, this.now());
    if (this.lastWrite.size > 50_000) for (const [k, t] of this.lastWrite) if (t < this.now() - this.o.stickyMs) this.lastWrite.delete(k);
  }

  async refresh(): Promise<void> {
    await Promise.all(
      this.replicas.map(async (r, i) => {
        try {
          const res = await r.pool.query({ text: `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000, 0)::float8 AS lag` });
          const lag = Number((res.rows[0] as { lag: number }).lag);
          this.lag[i] = lag;
          this.healthy[i] = lag <= this.o.maxLagMs;
        } catch {
          this.healthy[i] = false;
        }
      }),
    );
    this.o.onChange?.({ healthy: this.healthy.filter(Boolean).length, total: this.replicas.length });
  }

  /** The handle to read from, or null for "use the primary". */
  pick(stickyKey?: string): T | null {
    if (stickyKey) {
      const t = this.lastWrite.get(stickyKey);
      if (t !== undefined && this.now() - t < this.o.stickyMs) return null;
    }
    for (let n = 0; n < this.replicas.length; n++) {
      const i = (this.next + n) % this.replicas.length;
      if (this.healthy[i]) {
        this.next = i + 1;
        return this.replicas[i]!.handle;
      }
    }
    return null;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all(this.replicas.map((r) => r.pool.end()));
  }
}
