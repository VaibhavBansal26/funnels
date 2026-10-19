// The current write path (services/rollups.ts insertEvents: multi-row insert + one upsert per bucket) on every engine.
// Usage: [BENCH_PG_URL=postgres://...] node bench/ingest-engines.mjs [rowsPerBatch=500] [batches=100] [repeats=3]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const load = (p) => import(pathToFileURL(join(root, 'server/dist', p)));
const { openDb, openPglite } = await load('db/index.js');
const { insertEvents } = await load('services/rollups.js');
const [PER, BATCHES, REPEATS] = [Number(process.argv[2] ?? 500), Number(process.argv[3] ?? 100), Number(process.argv[4] ?? 3)];
const t0 = Date.parse('2026-03-10T12:00:00Z');
const row = (n, b) => ({ id: `e${n}`, workspace_id: 'w', funnel_id: 'f', step_id: `s${n % 4}`, type: 'page_view', visitor_id: `v${n}`, unique_visit: 1, lead_id: null, order_id: null, external_id: null, amount_cents: 0, currency: null, utm_json: '{}', url: null, created_at: new Date(t0 + b * 250).toISOString() });
async function fresh(kind) {
  const db = kind === 'sqlite' ? await openDb({ sqlitePath: join(mkdtempSync(join(tmpdir(), 'ie-')), 'b.db') }) : kind === 'pglite' ? await openPglite() : null;
  let d = db;
  if (kind === 'postgres') {
    const admin = await openDb({ url: process.env.BENCH_PG_URL });
    const name = `bench_${Date.now()}`;
    await admin.exec(`CREATE DATABASE ${name}`); await admin.close();
    const u = new URL(process.env.BENCH_PG_URL); u.pathname = `/${name}`;
    d = await openDb({ url: u.toString(), poolMax: 4 });
  }
  await d.exec(`INSERT INTO workspaces VALUES ('w','w',0,'now'); INSERT INTO funnels (id, workspace_id, name, base_path, created_at, updated_at) VALUES ('f','w','f','/f','now','now');`);
  for (let i = 0; i < 4; i++) await d.run(`INSERT INTO steps (id, workspace_id, funnel_id, name, base_path, path_key, position, version, created_at, updated_at) VALUES (?, 'w','f','s',?,?,?,1,'now','now')`, `s${i}`, `/s${i}`, `/s${i}`, i);
  return d;
}
const kinds = ['sqlite', 'pglite', ...(process.env.BENCH_PG_URL ? ['postgres'] : [])];
const res = Object.fromEntries(kinds.map((k) => [k, []]));
for (let r = 0; r < REPEATS; r++) for (const k of kinds) {
  const d = await fresh(k); let n = 0; const t = performance.now();
  for (let b = 0; b < BATCHES; b++) await d.transaction((tx) => insertEvents(tx, Array.from({ length: PER }, () => row(n++, b))));
  res[k].push(performance.now() - t);
  const c = await d.get('SELECT COUNT(*) n FROM events'); const s = await d.get('SELECT SUM(page_views) n FROM event_rollups');
  if (c.n !== PER * BATCHES || s.n !== PER * BATCHES) throw new Error(`${k}: events ${c.n}, rollup ${s.n}`);
  await d.close();
}
const total = PER * BATCHES; const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`${total.toLocaleString()} events in batches of ${PER}, ${REPEATS} repeats\n\n| engine | ms/1k rows (median) | rows/s |\n|---|---|---|`);
for (const k of kinds) console.log(`| ${k} | ${((med(res[k]) / total) * 1000).toFixed(1)} | ${Math.round(total / (med(res[k]) / 1000))} |`);
process.exit(0);
