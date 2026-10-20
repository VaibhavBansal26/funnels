/**
 * Copies stored events from the primary database into ClickHouse (docs/SCALING.md, ADR 0016). Idempotent: ClickHouse deduplicates by event id, and each
 * batch carries a deterministic insert_deduplication_token, so re-running it (or running it while the live mirror is on) is safe.
 *
 *   DATABASE_URL=postgres://... CLICKHOUSE_URL=http://ch:8123 npx tsx scripts/backfill-clickhouse.ts [--from 2026-01-01] [--to 2026-04-01] [--batch 5000] [--dry-run]
 *
 * Keyset pagination on (created_at, id), so memory is bounded by --batch and progress survives a restart: it prints the last position, pass it back as --after-created/--after-id.
 */
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import type { EventInsert } from '../src/services/rollups.js';
import { ClickHouseEventStore } from '../src/store/clickhouse.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dry = process.argv.includes('--dry-run');
const batch = Number(arg('batch') ?? 5000);
const from = arg('from') ? `${arg('from')}T00:00:00.000Z` : '';
const to = arg('to') ? `${arg('to')}T00:00:00.000Z` : '9999-12-31T00:00:00.000Z';

const config = loadConfig();
if (!config.CLICKHOUSE_URL) throw new Error('set CLICKHOUSE_URL');
const db = await openDb({ url: config.DATABASE_URL, sqlitePath: config.DATABASE_PATH, poolMax: 2, prepare: config.DATABASE_PREPARED_STATEMENTS });
const store = new ClickHouseEventStore({ url: config.CLICKHOUSE_URL, database: config.CLICKHOUSE_DATABASE, user: config.CLICKHOUSE_USER, password: config.CLICKHOUSE_PASSWORD });

let afterAt = arg('after-created') ?? from;
let afterId = arg('after-id') ?? '';
let total = 0;
const started = Date.now();
for (;;) {
  const rows = await db.all<EventInsert>(
    `SELECT id, workspace_id, funnel_id, step_id, type, visitor_id, unique_visit, lead_id, order_id, external_id, amount_cents, currency, utm_json, url, created_at
     FROM events WHERE (created_at > ? OR (created_at = ? AND id > ?)) AND created_at < ? ORDER BY created_at, id LIMIT ?`,
    afterAt, afterAt, afterId, to, batch,
  );
  if (!rows.length) break;
  const last = rows[rows.length - 1]!;
  if (!dry) await store.write(rows, { token: `backfill:${rows[0]!.id}:${last.id}:${rows.length}` });
  total += rows.length;
  afterAt = last.created_at;
  afterId = last.id;
  console.log(`${total} rows (${Math.round(total / ((Date.now() - started) / 1000))}/s) last=${afterAt} ${afterId}${dry ? ' [dry run]' : ''}`);
}
console.log(`done: ${total} rows${dry ? ' (dry run, nothing written)' : ''}`);
await db.close();
