// Isolates the cost of keeping aggregates in step with event writes, without HTTP, the load generator or the rest of the stack.
// Same data (unique visitors, one funnel, 4 steps, timestamps advancing 250 ms per batch) is written through each strategy:
//   per-row + both triggers   (the code before this change: rollup trigger + visitor_days trigger, one INSERT per row)
//   per-row + rollup trigger  (visitor_days trigger removed)
//   per-row, no triggers      (lower bound: raw insert cost only, no rollups at all)
//   batch + app-level rollups (current code: services/rollups.ts insertEvents, one multi-row insert + one upsert per bucket)
// Usage: node bench/ingest-db.mjs [rowsPerBatch=500] [batches=200] [repeats=7]. Needs `npm run build --prefix server`.
// Strategies are interleaved in every repeat so drift in machine load hits all of them alike; the table shows median and min.
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const root = fileURLToPath(new URL('..', import.meta.url));
const [PER, BATCHES, REPEATS] = [Number(process.argv[2] ?? 500), Number(process.argv[3] ?? 200), Number(process.argv[4] ?? 7)];
const { SqliteDb } = await import(pathToFileURL(join(root, 'server/dist/db/sqlite.js')));
const { migrate } = await import(pathToFileURL(join(root, 'server/dist/db/migrate.js')));
const { insertEvents } = await import(pathToFileURL(join(root, 'server/dist/services/rollups.js')));
const mig = (f) => readFileSync(join(root, 'server/src/db/migrations/sqlite', f), 'utf8');

const seed = (exec) => exec(`INSERT INTO workspaces VALUES ('w','w',0,'now'); INSERT INTO funnels (id, workspace_id, name, base_path, created_at, updated_at) VALUES ('f','w','f','/f','now','now');
  ${[0, 1, 2, 3].map((i) => `INSERT INTO steps (id, workspace_id, funnel_id, name, base_path, path_key, position, version, created_at, updated_at) VALUES ('s${i}','w','f','s','/s${i}','/s${i}',${i},1,'now','now');`).join('')}`);
const t0 = Date.parse('2026-03-10T12:00:00Z');
const row = (n, b) => ({ id: `e${n}`, workspace_id: 'w', funnel_id: 'f', step_id: `s${n % 4}`, type: 'page_view', visitor_id: `v${n}`, unique_visit: 1, lead_id: null, order_id: null, external_id: null, amount_cents: 0, currency: null, utm_json: '{}', url: null, created_at: new Date(t0 + b * 250).toISOString() });

function legacy(triggers) {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'ingest-db-')), 'b.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL');
  db.exec(mig('001_init.sql')); db.exec(mig('002_perf_edge.sql'));
  if (triggers === 'both') db.exec(mig('003_visitor_days.sql'));
  if (triggers === 'none') db.exec('DROP TRIGGER events_rollup_ai');
  seed((s) => db.exec(s));
  const ins = db.prepare(`INSERT OR IGNORE INTO events (id, workspace_id, funnel_id, step_id, type, visitor_id, unique_visit, external_id, utm_json, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return {
    async run() {
      let n = 0;
      for (let b = 0; b < BATCHES; b++) {
        db.exec('BEGIN IMMEDIATE');
        for (let i = 0; i < PER; i++) { const r = row(n++, b); ins.run(r.id, r.workspace_id, r.funnel_id, r.step_id, r.type, r.visitor_id, r.unique_visit, r.external_id, r.utm_json, r.url, r.created_at); }
        db.exec('COMMIT');
      }
    },
    check: () => ({ events: db.prepare('SELECT COUNT(*) n FROM events').get().n, rollupViews: db.prepare('SELECT COALESCE(SUM(page_views),0) n FROM event_rollups').get().n }),
  };
}
async function current() {
  const db = new SqliteDb(join(mkdtempSync(join(tmpdir(), 'ingest-db-')), 'b.db'));
  await migrate(db);
  await seed((s) => db.exec(s));
  return {
    async run() {
      let n = 0;
      for (let b = 0; b < BATCHES; b++) await db.transaction((tx) => insertEvents(tx, Array.from({ length: PER }, () => row(n++, b))));
    },
    check: async () => ({ events: (await db.get('SELECT COUNT(*) n FROM events')).n, rollupViews: (await db.get('SELECT COALESCE(SUM(page_views),0) n FROM event_rollups')).n }),
  };
}

const strategies = {
  'per-row + both triggers (before)': () => legacy('both'),
  'per-row + rollup trigger only': () => legacy('rollup'),
  'per-row, no triggers (lower bound, no rollups)': () => legacy('none'),
  'batch + app-level rollups (current)': current,
};
const times = Object.fromEntries(Object.keys(strategies).map((k) => [k, []]));
const checks = {};
for (let r = 0; r < REPEATS; r++) {
  for (const [name, make] of Object.entries(strategies)) {
    const s = await make();
    const c0 = process.cpuUsage(); const t = performance.now();
    await s.run();
    const wall = performance.now() - t; const c = process.cpuUsage(c0);
    times[name].push({ wall, cpu: (c.user + c.system) / 1000 });
    checks[name] = await s.check();
  }
}
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const total = PER * BATCHES;
console.log(`${total.toLocaleString()} events per run in batches of ${PER}; ${REPEATS} interleaved repeats; load ${process.platform === 'darwin' ? '' : ''}${(await import('node:os')).loadavg().map((x) => x.toFixed(1)).join(' ')}\n`);
console.log('| strategy | wall ms/1k rows (median / min) | CPU ms/1k rows (median / min) | rows/s (median) | events | rollup page_views |');
console.log('|---|---|---|---|---|---|');
for (const [name, ts] of Object.entries(times)) {
  const w = ts.map((x) => (x.wall / total) * 1000); const c = ts.map((x) => (x.cpu / total) * 1000);
  console.log(`| ${name} | ${med(w).toFixed(1)} / ${Math.min(...w).toFixed(1)} | ${med(c).toFixed(1)} / ${Math.min(...c).toFixed(1)} | ${Math.round(1000 / (med(w) / 1000))} | ${checks[name].events} | ${checks[name].rollupViews} |`);
}
