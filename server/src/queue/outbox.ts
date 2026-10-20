import type { Db } from '../db/index.js';
import type { Deps } from '../deps.js';
import type { Logger } from '../logger.js';
import { newId } from '../util/ids.js';
import type { BusEvent, EventBus } from './eventbus.js';

export const TOPIC_DOMAIN = 'funnels.domain'; // lead.created, order.created (low volume, keyed by funnel id)
export const TOPIC_EVENTS_STORED = 'events.stored'; // batches of stored analytics events for the secondary EventStore (ClickHouse)
export const TOPIC_INGEST = 'ingest.events'; // raw analytics events accepted by the origin, waiting to be written (INGEST_QUEUE=bus)

/** Arbitrary constant; only one relay publishes at a time (PostgreSQL). */
const RELAY_LOCK = 724_309_119;

/**
 * Writes a domain event in the CALLER'S transaction (pass the transaction handle), so the event exists if and only if the change committed.
 * `key` is the ordering key: events with the same key reach a consumer group in order.
 */
export async function writeOutbox(tx: Db, topic: string, key: string, payload: unknown, now: string, id = newId('obx')): Promise<string> {
  await tx.run('INSERT INTO outbox_events (id, topic, key, payload, created_at) VALUES (?, ?, ?, ?, ?)', id, topic, key, JSON.stringify(payload), now);
  return id;
}

/**
 * Publishes unpublished rows to the bus, oldest first, then marks them, all inside one transaction that holds a PostgreSQL advisory lock, so
 * any number of replicas can run this and only one publishes at a time (order is preserved). A crash between publish and mark publishes the
 * rows again on the next pass (at-least-once; consumers dedupe on the event id). A bus failure rolls back and leaves every row for the next pass.
 */
/** How many of the oldest unpublished rows one relay pass ranks for fairness (bounds the query cost during a long bus outage). */
const RELAY_WINDOW = 20_000;

export async function relayOutbox(db: Db, bus: EventBus, now: () => Date, batch = 500): Promise<number> {
  return db.transaction(async (tx) => {
    if (tx.dialect.name === 'postgres' && !(await tx.get<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(?) AS ok', RELAY_LOCK))!.ok) return 0;
    // Fair read: among the oldest RELAY_WINDOW unpublished rows take rank 1 of every key (a workspace), then rank 2, ... up to `batch` rows, so one tenant that
    // wrote a million rows cannot delay everybody else's by a million rows. Per key the order is unchanged (ranks ascend with ord), which is what consumers rely on.
    const rows = await tx.all<{ ord: number | string; id: string; topic: string; key: string; payload: string }>(
      `SELECT ord, id, topic, key, payload FROM (
         SELECT ord, id, topic, key, payload, ROW_NUMBER() OVER (PARTITION BY key ORDER BY ord) AS rn
         FROM (SELECT ord, id, topic, key, payload FROM outbox_events WHERE published_at IS NULL ORDER BY ord LIMIT ${RELAY_WINDOW}) head
       ) ranked ORDER BY rn, ord LIMIT ?`,
      batch,
    );
    if (!rows.length) return 0;
    // XADDs are issued in order on one connection, so per-key order holds even though replies are awaited together.
    await Promise.all(rows.map((r) => bus.publish(r.topic, r.key, JSON.parse(r.payload), r.id)));
    await tx.run(`UPDATE outbox_events SET published_at = ? WHERE ord IN (${rows.map(() => '?').join(', ')})`, now().toISOString(), ...rows.map((r) => Number(r.ord)));
    return rows.length;
  });
}

/** Published rows are kept for `hours` for debugging, then deleted. Unpublished rows are never deleted. */
export async function pruneOutbox(db: Db, now: Date, hours = 24): Promise<number> {
  return (await db.run('DELETE FROM outbox_events WHERE published_at IS NOT NULL AND published_at < ?', new Date(now.getTime() - hours * 3_600_000).toISOString())).changes;
}

export async function outboxLag(db: Db, now: Date): Promise<{ unpublished: number; oldestAgeMs: number }> {
  const r = await db.get<{ n: number | string; oldest: string | null }>('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM outbox_events WHERE published_at IS NULL');
  return { unpublished: Number(r?.n ?? 0), oldestAgeMs: r?.oldest ? now.getTime() - Date.parse(r.oldest) : 0 };
}

/** Runs `fn` once per (consumer, event): the marker and the effect commit together, so a redelivery is harmless. Returns false when it was a repeat. */
export async function once(db: Db, consumer: string, event: Pick<BusEvent, 'id'>, now: Date, fn: (tx: Db) => Promise<void>): Promise<boolean> {
  return db.transaction(async (tx) => {
    const r = await tx.run(`INSERT INTO consumed_events (consumer, event_id, consumed_at) VALUES (?, ?, ?)${tx.dialect.onConflictDoNothing()}`, consumer, event.id, now.toISOString());
    if (!r.changes) return false;
    await fn(tx);
    return true;
  });
}

export interface Relay {
  stop(): Promise<void>;
}

/** Polls the outbox every `pollMs`, draining it while there is work. Safe to start on every replica (see relayOutbox). */
export function startRelay(o: { db: Db; bus: EventBus; log: Logger; now: () => Date; pollMs: number }): Relay {
  let running = false;
  let stopped = false;
  const pass = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (let i = 0; i < 20 && !stopped; i++) if ((await relayOutbox(o.db, o.bus, o.now)) === 0) break;
    } catch (e) {
      o.log.warn('outbox relay pass failed', { error: e instanceof Error ? e.message : String(e) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void pass(), o.pollMs);
  timer.unref();
  const prune = setInterval(() => void pruneOutbox(o.db, o.now()).catch(() => undefined), 3_600_000);
  prune.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearInterval(prune);
      while (running) await new Promise((r) => setTimeout(r, 5));
    },
  };
}

/** Domain event (`lead.created`, `order.created`) in the caller's transaction (`deps` must be the transaction-scoped deps). No-op when OUTBOX_DOMAIN_EVENTS is off. */
export async function domainEvent(deps: Deps, type: string, funnelId: string, data: Record<string, unknown>): Promise<void> {
  if (!deps.config.OUTBOX_DOMAIN_EVENTS) return;
  await writeOutbox(deps.db, TOPIC_DOMAIN, String(data.workspaceId ?? funnelId), { type, funnelId, at: deps.now().toISOString(), ...data }, deps.now().toISOString());
}
