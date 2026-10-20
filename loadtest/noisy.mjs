// Noisy-neighbour test on the real stack: 2 server processes + private Redis + real PostgreSQL, 10 workspaces. Phase A: nine normal tenants alone.
// Phase B: the same nine plus tenant 0 flooding at about 100x one normal tenant's rate. Reports per-tenant acceptance and accept latency, the heavy tenant's
// 202/429 split, the time until every accepted event is in the database, and verifies rows == acknowledged per tenant.
//   node loadtest/noisy.mjs --seconds 15 --normal-rate 40 --quota 60000 [--out loadtest/results/noisy.json]
import autocannon from 'autocannon';
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const SECONDS = Number(opt('seconds', 15)), NORMAL_RATE = Number(opt('normal-rate', 40)), QUOTA = opt('quota', '60000'), OUT = opt('out', null), NODES = 2, TENANTS = 10;
const root = fileURLToPath(new URL('..', import.meta.url));
const { Client } = createRequire(join(root, 'server/package.json'))('pg');
const PG_URL = process.env.TEST_PG_URL ?? 'postgres://postgres@127.0.0.1:54330/postgres';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const procs = [];
const cleanup = () => { for (const p of procs) try { p.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

const redisPort = await freePort();
procs.push(spawn('redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--loglevel', 'warning'], { stdio: 'ignore' }));
await sleep(500);
const dbName = `noisy_${Date.now()}`;
const admin = new Client({ connectionString: PG_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
const dbUrl = new URL(PG_URL); dbUrl.pathname = `/${dbName}`;
const db = new Client({ connectionString: dbUrl.toString() });
const ports = await Promise.all(Array.from({ length: NODES }, freePort));
const env = (port) => ({ ...process.env, NODE_ENV: 'production', JWT_SECRET: 'noisy-secret-noisy-secret-noisy-secret-1', PORT: String(port), DATABASE_URL: dbUrl.toString(), DATABASE_POOL_MAX: '10', REDIS_URL: `redis://127.0.0.1:${redisPort}`, EVENT_BUS: 'redis', INGEST_QUEUE: 'true', INGEST_WORKSPACE_PER_MINUTE: QUOTA, LOG_LEVEL: 'error', TRUST_PROXY: 'true', PUBLIC_EVENTS_PER_MINUTE: '1000000000', IP_GUARD_PER_MINUTE: '1000000000', API_USER_PER_MINUTE: '1000000000', API_WORKSPACE_PER_MINUTE: '1000000000' });
const nodes = ports.map((port) => { const p = spawn('node', [join(root, 'server/dist/index.js')], { env: env(port), stdio: ['ignore', 'ignore', 'inherit'] }); procs.push(p); return { port, proc: p }; });
const base = (n) => `http://127.0.0.1:${n.port}`;
for (const n of nodes) for (let i = 0; i < 300; i++) { try { if ((await fetch(base(n) + '/healthz')).ok) break; } catch {} await sleep(100); }
await db.connect();
const j = async (n, method, path, body, token) => (await fetch(base(n) + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
const tenants = [];
for (let i = 0; i < TENANTS; i++) {
  const { token } = await j(nodes[0], 'POST', '/api/auth/register', { email: `t${i}@example.test`, password: 'noisy-test-password', name: `T${i}` });
  const f = await j(nodes[0], 'POST', '/api/funnels', { name: `T${i}`, base_path: `/t${i}` }, token);
  tenants.push({ i, funnelId: f.id, stepId: f.steps[0].id, node: nodes[i % NODES] });
}

async function phase(label, withHeavy) {
  const t0 = new Date();
  const runs = tenants.filter((t) => withHeavy || t.i > 0).map((t) => {
    let c = 0;
    const heavy = t.i === 0;
    return autocannon({
      url: base(t.node), connections: heavy ? 48 : 2, duration: SECONDS, timeout: 20, ...(heavy ? {} : { overallRate: NORMAL_RATE }),
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/120' },
      requests: [{ method: 'POST', path: '/api/public/events', setupRequest: (req) => ({ ...req, body: JSON.stringify({ funnelId: t.funnelId, stepId: t.stepId, type: 'page_view', visitorId: `${label}-t${t.i}-${++c}` }) }) }],
    }).then((r) => ({ tenant: t.i, sent: r.requests.total, ok: r['2xx'], limited: r.non2xx, errors: r.errors + r.timeouts, p50: r.latency.p50, p99: r.latency.p99, rps: Math.round(r.requests.average) }));
  });
  const res = await Promise.all(runs);
  // wait for the consumers to write everything that was acknowledged
  const acked = Object.fromEntries(res.map((r) => [r.tenant, r.ok]));
  const start = Date.now(); let rows = {};
  for (;;) {
    rows = Object.fromEntries((await db.query(`SELECT funnel_id, count(*)::int n FROM events WHERE visitor_id LIKE $1 GROUP BY 1`, [`${label}-%`])).rows.map((r) => [tenants.find((t) => t.funnelId === r.funnel_id).i, r.n]));
    if (res.every((r) => (rows[r.tenant] ?? 0) >= acked[r.tenant]) || Date.now() - start > 30000) break;
    await sleep(200);
  }
  const normal = res.filter((r) => r.tenant > 0);
  const sum = (k) => normal.reduce((a, r) => a + r[k], 0);
  return {
    label, withHeavy, load_average_at_start: loadavg().map((x) => Math.round(x * 10) / 10), drain_s: Math.round((Date.now() - start) / 100) / 10,
    normal_tenants: { requests: sum('sent'), accepted_202: sum('ok'), refused_429: sum('limited'), errors: sum('errors'), p50_ms_median: normal.map((r) => r.p50).sort((a, b) => a - b)[4], p99_ms_worst: Math.max(...normal.map((r) => r.p99)), p99_ms_median: normal.map((r) => r.p99).sort((a, b) => a - b)[4] },
    heavy_tenant: res.find((r) => r.tenant === 0) ?? null,
    rows_match_acknowledged: res.map((r) => ({ tenant: r.tenant, acked: r.ok, rows: rows[r.tenant] ?? 0 })).every((x) => x.rows >= x.acked && x.rows - x.acked <= 64), 
    lost: res.reduce((a, r) => a + Math.max(0, r.ok - (rows[r.tenant] ?? 0)), 0),
  };
}
const A = await phase('A', false);
const B = await phase('B', true);
const C = await phase('C', false); // baseline again: how much of A-vs-B is just machine noise
const out = { when: new Date().toISOString(), nodes: NODES, tenants: TENANTS, quota_per_min_free_plan: Number(QUOTA), burst: Math.ceil(Number(QUOTA) / 60), normal_rate_per_tenant: NORMAL_RATE, seconds: SECONDS, baseline_before: A, with_noisy_neighbour: B, baseline_after: C, machine: `${execSync('sysctl -n machdep.cpu.brand_string').toString().trim()}, ${execSync('sysctl -n hw.ncpu').toString().trim()} cores shared with load generator, servers, Redis and PostgreSQL` };
console.log(JSON.stringify(out, null, 1));
if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(out, null, 2)); }
await db.end(); for (const n of nodes) n.proc.kill('SIGTERM'); await sleep(1500); cleanup(); await sleep(300);
await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await admin.end(); process.exit(0);
