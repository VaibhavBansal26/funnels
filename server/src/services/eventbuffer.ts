import type { Db } from '../db/db.js';
import type { Logger } from '../logger.js';

export interface EventRow {
  id: string;
  workspace_id: string;
  funnel_id: string;
  step_id: string;
  type: 'page_view' | 'optin';
  visitor_id: string | null;
  unique_visit: number;
  external_id: string | null;
  utm_json: string;
  url: string | null;
  created_at: string;
}

/**
 * Write-behind buffer for the public events endpoint. Rows are queued in memory and inserted in one
 * transaction every `flushMs` (or when `maxQueue` is reached, which applies backpressure to the caller
 * by flushing synchronously). `flushMs: 0` disables buffering (write-through). Readers call `flush()`
 * first so analytics are never stale, and shutdown flushes whatever is left.
 */
export class EventBuffer {
  private queue: EventRow[] = [];
  private seenViews = new Set<string>();
  private seenExternal = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
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
    return this.seenViews.has(`${funnelId}:${stepId}:${visitor}`);
  }

  hasQueuedExternal(funnelId: string, externalId: string): boolean {
    return this.seenExternal.has(`${funnelId}:${externalId}`);
  }

  add(row: EventRow): void {
    this.queue.push(row);
    if (row.type === 'page_view' && row.visitor_id) this.seenViews.add(`${row.funnel_id}:${row.step_id}:${row.visitor_id}`);
    if (row.external_id) this.seenExternal.add(`${row.funnel_id}:${row.external_id}`);
    if (this.opts.flushMs <= 0 || this.queue.length >= this.opts.maxQueue) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.opts.flushMs);
      this.timer.unref();
    }
  }

  flush(): number {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.length === 0) return 0;
    const batch = this.queue;
    this.queue = [];
    this.seenViews.clear();
    this.seenExternal.clear();
    try {
      this.db.tx(() => {
        for (const r of batch) {
          // A funnel deleted between queueing and flushing makes the insert fail its foreign key; skip that row only.
          try {
            this.db.run(
              `INSERT OR IGNORE INTO events (id, workspace_id, funnel_id, step_id, type, visitor_id, unique_visit, external_id, utm_json, url, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              r.id, r.workspace_id, r.funnel_id, r.step_id, r.type, r.visitor_id, r.unique_visit, r.external_id, r.utm_json, r.url, r.created_at,
            );
          } catch (e) {
            this.dropped++;
            this.log.warn('event dropped at flush', { error: (e as Error).message });
          }
        }
      });
      this.flushes++;
    } catch (e) {
      this.log.error('event flush failed', { error: (e as Error).message, rows: batch.length });
      this.dropped += batch.length;
    }
    return batch.length;
  }

  /** Stops the timer and writes everything that is still queued. */
  close(): void {
    this.flush();
  }
}
