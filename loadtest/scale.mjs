// Scale-out and correctness harness for event ingestion: N built server processes + shared Redis + a real PostgreSQL, load from this process, then verify the database.
//
//   node loadtest/scale.mjs --nodes 2 --queue on --seconds 20 --conc 64 [--kill] [--tenants 8] [--out results/x.json]
//
// Needs: server/dist built (npm run build), TEST_PG_URL (a PostgreSQL server you may create databases on; default postgres://postgres@127.0.0.1:54330/postgres),
// redis-server on PATH (a private instance on a free port is started and killed again; it never touches REDIS_URL of anything else), autocannon (loadtest/node_modules).
// What it checks, not just how fast: every 202 the load generator saw must be exactly one row in `events` (no loss, no duplicate) and the rollups must equal the rows,
// also with --kill (SIGKILL of node 2 mid-load; only requests answered 202 by a live node count). `--queue off` shows the in-process buffer for comparison.
import autocannon from 'autocannon';
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? (args[i + 1]?.startsWith('--') || args[i + 1] === undefined ? true : args[i + 1]) : d; };
const NODES = Number(opt('nodes', 1)), QUEUE = opt('queue', 'on') === 'on', SECONDS = Number(opt('seconds', 15)), CONC = Number(opt('conc', 64)), TENANTS = Number(opt('tenants', 8)), KILL = !!opt('kill', false), WORKERS = 1;
const OUT = opt('out', null);
const RATE = Number(opt('rate', 0)); // requests/s per node (0 = as fast as possible); a soak uses a steady rate
const SAMPLE_S = Number(opt('sample', 0)); // seconds between RSS/heap/lag samples (soak)
const root = fileURLToPath(new URL('..', import.meta.url));
const requireServer = createRequire(join(root, 'server/package.json'));
const { Client } = requireServer('pg');
const PG_URL = process.env.TEST_PG_URL ?? 'postgres://postgres@127.0.0.1:54330/postgres';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const procs = [];
const cleanup = () => { for (const p of procs) try { p.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(1); });

const redisPort = await freePort();
const redis = spawn('redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--loglevel', 'warning'], { stdio: 'ignore' });
procs.push(redis);
await sleep(500);

const dbName = `scale_${Date.now()}`;
const admin = new Client({ connectionString: PG_URL });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
const dbUrl = new URL(PG_URL); dbUrl.pathname = `/${dbName}`;
const db = new Client({ connectionString: dbUrl.toString() });

const ports = await Promise.all(Array.from({ length: NODES }, freePort));
const env = (port) => ({ ...process.env, NODE_ENV: 'production', JWT_SECRET: 'scale-secret-scale-secret-scale-secret-1', PORT: String(port), DATABASE_URL: dbUrl.toString(), DATABASE_POOL_MAX: '10', REDIS_URL: `redis://127.0.0.1:${redisPort}`, EVENT_BUS: 'redis', INGEST_QUEUE: QUEUE ? 'true' : 'false', LOG_LEVEL: 'error', TRUST_PROXY: 'true', PUBLIC_EVENTS_PER_MINUTE: '1000000000', IP_GUARD_PER_MINUTE: '1000000000', API_USER_PER_MINUTE: '1000000000', API_WORKSPACE_PER_MINUTE: '1000000000', ...(process.env.LOAD_ENV ? JSON.parse(process.env.LOAD_ENV) : {}) });
const nodes = ports.map((port) => ({ port, proc: spawn('node', [join(root, 'server/dist/index.js')], { env: env(port), stdio: ['ignore', 'ignore', 'inherit'] }), alive: true }));
nodes.forEach((n) => procs.push(n.proc));
const base = (n) => `http://127.0.0.1:${n.port}`;
for (const n of nodes) { for (let i = 0; i < 300; i++) { try { if ((await fetch(base(n) + '/healthz')).ok) break; } catch {} await sleep(100); } }
await db.connect();

