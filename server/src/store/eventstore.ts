import type { Db } from '../db/index.js';
import type { EventInsert } from '../services/rollups.js';
import { insertEvents } from '../services/rollups.js';

/**
 * Where analytics events end up. The primary store (`PostgresEventStore`: partitioned `events`, `event_dedupe`, `visitor_steps`, `event_rollups`,
 * `visitor_sketches`) is authoritative and decides idempotency and first views. A secondary store (`ClickHouseEventStore`) receives the rows the
 * primary actually stored, through the transactional outbox, and must be idempotent by event id (replays happen: the bus is at-least-once).
 */
export interface EventStore {
  readonly kind: 'postgres' | 'clickhouse';
  /** Writes rows. Idempotent by `id`. Resolves when durable; rejects so the caller can retry. Returns the rows it stored (final `unique_visit`). */
  write(rows: EventInsert[], opts?: { token?: string }): Promise<EventInsert[]>;
  close(): Promise<void>;
}

/** The primary store: a thin wrapper over `insertEvents` (one transaction per call). */
export class PostgresEventStore implements EventStore {
  readonly kind = 'postgres';
  constructor(private db: Db) {}
  async write(rows: EventInsert[]): Promise<EventInsert[]> {
    const stored: EventInsert[] = [];
    await this.db.transaction(async (tx) => {
      stored.length = 0;
      await insertEvents(tx, rows, { decideUnique: true, collect: stored });
    });
    return stored;
  }
  async close() {}
}
