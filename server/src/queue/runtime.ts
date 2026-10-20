import { Redis } from 'ioredis';
import type { Config } from '../config.js';
import type { Deps } from '../deps.js';
import { EventBuffer, INGEST_GROUP } from '../services/eventbuffer.js';
import type { EventInsert } from '../services/rollups.js';
import { ClickHouseEventStore } from '../store/clickhouse.js';
import type { EventStore } from '../store/eventstore.js';
import { type EventBus, MemoryBus, RedisStreamsBus } from './eventbus.js';
import { startRelay, TOPIC_EVENTS_STORED, TOPIC_INGEST } from './outbox.js';

export function createEventBus(config: Config): EventBus {
  const useRedis = config.EVENT_BUS === 'redis' || (config.EVENT_BUS === 'auto' && !!config.REDIS_URL);
  if (!useRedis) return new MemoryBus(config.EVENT_BUS_PARTITIONS);
  const redis = new Redis(config.REDIS_URL!, { enableAutoPipelining: true, maxRetriesPerRequest: null });
  redis.on('error', () => undefined);
  return new RedisStreamsBus(redis, `${config.REDIS_KEY_PREFIX}:`, { partitions: config.EVENT_BUS_PARTITIONS });
}

export function createSecondaryStore(config: Config): EventStore | undefined {
  if (config.EVENTSTORE_MIRROR !== 'clickhouse') return undefined;
  return new ClickHouseEventStore({ url: config.CLICKHOUSE_URL!, database: config.CLICKHOUSE_DATABASE, user: config.CLICKHOUSE_USER, password: config.CLICKHOUSE_PASSWORD });
}

export const MIRROR_GROUP = 'clickhouse';

export interface QueueRuntime {
  stop(): Promise<void>;
}

/**
 * Starts what moves events between stages, in this process: the outbox relay (when anything uses the outbox), the ingest consumer (INGEST_QUEUE) and the
 * secondary-store consumer (EVENTSTORE_MIRROR). Every replica may run all of them: consumers of a group split the partitions, and the relay serialises on a lock.
 */
export async function startQueues(deps: Deps): Promise<QueueRuntime> {
  const { config, eventBus: bus } = deps;
  const closers: (() => Promise<void>)[] = [];
  if (deps.secondaryStore || config.OUTBOX_DOMAIN_EVENTS) {
    const relay = startRelay({ db: deps.db, bus, log: deps.log, now: deps.now, pollMs: config.OUTBOX_POLL_MS });
    closers.push(() => relay.stop());
  }
  if (config.INGEST_QUEUE) {
    const sub = await bus.subscribe({
      group: INGEST_GROUP,
      topics: [TOPIC_INGEST],
      batchSize: 500,
      // Throwing makes the bus retry the run one event at a time and dead-letter a poison event alone; persist is idempotent by event id.
      batchHandler: async (events) => void (await (deps.events as EventBuffer).persist(events.map((e) => e.payload as EventInsert))),
    });
    closers.push(() => sub.close());
  }
  if (deps.secondaryStore) {
    const store = deps.secondaryStore;
    const sub = await bus.subscribe({
      group: MIRROR_GROUP,
      topics: [TOPIC_EVENTS_STORED],
      batchSize: 20,
      maxDeliveries: 8,
      backoffMs: 500,
      batchHandler: async (events) => {
        // One ClickHouse insert per outbox row, tokened with its id: a replay is dropped by ClickHouse's block deduplication.
        for (const e of events) await store.write(e.payload as EventInsert[], { token: e.id });
      },
    });
    closers.push(() => sub.close());
  }
  return { stop: async () => void (await Promise.allSettled(closers.map((c) => c()))) };
}
