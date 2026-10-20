import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

export interface BusEvent<T = unknown> {
  /** unique per event; consumers dedupe on it */
  id: string;
  topic: string;
  /** ordering key: events with the same key are delivered to a consumer group in publish order */
  key: string;
  payload: T;
  /** 1 for the first delivery */
  attempt: number;
}

export interface SubscribeOptions {
  /** consumer group: every group sees every event once; consumers sharing a group split the work */
  group: string;
  topics: string[];
  /** one event at a time (omit when `batchHandler` is given) */
  handler?: (e: BusEvent) => Promise<void>;
  /**
   * Whole runs of events from one partition at once, in order (up to `batchSize`, default 200). They are acknowledged together only when the
   * handler resolves. If it throws, the run is retried one event at a time through the same handler, so a single poison event dead-letters
   * alone and does not block or discard its neighbours.
   */
  batchHandler?: (events: BusEvent[]) => Promise<void>;
  batchSize?: number;
  /** deliveries before an event is parked in the dead-letter list (default 5) */
  maxDeliveries?: number;
  /** base delay between redeliveries, doubled per attempt, with jitter (default 100 ms) */
  backoffMs?: number;
}

export interface Subscription {
  close(): Promise<void>;
}

export interface DeadLetter {
  event: BusEvent;
  error: string;
}

/**
 * Event bus contract. At-least-once delivery, per-key ordering within a consumer group, consumer groups, retry with backoff, dead letters.
 * Implementations: MemoryBus (single node, tests), RedisStreamsBus (default when REDIS_URL is set), KafkaBus / NatsBus (stubs with the same
 * contract suite, see docs/SCALING.md for the mapping).
 */
export interface EventBus {
  readonly kind: string;
  publish(topic: string, key: string, payload: unknown, id?: string): Promise<string>;
  subscribe(o: SubscribeOptions): Promise<Subscription>;
  deadLetters(topic: string, group: string): Promise<DeadLetter[]>;
  /** Events published to `topic` that `group` has not acknowledged yet (the backlog). Used for backpressure and the queue-lag metric. */
  lag(topic: string, group: string): Promise<number>;
  close(): Promise<void>;
}

export const newEventId = () => `evt_${Date.now().toString(16)}${randomBytes(6).toString("hex")}`;

/** FNV-1a: stable partition for a key (identical on every node and in every language we might add a consumer in). */
export function partitionOf(key: string, partitions: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % partitions;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms: number) => ms * (0.5 + Math.random());

/* ----------------------------------------------------------------------------------------------------------------------------------- */

interface Entry {
  event: Omit<BusEvent, "attempt">;
}

/**
 * In-process bus with the same semantics as the durable ones: partitioned per key, one sequential worker per (group, partition),
 * retry with backoff, dead letters. Not durable: events die with the process. Used when no Redis is configured and in tests.
 */
export class MemoryBus implements EventBus {
  readonly kind = "memory";
  private readonly log = new Map<string, Entry[][]>(); // topic -> partition -> entries
  private readonly dlq = new Map<string, DeadLetter[]>();
  private readonly waiters = new Set<() => void>();
  private closed = false;
  private readonly subs = new Set<{ stop: () => Promise<void> }>();
  /** next index per (group, topic, partition): shared by every consumer of a group, which is what makes them split the work */
  private readonly groupCursors = new Map<string, number>();
  /** (group, topic, partition) currently owned by one live consumer */
  private readonly owners = new Set<string>();

  constructor(private readonly partitions = 8) {}

  private part(topic: string): Entry[][] {
    let p = this.log.get(topic);
    if (!p) this.log.set(topic, (p = Array.from({ length: this.partitions }, () => [])));
    return p;
  }

  async publish(topic: string, key: string, payload: unknown, id = newEventId()) {
    this.part(topic)[partitionOf(key, this.partitions)]!.push({ event: { id, topic, key, payload } });
    for (const w of [...this.waiters]) w();
    return id;
  }