const j = async (n, method, path, body, token) => (await fetch(base(n) + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
const { token } = await j(nodes[0], 'POST', '/api/auth/register', { email: 'scale@example.test', password: 'scale-test-password', name: 'Scale' });
const funnels = [];
for (let i = 0; i < TENANTS; i++) { const f = await j(nodes[0], 'POST', '/api/funnels', { name: `T${i}`, base_path: `/t${i}` }, token); funnels.push({ id: f.id, step: f.steps[0].id }); }

const rssMb = (pid) => Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024;
const cpuMs = (pid) => { const [m, s] = execSync(`ps -o time= -p ${pid}`).toString().trim().split(':'); return (Number(m) * 60 + Number(s)) * 1000; };
const cpu0 = nodes.map((n) => cpuMs(n.proc.pid));
const loadStart = Date.now();
const loadAvgAtStart = loadavg();
// One autocannon instance (one thread) per node; the body is generated per request (unique visitor per request, tenants round-robin).
// Several instances: autocannon's `workers` mode cannot take per-request functions.
const runs = nodes.map((n) => {
  let c = 0;
  return autocannon({
    url: base(n), connections: Math.ceil(CONC / NODES), duration: SECONDS, timeout: 20, ...(RATE ? { overallRate: RATE } : {}),
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/120' },
    requests: [{ method: 'POST', path: '/api/public/events', setupRequest: (req) => { const f = funnels[c++ % funnels.length]; return { ...req, body: JSON.stringify({ funnelId: f.id, stepId: f.step, type: 'page_view', visitorId: `n${n.port}-${c}` }) }; } }],
  });
});
const series = [];
const sampler = SAMPLE_S ? setInterval(async () => {
  try {
    const t = Math.round((Date.now() - loadStart) / 1000);
    const lagM = await (await fetch(base(nodes.find((x) => x.alive)) + '/metrics')).text();
    const g = (name) => Number(lagM.match(new RegExp(`^${name} ([0-9.e+]+)`, 'm'))?.[1] ?? NaN);
    series.push({ t_s: t, rss_mb: nodes.filter((x) => x.alive).map((x) => Math.round(rssMb(x.proc.pid))), heap_mb: Math.round(g('nodejs_heap_size_used_bytes') / 1e6), loop_lag_p99_ms: Math.round(g('nodejs_eventloop_lag_p99_seconds') * 1000), gc_s_total: Math.round(g('nodejs_gc_duration_seconds_sum') * 100) / 100, queue_lag: g('funnels_ingest_queue_lag') });
  } catch {}
}, SAMPLE_S * 1000) : null;
let killedAt = null;
if (KILL && NODES >= 2) setTimeout(() => { nodes[1].proc.kill('SIGKILL'); nodes[1].alive = false; killedAt = (Date.now() - loadStart) / 1000; }, SECONDS * 400);
const results = await Promise.all(runs);
if (sampler) clearInterval(sampler);
if (process.env.DEBUG_LOAD) console.error(JSON.stringify(results.map((r) => ({ ...r, latency: undefined, throughput: undefined, requests: undefined })), null, 1));
const loadSecs = (Date.now() - loadStart) / 1000;
const rss = nodes.filter((n) => n.alive).map((n) => Math.round(rssMb(n.proc.pid)));
const cpu = nodes.map((n, i) => (n.alive ? cpuMs(n.proc.pid) - cpu0[i] : null));
const accepted = results.reduce((a, r) => a + r['2xx'], 0);
const non2xx = results.reduce((a, r) => a + r.non2xx, 0);
const errors = results.reduce((a, r) => a + r.errors, 0);
const p = (k) => Math.max(...results.map((r) => r.latency[k]));

// drain: how long until the database has everything that was accepted
const drainStart = Date.now();
let rows = 0, last = -1, lastAt = Date.now();
for (;;) {
  rows = Number((await db.query('SELECT COUNT(*) AS n FROM events')).rows[0].n);
  if (rows >= accepted) break;
  if (rows !== last) { last = rows; lastAt = Date.now(); }
  if (Date.now() - lastAt > 20_000) break; // no progress for 20 s
  await sleep(250);
}
const drainSecs = (Date.now() - drainStart) / 1000;
const distinct = Number((await db.query('SELECT COUNT(DISTINCT visitor_id) AS n FROM events')).rows[0].n); // one unique visitor per request, so rows must equal distinct visitors
const rollup = Number((await db.query('SELECT COALESCE(SUM(page_views),0) AS n FROM event_rollups')).rows[0].n);
const live = nodes.find((n) => n.alive);
const metrics = await (await fetch(base(live) + '/metrics')).text();
const metric = (name) => Number(metrics.match(new RegExp(`^${name} ([0-9.e+]+)`, 'm'))?.[1] ?? NaN);
const out = {
  when: new Date().toISOString(), nodes: NODES, queue: QUEUE, tenants: TENANTS, conc: CONC, seconds: SECONDS, kill: KILL && NODES >= 2 ? { killedNode: 2, atSecond: killedAt } : null,
  accepted_2xx: accepted, non2xx, connection_errors: errors, accepted_per_s: Math.round(accepted / loadSecs), p50_ms: p('p50'), p99_ms: p('p99'),
  rows_in_db: rows, distinct_visitors: distinct, rollup_page_views: rollup, lost: Math.max(0, accepted - rows), rows_beyond_acked: Math.max(0, rows - accepted) /* requests in flight when the generator stopped: written, response not counted; at most conc */, duplicated: rows - distinct, rollup_mismatch: rollup - rows,
  drain_s_after_load: Math.round(drainSecs * 10) / 10, db_write_per_s_overall: Math.round(rows / (loadSecs + drainSecs)),
  server_cpu_ms_per_1k_accepted: cpu.map((c) => (c === null ? null : Math.round((c / Math.max(1, accepted / NODES)) * 1000))), rss_mb: rss, ingest_queue_lag_end: metric('funnels_ingest_queue_lag'),
  load_average_at_start: loadAvgAtStart.map((x) => Math.round(x * 10) / 10),
  rss_series: series.length ? series : undefined,
  machine: `${execSync('sysctl -n machdep.cpu.brand_string').toString().trim()}, ${execSync('sysctl -n hw.ncpu').toString().trim()} cores (load generator, servers, Redis and PostgreSQL share them)`,
};
console.log(JSON.stringify(out));
if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(out, null, 2)); }
await db.end();
for (const n of nodes) if (n.alive) n.proc.kill('SIGTERM'); // graceful: flushes buffers, writes --cpu-prof output when profiling
await sleep(2500);
cleanup();
await sleep(500);
await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
await admin.end();
process.exit(0);
