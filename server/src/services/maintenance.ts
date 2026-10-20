import type { Db } from '../db/index.js';
import type { Deps } from '../deps.js';

/** Arbitrary constant; serialises partition creation between replicas. */
const PARTITION_LOCK = 724_309_118;

const monthStart = (d: Date, offset: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
const ym = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const bound = (d: Date) => `${ym(d)}-01T00:00:00.000Z`;

/**
 * PostgreSQL: makes sure monthly partitions of `events` exist from last month to `monthsAhead` months in the future, so inserts never fall into
 * the DEFAULT partition (and a later CREATE for that month would fail on the rows already there). Idempotent and safe to run on every replica.
 * Returns the partitions it created. No-op on SQLite.
 */
export async function ensureEventPartitions(db: Db, now: Date, monthsAhead = 3): Promise<string[]> {
  if (db.dialect.name !== 'postgres') return [];
  const created: string[] = [];
  await db.transaction(async (tx) => {
    await tx.run('SELECT pg_advisory_xact_lock(?)', PARTITION_LOCK);
    for (let i = -1; i <= monthsAhead; i++) {
      const from = monthStart(now, i);
      const name = `events_${ym(from).replace('-', '_')}`;
      const exists = await tx.get('SELECT 1 FROM pg_class WHERE relname = ? AND relkind = ?', name, 'r');
      if (exists) continue;
      await tx.exec(`CREATE TABLE ${name} PARTITION OF events FOR VALUES FROM ('${bound(from)}') TO ('${bound(monthStart(now, i + 1))}')`);
      created.push(name);
    }
  });
  return created;
}

/** Deletes idempotency keys older than `days` (the dedupe window). Returns how many were removed. */
export async function pruneEventDedupe(db: Db, now: Date, days: number): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return (await db.run('DELETE FROM event_dedupe WHERE created_at < ?', cutoff)).changes;
}

export async function runMaintenance(deps: Deps): Promise<{ partitions: string[]; dedupePruned: number }> {
  const now = deps.now();
  const partitions = await ensureEventPartitions(deps.db, now, deps.config.PARTITION_MONTHS_AHEAD);
  const dedupePruned = await pruneEventDedupe(deps.db, now, deps.config.EVENT_DEDUPE_DAYS);
  if (partitions.length || dedupePruned) deps.log.info('maintenance', { partitions, dedupePruned });
  return { partitions, dedupePruned };
}

/** Job handler: runs the maintenance and schedules the next run (one pending job at a time, whichever replica enqueues it). */
export async function maintenanceJob(deps: Deps): Promise<void> {
  try {
    await runMaintenance(deps);
  } finally {
    await scheduleMaintenance(deps, deps.config.MAINTENANCE_INTERVAL_HOURS * 3_600_000);
  }
}

export const scheduleMaintenance = (deps: Deps, delayMs = 0) => deps.jobs.enqueue('maintenance.run', {}, { delayMs, maxAttempts: 5, dedupeKey: 'maintenance.run' });