  async subscribe(o: SubscribeOptions): Promise<Subscription> {
    const max = o.maxDeliveries ?? 5;
    const backoff = o.backoffMs ?? 100;
    let stopped = false;
    const workers: Promise<void>[] = [];
    for (const topic of o.topics) {
      for (let p = 0; p < this.partitions; p++) {
        const ck = `${o.group}|${topic}|${p}`;
        workers.push(
          (async () => {
            let mine = false;
            try {
              while (!stopped && !this.closed) {
                // one active reader per (group, partition): consumers of a group that do not hold it wait and take over if the holder stops
                if (!mine) {
                  if (this.owners.has(ck)) {
                    await sleep(20);
                    continue;
                  }
                  this.owners.add(ck);
                  mine = true;
                }
                const list = this.part(topic)[p]!;
                const at = this.groupCursors.get(ck) ?? 0;
                if (at >= list.length) {
                  await new Promise<void>((res) => {
                    const w = () => {
                      this.waiters.delete(w);
                      res();
                    };
                    this.waiters.add(w);
                    setTimeout(w, 50).unref();
                  });
                  continue;
                }
                const take = o.batchHandler ? Math.min(o.batchSize ?? 200, list.length - at) : 1;
                const entries = list.slice(at, at + take);
                if (o.batchHandler && take > 1) {
                  try {
                    await o.batchHandler(entries.map((e) => ({ ...e.event, attempt: 1 })));
                    this.groupCursors.set(ck, at + take);
                    continue;
                  } catch {
                    // fall through: deliver them one by one (attempt 2 onwards) so only the poison event is dead-lettered
                  }
                }
                const entry = entries[0]!;
                const single = (e: BusEvent) => (o.handler ? o.handler(e) : o.batchHandler!([e]));
                let attempt = o.batchHandler && take > 1 ? 2 : 1;
                for (;;) {
                  try {
                    await single({ ...entry.event, attempt });
                    break;
                  } catch (e) {
                    if (attempt >= max) {
                      const key = `${topic}|${o.group}`;
                      this.dlq.set(key, [...(this.dlq.get(key) ?? []), { event: { ...entry.event, attempt }, error: e instanceof Error ? e.message : String(e) }]);
                      break;
                    }
                    attempt++;
                    await sleep(jitter(backoff * 2 ** (attempt - 2)));
                    if (stopped || this.closed) return; // stays unconsumed: the next owner redelivers it
                  }
                }
                this.groupCursors.set(ck, at + 1);
              }
            } finally {
              if (mine) this.owners.delete(ck);
            }
          })(),
        );
      }
    }
    const sub = {
      stop: async () => {
        stopped = true;
        for (const w of [...this.waiters]) w();
        await Promise.all(workers);
        this.subs.delete(sub);
      },
    };
    this.subs.add(sub);
    return { close: sub.stop };
  }

  async deadLetters(topic: string, group: string) {
    return this.dlq.get(`${topic}|${group}`) ?? [];
  }
  async lag(topic: string, group: string) {
    const parts = this.log.get(topic) ?? [];
    return parts.reduce((n, list, p) => n + list.length - (this.groupCursors.get(`${group}|${topic}|${p}`) ?? 0), 0);
  }
  async close() {
    this.closed = true;
    for (const w of [...this.waiters]) w();
    await Promise.all([...this.subs].map((s) => s.stop()));
  }
}

/* ----------------------------------------------------------------------------------------------------------------------------------- */

export interface RedisBusOptions {
  partitions?: number;
  /** approximate cap per partition stream (older acked entries are trimmed) */
  maxLen?: number;
  /** how long a consumer owns a partition without renewing */
  leaseMs?: number;
  /** poll for ownership changes this often */
  pollMs?: number;
}

/**
 * Redis Streams bus. Each topic is split into P partition streams (`<topic>:{p}`), chosen by hash of the ordering key. A consumer group
 * has ONE active reader per partition, held by a short Redis lease that is renewed while it works and taken over when its holder dies,
 * which is what gives per-key ordering with horizontally scaled consumers. Entries are acknowledged only after the handler succeeds; a
 * new owner re-reads the group's pending list first, so a crash redelivers (at-least-once; consumers dedupe on the event id).
 * After `maxDeliveries` failures an entry moves to `dlq:<topic>:<group>` and processing continues.
 */
