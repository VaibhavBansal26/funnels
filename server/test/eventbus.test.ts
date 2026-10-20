import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type BusEvent, type EventBus, KafkaBus, MemoryBus, NatsBus, NotImplementedError, RedisStreamsBus } from '../src/queue/eventbus.js';
import { BACKEND } from './helpers.js';
import { redisBinary, startRedis, type RedisServer } from './support/redis.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(15);
  }
  throw new Error('condition not met in time');
}

const redisAvailable = redisBinary() !== null && BACKEND === 'sqlite'; // the bus does not touch the database: run once per test run
let redis: RedisServer | undefined;
const clients: Redis[] = [];
const buses: EventBus[] = [];
beforeAll(async () => {
  if (redisAvailable) redis = await startRedis();
});
afterEach(async () => {
  for (const b of buses.splice(0)) await b.close();
  for (const c of clients.splice(0)) c.disconnect();
});
afterAll(async () => {
  await redis?.stop();
});

type Factory = () => { make: () => EventBus };
const factories: [string, Factory, boolean][] = [
  [
    'memory',
    () => {
      const shared = new MemoryBus(4);
      return { make: () => shared };
    },
    BACKEND === 'sqlite',
  ],
  [
    'redis-streams',
    () => {
      const prefix = `eb${randomBytes(4).toString('hex')}:`;
      return {
        make: () => {
          const c = new Redis(redis!.url, { enableAutoPipelining: true, maxRetriesPerRequest: null });
          clients.push(c);
          return new RedisStreamsBus(c, prefix, { partitions: 4, leaseMs: 800, pollMs: 60 });
        },
      };
    },
    redisAvailable,
  ],
];

for (const [name, factory, enabled] of factories) {
  describe.skipIf(!enabled)(`EventBus contract: ${name}`, () => {
    const mk = () => {
      const f = factory();
      const bus = f.make();
      buses.push(bus);
      return { f, bus };
    };

    it('delivers every event once to a group and every event to each group', async () => {
      const { bus } = mk();
      const a: string[] = [];
      const b: string[] = [];
      await bus.subscribe({ group: 'a', topics: ['t'], handler: async (e) => void a.push(e.id) });
      await bus.subscribe({ group: 'b', topics: ['t'], handler: async (e) => void b.push(e.id) });
      const ids: string[] = [];
      for (let i = 0; i < 50; i++) ids.push(await bus.publish('t', `k${i % 7}`, { i }));
      await until(() => a.length === 50 && b.length === 50);
      expect(new Set(a)).toEqual(new Set(ids));
      expect(a).toHaveLength(50);
      expect(b).toHaveLength(50);
    });

    it('a subscriber that starts late still receives the backlog, and lag reports it', async () => {
      const { bus } = mk();
      for (let i = 0; i < 20; i++) await bus.publish('late', 'k', { i });
      const got: number[] = [];
      await bus.subscribe({ group: 'g', topics: ['late'], handler: async (e) => void got.push((e.payload as { i: number }).i) });
      await until(() => got.length === 20);
      expect(got).toEqual([...Array(20).keys()]);
      await until(async () => (await bus.lag('late', 'g')) === 0);
    });

    it('lag counts events a group has not acknowledged', async () => {
      const { bus } = mk();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      await bus.subscribe({ group: 'g', topics: ['lagt'], handler: () => gate });
      for (let i = 0; i < 10; i++) await bus.publish('lagt', 'one-key', { i });
      await sleep(150);
      expect(await bus.lag('lagt', 'g')).toBe(10); // the first is in flight (unacknowledged), the rest wait behind it
      release();
      await until(async () => (await bus.lag('lagt', 'g')) === 0);
    });

    it('preserves order per key, with many keys interleaved and a slow handler', async () => {
      const { bus } = mk();
      const seen = new Map<string, number[]>();
      await bus.subscribe({
        group: 'g',
        topics: ['ord'],
        handler: async (e) => {
          if (Math.random() < 0.1) await sleep(3);
          const l = seen.get(e.key) ?? [];
          l.push((e.payload as { n: number }).n);
          seen.set(e.key, l);
        },
      });
      const per = new Map<string, number>();
      for (let i = 0; i < 400; i++) {
        const k = `funnel${i % 23}`;
        const n = per.get(k) ?? 0;
        per.set(k, n + 1);
        await bus.publish('ord', k, { n });
      }
      await until(() => [...seen.values()].reduce((a, l) => a + l.length, 0) === 400);
      for (const [k, l] of seen) expect(l, k).toEqual([...Array(l.length).keys()]);
    });

    it('competing consumers in one group split the work with no duplicates', async () => {
      const f = factory();
      const b1 = f.make();
      const b2 = f.make();
      buses.push(b1, b2);
      const seen: string[] = [];
      const h = async (e: BusEvent) => {
        await sleep(1);
        seen.push(e.id);
      };
      await b1.subscribe({ group: 'g', topics: ['cc'], handler: h });
      await b2.subscribe({ group: 'g', topics: ['cc'], handler: h });
      for (let i = 0; i < 120; i++) await b1.publish('cc', `k${i % 11}`, { i });
      await until(() => seen.length >= 120);
      await sleep(200);
      expect(seen).toHaveLength(120);
      expect(new Set(seen).size).toBe(120);
    });

    it('retries with an increasing attempt count, then succeeds', async () => {
      const { bus } = mk();
      const attempts: number[] = [];
      await bus.subscribe({
        group: 'g',
        topics: ['retry'],
        backoffMs: 5,
        handler: async (e) => {
          attempts.push(e.attempt);
          if (e.attempt < 3) throw new Error('flaky');
        },
      });
      await bus.publish('retry', 'k', {});
      await until(() => attempts.length >= 3);
      await sleep(50);
      expect(attempts).toEqual([1, 2, 3]);
      expect(await bus.deadLetters('retry', 'g')).toEqual([]);
    });

    it('parks a poison event in the dead letters after maxDeliveries and keeps going', async () => {
      const { bus } = mk();
      const ok: number[] = [];
      await bus.subscribe({
        group: 'g',
        topics: ['poison'],
        maxDeliveries: 3,
        backoffMs: 5,
        handler: async (e) => {
          if ((e.payload as { bad?: boolean }).bad) throw new Error('cannot process');
          ok.push((e.payload as { n: number }).n);
        },
      });
      await bus.publish('poison', 'k', { n: 1 });
      await bus.publish('poison', 'k', { bad: true });
      await bus.publish('poison', 'k', { n: 3 });
      await until(() => ok.length === 2);
      expect(ok).toEqual([1, 3]);
      await until(async () => (await bus.deadLetters('poison', 'g')).length === 1);
      const dl = (await bus.deadLetters('poison', 'g'))[0]!;
      expect(dl.error).toContain('cannot process');
      expect(dl.event.attempt).toBe(3);
    });

    it('batch handler: runs arrive in order, in groups, and one poison event dead-letters alone', async () => {
      const { bus } = mk();
      const batches: number[][] = [];
      const applied: number[] = [];
      for (let i = 0; i < 60; i++) await bus.publish('batch', 'k', i === 17 ? { n: i, bad: true } : { n: i });
      await bus.subscribe({
        group: 'g',
        topics: ['batch'],
        batchSize: 25,
        maxDeliveries: 3,
        backoffMs: 5,
        batchHandler: async (events) => {
          // all-or-nothing, like a database transaction
          if (events.some((e) => (e.payload as { bad?: boolean }).bad)) throw new Error('bad row in batch');
          batches.push(events.map((e) => (e.payload as { n: number }).n));
          for (const e of events) applied.push((e.payload as { n: number }).n);
        },
      });
      await until(async () => applied.length === 59 && (await bus.deadLetters('batch', 'g')).length === 1);
      expect(applied).toEqual([...Array(60).keys()].filter((n) => n !== 17)); // order kept, nothing else lost
      expect(batches.some((b) => b.length > 1)).toBe(true); // real batching happened
      expect(((await bus.deadLetters('batch', 'g'))[0]!.event.payload as { n: number }).n).toBe(17);
    });

    it('when a consumer stops mid-stream another consumer of the group takes over and nothing is lost', async () => {
      const f = factory();
      const b1 = f.make();
      const b2 = f.make();
      buses.push(b1, b2);
      const seen = new Map<string, number>();
      const h = async (e: BusEvent) => {
        await sleep(2);
        seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
      };
      const s1 = await b1.subscribe({ group: 'g', topics: ['fo'], handler: h });
      await b2.subscribe({ group: 'g', topics: ['fo'], handler: h });
      const ids: string[] = [];
      for (let i = 0; i < 100; i++) ids.push(await b1.publish('fo', `k${i % 5}`, { i }));
      await sleep(40);
      await s1.close(); // "crash": the first consumer goes away with events still unprocessed
      await until(() => ids.every((id) => seen.has(id)), 12000);
      expect([...seen.values()].every((n) => n >= 1)).toBe(true); // at-least-once: maybe twice around the hand-over, never zero
    });
  });
}

