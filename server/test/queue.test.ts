import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryBus, type BusEvent, type EventBus } from '../src/queue/eventbus.js';
import { once, outboxLag, pruneOutbox, relayOutbox, TOPIC_DOMAIN, TOPIC_EVENTS_STORED, TOPIC_INGEST, writeOutbox } from '../src/queue/outbox.js';
import { startQueues } from '../src/queue/runtime.js';
import type { EventInsert } from '../src/services/rollups.js';
import { ClickHouseEventStore, toClickHouseRow } from '../src/store/clickhouse.js';
import type { EventStore } from '../src/store/eventstore.js';
import { signEdge } from '../src/edge/signing.js';
import { formTarget, makeFunnel, makeHarness, type Harness } from './helpers.js';

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(15);
  }
  throw new Error('condition not met in time');
}

const rollupTotals = async (h: Harness) => (await h.deps.db.get<{ v: number | null; u: number | null }>('SELECT SUM(page_views) AS v, SUM(unique_views) AS u FROM event_rollups'))!;
const countEvents = async (h: Harness) => Number((await h.deps.db.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM events'))!.n);

class FakeStore implements EventStore {
  readonly kind = 'clickhouse' as const;
  rows = new Map<string, EventInsert>();
  tokens: string[] = [];
  failNext = 0;
  async write(rows: EventInsert[], opts: { token?: string } = {}) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('clickhouse down');
    }
    if (opts.token) this.tokens.push(opts.token);
    for (const r of rows) this.rows.set(r.id, r); // idempotent by id, like ReplacingMergeTree after a merge
    return rows;
  }
  async close() {}
}

async function ingestHarness(env: Record<string, string> = {}, deps: Parameters<typeof makeHarness>[0] extends infer O ? (O extends { deps?: infer D } ? D : never) : never = {}) {
  const h = await makeHarness({ env: { INGEST_QUEUE: 'true', ...env }, deps: { eventBus: new MemoryBus(4), ...deps } });
  const u = await h.register();
  const f = await makeFunnel(h, u.token);
  const stepId = f.steps[0].id as string;
  const view = (v: string) => h.call('POST', '/api/public/events', { body: { funnelId: f.id, stepId, type: 'page_view', visitorId: v }, headers: UA });
  return { h, u, f, stepId, view };
}

