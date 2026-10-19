// Before/after for analytics reads: scan of raw events (the previous implementation) vs the 15-minute rollup table (current).
// Usage: node bench/analytics.mjs [events=1000000]
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';

const N = Number(process.argv[2] ?? 1_000_000);
const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'funnels-bench-')), 'b.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA foreign_keys = ON');
const mdir = fileURLToPath(new URL('../server/src/db/migrations/', import.meta.url));
for (const f of readdirSync(mdir).sort()) db.exec(readFileSync(join(mdir, f), 'utf8'));
db.exec(`INSERT INTO workspaces VALUES ('w','w',0,'now'); INSERT INTO funnels (id, workspace_id, name, base_path, created_at, updated_at) VALUES ('f','w','f','/f','now','now')`);
for (let i = 0; i < 4; i++) db.exec(`INSERT INTO steps (id, workspace_id, funnel_id, name, base_path, path_key, position, version, created_at, updated_at) VALUES ('s${i}','w','f','s','/s${i}','/s${i}',${i},1,'now','now')`);
const ins = db.prepare(`INSERT INTO events (id, workspace_id, funnel_id, step_id, type, visitor_id, unique_visit, amount_cents, created_at) VALUES (?, 'w', 'f', ?, ?, ?, ?, ?, ?)`);
let t = performance.now();
db.exec('BEGIN');
const start = Date.parse('2026-01-01T00:00:00Z');
for (let i = 0; i < N; i++) {
  const type = i % 20 === 0 ? 'optin' : i % 97 === 0 ? 'order' : 'page_view';
  ins.run(`e${i}`, `s${i % 4}`, type, `v${i % 200000}`, i % 3 === 0 ? 1 : 0, type === 'order' ? 4900 : 0, new Date(start + Math.floor((i / N) * 90 * 86400000)).toISOString());
}
db.exec('COMMIT');
const insertMs = performance.now() - t;
const time = (label, fn, n = 5) => { fn(); const ts = []; for (let i = 0; i < n; i++) { const a = performance.now(); fn(); ts.push(performance.now() - a); } ts.sort((x, y) => x - y); return `${label}: median ${ts[Math.floor(n / 2)].toFixed(1)} ms`; };
const from = '2026-02-01T00:00:00.000Z', to = '2026-03-01T00:00:00.000Z';
const raw = () => db.prepare(`SELECT step_id, SUM(type='page_view'), SUM(type='page_view' AND unique_visit=1), SUM(type='optin'), SUM(type='order'), SUM(CASE WHEN type='order' THEN amount_cents ELSE 0 END) FROM events WHERE workspace_id='w' AND funnel_id='f' AND created_at >= ? AND created_at < ? GROUP BY step_id`).all(from, to);
const roll = () => db.prepare(`SELECT step_id, SUM(page_views), SUM(unique_views), SUM(optins), SUM(orders), SUM(cents) FROM event_rollups WHERE funnel_id='f' AND workspace_id='w' AND bucket >= ? AND bucket < ? GROUP BY step_id`).all(from.slice(0, 16), to.slice(0, 16));
const rawSeries = () => db.prepare(`SELECT substr(created_at,1,16) m, type, unique_visit, COUNT(*) FROM events WHERE funnel_id='f' AND created_at >= ? AND created_at < ? GROUP BY m, type, unique_visit`).all(from, to);
const rollSeries = () => db.prepare(`SELECT bucket, SUM(page_views), SUM(unique_views), SUM(optins), SUM(orders), SUM(cents) FROM event_rollups WHERE funnel_id='f' AND bucket >= ? AND bucket < ? GROUP BY bucket`).all(from.slice(0, 16), to.slice(0, 16));
const distinct = () => db.prepare(`SELECT COUNT(DISTINCT visitor_id) FROM events WHERE funnel_id='f' AND created_at >= ? AND created_at < ? AND type='page_view'`).get(from, to);
console.log(`${N.toLocaleString()} events inserted in ${(insertMs / 1000).toFixed(1)} s (with the rollup trigger active); rollup rows: ${db.prepare('SELECT COUNT(*) n FROM event_rollups').get().n}`);
console.log(time('per-step totals, raw events scan   ', raw));
console.log(time('per-step totals, rollups           ', roll));
console.log(time('daily series input, raw events scan', rawSeries));
console.log(time('daily series input, rollups        ', rollSeries));
const vd = () => db.prepare(`SELECT COUNT(*) n FROM (SELECT DISTINCT visitor_id FROM visitor_days WHERE funnel_id='f' AND day >= '2026-02-01' AND day < '2026-03-01')`).get();
console.log(time('COUNT(DISTINCT visitor), raw events      ', distinct, 3));
console.log(time('COUNT(DISTINCT visitor), visitor_days    ', vd, 3));
console.log(`distinct visitors identical: ${JSON.stringify(distinct()) === JSON.stringify(vd()).replace('"n"', '"COUNT(DISTINCT visitor_id)"')} (${Object.values(vd())[0]} visitor_days-based)`);
const a = JSON.stringify(raw().map((r) => Object.values(r).map(Number)));
const b = JSON.stringify(roll().map((r) => Object.values(r).map(Number)));
console.log(`results identical: ${a === b}`);