describe.skipIf(!redisAvailable)('Redis Streams bus: crash and restart', () => {
  it('a consumer process killed with SIGKILL mid-event loses nothing: a fresh consumer re-reads the unacknowledged entries', async () => {
    const prefix = `cr${randomBytes(4).toString('hex')}:`;
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/support/bus-child.ts', redis!.url, prefix, 'crash'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    try {
      await until(() => out.includes('ready'), 20_000);
      const c = new Redis(redis!.url, { maxRetriesPerRequest: null });
      clients.push(c);
      const pub = new RedisStreamsBus(c, prefix, { partitions: 2 });
      buses.push(pub);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await pub.publish('crash', 'one-key', { i }));
      await until(() => out.includes('started'), 10_000); // delivered to the child, never acknowledged
      child.kill('SIGKILL');
      const c2 = new Redis(redis!.url, { maxRetriesPerRequest: null });
      clients.push(c2);
      const second = new RedisStreamsBus(c2, prefix, { partitions: 2, leaseMs: 500, pollMs: 50 });
      buses.push(second);
      const got: string[] = [];
      await second.subscribe({ group: 'g', topics: ['crash'], handler: async (e) => void got.push(e.id) });
      await until(() => new Set(got).size >= 5, 15_000);
      expect(got.slice(0, 5)).toEqual(ids); // redelivered in the original order
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('EventBus adapters that are documented stubs', () => {
  it.each([
    ['kafka', new KafkaBus(['localhost:9092'])],
    ['nats', new NatsBus('nats://localhost:4222')],
  ])('%s fails loudly instead of pretending to work', (_n, bus) => {
    expect(() => bus.publish()).toThrow(NotImplementedError);
    expect(() => bus.subscribe()).toThrow(NotImplementedError);
    expect(() => bus.lag()).toThrow(NotImplementedError);
  });
});