describe('ingest queue (INGEST_QUEUE=true)', () => {
  it('the request path only publishes: nothing is written until a consumer runs, then every event is written exactly once', async () => {
    const { h, view } = await ingestHarness();
    for (let i = 0; i < 40; i++) expect((await view(`v${i % 25}`)).status).toBe(202);
    expect(await countEvents(h)).toBe(0); // 202 returned, database untouched
    expect(await h.deps.eventBus.lag(TOPIC_INGEST, 'ingest')).toBe(40); // the whole backlog is waiting
    const q = await startQueues(h.deps);
    await until(async () => (await countEvents(h)) === 40);
    await sleep(100);
    expect(await countEvents(h)).toBe(40);
    const t = await rollupTotals(h);
    expect(Number(t.v)).toBe(40);
    expect(Number(t.u)).toBe(25); // 25 distinct visitors on one step: first views decided by the server
    await q.stop();
  });

  it('redelivery is harmless: the same events published twice are written once (idempotent by event id)', async () => {
    const { h, f, stepId, u } = await ingestHarness();
    const row: EventInsert = { id: 'evt_dup_1', workspace_id: u.wsId, funnel_id: f.id, step_id: stepId, type: 'page_view', visitor_id: 'vx', unique_visit: 0, lead_id: null, order_id: null, external_id: null, amount_cents: 0, currency: null, utm_json: null, url: null, created_at: h.clock.now().toISOString() };
    for (let i = 0; i < 3; i++) await h.deps.eventBus.publish(TOPIC_INGEST, f.id, row, row.id);
    const q = await startQueues(h.deps);
    await until(async () => (await h.deps.eventBus.lag(TOPIC_INGEST, 'ingest')) === 0 && (await countEvents(h)) >= 1);
    await sleep(100);
    expect(await countEvents(h)).toBe(1);
    expect(Number((await rollupTotals(h)).v)).toBe(1);
    await q.stop();
  });

  it('a database outage mid-stream loses nothing: the consumer retries and the backlog drains afterwards', async () => {
    const { h, view } = await ingestHarness();
    const q = await startQueues(h.deps);
    const realTx = h.deps.db.transaction.bind(h.deps.db);
    let fail = true;
    (h.deps.db as { transaction: unknown }).transaction = (fn: never, o: never) => (fail ? Promise.reject(new Error('db down')) : realTx(fn, o));
    for (let i = 0; i < 30; i++) await view(`out${i}`);
    await sleep(300);
    expect(await countEvents(h)).toBe(0);
    fail = false;
    await until(async () => (await countEvents(h)) === 30, 15_000);
    expect(Number((await rollupTotals(h)).v)).toBe(30);
    await q.stop();
  });

  it('sheds with 503 INGEST_BACKPRESSURE when the backlog is above INGEST_MAX_LAG, and recovers when it drains', async () => {
    const { h, view } = await ingestHarness({ INGEST_MAX_LAG: '5' });
    for (let i = 0; i < 8; i++) await view(`s${i}`); // no consumer: the backlog (lag is measured per group) needs a group, so subscribe with a stalled handler
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await h.deps.eventBus.subscribe({ group: 'ingest', topics: [TOPIC_INGEST], handler: () => gate });
    await sleep(1100); // lag is cached for a second
    let status = 202;
    for (let i = 0; i < 20 && status === 202; i++) status = (await view(`t${i}`)).status;
    expect(status).toBe(503);
    release();
  });

  it('a poison row (not a valid event) is dead-lettered alone; the rest of the run is written', async () => {
    const { h, f, stepId, u } = await ingestHarness();
    const ok = (n: number): EventInsert => ({ id: `evt_ok_${n}`, workspace_id: u.wsId, funnel_id: f.id, step_id: stepId, type: 'page_view', visitor_id: `p${n}`, unique_visit: 0, lead_id: null, order_id: null, external_id: null, amount_cents: 0, currency: null, utm_json: null, url: null, created_at: h.clock.now().toISOString() });
    const bad = { ...ok(99), type: 'not-a-type' };
    for (const r of [ok(1), ok(2), bad, ok(3), ok(4)]) await h.deps.eventBus.publish(TOPIC_INGEST, f.id, r, r.id);
    const q = await startQueues(h.deps);
    await until(async () => (await countEvents(h)) === 4, 15_000);
    await until(async () => (await h.deps.eventBus.deadLetters(TOPIC_INGEST, 'ingest')).length === 1, 15_000);
    expect((await h.deps.eventBus.deadLetters(TOPIC_INGEST, 'ingest'))[0]!.event.id).toBe('evt_ok_99');
    await q.stop();
  });
});

