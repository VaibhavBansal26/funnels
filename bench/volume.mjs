// Data volume on a REAL PostgreSQL: loads N events into the partitioned `events` table (server-side generate_series, 90 days, 5 funnels x 4 steps), builds rollups and
// sketches the way the app would, then runs the hot analytics queries with EXPLAIN (ANALYZE, BUFFERS) to prove partition pruning and record latencies and sizes.
//   node bench/volume.mjs 10000000   (--reuse=<db> skips the load and re-runs the rollups, sketches and queries on an existing database; --keep keeps the database)        (needs server/dist built; TEST_PG_URL, default postgres://postgres@127.0.0.1:54330/postgres; creates and drops its own database)
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const N = Number(process.argv[2] ?? 10_000_000);
const KEEP = process.argv.includes('--keep') || process.argv.some((a) => a.startsWith('--reuse='));
const REUSE = process.argv.find((a) => a.startsWith('--reuse='))?.split('=')[1];
const root = fileURLToPath(new URL('..', import.meta.url));
const { Client } = createRequire(join(root, 'server/package.json'))('pg');
const { openDb } = await import(pathToFileURL(join(root, 'server/dist/db/index.js')).href);
const { HyperLogLog } = await import(pathToFileURL(join(root, 'server/dist/util/hll.js')).href);
const PG = process.env.TEST_PG_URL ?? 'postgres://postgres@127.0.0.1:54330/postgres';
const name = REUSE ?? `volume_${Date.now()}`;
const admin = new Client({ connectionString: PG }); await admin.connect(); if (!REUSE) await admin.query(`CREATE DATABASE ${name}`);
const url = new URL(PG); url.pathname = `/${name}`;
const app = await openDb({ url: url.toString(), poolMax: 2 }); await app.close(); // migrations
const c = new Client({ connectionString: url.toString() }); await c.connect();
const t0 = Date.now(); const lap = () => Math.round((Date.now() - t0) / 1000);
const q = (s, p) => c.query(s, p);

if (!REUSE) await q(`INSERT INTO workspaces (id, name, created_at) VALUES ('w','w','2026-07-01T00:00:00.000Z')`);
let insertSecs = 0;
if (!REUSE) {
for (let f = 0; f < 5; f++) {
  await q(`INSERT INTO funnels (id, workspace_id, name, base_path, created_at, updated_at) VALUES ('f${f}','w','f${f}','/f${f}','2026-07-01T00:00:00.000Z','2026-07-01T00:00:00.000Z')`);
  for (let s = 0; s < 4; s++) await q(`INSERT INTO steps (id, workspace_id, funnel_id, name, base_path, path_key, position, version, created_at, updated_at) VALUES ('f${f}s${s}','w','f${f}','s','/s${s}','/s${s}',${s},1,'2026-07-01T00:00:00.000Z','2026-07-01T00:00:00.000Z')`);
}
// partitions for the whole 90 days (the app's maintenance job only creates now-1 .. now+3 months)
for (const [m, a, b] of [['2026_07', '2026-07-01', '2026-08-01'], ['2026_08', '2026-08-01', '2026-09-01'], ['2026_09', '2026-09-01', '2026-10-01']]) {
  await q(`CREATE TABLE IF NOT EXISTS events_${m} PARTITION OF events FOR VALUES FROM ('${a}T00:00:00.000Z') TO ('${b}T00:00:00.000Z')`).catch(() => {});
}
const start = Date.parse('2026-07-22T00:00:00Z');
const CH = 1_000_000;
for (let off = 0; off < N; off += CH) {
  const n = Math.min(CH, N - off);
  await q(`INSERT INTO events (id, workspace_id, funnel_id, step_id, type, visitor_id, unique_visit, amount_cents, created_at)
    SELECT 'e' || (${off} + g), 'w', 'f' || (g % 5), 'f' || (g % 5) || 's' || ((g / 5) % 4),
      CASE WHEN g % 97 = 0 THEN 'order' WHEN g % 20 = 0 THEN 'optin' ELSE 'page_view' END,
      'v' || ((${off} + g) % 3000000), CASE WHEN g % 3 = 0 THEN 1 ELSE 0 END, CASE WHEN g % 97 = 0 THEN 4900 ELSE 0 END,
      to_char(to_timestamp(${start / 1000} + ((${off} + g)::float8 / ${N}) * 90 * 86400) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    FROM generate_series(1, ${n}) g`);
  if ((off / CH) % 2 === 1 || off + CH >= N) console.error(`${off + n} events inserted, ${lap()} s`);
}

insertSecs = lap();
}

