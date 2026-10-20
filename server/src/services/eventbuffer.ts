import type { Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import { AppError } from '../errors.js';
import type { EventBus } from '../queue/eventbus.js';
import { TOPIC_EVENTS_STORED, TOPIC_INGEST, writeOutbox } from '../queue/outbox.js';
import { type EventInsert, insertEvents } from './rollups.js';

export type EventRow = EventInsert;

/**
 * Write-behind buffer for the public events endpoint. Rows are queued in memory and written in one
 * transaction every `flushMs` (or when `maxQueue` is reached, which applies backpressure: the caller awaits the
 * flush). `flushMs: 0` disables buffering (write-through). A flush inserts the batch and folds it into
 * `event_rollups` with one upsert per bucket (see rollups.ts), so the aggregate cost is per batch, not per row.
 * Readers `await flush()` first so analytics are never stale, and shutdown flushes whatever is left. "First view" is decided at flush time
 * from `visitor_steps` (see insertEvents), so it is exact across replicas and needs no in-memory set.
 *
 * Two optional scale features (docs/SCALING.md):
 *  - `queue`: `add` publishes the row to the event bus (topic `ingest.events`, keyed by funnel) and returns; a consumer group calls `persist` with
 *    batches. The request path then never touches the database. The bus is at-least-once and `persist` is idempotent by event id, so the effect
 *    is exactly-once. When the consumer's backlog exceeds `maxLag`, `add` fails with 503 so a spike backs up at the caller instead of in memory.
 *  - `mirror`: every batch also writes one outbox row per 500 stored events (same transaction), which the relay publishes for the secondary store.
 */
export interface EventBufferOptions {
  flushMs: number;
  maxQueue: number;
  queue?: { bus: EventBus; maxLag: number };
  mirror?: boolean;
}

export const INGEST_GROUP = 'ingest';
const MIRROR_CHUNK = 500;

export class EventBuffer {
  private queue: EventRow[] = [];
  private seenExternal = new Set<string>();
  /** Key sets of batches being written right now: their rows are not readable from the database until COMMIT. */
  private writing = new Set<{ external: Set<string> }>();
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<unknown> = Promise.resolve();
  private lagCache = { at: 0, lag: 0 };
  flushes = 0;
  dropped = 0;
  published = 0;
  shed = 0;

  constructor(
    private db: Db,
    private log: Logger,
    private opts: EventBufferOptions,
  ) {}

  /** Last observed backlog of the ingest queue (0 when the queue is off). Refreshed at most once a second. */
  get queueLag(): number {
    return this.lagCache.lag;
  }

  get depth(): number {
    return this.queue.length;
  }

  hasQueuedExternal(funnelId: string, externalId: string): boolean {
    const key = `${funnelId}:${externalId}`;
    return this.seenExternal.has(key) || [...this.writing].some((w) => w.external.has(key));
  }

  async add(row: EventRow): Promise<void> {
    if (this.opts.queue) return this.publish(row);
    this.queue.push(row);
    if (row.external_id) this.seenExternal.add(`${row.funnel_id}:${row.external_id}`);
    if (this.opts.flushMs <= 0 || this.queue.length >= this.opts.maxQueue) await this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush().catch(() => undefined), this.opts.flushMs);
      this.timer.unref();
    }
  }

  private async publish(row: EventRow): Promise<void> {
    const q = this.opts.queue!;
    const t = Date.now();
    if (t - this.lagCache.at > 1000) {
      this.lagCache.at = t; // set first: concurrent requests reuse the value while this one is being fetched
      this.lagCache.lag = await q.bus.lag(TOPIC_INGEST, INGEST_GROUP).catch(() => this.lagCache.lag);
    }
    if (this.lagCache.lag > q.maxLag) {
      this.shed++;
      throw new AppError(503, 'INGEST_BACKPRESSURE', 'Event ingestion is catching up, retry shortly');
    }
    await q.bus.publish(TOPIC_INGEST, row.funnel_id, row, row.id);
    this.published++;
  }

  /**
   * Writes a batch in one transaction and throws on failure (the queue consumer relies on that to retry and dead-letter). Rows for funnels purged since
   * they were accepted are skipped (a foreign-key failure would abort the whole batch); FOR SHARE keeps the funnels alive until COMMIT.
   */
  async persist(batch: EventRow[]): Promise<number> {
    if (batch.length === 0) return 0;
    const stored: EventRow[] = [];
    await this.db.transaction(async (tx) => {
      stored.length = 0;
      const ids = [...new Set(batch.map((r) => r.funnel_id))].sort();
      const live = new Set((await tx.all<{ id: string }>(`SELECT id FROM funnels WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id${tx.dialect.forShare()}`, ...ids)).map((r) => r.id));
      const rows = batch.filter((r) => live.has(r.funnel_id));
      this.dropped += batch.length - rows.length;
      await insertEvents(tx, rows, { decideUnique: true, collect: stored });
      if (this.opts.mirror) {
        const at = new Date().toISOString();
        for (let i = 0; i < stored.length; i += MIRROR_CHUNK) {
          const chunk = stored.slice(i, i + MIRROR_CHUNK);
          await writeOutbox(tx, TOPIC_EVENTS_STORED, chunk[0]!.funnel_id, chunk, at);
        }
      }
    });
    this.flushes++;
    return batch.length;
  }

  /** Writes everything queued so far; resolves when it is committed (also when another flush already covered it). */
  flush(): Promise<number> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.queue;
    this.queue = [];
    const frozen = { external: this.seenExternal };
    this.seenExternal = new Set();
    this.writing.add(frozen);
    const run = this.inflight.then(() => this.write(batch)).finally(() => this.writing.delete(frozen));
    this.inflight = run.catch(() => undefined);
    return run;
  }

  private async write(batch: EventRow[]): Promise<number> {
    if (batch.length === 0) return 0;
    try {
      await this.persist(batch);
    } catch (e) {
      this.log.error('event batch failed, retrying rows one by one', { error: (e as Error).message, rows: batch.length });
      for (const r of batch) {
        try {
          await this.persist([r]);
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
