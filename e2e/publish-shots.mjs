// Screenshots of the builder's Publish dialog in its main states for docs/design/ (and for design review). Boots the e2e server (built app, fake Cloudflare Pages, job worker),
// builds a workspace with a published funnel, ad spend, attributed orders and an integration through the real API, and captures each screen at 1440, 1024 and 390 px, light and dark.
//   npm run build (repo root), then: node publish-shots.mjs [outDir]   (SHOTS_ONLY=<name part> for one screen)
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] ?? join(root, 'docs/design');
const dir = join(tmpdir(), `funnels-publish-shots-${process.pid}`);
mkdirSync(dir, { recursive: true });
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.SHOTS_PORT ?? 4395);
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DATABASE_PATH: ':memory:', JWT_SECRET: 'shots-secret-shots-secret-shots-secret-12', DATA_ENCRYPTION_KEY: 'shots-data-key-shots-data-key-shots-data-12', APP_PUBLIC_URL: BASE, APP_PUBLIC_CNAME_TARGET: 'sites.e2e.test', WEB_DIST: join(root, 'web/dist'), LOG_LEVEL: 'error', IP_GUARD_PER_MINUTE: '1000000', AUTH_ATTEMPTS_PER_MINUTE: '100000', API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', EVENT_BUFFER_MS: '0', JOB_POLL_MS: '300', PAGES_POLL_INTERVAL_MS: '300', PAGES_DEBOUNCE_SECONDS: '0', MAIL_PORT: String(PORT + 1), ACCESS_TOKEN_TTL_SECONDS: '3600' };
const server = spawn('node', ['--import', '../server/node_modules/tsx/dist/esm/index.mjs', 'server.mjs'], { cwd: join(root, 'e2e'), env, stdio: 'ignore' });
const stop = () => { server.kill(); rmSync(dir, { recursive: true, force: true }); };
process.on('exit', stop);
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/readyz`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 200)); }

const call = async (method, path, body, token, raw) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(raw ? { 'content-type': raw } : body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120' }, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const reg = await call('POST', '/api/auth/register', { email: 'shots@example.test', password: 'correct horse battery', name: 'Ada Founder' });
const T = reg.token;
const mk = async () => { const f = await call('POST', '/api/templates/lead-magnet/use', undefined, T); const d = await call('GET', `/api/funnels/${f.id}`, undefined, T); return { id: f.id, step: d.steps[0].id }; };
const draftNoCf = await mk();
const draftCf = await mk();
const liveBuiltin = await mk();
const failed = await mk();
await call('POST', `/api/funnels/${liveBuiltin.id}/go-live`, { address: { kind: 'builtin' } }, T);
const hasWebp = spawnSync('cwebp', ['-version']).status === 0;
async function shot(page, name) {
  const png = join(dir, `${name}.png`);
  await page.screenshot({ path: png });
  if (hasWebp && spawnSync('cwebp', ['-quiet', '-q', '88', '-m', '6', png, '-o', join(out, `${name}.webp`)]).status === 0) return;
  copyFileSync(png, join(out, `${name}.png`));
}
const SIZES = [{ id: '1440', width: 1440, height: 900 }, { id: '1024', width: 1024, height: 768 }, { id: '390', width: 390, height: 844 }];
const only = process.env.SHOTS_ONLY;
const browser = await chromium.launch();
async function run(screens) {
  for (const theme of ['light', 'dark']) {
    for (const size of SIZES) {
      const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: theme });
      await ctx.addInitScript(([t, tok]) => { localStorage.setItem('funnels.theme', t); localStorage.setItem('funnels.token', tok); }, [theme, T]);
      for (const s of screens) {
        if (only && !s.name.includes(only)) continue;
        const page = await ctx.newPage();
        if (s.route) await page.route('**/api/funnels/*/addresses', async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ response: res, json: s.route(j) }); });
        if (s.route) await page.route('**/api/funnels/*/publishing', async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ response: res, json: { ...j, lastError: 'Cloudflare rejected the upload: the account has reached its Pages project limit (100).' } }); });
        await page.goto(`${BASE}/funnels/${s.f.id}/builder/${s.f.step}`);
        await page.waitForSelector('[data-builder-ready="1"]');
        await page.getByRole('button', { name: 'Publish', exact: true }).click();
        const dlg = page.getByRole('dialog');
        await dlg.waitFor();
        await page.waitForTimeout(900);
        if (s.after) await s.after(page, dlg);
        await shot(page, `${s.name}-${size.id}-${theme}`);
        await page.close();
      }
      await ctx.close();
    }
  }
}
// Cloudflare is not connected yet: the Pages option explains what is missing.
await run([{ name: 'publish-dialog-test-mode', f: draftNoCf }]);
await call('PUT', '/api/publishing/connection', { accountId: 'a'.repeat(32), token: 'cf-test-token-0123456789abcdef' }, T);
await run([
  { name: 'publish-dialog-pages-chosen', f: draftCf, after: async (page, dlg) => { await dlg.getByRole('radio', { name: /Cloudflare Pages address/ }).check(); await page.waitForTimeout(200); } },
  { name: 'publish-dialog-live', f: liveBuiltin },
  { name: 'publish-dialog-failed', f: failed, route: (j) => ({ ...j, state: 'failed', funnelStatus: 'live', options: j.options.map((o) => (o.kind === 'pages' ? { ...o, selected: true } : o)) }) },
]);
await browser.close();
stop();
console.log('written to', out);