describe('transactional outbox', () => {
  it('a row exists only if the transaction commits; nothing is published before commit', async () => {
    const h = await makeHarness();
    const published: string[] = [];
    const bus = { publish: async (_t: string, _k: string, _p: unknown, id: string) => void published.push(id) } as unknown as EventBus;
    const at = h.clock.now().toISOString();
    await expect(
      h.deps.db.transaction(async (tx) => {
        await writeOutbox(tx, 'topic', 'k', { n: 1 }, at);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await relayOutbox(h.deps.db, bus, h.clock.now)).toBe(0);
    await h.deps.db.transaction((tx) => writeOutbox(tx, 'topic', 'k', { n: 2 }, at, 'obx_commit'));
    expect(await relayOutbox(h.deps.db, bus, h.clock.now)).toBe(1);
    expect(published).toEqual(['obx_commit']);
  });

  it('a bus outage loses nothing: unpublished rows stay, and the next pass delivers them in order', async () => {
    const h = await makeHarness();
    const at = h.clock.now().toISOString();
    for (let i = 0; i < 5; i++) await h.deps.db.transaction((tx) => writeOutbox(tx, 'topic', 'k', { i }, at));
    const down = { publish: async () => Promise.reject(new Error('bus down')) } as unknown as EventBus;
    await expect(relayOutbox(h.deps.db, down, h.clock.now)).rejects.toThrow('bus down');
    expect((await outboxLag(h.deps.db, h.clock.now())).unpublished).toBe(5);
    const got: number[] = [];
    const up = { publish: async (_t: string, _k: string, p: { i: number }) => void got.push(p.i) } as unknown as EventBus;
    await relayOutbox(h.deps.db, up, h.clock.now);
    expect(got).toEqual([0, 1, 2, 3, 4]);
    expect((await outboxLag(h.deps.db, h.clock.now())).unpublished).toBe(0);
  });

  it('crash after publish but before marking republishes; once() makes the consumer apply each event a single time', async () => {
    const h = await makeHarness();
    const at = h.clock.now().toISOString();
    for (let i = 0; i < 4; i++) await h.deps.db.transaction((tx) => writeOutbox(tx, 'topic', 'k', { i }, at));
    const events: BusEvent[] = [];
    const rec = { publish: async (topic: string, key: string, payload: unknown, id: string) => void events.push({ id, topic, key, payload, attempt: 1 }) } as unknown as EventBus;
    await relayOutbox(h.deps.db, rec, h.clock.now);
    await h.deps.db.run('UPDATE outbox_events SET published_at = NULL'); // the crash
    await relayOutbox(h.deps.db, rec, h.clock.now);
    expect(events).toHaveLength(8);
    let applied = 0;
    for (const e of events) await once(h.deps.db, 'c', e, h.clock.now(), async () => void applied++);
    expect(applied).toBe(4);
  });

  it('once() rolls its marker back with a failing effect', async () => {
    const h = await makeHarness();
    const ev = { id: 'evt_x' };
    await expect(once(h.deps.db, 'c', ev, h.clock.now(), async () => Promise.reject(new Error('effect failed')))).rejects.toThrow();
    expect(await once(h.deps.db, 'c', ev, h.clock.now(), async () => undefined)).toBe(true);
  });

  it('pruning deletes old published rows and never an unpublished one', async () => {
    const h = await makeHarness();
    const at = h.clock.now().toISOString();
    await h.deps.db.transaction((tx) => writeOutbox(tx, 't', 'k', {}, at, 'obx_a'));
    await relayOutbox(h.deps.db, { publish: async () => 'x' } as unknown as EventBus, h.clock.now);
    await h.deps.db.transaction((tx) => writeOutbox(tx, 't', 'k', {}, at, 'obx_b'));
    h.clock.advance(48 * 3_600_000);
    expect(await pruneOutbox(h.deps.db, h.clock.now(), 24)).toBe(1);
    expect((await h.deps.db.all<{ id: string }>('SELECT id FROM outbox_events')).map((r) => r.id)).toEqual(['obx_b']);
  });

  it('lead and order domain events are written with the lead, only when OUTBOX_DOMAIN_EVENTS is on', async () => {
    for (const on of [false, true]) {
      const h = await makeHarness({ env: { OUTBOX_DOMAIN_EVENTS: String(on) } });
      const u = await h.register();
      const t = await formTarget(h, u.token);
      const r = await h.call('POST', t.path, { body: { fields: { name: 'Ada', email: 'ada@example.com', _consent: true }, consent: true }, headers: UA });
      expect(r.json.recorded).toBe(true);
      const rows = await h.deps.db.all<{ topic: string; payload: string }>('SELECT topic, payload FROM outbox_events');
      if (!on) expect(rows).toHaveLength(0);
      else {
        expect(rows).toHaveLength(1);
        expect(rows[0]!.topic).toBe(TOPIC_DOMAIN);
        expect(JSON.parse(rows[0]!.payload)).toMatchObject({ type: 'lead.created', funnelId: t.funnelId });
      }
    }
  });
});

describe('secondary event store (ClickHouse mirror)', () => {
  it('every stored event reaches the store through outbox -> bus -> consumer, with unique_visit as decided by the primary', async () => {
    const store = new FakeStore();
    const { h, view } = await ingestHarness({ EVENTSTORE_MIRROR: 'clickhouse', CLICKHOUSE_URL: 'http://ch.test:8123' }, { secondaryStore: store });
    const q = await startQueues(h.deps);
    for (let i = 0; i < 30; i++) await view(`m${i % 10}`);
    await until(() => store.rows.size === 30, 15_000);
    expect([...store.rows.values()].filter((r) => r.unique_visit === 1)).toHaveLength(10);
    expect(await countEvents(h)).toBe(30);
    expect(store.tokens.every((t) => t.startsWith('obx_'))).toBe(true); // block deduplication token = outbox id, stable across replays
    await q.stop();
  });

  it('a ClickHouse outage is retried until it works; the primary is unaffected and nothing is lost', async () => {
    const store = new FakeStore();
    store.failNext = 3;
    const { h, view } = await ingestHarness({ EVENTSTORE_MIRROR: 'clickhouse', CLICKHOUSE_URL: 'http://ch.test:8123' }, { secondaryStore: store });
    const q = await startQueues(h.deps);
    for (let i = 0; i < 12; i++) await view(`o${i}`);
    await until(async () => (await countEvents(h)) === 12);
    await until(() => store.rows.size === 12, 20_000);
    await q.stop();
  });

  it('writes nothing to the outbox when the mirror is off', async () => {
    const { h, view } = await ingestHarness();
    const q = await startQueues(h.deps);
    for (let i = 0; i < 5; i++) await view(`n${i}`);
    await until(async () => (await countEvents(h)) === 5);
    expect(Number((await h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox_events'))!.n)).toBe(0);
    await q.stop();
  });
});

describe('ClickHouseEventStore wire format (against a fake HTTP server; not a real ClickHouse)', () => {
  const row: EventInsert = { id: 'e1', workspace_id: 'w', funnel_id: 'f', step_id: 's', type: 'order', visitor_id: null, unique_visit: 0, lead_id: 'l', order_id: 'o', external_id: 'order:o', amount_cents: 4700, currency: 'USD', utm_json: '{}', url: null, created_at: '2026-03-10T12:34:56.789Z' };

  it('posts JSONEachRow with auth headers and the dedup token, mapping nulls to empty strings and the timestamp to DateTime64', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const store = new ClickHouseEventStore({ url: 'http://ch:8123/', database: 'funnels', user: 'w', password: 'p', fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch });
    await store.write([row, { ...row, id: 'e2' }], { token: 'obx_1' });
    const u = new URL(calls[0]!.url);
    expect(u.origin).toBe('http://ch:8123');
    expect(u.searchParams.get('query')).toBe('INSERT INTO events FORMAT JSONEachRow');
    expect(u.searchParams.get('database')).toBe('funnels');
    expect(u.searchParams.get('insert_deduplication_token')).toBe('obx_1');
    expect(calls[0]!.headers).toMatchObject({ 'x-clickhouse-user': 'w', 'x-clickhouse-key': 'p' });
    const lines = calls[0]!.body.split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ id: 'e1', visitor_id: '', url: '', amount_cents: 4700, created_at: '2026-03-10 12:34:56.789' });
    expect(toClickHouseRow(row).created_at).toBe('2026-03-10 12:34:56.789');
  });

  it('rejects on a non-2xx answer so the bus retries', async () => {
    const store = new ClickHouseEventStore({ url: 'http://ch:8123', database: 'funnels', fetch: (async () => new Response('Code: 241. Memory limit exceeded', { status: 500 })) as unknown as typeof fetch });
    await expect(store.write([row])).rejects.toThrow(/500.*Memory limit/);
  });

  it('exposes the topic names the schema and docs refer to', () => {
    expect([TOPIC_INGEST, TOPIC_EVENTS_STORED, TOPIC_DOMAIN]).toEqual(['ingest.events', 'events.stored', 'funnels.domain']);
  });
});

describe('POST /internal/edge/events (batches from the edge queue consumer)', () => {
  const SECRET = 'edge-secret-edge-secret-edge-secret-1';
  async function edgeWorld(env: Record<string, string> = {}) {
    const h = await makeHarness({ env: { EDGE_SHARED_SECRET: SECRET, ...env } });
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const stepId = f.steps[0].id as string;
    let n = 0;
    const post = (events: unknown[], opts: { secret?: string } = {}) => {
      const ts = String(Math.floor(h.clock.now().getTime() / 1000));
      const nonce = randomBytes(12).toString('hex'); // 24 hex chars: the verifier requires 16 to 64 (a variable-length random suffix was the flake)
      void ++n;
      return h.call('POST', '/internal/edge/events', { body: { events }, headers: { 'x-edge-timestamp': ts, 'x-edge-nonce': nonce, 'x-edge-signature': signEdge(opts.secret ?? SECRET, ts, nonce, 'POST', '/internal/edge/events') } });
    };
    const ev = (id: string, visitor: string, at = h.clock.now().getTime()) => ({ id, at, ua: UA['user-agent'], body: { funnelId: f.id, stepId, type: 'page_view', visitorId: visitor } });
    return { h, post, ev };
  }

  it('rejects an unsigned or wrongly signed call', async () => {
    const { h, post } = await edgeWorld();
    expect((await h.call('POST', '/internal/edge/events', { body: { events: [] } })).status).toBe(401);
    expect((await post([], { secret: 'x'.repeat(40) })).status).toBe(401);
    expect((await post([])).status).toBe(200);
  });

  it('a nonce outside 16 to 64 characters is malformed even when correctly signed (the boundary the test helper once crossed at random)', async () => {
    const { h } = await edgeWorld();
    const ts = String(Math.floor(h.clock.now().getTime() / 1000));
    for (const [nonce, status] of [['a'.repeat(15), 401], ['a'.repeat(16), 200], ['a'.repeat(64), 200], ['a'.repeat(65), 401]] as const) {
      const r = await h.call('POST', '/internal/edge/events', { body: { events: [] }, headers: { 'x-edge-timestamp': ts, 'x-edge-nonce': nonce, 'x-edge-signature': signEdge(SECRET, ts, nonce, 'POST', '/internal/edge/events') } });
      expect(r.status, nonce.length + ' chars').toBe(status);
    }
  });

  it('records valid events, counts invalid ones as rejected, and a redelivered batch does not double count', async () => {
    const { h, post, ev } = await edgeWorld();
    const batch = [ev('aaaaaaaa1', 'v1'), ev('aaaaaaaa2', 'v2'), { id: 'aaaaaaaa3', at: 1, ua: 'x', body: { nonsense: true } }, { id: '!!', at: 1, ua: 'Mozilla/5.0 Chrome', body: {} }];
    const r1 = await post(batch);
    expect(r1.json).toEqual({ accepted: 2, rejected: 2, limited: 0 });
    await h.deps.events.flush();
    expect(await countEvents(h)).toBe(2);
    expect((await post(batch)).json.accepted).toBe(2); // the queue redelivered everything
    await h.deps.events.flush();
    expect(await countEvents(h)).toBe(2);
    expect(Number((await rollupTotals(h)).v)).toBe(2);
  });

  it('uses the edge timestamp as the event time (within 48 h), otherwise now', async () => {
    const { h, post, ev } = await edgeWorld();
    const now = h.clock.now().getTime();
    const resp = await post([ev('bbbbbbbb1', 'v1', now - 3_600_000), ev('bbbbbbbb2', 'v2', now - 10 * 86_400_000), ev('bbbbbbbb3', 'v3', now + 3_600_000)]);
    expect(resp.json, JSON.stringify(resp.json)).toEqual({ accepted: 3, rejected: 0, limited: 0 });
    await h.deps.events.flush();
    const times = Object.fromEntries((await h.deps.db.all<{ id: string; created_at: string }>('SELECT id, created_at FROM events')).map((r) => [r.id, r.created_at]));
    expect(Object.keys(times).sort(), `dropped=${h.deps.events.dropped}`).toEqual(['evt_bbbbbbbb1', 'evt_bbbbbbbb2', 'evt_bbbbbbbb3']);
    expect(times['evt_bbbbbbbb1']).toBe(new Date(now - 3_600_000).toISOString());
    expect(times['evt_bbbbbbbb2']).toBe(new Date(now).toISOString());
    expect(times['evt_bbbbbbbb3']).toBe(new Date(now).toISOString());
  });

  it('answers 503 for the whole batch when ingestion is backed up, so the queue retries it later', async () => {
    const { h, post, ev } = await edgeWorld({ INGEST_QUEUE: 'true', INGEST_MAX_LAG: '1' });
    (h.deps as { eventBus: EventBus }).eventBus = { publish: async () => 'x', lag: async () => 50 } as unknown as EventBus;
    // the buffer was constructed with the original bus; rebuild with a stub bus that reports a big backlog
    const { EventBuffer } = await import('../src/services/eventbuffer.js');
    (h.deps as { events: unknown }).events = new EventBuffer(h.deps.db, h.deps.log, { flushMs: 0, maxQueue: 10, queue: { bus: h.deps.eventBus, maxLag: 1 } });
    const r = await post([ev('cccccccc1', 'v1')]);
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('INGEST_BACKPRESSURE');
  });
});
