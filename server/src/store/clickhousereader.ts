import type { Agg, AnalyticsReader, BucketAgg, Distinct, Range, StepAgg } from '../services/analytics.js';
import type { ClickHouseEventStore } from './clickhouse.js';

/**
 * Analytics reads from ClickHouse (`ANALYTICS_READ_STORE=clickhouse`), over the tables defined in deploy/clickhouse/schema.sql: `event_rollups_15m`
 * (SummingMergeTree: rows with one key may not have merged yet, so every read SUMs, which is correct either way) and `events` for distinct visitors.
 *
 * NOT VERIFIED AGAINST A REAL CLICKHOUSE SERVER: no server was available when this was written. The tests run these queries' request construction and response
 * handling against a fake HTTP server that answers from the primary database; the SQL itself (functions, types, timezone handling) is unexecuted until it is
 * run against ClickHouse (docs/CLOUD-LOADTEST.md step 5). The analytics service falls back to the primary on any error, and when the mirror is stale.
 *
 * Every query is parameterised (no value is concatenated into SQL) and filters on workspace_id and funnel_id. Times are passed as ISO-8601 strings with an
 * explicit `Z` and parsed with `parseDateTimeBestEffort(..., 'UTC')`, so the server's time zone setting cannot shift a range.
 */
const ROLLUP = `sum(page_views) AS views, sum(unique_views) AS uniques, sum(optins) AS optins, sum(orders) AS orders, sum(cents) AS cents`;
const FROM_T = `bucket >= parseDateTimeBestEffort({from:String}, 'UTC') AND bucket < parseDateTimeBestEffort({to:String}, 'UTC')`;
const num = (v: unknown) => Number(v ?? 0);
const agg = (r: Record<string, unknown>): Agg => ({ views: num(r.views), uniques: num(r.uniques), optins: num(r.optins), orders: num(r.orders), cents: num(r.cents) });

export class ClickHouseReader implements AnalyticsReader {
  readonly kind = 'clickhouse';
  constructor(private ch: ClickHouseEventStore, private o: { exactMax: number; mode: 'auto' | 'exact' | 'sketch' }) {}

  private p(ws: string, funnelId: string, range: Range, extra: Record<string, string> = {}): Record<string, string> {
    return { ws, f: funnelId, from: range.startUtc, to: range.endUtc, ...extra };
  }

  async stepTotals(ws: string, funnelId: string, range: Range): Promise<StepAgg[]> {
    const rows = await this.ch.query(`SELECT step_id, ${ROLLUP} FROM event_rollups_15m WHERE workspace_id = {ws:String} AND funnel_id = {f:String} AND ${FROM_T} GROUP BY step_id`, this.p(ws, funnelId, range));
    return rows.map((r) => ({ step_id: String(r.step_id), ...agg(r) }));
  }

  async totals(ws: string, funnelId: string, range: Range, stepId?: string): Promise<Agg> {
    const rows = await this.ch.query(
      `SELECT ${ROLLUP} FROM event_rollups_15m WHERE workspace_id = {ws:String} AND funnel_id = {f:String} AND ${FROM_T}${stepId ? ' AND step_id = {s:String}' : ''}`,
      this.p(ws, funnelId, range, stepId ? { s: stepId } : {}),
    );
    return agg(rows[0] ?? {});
  }

  async buckets(ws: string, funnelId: string, range: Range, stepId?: string): Promise<BucketAgg[]> {
    const rows = await this.ch.query(
      `SELECT formatDateTime(bucket, '%Y-%m-%dT%H:%i', 'UTC') AS bucket, ${ROLLUP} FROM event_rollups_15m WHERE workspace_id = {ws:String} AND funnel_id = {f:String} AND ${FROM_T}${stepId ? ' AND step_id = {s:String}' : ''} GROUP BY bucket ORDER BY bucket`,
      this.p(ws, funnelId, range, stepId ? { s: stepId } : {}),
    );
    return rows.map((r) => ({ bucket: String(r.bucket), ...agg(r) }));
  }

  /**
   * Exact (`uniqExact`) up to the same page-view threshold the primary uses, an HLL estimate (`uniqHLL12`, 4,096 registers: 1.04 / sqrt(4096) = 1.6% standard
   * error by HyperLogLog theory) above it. Both scan `events` for the funnel and range; it is columnar and the ordering key starts with funnel_id.
   */
  async distinct(ws: string, funnelId: string, range: Range, totalViews: number): Promise<Distinct> {
    const approximate = this.o.mode === 'sketch' || (this.o.mode === 'auto' && totalViews > this.o.exactMax);
    const fn = approximate ? 'uniqHLL12' : 'uniqExact';
    const rows = await this.ch.query(
      `SELECT ${fn}(visitor_id) AS n FROM events WHERE workspace_id = {ws:String} AND funnel_id = {f:String} AND type = 'page_view' AND visitor_id != '' AND created_at >= parseDateTime64BestEffort({from:String}, 3, 'UTC') AND created_at < parseDateTime64BestEffort({to:String}, 3, 'UTC')`,
      this.p(ws, funnelId, range),
    );
    return approximate ? { value: num(rows[0]?.n), method: 'clickhouse_hll', standardErrorPct: 1.6 } : { value: num(rows[0]?.n), method: 'clickhouse_exact', standardErrorPct: 0 };
  }
}
