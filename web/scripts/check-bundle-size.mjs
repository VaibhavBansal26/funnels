// Fails when the production bundle outgrows its budget (gzip sizes). Run after `npm run build`.
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../dist/assets/', import.meta.url));
// Budgets in KB gzip. The builder chunk is loaded only when an editor is opened (GrapesJS itself is ~230 KB gzip of it), so it has its own budget and does not
// count against the first-load budget; the shared "ui" chunk is the design system (Radix primitives, icons, class utilities) used by every screen.
// The Sentry chunk is loaded only when the server is configured with a DSN (never on the first load), so like the builder it has its own budget and is not part of the total.
const BUDGET = { entryKb: 125, chunkKb: 90, builderKb: 450, sentryKb: 60, totalKb: 700 };
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const sizes = files.map((f) => ({ f, kb: gzipSync(readFileSync(join(dir, f))).length / 1024 }));
const entry = sizes.find((s) => s.f.startsWith('index-'));
const lazyOnly = (f) => f.startsWith('sentryLoader-');
const total = sizes.filter((s) => !lazyOnly(s.f)).reduce((n, s) => n + s.kb, 0);
let failed = false;
const check = (label, value, max) => {
  const ok = value <= max;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${value.toFixed(1)} KB gzip (budget ${max} KB)`);
};
check('entry chunk', entry?.kb ?? 0, BUDGET.entryKb);
for (const s of sizes.filter((x) => x !== entry)) check(`chunk ${s.f}`, s.kb, s.f.startsWith('BuilderPage-') ? BUDGET.builderKb : lazyOnly(s.f) ? BUDGET.sentryKb : BUDGET.chunkKb);
check('total JS', total, BUDGET.totalKb);
process.exit(failed ? 1 : 0);
