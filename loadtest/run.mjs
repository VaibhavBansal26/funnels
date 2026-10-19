// HTTP load scenarios against the BUILT server (server/dist). Usage: node loadtest/run.mjs [seconds]
// Boots the server on a temp database, creates a live funnel on an active domain, then runs each scenario with autocannon.
import autocannon from 'autocannon';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const seconds = Number(process.argv[2] ?? 8);
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'funnels-load-'));
const PORT = 3955;
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'load-test-secret-load-test-secret-123', PORT: String(PORT), DATABASE_PATH: join(dir, 'db.sqlite'), LOG_LEVEL: 'error', TRUST_PROXY: 'true', PUBLIC_EVENTS_PER_MINUTE: '100000000', PUBLIC_FORMS_PER_MINUTE: '100000000', ...(process.env.LOAD_ENV ? JSON.parse(process.env.LOAD_ENV) : {}) };
const server = spawn('node', [join(root, 'server/dist/index.js')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rss = () => Number(execSync(`ps -o rss= -p ${server.pid}`).toString().trim()) / 1024;
const j = async (method, path, body, token) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};

for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await sleep(100); }
const { token } = await j('POST', '/api/auth/register', { email: 'load@example.test', password: 'load-test-password', name: 'Load' });
const dom = await j('POST', '/api/domains', { hostname: 'load.example.com' }, token);
const db = new DatabaseSync(join(dir, 'db.sqlite'));
db.exec(`UPDATE domains SET status = 'active'`); // DNS verification is covered by tests; load runs need an active domain
const funnel = await j('POST', '/api/funnels', { name: 'Load', base_path: '/promo' }, token);
await j('PATCH', `/api/funnels/${funnel.id}`, { domain_id: dom.id, status: 'live' }, token);
const stepId = funnel.steps[0].id;
const page = await j('GET', `/api/funnels/${funnel.id}/steps/${stepId}/page`, undefined, token);
const lead = await j('POST', '/api/templates/lead-magnet/use', undefined, token);
const leadPage = await j('GET', `/api/funnels/${lead.id}/steps/${lead.steps[0].id}/page`, undefined, token);
const formBlock = JSON.stringify(leadPage.doc).match(/"id":"([^"]+)","type":"form"/)?.[1];
const auth = { authorization: `Bearer ${token}` };
const UA = { 'user-agent': 'Mozilla/5.0 Chrome/120' };

let visitor = 0;
const rows = [];
// autocannon mangles per-request bodies, so POST scenarios use a plain fetch loop (keep-alive via undici's global dispatcher).
async function fetchScenario(name, conc, make, note = '') {
  const before = rss();
  const lat = [];
  const codes = {};
  const end = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (Date.now() < end) {
      const { path, body } = make();
      const t = performance.now();
      try {
        const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...UA }, body: JSON.stringify(body) });
        await r.arrayBuffer();
        codes[r.status] = (codes[r.status] ?? 0) + 1;
      } catch { codes.error = (codes.error ?? 0) + 1; }
      lat.push(performance.now() - t);
    }
  }));
  lat.sort((a, b) => a - b);
  const q = (p) => Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] * 10) / 10;
  rows.push({ name, rps: Math.round(lat.length / seconds), p50: q(0.5), p97: q(0.975), p99: q(0.99), max: Math.round(lat[lat.length - 1]), errors: codes.error ?? 0, non2xx: Object.entries(codes).filter(([c]) => !/^2/.test(c)).reduce((n, [, v]) => n + v, 0), codes: Object.entries(codes).map(([c, v]) => `${c}:${v}`).join(' '), rssMb: Math.round(rss()), rssBefore: Math.round(before), note });
}
async function scenario(name, opts, note = '') {
  const before = rss();
  const r = await autocannon({ url: base, duration: seconds, ...opts });
  const codes = Object.entries(r.statusCodeStats ?? {}).map(([c, v]) => `${c}:${v.count}`).join(' ');
  rows.push({ name, rps: Math.round(r.requests.average), p50: r.latency.p50, p97: r.latency.p97_5, p99: r.latency.p99, max: r.latency.max, errors: r.errors + r.timeouts, non2xx: r.non2xx, codes, rssMb: Math.round(rss()), rssBefore: Math.round(before), note });
}

await scenario('public page, edge-cache-less origin hit (64 conn)', { connections: 64, requests: [{ method: 'GET', path: '/promo', headers: { host: 'load.example.com', ...UA } }] });
await scenario('public page, gzip (64 conn)', { connections: 64, requests: [{ method: 'GET', path: '/promo', headers: { host: 'load.example.com', 'accept-encoding': 'gzip', ...UA } }] });
await fetchScenario('page_view event ingestion (64 conc, unique visitors)', 64, () => ({ path: '/api/public/events', body: { funnelId: funnel.id, stepId, type: 'page_view', visitorId: `v${String(++visitor).padStart(12, '0')}` } }));
await scenario('mixed admin: list, analytics, steps (32 conn)', { connections: 32, requests: [
  { method: 'GET', path: '/api/funnels?limit=50', headers: auth }, { method: 'GET', path: `/api/funnels/${funnel.id}/analytics`, headers: auth }, { method: 'GET', path: `/api/funnels/${funnel.id}/steps`, headers: auth }, { method: 'GET', path: '/api/leads', headers: auth },
] });
// Builder save contention: every client saves from the same base version. Policy: optimistic concurrency, losers get 409 + currentVersion.
await scenario('builder save contention, same base version (16 conn)', { connections: 16, requests: [{ method: 'PUT', path: `/api/funnels/${funnel.id}/steps/${stepId}/page`, headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ version: page.version, backup: false, doc: page.doc }) }] }, 'exactly one 200 expected; the rest 409');
await fetchScenario('opt-in form submissions, distinct emails (32 conc)', 32, () => ({ path: `/api/public/forms/${lead.id}/${lead.steps[0].id}/${formBlock}`, body: { consent: true, fields: { name: 'L', email: `lead${++visitor}@example.com`, _consent: true }, submissionId: `sub-${String(visitor).padStart(12, '0')}` } }), 'rate limits raised for the run');
const stats = await j('GET', `/api/funnels/${funnel.id}/analytics`, undefined, token);
const counted = stats.summary.pageViews.all;
const raw = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'page_view'`).get().n;
server.kill('SIGTERM');
await sleep(500);

console.log(`\nmachine: ${execSync('sysctl -n machdep.cpu.brand_string hw.ncpu hw.memsize 2>/dev/null | tr "\\n" " "').toString().trim() || process.platform}; node ${process.version}; ${seconds}s per scenario\n`);
console.log('| scenario | req/s | p50 ms | p97.5 ms | p99 ms | max ms | errors | non-2xx | status codes | RSS MB (before→after) |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.name} | ${r.rps} | ${r.p50} | ${r.p97} | ${r.p99} | ${r.max} | ${r.errors} | ${r.non2xx} | ${r.codes} | ${r.rssBefore}→${r.rssMb} |`);
console.log(`\nevent integrity: analytics reported ${counted} page views, raw table holds ${raw} (must be equal after shutdown flush)`);
const ing = rows.find((r) => r.name.startsWith('page_view'));
console.log(`ingested requests accepted: ${ing?.codes}`);
