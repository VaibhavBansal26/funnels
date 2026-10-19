import type { Db } from '../db/index.js';

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
}

const COLUMNS = ['id', 'workspace_id', 'funnel_id', 'step_id', 'type', 'visitor_id', 'unique_visit', 'lead_id', 'order_id', 'external_id', 'amount_cents', 'currency', 'utm_json', 'url', 'created_at'] as const;
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

/**
 * The single write path for `events`: inserts the rows (duplicates by the dedupe index are skipped) and, in the
 * same transaction, adds the inserted rows to `event_rollups` with one upsert per bucket. Must run on a transaction
 * handle so the two writes commit together. Returns the ids that were actually inserted.
 */
export async function insertEvents(tx: Db, rows: EventInsert[]): Promise<Set<string>> {
  const inserted = new Set<string>();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const one = `(${COLUMNS.map(() => '?').join(', ')})`;
    const got = await tx.all<{ id: string }>(
      `INSERT INTO events (${COLUMNS.join(', ')}) VALUES ${chunk.map(() => one).join(', ')}${tx.dialect.onConflictDoNothing()}${tx.dialect.returning('id')}`,
      ...chunk.flatMap((r) => COLUMNS.map((c) => r[c])),
    );
    for (const g of got) inserted.add(g.id);
  }
  const deltas = aggregate(rows.filter((r) => inserted.has(r.id)));
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
