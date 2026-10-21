import type { Db } from '../db/index.js';
import type { Deps } from '../deps.js';
import { inTx } from '../db/scope.js';
import { fireWebhookEvent } from './webhooks.js';
import { pruneAttributionPii } from './attribution.js';
import { purgeReviewCache } from './googlereviews.js';
import { purgeGenerations } from '../ai/builder/service.js';

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

/**
 * Tells workspaces that subscribed to `analytics.daily_rollup_ready` that yesterday's (UTC) data is complete enough to pull from the analytics API. Once per workspace
 * and day: the marker row and the queued delivery are one transaction, and the marker's primary key makes concurrent replicas agree. Catches up only for
 * yesterday (a longer outage skips the days in between; consumers can always poll the API for any range).
 */
export async function announceDailyRollups(deps: Deps): Promise<number> {
  const now = deps.now();
  const today = now.toISOString().slice(0, 10);
  const day = new Date(Date.parse(`${today}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
  const subscribed = await deps.db.all<{ workspace_id: string }>("SELECT DISTINCT workspace_id FROM webhooks WHERE active = 1 AND events_json LIKE '%analytics.daily_rollup_ready%'");
  let announced = 0;
  for (const { workspace_id: ws } of subscribed) {
    const fired = await inTx(deps, async (d) => {
      const claim = await d.db.run(`INSERT INTO analytics_daily_ready (workspace_id, day, created_at) VALUES (?, ?, ?)${d.db.dialect.onConflictDoNothing()}`, ws, day, now.toISOString());
      if (claim.changes !== 1) return false;
      const funnels = (await d.db.all<{ funnel_id: string }>('SELECT DISTINCT funnel_id FROM event_rollups WHERE workspace_id = ? AND bucket >= ? AND bucket < ?', ws, `${day}T00:00`, `${today}T00:00`)).map((r) => r.funnel_id).sort();
      await fireWebhookEvent(d, ws, 'analytics.daily_rollup_ready', { day, from: day, to: day, tz: 'UTC', funnels, schemaVersion: 1 });
      return true;
    });
    if (fired) announced++;
  }
  return announced;
}

export async function runMaintenance(deps: Deps): Promise<{ partitions: string[]; dedupePruned: number; rollupsAnnounced: number }> {
  const now = deps.now();
  const partitions = await ensureEventPartitions(deps.db, now, deps.config.PARTITION_MONTHS_AHEAD);
  const dedupePruned = await pruneEventDedupe(deps.db, now, deps.config.EVENT_DEDUPE_DAYS);
  const rollupsAnnounced = await announceDailyRollups(deps);
  // Ads: IP addresses and user agents kept for server-side conversions expire; the delivery log keeps 180 days.
  await pruneAttributionPii(deps, deps.config.ATTRIBUTION_RETENTION_DAYS);
  await deps.db.run('DELETE FROM conversion_deliveries WHERE created_at < ?', new Date(now.getTime() - 180 * 86_400_000).toISOString());
  await purgeGenerations(deps, deps.config.AI_GENERATION_RETENTION_DAYS);
  await purgeReviewCache(deps);
  if (partitions.length || dedupePruned || rollupsAnnounced) deps.log.info('maintenance', { partitions, dedupePruned, rollupsAnnounced });
  return { partitions, dedupePruned, rollupsAnnounced };
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