export class RedisStreamsBus implements EventBus {
  readonly kind = "redis-streams";
  private readonly P: number;
  private readonly subsOpen = new Set<{ stop: () => Promise<void> }>();
  
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "funnels:",
    private readonly opts: RedisBusOptions = {},
  ) {
    this.P = opts.partitions ?? 16;
  }

  private k(s: string) {
    return this.prefix + s;
  }
  private stream(topic: string, p: number) {
    return this.k(`bus:${topic}:{${p}}`);
  }
  private dlqKey(topic: string, group: string) {
    return this.k(`bus:dlq:${topic}:${group}`);
  }
  private lease(group: string, topic: string, p: number) {
    return this.k(`bus:lease:${group}:${topic}:{${p}}`);
  }

  async publish(topic: string, key: string, payload: unknown, id = newEventId()) {
    await this.redis.xadd(this.stream(topic, partitionOf(key, this.P)), "MAXLEN", "~", String(this.opts.maxLen ?? 1_000_000), "*", "id", id, "key", key, "payload", JSON.stringify(payload));
    return id;
  }

  async subscribe(o: SubscribeOptions): Promise<Subscription> {
    // two connections: `ctl` for leases/acks (must never wait behind a blocking read) and `reader` for the blocking XREADGROUP
    const ctl = this.redis.duplicate();
    const reader = this.redis.duplicate();
        const consumer = `c-${randomBytes(4).toString("hex")}`;
    const max = o.maxDeliveries ?? 5;
    const backoff = o.backoffMs ?? 100;
    const leaseMs = this.opts.leaseMs ?? 6000;
    const pollMs = this.opts.pollMs ?? 250;
    let stopped = false;
    /** `ready` flips once the partition's pending (delivered, unacknowledged) entries are drained; new entries are not read before that, or order would break. */
    const owned = new Map<string, { topic: string; p: number; ready: boolean }>();

    // groups start at the beginning of the stream so a late subscriber still receives the backlog
    for (const topic of o.topics) {
      for (let p = 0; p < this.P; p++) {
        await ctl.xgroup("CREATE", this.stream(topic, p), o.group, "0", "MKSTREAM").catch((e: Error) => {
          if (!/BUSYGROUP/.test(e.message)) throw e;
        });
      }
    }

    const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";
    const tryLease = async (topic: string, p: number) => {
      const k = this.lease(o.group, topic, p);
      if ((await ctl.set(k, consumer, "PX", leaseMs, "NX")) === "OK") return true;
      if ((await ctl.get(k)) === consumer) {
        await ctl.pexpire(k, leaseMs);
        return true;
      }
      return false;
    };

    const processEntry = async (topic: string, p: number, entryId: string, f: string[], firstAttempt: number) => {
      const fields: Record<string, string> = {};
      for (let i = 0; i < f.length; i += 2) fields[f[i]!] = f[i + 1]!;
      const ev = { id: fields.id!, topic, key: fields.key!, payload: JSON.parse(fields.payload!) };
      let attempt = firstAttempt;
      for (;;) {
        try {
          await (o.handler ? o.handler({ ...ev, attempt }) : o.batchHandler!([{ ...ev, attempt }]));
          await ctl.xack(this.stream(topic, p), o.group, entryId);
          return;
        } catch (e) {
          if (attempt >= max) {
            await ctl.xadd(this.dlqKey(topic, o.group), "MAXLEN", "~", "10000", "*", "id", ev.id, "key", ev.key, "payload", fields.payload!, "error", (e instanceof Error ? e.message : String(e)).slice(0, 500), "attempt", String(attempt));
            await ctl.xack(this.stream(topic, p), o.group, entryId);
            return;
          }
          attempt++;
          await sleep(jitter(backoff * 2 ** (attempt - 2)));
          if (stopped || !owned.has(`${topic}|${p}`)) throw new Error("ownership lost"); // left unacknowledged: the next owner redelivers it
        }
      }
    };

    const decode = (topic: string, entryId: string, f: string[]) => {
      const m: Record<string, string> = {};
      for (let i = 0; i < f.length; i += 2) m[f[i]!] = f[i + 1]!;
      return { entryId, event: { id: m.id!, topic, key: m.key!, payload: JSON.parse(m.payload!) } };
    };
    /** A run of entries from one partition: one batch call and one XACK when it works, one-by-one retry (with dead-lettering) when it does not. */
    const processRun = async (topic: string, p: number, entries: [string, string[]][], firstAttempt: number) => {
      const lk = `${topic}|${p}`;
      if (o.batchHandler && entries.length > 1) {
        const dec = entries.map(([id, f]) => decode(topic, id, f));
        try {
          await o.batchHandler(dec.map((d) => ({ ...d.event, attempt: firstAttempt })));
          await ctl.xack(this.stream(topic, p), o.group, ...dec.map((d) => d.entryId));
          return;
        } catch {
          firstAttempt++;
        }
      }
      for (const [entryId, f] of entries) {
        if (stopped || !owned.has(lk)) return;
        await processEntry(topic, p, entryId, f, firstAttempt);
      }
    };

    // entries a previous owner was handed but never acknowledged come first, in order
    const drainPending = async (topic: string, p: number) => {
      for (;;) {
        const res = (await ctl.xreadgroup("GROUP", o.group, "owner", "COUNT", o.batchHandler ? (o.batchSize ?? 200) : 100, "STREAMS", this.stream(topic, p), "0")) as [string, [string, string[]][]][] | null;
        const entries = res?.[0]?.[1] ?? [];
        if (!entries.length) return;
        if (stopped || !owned.has(`${topic}|${p}`)) return;
        await processRun(topic, p, entries, 2);
      }
    };

    const byStream = new Map<string, { topic: string; p: number }>();
    const readLoop = (async () => {
      while (!stopped) {
        const active = [...owned.values()].filter((a) => a.ready);
        if (!active.length) {
          await sleep(pollMs / 2);
          continue;
        }
        const keys = active.map((a) => this.stream(a.topic, a.p));
        keys.forEach((k, i) => byStream.set(k, active[i]!));
        type XR = [string, [string, string[]][]][] | null;
        let res = null as XR;
        try {
          res = (await reader.xreadgroup("GROUP", o.group, "owner", "COUNT", o.batchHandler ? (o.batchSize ?? 200) : 100, "BLOCK", 100, "STREAMS", ...keys, ...keys.map(() => ">"))) as XR;
        } catch {
          await sleep(100);
          continue;
        }
        if (!res) continue;
        // partitions are processed in parallel with each other, strictly in order within a partition
        await Promise.all(
          res.map(async ([k, entries]) => {
            const t = byStream.get(k)!;
            if (stopped || !owned.has(`${t.topic}|${t.p}`)) return;
            await processRun(t.topic, t.p, entries, 1).catch(() => {});
          }),
        );
      }
    })();

    const tick = async () => {
      if (stopped) return;
      for (const topic of o.topics) {
        for (let p = 0; p < this.P; p++) {
          const lk = `${topic}|${p}`;
          const has = await tryLease(topic, p).catch(() => false);
          if (has && !owned.has(lk)) {
            const mine = { topic, p, ready: false };
            owned.set(lk, mine);
            await drainPending(topic, p).catch(() => {});
            mine.ready = true;
          } else if (!has && owned.has(lk)) owned.delete(lk);
        }
      }
    };
    await tick();
    const timer = setInterval(() => void tick().catch(() => {}), pollMs);
    timer.unref();

    const sub = {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await readLoop.catch(() => {});
        for (const topic of o.topics) for (let p = 0; p < this.P; p++) await ctl.eval(RELEASE, 1, this.lease(o.group, topic, p), consumer).catch(() => {});
        ctl.disconnect();
        reader.disconnect();
        this.subsOpen.delete(sub);
      },
    };
    this.subsOpen.add(sub);
    return { close: sub.stop };
  }

  async deadLetters(topic: string, group: string): Promise<DeadLetter[]> {
    const rows = await this.redis.xrange(this.dlqKey(topic, group), "-", "+");
    return rows.map(([, f]) => {
      const m: Record<string, string> = {};
      for (let i = 0; i < f.length; i += 2) m[f[i]!] = f[i + 1]!;
      return { event: { id: m.id!, topic, key: m.key!, payload: JSON.parse(m.payload!), attempt: Number(m.attempt) }, error: m.error ?? "" };
    });
  }

  /** Entries not yet acknowledged by `group`: the group's `lag` (never delivered) plus its pending count, summed over the topic's partitions. Needs Redis 7+. */
  async lag(topic: string, group: string): Promise<number> {
    let total = 0;
    for (let p = 0; p < this.P; p++) {
      const groups = (await this.redis.xinfo("GROUPS", this.stream(topic, p)).catch(() => [])) as unknown[][];
      for (const g of groups) {
        const m: Record<string, unknown> = {};
        for (let i = 0; i < g.length; i += 2) m[String(g[i])] = g[i + 1];
        if (m.name === group) total += Number(m.lag ?? 0) + Number(m.pending ?? 0);
      }
    }
    return total;
  }

  async close() {
    await Promise.all([...this.subsOpen].map((s) => s.stop()));
  }
}

