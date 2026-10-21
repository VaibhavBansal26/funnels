// Regenerates the screenshots in docs/design/: boots the BUILT server on a throw-away SQLite file with the demo data (npm run seed), signs in as the demo
// owner and captures the main screens at three viewport sizes in light and dark. Run `npm run build` at the repo root first, then `npm run design:shots` here.
// Images are written as WebP when `cwebp` is installed (small files), otherwise as PNG.
//   node design-shots.mjs [outDir]            all screens, all sizes
//   SHOTS_ONLY=builder node design-shots.mjs  only screens whose name contains the text
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] ?? join(root, 'docs/design');
const dir = join(tmpdir(), `funnels-shots-${process.pid}`);
mkdirSync(dir, { recursive: true });
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.SHOTS_PORT ?? 4390);
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATABASE_PATH: join(dir, 'shots.db'), JWT_SECRET: 'shots-secret-shots-secret-shots-secret-12', APP_PUBLIC_URL: BASE, WEB_DIST: join(root, 'web/dist'), LOG_LEVEL: 'error', IP_GUARD_PER_MINUTE: '1000000', AUTH_ATTEMPTS_PER_MINUTE: '100000' };

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
console.log('funnels:', withSteps.map((f) => f.name).join(' | '), '-> main:', main.name);

const hasWebp = spawnSync('cwebp', ['-version']).status === 0;
/** Writes the screenshot as WebP (or PNG without cwebp): docs/design stays a few hundred KB per image instead of a megabyte. */
async function shot(page, name) {
  const png = join(dir, `${name}.png`);
  await page.screenshot({ path: png });
  if (hasWebp && spawnSync('cwebp', ['-quiet', '-q', '88', '-m', '6', png, '-o', join(out, `${name}.webp`)]).status === 0) return;
  copyFileSync(png, join(out, `${name}.png`));
}

const SIZES = [{ id: '1440', width: 1440, height: 900 }, { id: '1024', width: 1024, height: 768 }, { id: '390', width: 390, height: 844 }];
const SCREENS = [
  { name: 'funnels', path: '/funnels' },
  { name: 'funnel-steps', path: `/funnels/${main.id}/steps` },
  { name: 'analytics', path: `/funnels/${main.id}/analytics`, wait: 1200 },
  { name: 'templates', path: '/templates', wait: 2500 },
  { name: 'builder', path: `/funnels/${main.id}/builder/${main.steps[0].id}`, builder: true },
  { name: 'products', path: '/products', wait: 800 },
  { name: 'products-performance', path: '/products?tab=performance', wait: 1500 },
  { name: 'domains', path: '/domains' },
  { name: 'settings', path: '/settings' },
  // more screens, for review rather than for the docs: SHOTS_EXTRA=1
  { name: 'x-new-funnel', path: '/funnels/new', extra: true },
  { name: 'x-webhooks', path: '/webhooks', extra: true },
  { name: 'x-leads', path: `/funnels/${main.id}/leads`, extra: true },
  { name: 'x-orders', path: `/funnels/${withSteps.find((f) => /sales/i.test(f.name))?.id ?? main.id}/orders`, extra: true },
  { name: 'x-funnel-settings', path: `/funnels/${main.id}/settings`, extra: true },
  { name: 'x-trash', path: '/trash', extra: true },
  { name: 'x-audit', path: '/audit', extra: true },
];

const browser = await chromium.launch();
// the sign-in screen needs a signed-out browser
if (!process.env.SHOTS_ONLY || 'login'.includes(process.env.SHOTS_ONLY)) {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
    await ctx.addInitScript((t) => localStorage.setItem('funnels.theme', t), theme);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.waitForTimeout(500);
    await shot(page, `login-1440-${theme}`);
    await ctx.close();
  }
}
try {
  for (const theme of ['light', 'dark']) {
    for (const size of SIZES) {
      const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: theme, deviceScaleFactor: 1 });
      await ctx.addInitScript(([t, token, refresh]) => { localStorage.setItem('funnels.theme', t); localStorage.setItem('funnels.token', token); localStorage.setItem('funnels.refresh', refresh); }, [theme, login.token, login.refreshToken]);
      const page = await ctx.newPage();
      for (const s of SCREENS) {
        if (process.env.SHOTS_ONLY && !s.name.includes(process.env.SHOTS_ONLY)) continue;
        if (s.extra !== undefined && !process.env.SHOTS_EXTRA) continue;
        await page.goto(BASE + s.path);
        if (s.builder) {
          await page.waitForSelector('[data-builder-ready="1"]');
          await page.waitForTimeout(900);
          if (size.width >= 768) await page.frameLocator('iframe.gjs-frame').locator('h1').first().click().catch(() => undefined);
        } else {
          await page.waitForLoadState('networkidle').catch(() => undefined);
          await page.waitForTimeout(s.wait ?? 600);
        }
        await shot(page, `${s.name}-${size.id}-${theme}`);
        console.log('shot', s.name, size.id, theme);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  stop();
}
