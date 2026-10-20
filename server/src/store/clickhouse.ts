import type { EventInsert } from '../services/rollups.js';
import type { EventStore } from './eventstore.js';

export interface ClickHouseOptions {
  /** HTTP interface, e.g. http://clickhouse:8123 */
  url: string;
  database: string;
  user?: string;
  password?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** One row in ClickHouse JSONEachRow form. Nullable app columns become empty strings (the schema uses non-Nullable columns, which are much faster). */
export function toClickHouseRow(r: EventInsert): Record<string, string | number> {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    funnel_id: r.funnel_id,
    step_id: r.step_id,
    type: r.type,
    visitor_id: r.visitor_id ?? '',
    unique_visit: r.unique_visit,
    lead_id: r.lead_id ?? '',
    order_id: r.order_id ?? '',
    external_id: r.external_id ?? '',
    amount_cents: r.amount_cents,
    currency: r.currency ?? '',
    utm_json: r.utm_json ?? '',
    url: r.url ?? '',
    device: r.device ?? '',
    country: r.country ?? '',
    referrer_host: r.referrer_host ?? '',
    created_at: r.created_at.replace('T', ' ').replace('Z', ''), // DateTime64(3, 'UTC') accepts 'YYYY-MM-DD hh:mm:ss.fff'
  };
}

/**
 * Secondary event store on ClickHouse over its HTTP interface (no driver dependency). Schema and materialised views: deploy/clickhouse/schema.sql.
 *
 * Idempotency: `events` is a ReplacingMergeTree keyed by (funnel_id, type, hour, id), so a replayed event collapses at merge time (queries use `FINAL` or
 * `argMax`); the rollup tables are fed by materialised views, which see every INSERT block, so a replay would double count unless the block is dropped.
 * Every write therefore carries `insert_deduplication_token` (the outbox event id, stable across replays) and the tables set
 * `non_replicated_deduplication_window`, which makes ClickHouse discard an identical block it has already seen.
 *
 * NOT VERIFIED AGAINST A REAL CLICKHOUSE SERVER in this repository's test environment (none was available); the unit tests exercise the wire format against a fake
 * HTTP server. See docs/CLOUD-LOADTEST.md for the validation steps.
 */
export class ClickHouseEventStore implements EventStore {
  readonly kind = 'clickhouse';
  private f: typeof fetch;
  constructor(private o: ClickHouseOptions) {
    this.f = o.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/x-ndjson' };
    if (this.o.user) h['x-clickhouse-user'] = this.o.user;
    if (this.o.password) h['x-clickhouse-key'] = this.o.password;
    return h;
  }

  async write(rows: EventInsert[], opts: { token?: string } = {}): Promise<EventInsert[]> {
    if (!rows.length) return [];
    const params = new URLSearchParams({ query: 'INSERT INTO events FORMAT JSONEachRow', database: this.o.database, input_format_skip_unknown_fields: '1', date_time_input_format: 'best_effort' });
    if (opts.token) {
      params.set('insert_deduplication_token', opts.token);
      params.set('deduplicate_blocks_in_dependent_materialized_views', '1');
    }
    const res = await this.f(`${this.o.url.replace(/\/$/, '')}/?${params}`, {
      method: 'POST',
      headers: this.headers(),
      body: rows.map((r) => JSON.stringify(toClickHouseRow(r))).join('\n'),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
    });
    if (!res.ok) throw new Error(`clickhouse insert failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return rows;
  }

  /**
   * Runs a read query and returns the JSON rows. Values go through ClickHouse query parameters (`{name:Type}` in the SQL, sent as `param_name`), never through
   * string concatenation, so ids and dates from a request cannot change the statement. 64-bit integers are returned as numbers (counts here are far below 2^53).
   */
  async query<T = Record<string, unknown>>(sql: string, values: Record<string, string> = {}): Promise<T[]> {
    const params = new URLSearchParams({ database: this.o.database, default_format: 'JSON', output_format_json_quote_64bit_integers: '0', readonly: '1' });
    for (const [k, v] of Object.entries(values)) params.set(`param_${k}`, v);
    const res = await this.f(`${this.o.url.replace(/\/$/, '')}/?${params}`, { method: 'POST', headers: this.headers(), body: sql, signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000) });
    if (!res.ok) throw new Error(`clickhouse query failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return ((await res.json()) as { data: T[] }).data;
  }

  async close() {}
}
