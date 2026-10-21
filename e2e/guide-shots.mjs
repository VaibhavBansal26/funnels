// Screenshots for docs/USER-GUIDE.md: the pages and dialogs that docs/design/ does not already show, at 1440 px wide, light theme, as JPEG (quality 80).
// Boots the BUILT server (run `npm run build` at the repo root first) on a random free port with a throw-away SQLite file and the demo data (`npm run seed`),
// signs in as the demo owner (who is also made a platform admin so the Admin screens exist), captures every screen and stops what it started.
//   node guide-shots.mjs [outDir]                   all screens (default outDir: docs/design/guide)
//   GUIDE_ONLY=builder node guide-shots.mjs         only screens whose name contains the text
// JPEG conversion uses `sips` (macOS) or ImageMagick `convert`; without either the PNG is kept.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] ?? join(root, 'docs/design/guide');
const dir = join(tmpdir(), `funnels-guide-shots-${process.pid}`);
mkdirSync(dir, { recursive: true });
mkdirSync(out, { recursive: true });
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = Number(process.env.SHOTS_PORT ?? (await freePort()));
const BASE = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATABASE_PATH: join(dir, 'guide.db'), JWT_SECRET: 'shots-secret-shots-secret-shots-secret-12', APP_PUBLIC_URL: BASE,
  WEB_DIST: join(root, 'web/dist'), LOG_LEVEL: 'error', IP_GUARD_PER_MINUTE: '1000000', AUTH_ATTEMPTS_PER_MINUTE: '100000', PLATFORM_ADMIN_EMAILS: 'demo@example.test',
};
const seed = spawnSync('npx', ['tsx', 'src/seed.ts'], { cwd: join(root, 'server'), env, encoding: 'utf8' });
if (seed.status !== 0) { console.error(seed.stdout, seed.stderr); process.exit(1); }
const server = spawn('node', ['dist/index.js'], { cwd: join(root, 'server'), env, stdio: 'ignore' });
const stop = () => { server.kill(); rmSync(dir, { recursive: true, force: true }); };
process.on('exit', stop);
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/readyz`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 200)); }

const call = async (method, path, body, token) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const login = await call('POST', '/api/auth/login', { email: 'demo@example.test', password: 'demo-password-123' });
const T = login.token;
const funnels = (await call('GET', '/api/funnels?limit=50', undefined, T)).data;
const detail = async (re) => call('GET', `/api/funnels/${funnels.find((f) => re.test(f.name)).id}`, undefined, T);
const sales = await detail(/sales/i);
const lead = await detail(/lead/i);
// Something in the trash, a webhook, and a spend row, so those screens are not empty.
const old = await call('POST', '/api/funnels', { name: 'Old holiday promo', base_path: '/holiday' }, T);
await call('DELETE', `/api/funnels/${old.id}`, undefined, T);
await call('POST', '/api/webhooks', { url: 'https://example.com/hooks/funnels', events: ['funnel.optin', 'funnel.purchase'] }, T).catch(() => undefined);
await call('POST', '/api/products', { name: 'Sample ebook', type: 'one_time', price: { amount: 19, currency: 'USD' } }, T).catch(() => undefined);

const convert = (png, jpg) => {
  if (spawnSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', png, '--out', jpg], { stdio: 'ignore' }).status === 0) return true;
  return spawnSync('convert', [png, '-quality', '80', jpg], { stdio: 'ignore' }).status === 0;
};
async function shot(page, name, target) {
  const png = join(dir, `${name}.png`);
  await (target ?? page).screenshot({ path: png });
  if (!convert(png, join(out, `${name}.jpg`))) copyFileSync(png, join(out, `${name}.png`));
  console.log('shot', name);
}
const settle = async (page, ms = 700) => { await page.waitForLoadState('networkidle').catch(() => undefined); await page.waitForTimeout(ms); };
const W = 1440, H = 900;

const browser = await chromium.launch();
const wanted = (name) => !process.env.GUIDE_ONLY || name.includes(process.env.GUIDE_ONLY);
const failures = [];
const step = async (name, fn) => { if (!wanted(name)) return; try { await fn(); } catch (e) { failures.push(name); console.error('FAILED', name, String(e).split('\n')[0]); } };

// ---- signed out ----
{
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: 'light' });
  await ctx.addInitScript(() => localStorage.setItem('funnels.theme', 'light'));
  const page = await ctx.newPage();
  for (const [name, path] of [['register', '/register'], ['forgot-password', '/forgot-password'], ['reset-password', '/reset-password?token=example'], ['accept-invite-invalid', '/accept-invite?token=example']]) {
    await step(name, async () => { await page.goto(BASE + path); await settle(page, 500); await shot(page, name); });
  }
  await ctx.close();
}

// ---- signed in ----
const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: 'light', deviceScaleFactor: 1 });
await ctx.addInitScript(([token, refresh]) => { localStorage.setItem('funnels.theme', 'light'); localStorage.setItem('funnels.token', token); localStorage.setItem('funnels.refresh', refresh); }, [T, login.refreshToken]);
const page = await ctx.newPage();
const go = async (path, ms) => { await page.goto(BASE + path); await settle(page, ms); };
const dialog = () => page.locator('[role=dialog]').first();

await step('funnels-table', async () => { await go('/funnels?view=table'); await shot(page, 'funnels-table'); });
await step('account-menu', async () => { await go('/funnels'); await page.getByRole('button', { name: 'Account menu' }).click(); await page.waitForTimeout(300); await shot(page, 'account-menu'); await page.keyboard.press('Escape'); });
await step('notifications', async () => { await go('/funnels'); await page.getByRole('button', { name: /Notifications/ }).click(); await page.waitForTimeout(500); await shot(page, 'notifications'); await page.keyboard.press('Escape'); });
await step('new-funnel-blank', async () => { await go('/funnels/new'); await page.getByLabel('Funnel name').fill('Spring offer'); await page.waitForTimeout(200); await shot(page, 'new-funnel-blank'); });
await step('new-funnel-template', async () => { await go('/funnels/new'); await page.getByRole('button', { name: /From a template/ }).click(); await settle(page, 2500); await shot(page, 'new-funnel-template'); });
await step('template-preview', async () => { await go('/templates', 2000); await page.getByRole('button', { name: /^Preview / }).first().click(); await settle(page, 1500); await shot(page, 'template-preview'); await page.keyboard.press('Escape'); });
await step('use-template', async () => { await go('/templates', 2000); await page.getByRole('button', { name: /^Use template Sales/ }).first().click(); await page.waitForTimeout(600); await shot(page, 'use-template'); await page.keyboard.press('Escape'); });

await step('funnel-leads', async () => { await go(`/funnels/${lead.id}/leads`); await shot(page, 'funnel-leads'); });
await step('funnel-orders', async () => { await go(`/funnels/${sales.id}/orders`); await shot(page, 'funnel-orders'); });
await step('funnel-ads', async () => { await go(`/funnels/${sales.id}/ads`); await shot(page, 'funnel-ads'); });
await step('funnel-settings', async () => { await go(`/funnels/${sales.id}/settings`); await shot(page, 'funnel-settings'); });
await step('funnel-settings-tracking', async () => { await go(`/funnels/${sales.id}/settings`); await page.getByRole('region', { name: 'Tracking and ad pixels' }).scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await shot(page, 'funnel-settings-tracking'); });
await step('add-step', async () => { await go(`/funnels/${sales.id}/steps`); await page.getByRole('button', { name: 'Add step' }).click(); await page.getByLabel('Step name').fill('Bonus offer'); await page.waitForTimeout(600); await shot(page, 'add-step'); await page.keyboard.press('Escape'); });
await step('add-payments', async () => { await go(`/funnels/${lead.id}/steps`); await page.getByRole('button', { name: 'Add payments' }).click(); await page.waitForTimeout(600); await shot(page, 'add-payments'); await page.keyboard.press('Escape'); });

await step('product-editor', async () => { await go('/products'); await page.getByRole('button', { name: /New product/ }).click(); await page.waitForTimeout(500); await shot(page, 'product-editor'); await page.keyboard.press('Escape'); });
await step('domains-add', async () => { await go('/domains'); await page.getByRole('button', { name: 'Add domain' }).click(); await page.getByLabel('Hostname').fill('offers.example.com'); await shot(page, 'domains-add'); await page.keyboard.press('Escape'); });
await step('webhooks', async () => { await go('/webhooks'); await shot(page, 'webhooks'); });
await step('webhooks-add', async () => { await go('/webhooks'); await page.getByRole('button', { name: 'Add webhook' }).first().click(); await page.waitForTimeout(400); await shot(page, 'webhooks-add'); await page.keyboard.press('Escape'); });
await step('trash', async () => { await go('/trash'); await shot(page, 'trash'); });
await step('audit', async () => { await go('/audit'); await shot(page, 'audit'); });

await step('ads-attribution', async () => { await go('/ads/attribution'); await shot(page, 'ads-attribution'); });
await step('ads-integration-connect', async () => { await go('/ads/integrations'); await page.getByRole('button', { name: 'Connect a network' }).first().click(); await page.waitForTimeout(400); await shot(page, 'ads-integration-connect'); await page.keyboard.press('Escape'); });
await step('ads-spend-import', async () => { await go('/ads/spend'); await page.getByRole('button', { name: 'Import CSV' }).click(); await page.waitForTimeout(400); await shot(page, 'ads-spend-import'); await page.keyboard.press('Escape'); });

for (const [name, id] of [['team', 'team'], ['security', 'security'], ['plan', 'billing'], ['payments', 'payments'], ['publishing', 'publishing'], ['tracking', 'tracking'], ['reviews', 'reviews'], ['api', 'api'], ['ai', 'ai']]) {
  await step(`settings-${name}`, async () => { await go('/settings'); const el = page.locator(`#${id}`).first(); await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await shot(page, `settings-${name}`, el); });
}
await step('settings-api-key', async () => { await go('/settings'); await page.locator('#api').scrollIntoViewIfNeeded(); await page.getByRole('button', { name: 'New API key' }).click(); await page.waitForTimeout(400); await shot(page, 'settings-api-key'); await page.keyboard.press('Escape'); });

