// Isolated ingestion benchmark against the BUILT server (server/dist), fixed request count so every run
// sees identical data volume. Usage: node bench/ingest.mjs [requests=30000] [concurrency=64] [--drop=trigger1,trigger2]
// --drop removes SQLite triggers (only meaningful for builds that still have them) to measure their cost.
// Prints one JSON line: req/s, latency percentiles and server CPU milliseconds per 1000 requests (client-independent).
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const args = process.argv.slice(2);
const flag = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const [N, CONC] = [Number(args.find((a) => /^\d+$/.test(a)) ?? 30000), Number(args.filter((a) => /^\d+$/.test(a))[1] ?? 64)];
const drop = (flag('drop') ?? '').split(',').filter(Boolean);
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'funnels-ingest-'));
const dbPath = join(dir, 'db.sqlite');
const PORT = 3960 + Math.floor(Math.random() * 30);
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'bench-secret-bench-secret-bench-secret-1', PORT: String(PORT), DATABASE_PATH: dbPath, LOG_LEVEL: 'error', TRUST_PROXY: 'true', PUBLIC_EVENTS_PER_MINUTE: '100000000' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const boot = async () => {
  const s = spawn('node', [join(root, 'server/dist/index.js')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) return s; } catch {} await sleep(100); }
  throw new Error('server did not start');
};
const j = async (method, path, body, token) => (await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
const cpuMs = (pid) => { const t = execSync(`ps -o time= -p ${pid}`).toString().trim(); const [m, s] = t.split(':'); return (Number(m) * 60 + Number(s)) * 1000; };

let server = await boot();
const { token } = await j('POST', '/api/auth/register', { email: 'b@example.test', password: 'bench-password', name: 'B' });
const funnel = await j('POST', '/api/funnels', { name: 'Bench', base_path: '/b' }, token);
const stepId = funnel.steps[0].id;
if (drop.length) {
  server.kill('SIGTERM'); await sleep(500);
  const db = new DatabaseSync(dbPath);
  for (const t of drop) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  db.close();
  server = await boot();
}
const UA = { 'user-agent': 'Mozilla/5.0 Chrome/120', 'content-type': 'application/json' };
let next = 0;
const lat = [];
let bad = 0;
const cpu0 = cpuMs(server.pid);
const t0 = performance.now();
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < N) {
    const i = next++;
    const t = performance.now();
    const r = await fetch(base + '/api/public/events', { method: 'POST', headers: UA, body: JSON.stringify({ funnelId: funnel.id, stepId, type: 'page_view', visitorId: `v${String(i).padStart(12, '0')}` }) });
    await r.arrayBuffer();
    if (r.status !== 202) bad++;
    lat.push(performance.now() - t);
  }
}));
const secs = (performance.now() - t0) / 1000;
const cpu = cpuMs(server.pid) - cpu0;
lat.sort((a, b) => a - b);
const q = (p) => Math.round(lat[Math.floor(lat.length * p)] * 10) / 10;
const analytics = await j('GET', `/api/funnels/${funnel.id}/analytics`, undefined, token);
server.kill('SIGTERM'); await sleep(500);
console.log(JSON.stringify({ drop: drop.join('+') || 'none', requests: N, conc: CONC, rps: Math.round(N / secs), p50: q(0.5), p99: q(0.99), serverCpuMsPer1k: Math.round((cpu / N) * 1000), bad, counted: analytics.summary.pageViews.all }));