/* ----------------------------------------------------------------------------------------------------------------------------------- */

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is a documented stub: implement the EventBus contract (see test/eventbus.test.ts) to enable it`);
    this.name = "NotImplementedError";
  }
}

/**
 * Kafka / Redpanda adapter stub. Mapping: topic = topic, key = message key (partitioner keeps per-key order), group = consumer group,
 * attempt count = a retry topic (`<topic>.retry.<n>`), dead letters = `<topic>.dlq`. Run the contract suite against it once implemented.
 */
export class KafkaBus implements EventBus {
  readonly kind = "kafka";
  constructor(readonly brokers: string[]) {}
  publish(): Promise<string> {
    throw new NotImplementedError("KafkaBus");
  }
  subscribe(): Promise<Subscription> {
    throw new NotImplementedError("KafkaBus");
  }
  deadLetters(): Promise<DeadLetter[]> {
    throw new NotImplementedError("KafkaBus");
  }
  lag(): Promise<number> {
    throw new NotImplementedError("KafkaBus");
  }
  async close() {}
}

/** NATS JetStream adapter stub. Mapping: subject `<topic>.<partition>`, durable consumer per group with MaxDeliver, `AckWait` as the lease, advisory for dead letters. */
export class NatsBus implements EventBus {
  readonly kind = "nats-jetstream";
  constructor(readonly url: string) {}
  publish(): Promise<string> {
    throw new NotImplementedError("NatsBus");
  }
  subscribe(): Promise<Subscription> {
    throw new NotImplementedError("NatsBus");
  }
  deadLetters(): Promise<DeadLetter[]> {
    throw new NotImplementedError("NatsBus");
  }
  lag(): Promise<number> {
    throw new NotImplementedError("NatsBus");
  }
  async close() {}
}