for (const tab of ['workspaces', 'queues', 'flags', 'announcements', 'audit', 'privacy', 'admins']) {
  await step(`admin-${tab}`, async () => { await go(`/admin/${tab}`); await shot(page, `admin-${tab}`); });
}
await step('admin-workspace-detail', async () => { await go('/admin/workspaces'); await page.getByRole('button', { name: 'Demo Studio' }).click(); await page.waitForTimeout(800); await shot(page, 'admin-workspace-detail'); await page.keyboard.press('Escape'); });

// ---- builder ----
const builderPath = `/funnels/${sales.id}/builder/${sales.steps[0].id}`;
const openBuilder = async () => { await page.goto(BASE + builderPath); await page.waitForSelector('[data-builder-ready="1"]'); await page.getByRole('tab', { name: 'Blocks' }).click(); await page.waitForTimeout(1000); };
await step('builder-layers', async () => { await openBuilder(); await page.getByRole('tab', { name: 'Layers' }).click(); await page.waitForTimeout(400); await shot(page, 'builder-layers'); });
await step('builder-pages', async () => { await openBuilder(); await page.getByRole('tab', { name: 'Pages' }).click(); await page.waitForTimeout(400); await shot(page, 'builder-pages'); });
await step('builder-images', async () => { await openBuilder(); await page.getByRole('tab', { name: 'Images' }).click(); await page.waitForTimeout(400); await shot(page, 'builder-images'); });
await step('builder-inspector-settings', async () => {
  await openBuilder();
  await page.frameLocator('iframe.gjs-frame').locator('h1').first().click();
  await page.getByRole('tab', { name: /Settings/ }).click(); await page.waitForTimeout(400);
  await shot(page, 'builder-inspector-settings');
});
await step('builder-inspector-advanced', async () => {
  await openBuilder();
  await page.frameLocator('iframe.gjs-frame').locator('h1').first().click();
  await page.getByRole('tab', { name: /Advanced/ }).click(); await page.waitForTimeout(400);
  await shot(page, 'builder-inspector-advanced');
});
await step('builder-page-settings', async () => { await openBuilder(); await page.getByRole('button', { name: 'More actions' }).click(); await page.getByRole('menuitem', { name: /Page settings/ }).click(); await page.waitForTimeout(500); await shot(page, 'builder-page-settings'); });
await step('builder-history', async () => { await openBuilder(); await page.getByRole('button', { name: 'More actions' }).click(); await page.getByRole('menuitem', { name: /Version history/ }).click(); await page.waitForTimeout(500); await shot(page, 'builder-history'); });
await step('builder-shortcuts', async () => { await openBuilder(); await page.getByRole('button', { name: 'More actions' }).click(); await page.getByRole('menuitem', { name: /Keyboard shortcuts/ }).click(); await page.waitForTimeout(500); await shot(page, 'builder-shortcuts'); });
await step('builder-more-menu', async () => { await openBuilder(); await page.getByRole('button', { name: 'More actions' }).click(); await page.waitForTimeout(300); await shot(page, 'builder-more-menu'); });
await step('builder-preview', async () => { await openBuilder(); await page.getByRole('button', { name: /Preview/ }).first().click(); await page.waitForTimeout(700); await shot(page, 'builder-preview'); });

void dialog;
await browser.close();
stop();
if (failures.length) { console.error('failed screens:', failures.join(', ')); process.exit(1); }