if (REUSE) await q('TRUNCATE event_rollups, visitor_sketches');
await q(`INSERT INTO event_rollups (workspace_id, funnel_id, step_id, bucket, page_views, unique_views, optins, orders, cents)
  SELECT workspace_id, funnel_id, step_id, substr(created_at,1,14) || lpad(((substr(created_at,15,2)::int / 15) * 15)::text, 2, '0'),
    count(*) FILTER (WHERE type='page_view'), COALESCE(sum(unique_visit) FILTER (WHERE type='page_view'),0), count(*) FILTER (WHERE type='optin'), count(*) FILTER (WHERE type='order'), COALESCE(sum(amount_cents) FILTER (WHERE type='order'),0)
  FROM events GROUP BY 1,2,3,4`);
const rollupRows = Number((await q('SELECT count(*) n FROM event_rollups')).rows[0].n);
// sketches: one per funnel-day from the distinct visitors (what the write path maintains incrementally)
const days = (await q(`SELECT funnel_id, substr(created_at,1,10) d, array_agg(DISTINCT visitor_id) v FROM events WHERE type='page_view' GROUP BY 1,2`)).rows;
for (const r of days) { const h = new HyperLogLog(); for (const v of r.v) h.add(v); await q('INSERT INTO visitor_sketches (funnel_id, day, regs) VALUES ($1,$2,$3)', [r.funnel_id, r.d, h.serialize()]); }
await q('ANALYZE');
const prepSecs = lap() - insertSecs;

const size = async (rel) => (await q(`SELECT pg_total_relation_size('${rel}') s`)).rows[0].s / 1e6;
const parts = (await q(`SELECT c.relname, pg_total_relation_size(c.oid)/1e6 mb FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='events'::regclass ORDER BY 1`)).rows;
const eventsMb = parts.reduce((a, p) => a + Number(p.mb), 0);

async function explain(label, sql, params = []) {
  const runs = [];
  let plan = '';
  for (let i = 0; i < 5; i++) {
    const r = await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params);
    plan = r.rows.map((x) => x['QUERY PLAN']).join('\n');
    runs.push(Number(plan.match(/Execution Time: ([0-9.]+) ms/)[1]));
  }
  runs.sort((a, b) => a - b);
  const scanned = [...new Set([...plan.matchAll(/(?:Seq Scan|Index (?:Only )?Scan|Bitmap Heap Scan)[^\n]* on (events_\w+|event_rollups\w*|visitor_sketches)/g)].map((m) => m[1]))];
  return { label, median_ms: runs[2], min_ms: runs[0], max_ms: runs[4], relations_scanned: scanned, plan };
}
const win = (a, b) => [a, b];
const results = [];
// the three analytics shapes, ranges of 7 / 30 / 90 days, funnel f1, same SQL as services/analytics.ts
for (const [label, from, to] of [['7 days', '2026-10-13T00:00:00.000Z', '2026-10-20T00:00:00.000Z'], ['30 days', '2026-09-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z'], ['90 days', '2026-07-22T00:00:00.000Z', '2026-10-20T00:00:00.000Z']]) {
  results.push(await explain(`per-step totals from rollups, ${label}`, `SELECT step_id, SUM(page_views), SUM(unique_views), SUM(optins), SUM(orders), SUM(cents) FROM event_rollups WHERE funnel_id = 'f1' AND workspace_id = 'w' AND bucket >= '${from.slice(0, 16)}' AND bucket < '${to.slice(0, 16)}' GROUP BY step_id`));
  results.push(await explain(`exact COUNT(DISTINCT visitor), ${label}`, `SELECT COUNT(DISTINCT visitor_id) FROM events WHERE funnel_id = 'f1' AND type = 'page_view' AND created_at >= '${from}' AND created_at < '${to}'`));
  results.push(await explain(`sketch merge input, ${label}`, `SELECT regs FROM visitor_sketches WHERE funnel_id = 'f1' AND day >= '${from.slice(0, 10)}' AND day < '${to.slice(0, 10)}'`));
}
results.push(await explain('keyset page of recent events for one funnel (history list)', `SELECT * FROM events WHERE funnel_id = 'f1' AND created_at < '2026-10-20T00:00:00.000Z' ORDER BY created_at DESC, id DESC LIMIT 50`));
const out = { when: new Date().toISOString(), events: N, insert_s: insertSecs, insert_rows_per_s: Math.round(N / insertSecs), prep_s: prepSecs, rollup_rows: rollupRows, events_total_mb: Math.round(eventsMb), bytes_per_event_incl_indexes: Math.round((eventsMb * 1e6) / N), rollup_mb: Math.round(await size('event_rollups')), sketch_mb: Math.round((await size('visitor_sketches')) * 10) / 10, partitions: parts.map((p) => `${p.relname}: ${Math.round(p.mb)} MB`),
  results: results.map(({ plan, ...r }) => r), pruning_example: results.find((r) => r.label.startsWith('exact COUNT(DISTINCT visitor), 7'))?.plan.split('\n').filter((l) => /events_|Scan|Partition|Subplans/i.test(l)).slice(0, 12) };
console.log(JSON.stringify(out, null, 1));
await c.end();
if (!KEEP) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
await admin.end();
