// Fails when the production bundle outgrows its budget (gzip sizes). Run after `npm run build`.
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../dist/assets/', import.meta.url));
const BUDGET = { entryKb: 125, chunkKb: 60, totalKb: 280 };
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const sizes = files.map((f) => ({ f, kb: gzipSync(readFileSync(join(dir, f))).length / 1024 }));
const entry = sizes.find((s) => s.f.startsWith('index-'));
const total = sizes.reduce((n, s) => n + s.kb, 0);
let failed = false;
const check = (label, value, max) => {
  const ok = value <= max;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${value.toFixed(1)} KB gzip (budget ${max} KB)`);
};
check('entry chunk', entry?.kb ?? 0, BUDGET.entryKb);
for (const s of sizes.filter((x) => x !== entry)) check(`chunk ${s.f}`, s.kb, BUDGET.chunkKb);
check('total JS', total, BUDGET.totalKb);
process.exit(failed ? 1 : 0);
