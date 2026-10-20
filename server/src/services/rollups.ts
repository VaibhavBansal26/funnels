import type { Db } from '../db/index.js';
import { HyperLogLog } from '../util/hll.js';

export interface EventInsert {
  id: string;
  workspace_id: string;
  funnel_id: string;
  step_id: string;
  type: 'page_view' | 'optin' | 'order';
  visitor_id: string | null;
  unique_visit: number;
  lead_id: string | null;
  order_id: string | null;
  external_id: string | null;
  amount_cents: number;
  currency: string | null;
  utm_json: string | null;
  url: string | null;
  created_at: string;
  /** Optional context captured at the beacon (analytics export contract); absent for server-created events such as orders. */
  device?: string | null;
  country?: string | null;
  referrer_host?: string | null;
}

const COLUMNS = ['id', 'workspace_id', 'funnel_id', 'step_id', 'type', 'visitor_id', 'unique_visit', 'lead_id', 'order_id', 'external_id', 'amount_cents', 'currency', 'utm_json', 'url', 'created_at', 'device', 'country', 'referrer_host'] as const;
const CHUNK = 200;

/** 15-minute UTC bucket label `YYYY-MM-DDTHH:MM`. Every real time-zone offset is a multiple of 15 minutes, so a local-day boundary never splits a bucket. */
export const bucketOf = (iso: string): string => `${iso.slice(0, 14)}${String(Math.floor(Number(iso.slice(14, 16)) / 15) * 15).padStart(2, '0')}`;

interface Delta {
  workspace_id: string;
  funnel_id: string;
  step_id: string;
  bucket: string;
  page_views: number;
  unique_views: number;
  optins: number;
  orders: number;
  cents: number;
}

/** Folds events into one delta per (funnel, bucket, step). Pure, so the batching is unit-testable. */
export function aggregate(rows: EventInsert[]): Delta[] {
  const map = new Map<string, Delta>();
  for (const r of rows) {
    const bucket = bucketOf(r.created_at);
    const key = `${r.funnel_id}\u0000${bucket}\u0000${r.step_id}`;
    let d = map.get(key);
    if (!d) map.set(key, (d = { workspace_id: r.workspace_id, funnel_id: r.funnel_id, step_id: r.step_id, bucket, page_views: 0, unique_views: 0, optins: 0, orders: 0, cents: 0 }));
    if (r.type === 'page_view') {
      d.page_views++;
      if (r.unique_visit === 1) d.unique_views++;
    } else if (r.type === 'optin') d.optins++;
    else {
      d.orders++;
      d.cents += r.amount_cents;
    }
  }
  // One fixed order for every writer, so concurrent batches touching the same buckets cannot deadlock.
  return [...map.values()].sort((a, b) => (a.funnel_id + a.bucket + a.step_id < b.funnel_id + b.bucket + b.step_id ? -1 : 1));
}

const keyOf = (r: Pick<EventInsert, 'funnel_id' | 'step_id' | 'visitor_id'>) => `${r.funnel_id}\u0000${r.step_id}\u0000${r.visitor_id}`;

/**
 * The single write path for `events`. In one transaction, for a batch:
 *  1. external ids (opt-in `externalId`, `order:<id>`) are claimed in `event_dedupe` (`ON CONFLICT DO NOTHING RETURNING`); a row whose id was
 *     already claimed, in this batch or earlier, is dropped. This is the idempotency boundary, and it works across partitions and processes;
 *  2. with `decideUnique`, the first page view of a (funnel, step, visitor) is claimed in `visitor_steps` the same way, and only that row gets
 *     `unique_visit = 1` (so two replicas cannot both count a first view, which the old in-memory check could not promise);
 *  3. the rows are inserted and the inserted ones are added to `event_rollups`, one upsert per bucket.
 * Keys are claimed in sorted order so concurrent batches cannot deadlock on each other's uncommitted keys. Must run on a transaction handle.
 * Returns the ids that were inserted; `opts.collect` receives the rows that were stored (with their final `unique_visit`).
 */
