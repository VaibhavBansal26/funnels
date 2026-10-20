// Bounded-memory check for the analytics export: seeds N events through the production write path, then pages the whole export (limit 20000, following X-Next-Cursor)
// and reports rows/s and the memory high-water mark per page. Memory must stay flat however many events exist: a page is `limit` rows, never the table.
//   node bench/export.mjs [events=300000]
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = (f) => import(pathToFileURL(join(root, 'server/dist', f)).href);
const N = Number(process.argv[2] ?? 300000);
process.env.DATABASE_PATH = ':memory:'; process.env.JWT_SECRET = 'bench-secret-bench-secret-bench-secret-1'; process.env.LOG_LEVEL = 'silent';
process.env.ANALYTICS_EXPORT_PER_MINUTE = '1000000'; process.env.ANALYTICS_API_PER_MINUTE = '1000000'; process.env.IP_GUARD_PER_MINUTE = '100000000'; process.env.API_USER_PER_MINUTE = '1000000'; process.env.API_WORKSPACE_PER_MINUTE = '1000000'; process.env.AUTH_ATTEMPTS_PER_MINUTE = '100000'; process.env.EVENT_BUFFER_MS = '0';
const { createApp } = await dist('app.js'); const { createDeps } = await dist('bootstrap.js'); const { loadConfig } = await dist('config.js'); const { insertEvents } = await dist('services/rollups.js');
const deps = await createDeps(loadConfig()); const app = createApp(deps);
const j = async (m, p, b, t) => (await app.request(p, { method: m, headers: { 'content-type': 'application/json', 'user-agent': 'bench', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined })).json();
const reg = await j('POST', '/api/auth/register', { email: 'b@example.test', password: 'bench-password', name: 'B' });
const f = await j('POST', '/api/funnels', { name: 'Bench', base_path: '/b' }, reg.token);
await deps.db.run("UPDATE funnels SET status = 'live'"); // a live key sees live funnels
const key = (await j('POST', '/api/v1/api-keys', { name: 'bench', scopes: ['analytics:export'] }, reg.token)).key;
const step = f.steps[0].id, ws = reg.workspace.id, base = Date.parse('2026-03-01T00:00:00Z');
let t0 = performance.now();
for (let off = 0; off < N; off += 5000) {
  const rows = Array.from({ length: Math.min(5000, N - off) }, (_, i) => ({ id: `evt_${String(off + i).padStart(10, '0')}`, workspace_id: ws, funnel_id: f.id, step_id: step, type: 'page_view', visitor_id: `v${(off + i) % 90000}`, unique_visit: 0, lead_id: null, order_id: null, external_id: null, amount_cents: 0, currency: null, utm_json: '{"source":"bench"}', url: null, created_at: new Date(base + (off + i) * 5000).toISOString(), device: 'desktop', country: 'US', referrer_host: 'example.org' }));
  await deps.db.transaction((tx) => insertEvents(tx, rows));
}
console.error(`seeded ${N} events in ${Math.round((performance.now() - t0) / 1000)} s`);
global.gc?.();
const baseRss = process.memoryUsage().rss; let peak = baseRss, rows = 0, pages = 0, cursor = '', maxPageBytes = 0, pageMs = [];
t0 = performance.now();
for (;;) {
  const s = performance.now();
  const res = await app.request(`/api/v1/analytics/export/events?from=2026-01-01&to=2027-01-01&limit=20000${cursor ? `&cursor=${cursor}` : ''}`, { headers: { authorization: `Bearer ${key}` } });
  const text = await res.text(); pageMs.push(performance.now() - s); pages++; rows += Number(res.headers.get('x-row-count')); maxPageBytes = Math.max(maxPageBytes, text.length);
  peak = Math.max(peak, process.memoryUsage().rss); cursor = res.headers.get('x-next-cursor') ?? ''; if (!cursor) break;
}
const secs = (performance.now() - t0) / 1000; pageMs.sort((a, b) => a - b);
console.log(JSON.stringify({ when: new Date().toISOString(), events: N, pages, rows_exported: rows, rows_per_s: Math.round(rows / secs), page_ms_median: Math.round(pageMs[pageMs.length >> 1]), page_ms_last: Math.round(pageMs.at(-1)), max_page_mb: Math.round(maxPageBytes / 1e5) / 10, rss_before_mb: Math.round(baseRss / 1e6), rss_peak_mb: Math.round(peak / 1e6), rss_growth_mb: Math.round((peak - baseRss) / 1e6), node: process.version }));
