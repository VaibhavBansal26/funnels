// Screenshots of the publishing, tracking and ads screens for docs/design/ (and for design review). Boots the e2e server (built app, fake Cloudflare Pages, job worker),
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
const dir = join(tmpdir(), `funnels-growth-shots-${process.pid}`);
mkdirSync(dir, { recursive: true });
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.SHOTS_PORT ?? 4392);
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
const f = await call('POST', '/api/templates/lead-magnet/use', undefined, T);
const sales = await call('POST', '/api/templates/sales-page-bump-upsell/use', undefined, T);
const dom = await call('POST', '/api/domains', { hostname: 'offers.e2e.test' }, T);
await call('POST', `/api/domains/${dom.id}/verify`, undefined, T);
await call('PATCH', `/api/funnels/${f.id}`, { status: 'live', domain_id: dom.id }, T);
await call('PUT', '/api/publishing/connection', { accountId: 'a'.repeat(32), token: 'cf-test-token-0123456789abcdef' }, T);
await call('PUT', `/api/funnels/${f.id}/publishing`, { target: 'cloudflare-pages' }, T);
await call('PUT', '/api/pixels', { meta: { pixelId: '123456789012345' }, ga4: { measurementId: 'G-ABC123XYZ9' }, consent: { enabled: true, regions: 'eu_uk', policyUrl: '/privacy' } }, T);
await call('POST', '/api/integrations', { provider: 'meta', name: 'Main pixel', pixelId: '123456789012345', secret: 'EAAB-shots-token-123456', testEventCode: 'TEST123' }, T);
await call('POST', '/api/integrations', { provider: 'ga4', name: 'GA4 property', pixelId: 'G-ABC123XYZ9', secret: 'ga-shots-secret-xyz' }, T);
const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const rows = ['date,source,campaign,currency,spend,impressions,clicks'];
for (let i = 1; i <= 10; i++) rows.push(`${day(i)},facebook,Spring Sale,USD,${(80 + i * 7).toFixed(2)},${9000 + i * 300},${200 + i * 9}`, `${day(i)},google,Brand Search,USD,${(30 + i * 3).toFixed(2)},${3000 + i * 100},${90 + i * 4}`);
rows.push(`${day(1)},tiktok,Creators Q1,USD,60.00,12000,310`);
await call('POST', '/api/ads/spend/import', rows.join('\n'), T, 'text/csv');
const step = sales.steps[0];
const doc = (await call('GET', `/api/funnels/${sales.id}/steps/${step.id}/page`, undefined, T)).doc;
const main = doc.products.find((b) => b.type === 'checkout' && !b.orderBump && !b.oneClickUpsell);
for (let i = 0; i < 9; i++) {
  const [src, med, camp] = i % 3 === 0 ? ['google', 'cpc', 'Brand Search'] : ['facebook', 'paid_social', 'Spring Sale'];
  const v = `shot-v${i}`;
  await call('POST', '/api/public/attribution', { funnelId: sales.id, stepId: step.id, visitorId: v, touch: { utm_source: src, utm_medium: med, utm_campaign: camp, utm_content: `ad-${i % 4}` }, ids: { consent: 'na' } });
  await call('POST', `/api/public/checkout/${sales.id}/${step.id}/${main.id}`, { email: `buyer${i}@example.com`, name: 'Buyer', visitorId: v });
}

const hasWebp = spawnSync('cwebp', ['-version']).status === 0;
async function shot(page, name) {
  const png = join(dir, `${name}.png`);
  await page.screenshot({ path: png, fullPage: true });
  if (hasWebp && spawnSync('cwebp', ['-quiet', '-q', '88', '-m', '6', png, '-o', join(out, `${name}.webp`)]).status === 0) return;
  copyFileSync(png, join(out, `${name}.png`));
}
const SIZES = [{ id: '1440', width: 1440, height: 900 }, { id: '1024', width: 1024, height: 768 }, { id: '390', width: 390, height: 844 }];
const SCREENS = [
  { name: 'ads-performance', path: '/ads/performance', wait: 1500 },
  { name: 'ads-spend', path: '/ads/spend', wait: 800 },
  { name: 'ads-integrations', path: '/ads/integrations', wait: 800 },
  { name: 'funnel-publishing', path: `/funnels/${f.id}/settings`, wait: 2500 },
  { name: 'settings-publishing', path: '/settings', wait: 800 },
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
