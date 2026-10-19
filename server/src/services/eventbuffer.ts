import type { Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import { type EventInsert, insertEvents } from './rollups.js';

export type EventRow = EventInsert;

/**
 * Write-behind buffer for the public events endpoint. Rows are queued in memory and written in one
 * transaction every `flushMs` (or when `maxQueue` is reached, which applies backpressure: the caller awaits the
 * flush). `flushMs: 0` disables buffering (write-through). A flush inserts the batch and folds it into
 * `event_rollups` with one upsert per bucket (see rollups.ts), so the aggregate cost is per batch, not per row.
 * Readers `await flush()` first so analytics are never stale, and shutdown flushes whatever is left.
 */
export class EventBuffer {
  private queue: EventRow[] = [];
  private seenViews = new Set<string>();
  private seenExternal = new Set<string>();
  /** Key sets of batches being written right now: their rows are not readable from the database until COMMIT. */
  private writing = new Set<{ views: Set<string>; external: Set<string> }>();
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<unknown> = Promise.resolve();
  flushes = 0;
  dropped = 0;

  constructor(
    private db: Db,
    private log: Logger,
    private opts: { flushMs: number; maxQueue: number },
  ) {}

  get depth(): number {
    return this.queue.length;
  }

  /** True when the same visitor already has a queued page view for the step (so uniqueness stays correct before the flush). */
  hasQueuedView(funnelId: string, stepId: string, visitor: string): boolean {
    const key = `${funnelId}:${stepId}:${visitor}`;
    return this.seenViews.has(key) || [...this.writing].some((w) => w.views.has(key));
  }

  hasQueuedExternal(funnelId: string, externalId: string): boolean {
    const key = `${funnelId}:${externalId}`;
    return this.seenExternal.has(key) || [...this.writing].some((w) => w.external.has(key));
  }

  async add(row: EventRow): Promise<void> {
    this.queue.push(row);
    if (row.type === 'page_view' && row.visitor_id) this.seenViews.add(`${row.funnel_id}:${row.step_id}:${row.visitor_id}`);
    if (row.external_id) this.seenExternal.add(`${row.funnel_id}:${row.external_id}`);
    if (this.opts.flushMs <= 0 || this.queue.length >= this.opts.maxQueue) await this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush().catch(() => undefined), this.opts.flushMs);
      this.timer.unref();
    }
  }

  /** Writes everything queued so far; resolves when it is committed (also when another flush already covered it). */
  flush(): Promise<number> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.queue;
    this.queue = [];
    const frozen = { views: this.seenViews, external: this.seenExternal };
    this.seenViews = new Set();
    this.seenExternal = new Set();
    this.writing.add(frozen);
    const run = this.inflight.then(() => this.write(batch)).finally(() => this.writing.delete(frozen));
    this.inflight = run.catch(() => undefined);
    return run;
  }

  private async write(batch: EventRow[]): Promise<number> {
    if (batch.length === 0) return 0;
    try {
      await this.db.transaction(async (tx) => {
        // Rows for funnels purged since queueing are skipped (a foreign-key failure would abort the whole batch).
        // FOR SHARE keeps the funnels from being deleted until this transaction commits.
        const ids = [...new Set(batch.map((r) => r.funnel_id))].sort();
        const live = new Set((await tx.all<{ id: string }>(`SELECT id FROM funnels WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id${tx.dialect.forShare()}`, ...ids)).map((r) => r.id));
        const rows = batch.filter((r) => live.has(r.funnel_id));
        this.dropped += batch.length - rows.length;
        await insertEvents(tx, rows);
      });
      this.flushes++;
    } catch (e) {
      this.log.error('event batch failed, retrying rows one by one', { error: (e as Error).message, rows: batch.length });
      for (const r of batch) {
        try {
          await this.db.transaction((tx) => insertEvents(tx, [r]));
        } catch (err) {
          this.dropped++;
          this.log.warn('event dropped at flush', { error: (err as Error).message });
        }
      }
    }
    return batch.length;
  }

  /** Stops the timer and writes everything that is still queued. */
  close(): Promise<number> {
    return this.flush();
  }
}
