// Design-review screenshots: boots the BUILT server on a throw-away SQLite file with the demo data (the demo owner is also a platform admin), signs in and captures
// EVERY main screen (auth, lists, funnel tabs, builder states, dialogs, settings, admin) at 390, 1024 and 1440 px in light and dark as full-page PNGs (height capped).
// Used for before/after comparison; `contact-sheet.mjs` turns the output folder into JPEG sheets for docs/design/.
//   npm run build (repo root), then: node review-shots.mjs <outDir>      (SHOTS_ONLY=<name part>, SHOTS_SIZES=1440,390, SHOTS_THEMES=light)
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2];
if (!out) { console.error('usage: node review-shots.mjs <outDir>'); process.exit(1); }
const dir = join(tmpdir(), `funnels-review-${process.pid}`);
mkdirSync(dir, { recursive: true });
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.SHOTS_PORT ?? 4000 + Math.floor(Math.random() * 3000));
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATABASE_PATH: join(dir, 'shots.db'), JWT_SECRET: 'shots-secret-shots-secret-shots-secret-12', APP_PUBLIC_URL: BASE, WEB_DIST: process.env.SHOTS_WEB_DIST ?? join(root, 'web/dist'), LOG_LEVEL: 'error', IP_GUARD_PER_MINUTE: '1000000', AUTH_ATTEMPTS_PER_MINUTE: '100000', API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', PLATFORM_ADMIN_EMAILS: 'demo@example.test', MAIL_PORT: String(PORT + 1) };
const seed = spawnSync('npx', ['tsx', 'src/seed.ts'], { cwd: join(root, 'server'), env, encoding: 'utf8' });
if (seed.status !== 0) { console.error(seed.stdout, seed.stderr); process.exit(1); }
const server = spawn('node', ['dist/index.js'], { cwd: join(root, 'server'), env, stdio: 'ignore' });
const stop = () => { server.kill(); rmSync(dir, { recursive: true, force: true }); };
process.on('exit', stop);
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/readyz`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 200)); }

const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@example.test', password: 'demo-password-123' }) })).json();
const H = { authorization: `Bearer ${login.token}` };
const funnels = (await (await fetch(`${BASE}/api/funnels?limit=50`, { headers: H })).json()).data;
const withSteps = await Promise.all(funnels.map(async (f) => (await fetch(`${BASE}/api/funnels/${f.id}`, { headers: H })).json()));
const main = withSteps.find((f) => /course|webinar|lead/i.test(f.name)) ?? withSteps[0];
const sales = withSteps.find((f) => /sales/i.test(f.name)) ?? main;

const SIZES = [{ id: '1440', width: 1440, height: 900 }, { id: '1024', width: 1024, height: 768 }, { id: '390', width: 390, height: 844 }].filter((s) => !process.env.SHOTS_SIZES || process.env.SHOTS_SIZES.split(',').includes(s.id));
const THEMES = (process.env.SHOTS_THEMES ?? 'light,dark').split(',');
const builderPath = `/funnels/${main.id}/builder/${main.steps[0].id}`;
const selectHeading = async (page, size) => { if (size.width >= 768) await page.frameLocator('iframe.gjs-frame').locator('h1').first().click().catch(() => undefined); };
const tab = async (page, name) => { await page.getByRole('tab', { name }).first().click().catch(() => undefined); await page.waitForTimeout(250); };
const SCREENS = [
  { name: 'auth-login', path: '/login', anon: true },
  { name: 'auth-register', path: '/register', anon: true },
  { name: 'funnels', path: '/funnels' },
  { name: 'funnels-new', path: '/funnels/new' },
  { name: 'funnel-steps', path: `/funnels/${main.id}/steps` },
  { name: 'funnel-analytics', path: `/funnels/${main.id}/analytics`, wait: 1200 },
  { name: 'funnel-leads', path: `/funnels/${main.id}/leads` },
  { name: 'funnel-orders', path: `/funnels/${sales.id}/orders` },
  { name: 'funnel-settings', path: `/funnels/${main.id}/settings` },
  { name: 'builder', path: builderPath, builder: true, act: selectHeading },
  { name: 'builder-blocks', path: builderPath, builder: true, act: async (p, s) => { if (s.width < 768) await p.getByRole('button', { name: /blocks|add/i }).first().click().catch(() => undefined); } },
  { name: 'builder-layers', path: builderPath, builder: true, act: async (p, s) => { await selectHeading(p, s); await tab(p, 'Layers'); } },
  { name: 'builder-style', path: builderPath, builder: true, act: async (p, s) => { await selectHeading(p, s); await tab(p, 'Style'); } },
  { name: 'builder-settings-tab', path: builderPath, builder: true, act: async (p, s) => { await selectHeading(p, s); await tab(p, 'Settings'); } },
  { name: 'builder-publish', path: builderPath, builder: true, act: async (p) => { await p.getByRole('button', { name: 'Publish', exact: true }).click().catch(() => undefined); await p.waitForTimeout(700); } },
  { name: 'templates', path: '/templates', wait: 2500 },
  { name: 'products', path: '/products', wait: 800 },
  { name: 'products-performance', path: '/products?tab=performance', wait: 1500 },
  { name: 'ads', path: '/ads', wait: 800 },
  { name: 'ads-integrations', path: '/ads/integrations', wait: 800 },
  { name: 'domains', path: '/domains' },
  { name: 'webhooks', path: '/webhooks' },
  { name: 'trash', path: '/trash' },
  { name: 'audit', path: '/audit' },
  { name: 'settings', path: '/settings', wait: 1200 },
  { name: 'admin', path: '/admin', wait: 900 },
  { name: 'admin-queues', path: '/admin/queues', wait: 900 },
];

const browser = await chromium.launch();
try {
  for (const theme of THEMES) {
    for (const size of SIZES) {
      for (const anon of [false, true]) {
        const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: theme, deviceScaleFactor: 1 });
        await ctx.addInitScript(([t, token, refresh, a]) => { localStorage.setItem('funnels.theme', t); if (!a) { localStorage.setItem('funnels.token', token); localStorage.setItem('funnels.refresh', refresh); } }, [theme, login.token, login.refreshToken, anon]);
        const page = await ctx.newPage();
        for (const s of SCREENS.filter((x) => !!x.anon === anon)) {
          if (process.env.SHOTS_ONLY && !s.name.includes(process.env.SHOTS_ONLY)) continue;
          await page.goto(BASE + s.path);
          if (s.builder) {
            await page.waitForSelector('[data-builder-ready="1"]').catch(() => undefined);
            await page.waitForTimeout(900);
          } else {
            await page.waitForLoadState('networkidle').catch(() => undefined);
            await page.waitForTimeout(s.wait ?? 600);
          }
          if (s.act) await s.act(page, size);
          const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (over > 1) { const who = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => { if (e.getBoundingClientRect().right <= window.innerWidth + 1) return false; for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return false; } return true; }).slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 50)}`).join(' | ')); console.log(`OVERFLOW ${s.name} ${size.id} ${theme}: ${over}px ${who}`); if (process.env.SHOTS_DEBUG) console.log(await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0).slice(0, 8).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 60)} sw=${e.scrollWidth} cw=${e.clientWidth} ${getComputedStyle(e).overflowX}`).join('\n'))); if (false) console.log(await page.evaluate(() => { const t = [...document.querySelectorAll('table')].find((e) => e.getBoundingClientRect().right > window.innerWidth + 1); const out = []; for (let e = t; e && e !== document.body; e = e.parentElement) out.push(`${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)} w=${Math.round(e.getBoundingClientRect().width)} ${getComputedStyle(e).display}`); return out.join('\n'); })); }
          await page.waitForTimeout(250);
          const full = !s.builder;
          const h = await page.evaluate(() => document.documentElement.scrollHeight);
          // the app scrolls inside a main region on some layouts: measure the tallest scroller too
          const inner = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('main, [data-scroll]')].map((e) => e.scrollHeight)));
          if (full && Math.max(h, inner) > size.height) await page.setViewportSize({ width: size.width, height: Math.min(2600, Math.max(h, inner)) });
          await page.screenshot({ path: join(out, `${s.name}-${size.id}-${theme}.png`) });
          await page.setViewportSize({ width: size.width, height: size.height });
          console.log('shot', s.name, size.id, theme);
        }
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  stop();
}
