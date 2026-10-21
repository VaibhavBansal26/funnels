// Screenshots of the Go live card and the publishing states for docs/design/ (and for design review). Boots the e2e server (built app, fake Cloudflare Pages, job worker),
// builds a workspace with a published funnel, ad spend, attributed orders and an integration through the real API, and captures each screen at 1440, 1024 and 390 px, light and dark.
//   npm run build (repo root), then: node growth-shots.mjs [outDir]
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] ?? join(root, 'docs/design');
const dir = join(tmpdir(), `funnels-golive-shots-${process.pid}`);
mkdirSync(dir, { recursive: true });
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.SHOTS_PORT ?? 4393);
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
const draft = await call('POST', '/api/templates/lead-magnet/use', undefined, T);
const live = await call('POST', '/api/templates/sales-page-bump-upsell/use', undefined, T);
const failed = await call('POST', '/api/templates/lead-magnet/use', undefined, T);
await call('PUT', '/api/publishing/connection', { accountId: 'a'.repeat(32), token: 'cf-test-token-0123456789abcdef' }, T);
await call('POST', `/api/funnels/${live.id}/go-live`, { address: { kind: 'pages' } }, T);
const dom = await call('POST', '/api/domains', { hostname: 'offers.e2e.test' }, T);
const hasWebp = spawnSync('cwebp', ['-version']).status === 0;
async function shot(page, name) {
  const png = join(dir, `${name}.png`);
  await page.screenshot({ path: png, fullPage: true });
  if (hasWebp && spawnSync('cwebp', ['-quiet', '-q', '88', '-m', '6', png, '-o', join(out, `${name}.webp`)]).status === 0) return;
  copyFileSync(png, join(out, `${name}.png`));
}
await new Promise((r) => setTimeout(r, 3000)); // the fake deployment finishes
const SIZES = [{ id: '1440', width: 1440, height: 900 }, { id: '1024', width: 1024, height: 768 }, { id: '390', width: 390, height: 844 }];
const SCREENS = [
  { name: 'golive-draft', path: `/funnels/${draft.id}/settings`, wait: 1200 },
  { name: 'golive-live', path: `/funnels/${live.id}/settings`, wait: 1200 },
  { name: 'funnel-header-golive', path: `/funnels/${draft.id}/steps`, wait: 800 },
];
const only = process.env.SHOTS_ONLY;
const browser = await chromium.launch();
for (const theme of ['light', 'dark']) {
  for (const size of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: theme });
    await ctx.addInitScript(([t, tok]) => { localStorage.setItem('funnels.theme', t); localStorage.setItem('funnels.token', tok); }, [theme, T]);
    const page = await ctx.newPage();
    for (const s of SCREENS) {
      if (only && !s.name.includes(only)) continue;
      await page.goto(`${BASE}${s.path}`);
      await page.waitForTimeout(s.wait ?? 600);
      await shot(page, `${s.name}-${size.id}-${theme}`);
    }
    await ctx.close();
  }
}
await browser.close();
stop();
console.log('written to', out);