export async function insertEvents(tx: Db, rows: EventInsert[], opts: { decideUnique?: boolean; collect?: EventInsert[] } = {}): Promise<Set<string>> {
  let work = rows;

  const withExternal = work.filter((r) => r.external_id);
  if (withExternal.length) {
    const claimed = new Set<string>();
    const sorted = [...new Map(withExternal.map((r) => [`${r.funnel_id}\u0000${r.type}\u0000${r.external_id}`, r])).values()].sort((a, b) => (`${a.funnel_id}${a.type}${a.external_id}` < `${b.funnel_id}${b.type}${b.external_id}` ? -1 : 1));
    for (let i = 0; i < sorted.length; i += CHUNK) {
      const chunk = sorted.slice(i, i + CHUNK);
      const got = await tx.all<{ funnel_id: string; type: string; external_id: string }>(
        `INSERT INTO event_dedupe (funnel_id, type, external_id, created_at) VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(', ')}${tx.dialect.onConflictDoNothing()}${tx.dialect.returning('funnel_id, type, external_id')}`,
        ...chunk.flatMap((r) => [r.funnel_id, r.type, r.external_id!, r.created_at]),
      );
      for (const g of got) claimed.add(`${g.funnel_id}\u0000${g.type}\u0000${g.external_id}`);
    }
    work = work.filter((r) => {
      if (!r.external_id) return true;
      const k = `${r.funnel_id}\u0000${r.type}\u0000${r.external_id}`;
      return claimed.delete(k); // the first row of a claimed key wins; a later row with the same key is a duplicate
    });
  }

  if (opts.decideUnique) {
    const first = new Map<string, EventInsert>();
    for (const r of work) if (r.type === 'page_view' && r.visitor_id && !first.has(keyOf(r))) first.set(keyOf(r), r);
    const fresh = new Set<string>();
    const sorted = [...first.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    for (let i = 0; i < sorted.length; i += CHUNK) {
      const chunk = sorted.slice(i, i + CHUNK);
      const got = await tx.all<{ funnel_id: string; step_id: string; visitor_id: string }>(
        `INSERT INTO visitor_steps (funnel_id, step_id, visitor_id, first_seen) VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(', ')}${tx.dialect.onConflictDoNothing()}${tx.dialect.returning('funnel_id, step_id, visitor_id')}`,
        ...chunk.flatMap(([, r]) => [r.funnel_id, r.step_id, r.visitor_id!, r.created_at]),
      );
      for (const g of got) fresh.add(keyOf(g));
    }
    work = work.map((r) => {
      if (r.type !== 'page_view' || !r.visitor_id) return r;
      const isFirst = first.get(keyOf(r)) === r && fresh.has(keyOf(r));
      return { ...r, unique_visit: isFirst ? 1 : 0 };
    });
  }

  const inserted = new Set<string>();
  for (let i = 0; i < work.length; i += CHUNK) {
    const chunk = work.slice(i, i + CHUNK);
    const one = `(${COLUMNS.map(() => '?').join(', ')})`;
    const got = await tx.all<{ id: string }>(
      `INSERT INTO events (${COLUMNS.join(', ')}) VALUES ${chunk.map(() => one).join(', ')}${tx.dialect.onConflictDoNothing()}${tx.dialect.returning('id')}`,
      ...chunk.flatMap((r) => COLUMNS.map((c) => r[c] ?? null)),
    );
    for (const g of got) inserted.add(g.id);
  }
  // The same id twice in one batch (a redelivered queue message next to its original) inserts once; count it once too.
  const counted = new Set<string>();
  const stored = work.filter((r) => inserted.has(r.id) && !counted.has(r.id) && counted.add(r.id));
  opts.collect?.push(...stored);
  await updateSketches(tx, stored);
  const deltas = aggregate(stored);
  for (let i = 0; i < deltas.length; i += CHUNK) {
    const chunk = deltas.slice(i, i + CHUNK);
    const set = ['page_views', 'unique_views', 'optins', 'orders', 'cents'].map((c) => `${c} = event_rollups.${c} + excluded.${c}`).join(', ');
    await tx.run(
      `INSERT INTO event_rollups (workspace_id, funnel_id, step_id, bucket, page_views, unique_views, optins, orders, cents) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}${tx.dialect.upsert(['funnel_id', 'bucket', 'step_id'], set)}`,
      ...chunk.flatMap((d) => [d.workspace_id, d.funnel_id, d.step_id, d.bucket, d.page_views, d.unique_views, d.optins, d.orders, d.cents]),
    );
  }
  return inserted;
}

/**
 * Adds the page-view visitors of a batch to the per-funnel, per-UTC-day HyperLogLog sketches. Rows are created empty first (`DO NOTHING`), then
 * locked in key order and rewritten, so concurrent batches serialise on a sketch instead of overwriting each other's additions.
 */
async function updateSketches(tx: Db, rows: EventInsert[]): Promise<void> {
  const groups = new Map<string, { funnel: string; day: string; ids: Set<string> }>();
  for (const r of rows) {
    if (r.type !== 'page_view' || !r.visitor_id) continue;
    const day = r.created_at.slice(0, 10);
    const k = `${r.funnel_id}\u0000${day}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { funnel: r.funnel_id, day, ids: new Set() }));
    g.ids.add(r.visitor_id);
  }
  const keys = [...groups.values()].sort((a, b) => (a.funnel + a.day < b.funnel + b.day ? -1 : 1));
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const pairs = chunk.map(() => '(?, ?)').join(', ');
    const flat = chunk.flatMap((g) => [g.funnel, g.day]);
    await tx.run(`INSERT INTO visitor_sketches (funnel_id, day, regs) VALUES ${chunk.map(() => "(?, ?, '')").join(', ')}${tx.dialect.onConflictDoNothing()}`, ...flat);
    const existing = await tx.all<{ funnel_id: string; day: string; regs: string }>(`SELECT funnel_id, day, regs FROM visitor_sketches WHERE (funnel_id, day) IN (${pairs}) ORDER BY funnel_id, day${tx.dialect.forUpdate()}`, ...flat);
    for (const e of existing) {
      const g = groups.get(`${e.funnel_id}\u0000${e.day}`)!;
      const h = e.regs ? HyperLogLog.deserialize(e.regs) : new HyperLogLog();
      for (const id of g.ids) h.add(id);
      await tx.run('UPDATE visitor_sketches SET regs = ? WHERE funnel_id = ? AND day = ?', h.serialize(), e.funnel_id, e.day);
    }
  }
}
